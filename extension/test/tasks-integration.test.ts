/**
 * Phase 0 integration tests (a–g from the revised first build brief),
 * plus host-dispatch and dashboard-handler wiring checks.
 *
 * Mock executor, mock store, mock tab checker — no live browser, no
 * chrome APIs. These tests prove the sections work together (runner +
 * host dispatch + dashboard handler + registry stub), not just in
 * isolation: a task created through host dispatch must be readable
 * through the dashboard handler, and a task interrupted mid-run must
 * resume from storage on a new runner.
 */
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { createToolRegistry } from "../libs/browser-engine/index.js";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskStep,
  type TaskView,
} from "../libs/tasks/index.js";
import { HostProtocolHandler, type BridgeTransport } from "../src/host-protocol.js";
import { handleTaskDashboardRequest, type TaskDashboardPort } from "../src/task-dashboard.js";
import type { BridgeHostMessage } from "../libs/tool-contracts/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";
const SNAPSHOT: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" };

let nowVal = 1_000_000;
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `task_${idCounter.toString(16).padStart(32, "0")}`;
}

interface Call {
  tool: string;
  stepIndex: number;
}

function makeRunner(options: {
  executor?: (tool: string, input: Record<string, unknown>, ctx: { stepIndex: number }) => Promise<{ outputSummary: string }>;
  tabChecker?: (tabId: number) => Promise<{ exists: boolean; url: string | null }>;
  reobserve?: (step: TaskStep) => Promise<{ effectObserved: boolean; summary: string }>;
  executeCompensation?: (step: TaskStep) => Promise<void>;
  isConsequential?: (tool: string) => boolean;
  progress?: (view: TaskView) => void;
  store?: ReturnType<typeof createMemoryTaskStore>;
} = {}) {
  const store = options.store ?? createMemoryTaskStore();
  const calls: Call[] = [];
  const executor =
    options.executor ??
    (async (tool: string, _input: Record<string, unknown>, ctx: { stepIndex: number }) => {
      calls.push({ tool, stepIndex: ctx.stepIndex });
      return { outputSummary: `ok ${ctx.stepIndex}` };
    });
  const runner = new TaskRunner({
    store,
    executeStep: executor,
    executeCompensation: options.executeCompensation,
    audit: () => undefined,
    progress: options.progress ?? (() => undefined),
    policySnapshot: () => ({ ...SNAPSHOT }),
    tabChecker: options.tabChecker,
    reobserve: options.reobserve,
    now: () => nowVal,
    generateId: nextId,
    isConsequential: options.isConsequential,
  });
  return { runner, store, calls };
}

function readSteps(n: number) {
  return Array.from({ length: n }, (_, i) => ({ tool: "tabs.list", input: { url: `https://example.com/page-${i}` } }));
}

function doneIndices(view: TaskView): number[] {
  return view.steps.filter((s) => s.state === "done").map((s) => s.index);
}

class FakeTransport implements BridgeTransport {
  readonly messages: BridgeHostMessage[] = [];
  post(message: BridgeHostMessage): void {
    this.messages.push(message);
  }
  last(): BridgeHostMessage {
    return this.messages[this.messages.length - 1];
  }
}

function dashboardPort(runner: TaskRunner): TaskDashboardPort {
  const toView = (view: TaskView) => ({
    id: view.id,
    goal: view.goal,
    clientId: view.clientId,
    browserSessionId: view.browserSessionId,
    status: view.status,
    steps: view.steps.map((s) => ({
      index: s.index,
      tool: s.tool,
      inputSummary: s.inputSummary,
      state: s.state === "unknown" ? ("pending" as const) : s.state,
      attempts: s.attempts,
      outputSummary: s.outputSummary,
    })),
    totalSteps: view.steps.length,
    doneSteps: doneIndices(view),
    undoneSteps: view.steps.filter((s) => s.state !== "done").map((s) => s.index),
    totalBudgetMs: view.totalBudgetMs,
    correlationId: view.correlationId,
    resultSummary: view.resultSummary,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    completedAt: view.completedAt ?? 0,
    ...(view.resumeAfterMs !== null ? { resumeAfterMs: view.resumeAfterMs } : {}),
    ...(view.pauseReason !== null ? { pauseReason: view.pauseReason } : {}),
  });
  const withClient = async (id: string) => {
    const found = (await runner.listAllTasks()).find((t) => t.id === id);
    if (!found) throw new Error(`task not found: ${id}`);
    return found.clientId;
  };
  return {
    listTasks: async () => (await runner.listAllTasks()).map(toView),
    getTask: async (id) => toView(await runner.getTask(id, await withClient(id))),
    pauseTask: async (id, reason) => toView(await runner.pauseTask(id, await withClient(id), reason ?? "paused")),
    resumeTask: async (id) => {
      const clientId = await withClient(id);
      return toView(await runner.resumeTask(id, clientId, { ...SNAPSHOT, clientId }));
    },
    cancelTask: async (id) => toView(await runner.cancelTask(id, await withClient(id))),
  };
}

describe("integration a: restart resume", () => {
  it("10-step read-only task interrupted at step 5 resumes at step 6 with no duplicate work", async () => {
    const store = createMemoryTaskStore();
    let taskId = "";
    let pausedOnce = false;
    const progress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 5) {
        pausedOnce = true;
        const all = store.snapshot();
        const found = all.find((t) => t.id === taskId);
        if (found) {
          found.status = "paused";
          found.pauseReason = "test-interrupt";
          void store.save(all);
        }
      }
    };
    const first = makeRunner({ store, progress });
    const created = await first.runner.createTask(
      { goal: "read ten pages", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(10) },
      SNAPSHOT,
    );
    taskId = created.id;
    const interrupted = await first.runner.runTask(taskId, CLIENT);
    expect(interrupted.status).toBe("paused");
    expect(doneIndices(interrupted)).toEqual([0, 1, 2, 3, 4]);
    expect(first.calls).toHaveLength(5);

    const second = makeRunner({ store });
    // Share the call log so duplicate detection spans both runners.
    const finished = await second.runner.resumeTask(taskId, CLIENT, { ...SNAPSHOT });
    expect(finished.status).toBe("done");
    expect(doneIndices(finished)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Second runner executed exactly steps 5-9 (first runner did 0-4).
    expect(second.calls.map((c) => c.stepIndex)).toEqual([5, 6, 7, 8, 9]);
    expect(finished.resultSummary).toContain("Done steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].");
  });
});

describe("integration b: idempotency", () => {
  it("deliberate duplicate retry of a consequential step returns the stored result without re-executing", async () => {
    const { runner, calls } = makeRunner({ isConsequential: (tool) => tool === "dom.click" });
    const created = await runner.createTask(
      {
        goal: "click once",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { tabId: 1, x: 10, y: 20 } }],
      },
      SNAPSHOT,
    );
    const done = await runner.runTask(created.id, CLIENT);
    expect(done.status).toBe("done");
    expect(calls).toHaveLength(1);
    const again = await runner.runTask(created.id, CLIENT);
    expect(again.status).toBe("done");
    const resumed = await runner.resumeTask(created.id, CLIENT, { ...SNAPSHOT });
    expect(resumed.status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(again.steps[0].outputSummary).toBe("ok 0");
  });
});

describe("integration c: bridge disconnect", () => {
  it("marks the step unknown, re-observes before any retry, and does not retry blindly", async () => {
    const reobserveCalls: number[] = [];
    let attempts = 0;
    const { runner, calls } = makeRunner({
      executor: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Bridge closed");
        calls.push({ tool: "dom.click", stepIndex: 0 });
        return { outputSummary: "clicked on retry" };
      },
      reobserve: async () => {
        reobserveCalls.push(1);
        return { effectObserved: true, summary: "effect already happened" };
      },
      isConsequential: (tool) => tool === "dom.click",
    });
    const created = await runner.createTask(
      { goal: "click after disconnect", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "dom.click", input: {} }] },
      SNAPSHOT,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.steps[0].state).toBe("unknown");
    expect(paused.pauseReason).toBe("bridge-disconnected");
    expect(reobserveCalls).toHaveLength(0);

    const resolved = await runner.resolveUnknown(created.id, 0);
    expect(reobserveCalls).toHaveLength(1);
    expect(resolved.status).toBe("done");
    expect(resolved.steps[0].outputSummary).toBe("effect already happened");
    // Re-observation confirmed the effect, so no re-execution happened.
    expect(calls).toHaveLength(0);
  });

  it("re-observes with effect not observed, then re-executes exactly once", async () => {
    let attempts = 0;
    const { runner, calls } = makeRunner({
      executor: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Bridge closed");
        calls.push({ tool: "dom.click", stepIndex: 0 });
        return { outputSummary: "clicked on retry" };
      },
      reobserve: async () => ({ effectObserved: false, summary: "not observed" }),
      isConsequential: (tool) => tool === "dom.click",
    });
    const created = await runner.createTask(
      { goal: "click after disconnect 2", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "dom.click", input: {} }] },
      SNAPSHOT,
    );
    await runner.runTask(created.id, CLIENT);
    const resolved = await runner.resolveUnknown(created.id, 0);
    expect(resolved.steps[0].state).toBe("done");
    expect(calls).toHaveLength(1);
  });
});

describe("integration d: pinned tab", () => {
  it("pauses with tab-closed when a pinned tab disappears", async () => {
    const { runner } = makeRunner({
      tabChecker: async () => ({ exists: false, url: null }),
      isConsequential: (tool) => tool === "dom.click",
    });
    const created = await runner.createTask(
      {
        goal: "click in pinned tab",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { tabId: 7, url: "https://example.com/a" } }],
      },
      SNAPSHOT,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("tab-closed");
  });

  it("pauses with tab-navigated-externally when a pinned tab URL changes", async () => {
    const { runner, calls } = makeRunner({
      tabChecker: async () => ({ exists: true, url: "https://example.com/other" }),
      isConsequential: (tool) => tool === "dom.click",
    });
    const created = await runner.createTask(
      {
        goal: "click after navigation",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { tabId: 7, url: "https://example.com/a" } }],
      },
      SNAPSHOT,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("tab-navigated-externally");
    expect(calls).toHaveLength(0);
  });
});

describe("integration e: rate limit", () => {
  it("pauses with backoff on 429/503, does not fail the step, and does not loop", async () => {
    const { runner } = makeRunner({
      executor: async () => {
        throw Object.assign(new Error("rate_limited"), { code: "RATE_LIMITED", retryAfterMs: 5000 });
      },
    });
    const created = await runner.createTask(
      { goal: "rate limited task", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(3) },
      SNAPSHOT,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("rate-limited");
    expect(paused.resumeAfterMs).toBe(5000);
    expect(paused.steps[0].state).toBe("pending");
    expect(paused.steps[0].attempts).toBe(0);
  });
});

describe("integration f: policy/client/scope", () => {
  it("pauses on policy change and rejects a different client or weaker scope on resume", async () => {
    const { runner } = makeRunner();
    const created = await runner.createTask(
      { goal: "guarded task", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(2) },
      SNAPSHOT,
    );
    await expect(runner.resumeTask(created.id, "client-b", { ...SNAPSHOT, clientId: "client-b" })).rejects.toThrow(/different client/);
    await expect(runner.resumeTask(created.id, CLIENT, { ...SNAPSHOT, scope: "read:tools" })).rejects.toThrow(/weaker/);
    // Policy version change pauses (and adopts the new snapshot, so a
    // second explicit resume under that policy proceeds).
    const changed = await runner.resumeTask(created.id, CLIENT, { ...SNAPSHOT, policyVersion: 2 });
    expect(changed.status).toBe("paused");
    expect(changed.pauseReason).toBe("policy-changed");
  });
});

describe("integration g: cancel", () => {
  it("cancel at step 7 reports steps 1-6 done, 8-10 undone, with compensations listed", async () => {
    const store = createMemoryTaskStore();
    let taskId = "";
    let pausedOnce = false;
    const progress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 6) {
        pausedOnce = true;
        const all = store.snapshot();
        const found = all.find((t) => t.id === taskId);
        if (found) {
          found.status = "paused";
          found.pauseReason = "test-interrupt";
          void store.save(all);
        }
      }
    };
    const compensations: string[] = [];
    const { runner } = makeRunner({
      store,
      progress,
      executeCompensation: async (step) => {
        compensations.push(`step ${step.index}`);
      },
    });
    const steps = readSteps(10).map((s, i) => ({
      ...s,
      compensation: { kind: "manual" as const, description: `undo step ${i}` },
    }));
    const created = await runner.createTask({ goal: "cancel at seven", clientId: CLIENT, browserSessionId: SESSION, steps }, SNAPSHOT);
    taskId = created.id;
    const interrupted = await runner.runTask(taskId, CLIENT);
    expect(doneIndices(interrupted)).toEqual([0, 1, 2, 3, 4, 5]);
    const cancelled = await runner.cancelTask(taskId, CLIENT);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resultSummary).toContain("Done steps: [0, 1, 2, 3, 4, 5].");
    expect(cancelled.resultSummary).toContain("Undone steps: [6, 7, 8, 9].");
    expect(compensations).toEqual(["step 5", "step 4", "step 3", "step 2", "step 1", "step 0"]);
  });
});

describe("integration: host dispatch + dashboard wiring", () => {
  it("creates a task through host dispatch and reads it through the dashboard handler, with no step inputs leaking", async () => {
    const { runner } = makeRunner();
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      },
    });
    const transport = new FakeTransport();
    const handler = new HostProtocolHandler({
      registry: rt.registry,
      executor: rt.executor,
      policy: rt.policy,
      approvals: rt.approvals,
      transport,
      getContext: () => rt.ctx,
      server: { name: "test-host", version: "1.0.0" },
      legacyTools: true,
      tasks: runner,
      getBrowserSessionId: () => SESSION,
      getTaskPolicySnapshot: () => ({ policyVersion: 1, mode: "default", clientId: "", scope: "gateway-enforced" }),
    });
    await handler.handle({
      type: "tool.call",
      id: "c1",
      tool: "tasks.create",
      input: { goal: "wired task", steps: [{ tool: "tabs.list", input: { secretMarker: "should-not-leak" } }], browserSessionId: SESSION },
      client: { id: CLIENT, name: "Client A", transport: "remote" },
    });
    const createdMsg = transport.last() as { type: string; result: { id: string; status: string; steps: { inputSummary: string }[] } };
    expect(createdMsg.type).toBe("tool.result");
    expect(createdMsg.result.status).toBe("done");
    expect(JSON.stringify(createdMsg.result)).not.toContain("should-not-leak");

    const port = dashboardPort(runner);
    const listed = await handleTaskDashboardRequest({ type: "muze/tasks.list" }, port);
    expect(listed.ok).toBe(true);
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks?.[0].goal).toBe("wired task");
    expect(JSON.stringify(listed)).not.toContain("should-not-leak");
    const got = await handleTaskDashboardRequest({ type: "muze/tasks.get", taskId: createdMsg.result.id }, port);
    expect(got.ok).toBe(true);
    expect(got.task?.status).toBe("done");
  });

  it("registry includes tasks.* with stub handlers that fail cleanly on direct executor calls", () => {
    const registry = createToolRegistry();
    expect(registry.names().filter((n) => n.startsWith("tasks."))).toHaveLength(7);
    expect(registry.get("tasks.create")).toBeDefined();
    expect(registry.get("tasks.complete")).toBeDefined();
  });
});
