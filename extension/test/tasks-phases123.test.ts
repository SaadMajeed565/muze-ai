/**
 * Complex-task Phases 1–3 tests (mock executor, no live browser):
 * per-step approval for consequential steps, denial, dry-run,
 * parallel read-only vs consequential, stale-ref pause + re-observe,
 * single-browser-session binding, and cancel final reports.
 * Phase 0 regression is covered by tasks-runner.test.ts and
 * tasks-integration.test.ts, which must keep passing unchanged.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type RunnerAuditEntry,
  type TaskStep,
  type TaskStore,
  type TaskView,
} from "../libs/tasks/index.js";
import { HostProtocolHandler, type TaskRunnerPort } from "../src/host-protocol.js";
import type { BridgeHostMessage } from "../libs/tool-contracts/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";
const OTHER_SESSION = "browser-session-2";

let nowVal: number;
let idCounter: number;
let snapshot: PolicySnapshot;

beforeEach(() => {
  nowVal = 1_000_000;
  idCounter = 0;
  snapshot = { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" };
});

function nextId(): string {
  idCounter += 1;
  return `task_${idCounter.toString(16).padStart(32, "0")}`;
}

function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

const RISK: Record<string, string> = {
  "tabs.list": "read-only",
  "pages.read": "read-only",
  "dom.click": "consequential",
  "forms.submit": "consequential",
};

interface HarnessOptions {
  store?: TaskStore & { snapshot(): import("../libs/tasks/index.js").TaskRecord[] };
  executor?: (tool: string, input: Record<string, unknown>, ctx: { stepIndex: number }) => Promise<{ outputSummary: string }>;
  tabChecker?: (tabId: number) => Promise<{ exists: boolean; url: string | null }>;
  preStepObserve?: (step: TaskStep) => Promise<{ refValid: boolean; summary: string }>;
  progress?: (view: TaskView) => void;
}

function makeRunner(options: HarnessOptions = {}) {
  const store = options.store ?? createMemoryTaskStore();
  const calls: { tool: string; stepIndex: number }[] = [];
  const audit: RunnerAuditEntry[] = [];
  const progressViews: TaskView[] = [];
  const executor =
    options.executor ??
    (async (tool: string, _input: Record<string, unknown>, ctx: { stepIndex: number }) => {
      calls.push({ tool, stepIndex: ctx.stepIndex });
      return { outputSummary: `ok ${ctx.stepIndex}` };
    });
  const runner = new TaskRunner({
    store,
    executeStep: executor,
    audit: (entry) => audit.push(entry),
    progress: options.progress ?? ((view) => progressViews.push(view)),
    policySnapshot: () => ({ ...snapshot }),
    tabChecker: options.tabChecker,
    preStepObserve: options.preStepObserve,
    toolRisk: (tool) => RISK[tool],
    toolExists: (tool) => tool in RISK,
    validateStepInput: (_tool, input) => (input.bad === true ? ["input failed canonical validation"] : []),
    now: () => nowVal,
    generateId: nextId,
  });
  return { runner, store, calls, audit, progressViews };
}

function doneIndices(view: TaskView): number[] {
  return view.steps.filter((s) => s.state === "done").map((s) => s.index);
}

describe("No plan approval: consequential plans run through per-step approval", () => {
  it("runs a bounded consequential plan without any plan approval", async () => {
    const { runner, calls } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "click once",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { url: "https://example.com/page" } }],
        planBounds: { allowedDomains: ["example.com"] },
        start: true,
      },
      snapshot,
    );
    expect(created.status).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("sends an out-of-bounds step through the normal per-step approval path, not a plan pause", async () => {
    let allow = false;
    const { runner, calls } = makeRunner({
      executor: async (tool, _input, ctx) => {
        calls.push({ tool, stepIndex: ctx.stepIndex });
        // Simulate the executor's per-step approval gate: the first
        // attempt asks again; once approval is granted it runs.
        if (tool === "dom.click" && !allow) throw codedError("APPROVAL_REQUIRED", "approval required");
        return { outputSummary: "clicked" };
      },
    });
    const created = await runner.createTask(
      {
        goal: "click elsewhere",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { url: "https://other.com/page" } }],
        planBounds: { allowedDomains: ["example.com"] },
        start: false,
      },
      snapshot,
    );
    const waiting = await runner.resumeTask(created.id, CLIENT, snapshot);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.steps[0].state).toBe("waiting_approval");
    expect(waiting.pauseReason).toBe("approval-required");
    allow = true;
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshot);
    expect(resumed.status).toBe("done");
    expect(calls.filter((c) => c.tool === "dom.click")).toHaveLength(2);
  });

  it("ends honestly partial when a step is denied, instead of pausing for a denied step", async () => {
    const { runner, calls } = makeRunner({
      executor: async (tool, _input, ctx) => {
        calls.push({ tool, stepIndex: ctx.stepIndex });
        if (tool === "dom.click") throw codedError("APPROVAL_DENIED", "user denied this step");
        return { outputSummary: "ok" };
      },
    });
    const created = await runner.createTask(
      {
        goal: "read then click",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {} },
          { tool: "dom.click", input: { url: "https://example.com/a" } },
        ],
        start: false,
      },
      snapshot,
    );
    const finished = await runner.resumeTask(created.id, CLIENT, snapshot);
    expect(finished.status).toBe("partial");
    expect(finished.finalReport?.failed).toEqual([1]);
    expect(finished.finalReport?.done).toEqual([0]);
    expect(calls.filter((c) => c.tool === "dom.click")).toHaveLength(1);
  });

  it("resumes a task left waiting_approval by the old plan gate and runs it", async () => {
    const store = createMemoryTaskStore();
    const { runner, calls } = makeRunner({ store });
    const created = await runner.createTask(
      {
        goal: "click once",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { url: "https://example.com/page" } }],
        planBounds: { allowedDomains: ["example.com"] },
        start: false,
      },
      snapshot,
    );
    // Legacy record: stuck waiting on the removed gate.
    const all = store.snapshot();
    const legacy = all.find((t) => t.id === created.id);
    if (!legacy) throw new Error("task not stored");
    legacy.status = "waiting_approval";
    legacy.pauseReason = "plan-approval-required";
    await store.save(all);
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshot);
    expect(resumed.status).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("keeps idempotency: a resumed done step is never re-executed", async () => {
    const store = createMemoryTaskStore();
    let taskId = "";
    let pausedOnce = false;
    const progress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 1) {
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
    const { runner, calls } = makeRunner({ store, progress });
    const created = await runner.createTask(
      {
        goal: "click then read",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "dom.click", input: { url: "https://example.com/a" } },
          { tool: "tabs.list", input: {} },
        ],
        start: false,
      },
      snapshot,
    );
    taskId = created.id;
    await runner.resumeTask(created.id, CLIENT, snapshot);
    // New runner over the same store = service-worker restart.
    const second = makeRunner({ store });
    const resumed = await second.runner.resumeTask(created.id, CLIENT, snapshot);
    expect(resumed.status).toBe("done");
    expect(calls.filter((c) => c.tool === "dom.click")).toHaveLength(1);
    // The restarted runner never re-executed the done consequential step.
    expect(second.calls.filter((c) => c.tool === "dom.click")).toHaveLength(0);
    expect(second.calls.filter((c) => c.tool === "tabs.list")).toHaveLength(1);
  });
});

describe("Phase 1: dry-run", () => {
  it("executes nothing, creates no record, and reports unknown tools, bad params, risks, domains, and approvals", async () => {
    const { runner, store, calls } = makeRunner();
    const preview = await runner.previewTask({
      goal: "preview me",
      clientId: CLIENT,
      browserSessionId: SESSION,
      steps: [
        { tool: "tabs.list", input: { url: "https://example.com/a" } },
        { tool: "dom.click", input: { url: "https://example.com/b" } },
        { tool: "nosuch.tool", input: {} },
        { tool: "tabs.list", input: { bad: true } },
        { tool: "forms.submit", input: { url: "https://shop.example/checkout" } },
      ],
      planBounds: { allowedDomains: ["example.com"] },
    });
    expect(calls).toHaveLength(0);
    expect(store.snapshot()).toHaveLength(0);
    expect(preview.valid).toBe(false);
    expect(preview.totalSteps).toBe(5);
    expect(preview.domains).toEqual(["example.com", "shop.example"]);
    expect(preview.steps[0].risk).toBe("read-only");
    expect(preview.steps[1].risk).toBe("consequential");
    expect(preview.steps[1].needsApproval).toBe(true);
    expect(preview.steps[2].errors.join(" ")).toContain("does not exist");
    expect(preview.steps[3].errors.join(" ")).toContain("canonical validation");
    expect(preview.steps[4].outsideBoundsReason).toContain("shop.example");
    expect(preview.approvalsNeeded).toContain(1);
    expect(preview.approvalsNeeded).toContain(4);
    expect(preview.errors.length).toBeGreaterThan(0);
  });

  it("reports a clean plan as valid with no approvals for read-only steps", async () => {
    const { runner, store, calls } = makeRunner();
    const preview = await runner.previewTask({
      goal: "clean",
      clientId: CLIENT,
      browserSessionId: SESSION,
      steps: [
        { tool: "tabs.list", input: {} },
        { tool: "pages.read", input: { url: "https://example.com/a" } },
      ],
    });
    expect(preview.valid).toBe(true);
    expect(preview.approvalsNeeded).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(store.snapshot()).toHaveLength(0);
  });
});

describe("Phase 3: parallel read-only, grounding, session binding", () => {
  it("runs independent read-only steps in parallel, capped at 4", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { runner } = makeRunner({
      executor: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return { outputSummary: "ok" };
      },
    });
    const created = await runner.createTask(
      {
        goal: "read six pages",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: Array.from({ length: 6 }, (_, i) => ({ tool: "tabs.list", input: { n: i }, independent: true, parallelGroup: 0 })),
        start: true,
      },
      snapshot,
    );
    expect(created.status).toBe("done");
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });

  it("never parallelises consequential steps, even when explicitly independent", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { runner } = makeRunner({
      executor: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return { outputSummary: "ok" };
      },
    });
    // Consequential group members run one at a time.
    const sequential = await runner.createTask(
      {
        goal: "click three",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: Array.from({ length: 3 }, () => ({ tool: "dom.click", input: { url: "https://example.com/a" }, independent: true, parallelGroup: 0 })),
        start: true,
      },
      snapshot,
    );
    expect(sequential.status).toBe("done");
    expect(maxConcurrent).toBe(1);
  });

  it("pauses on a stale ref and re-observes on resume instead of failing", async () => {
    let observations = 0;
    const { runner, calls } = makeRunner({
      preStepObserve: async () => {
        observations += 1;
        return observations === 1 ? { refValid: false, summary: "ref r1 is stale" } : { refValid: true, summary: "ref r1 fresh" };
      },
    });
    const created = await runner.createTask(
      {
        goal: "click with grounding",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { ref: "r1" } }],
        start: true,
      },
      snapshot,
    );
    expect(created.status).toBe("paused");
    expect(created.pauseReason).toBe("stale-ref");
    expect(created.steps[0].state).toBe("pending");
    expect(calls).toHaveLength(0);
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshot);
    expect(resumed.status).toBe("done");
    expect(resumed.steps[0].observationSummary).toContain("fresh");
    expect(calls).toHaveLength(1);
  });

  it("refuses to run a task on a different browser session", async () => {
    const { runner, calls } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "bound task",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
        start: false,
      },
      snapshot,
    );
    await expect(runner.runTask(created.id, CLIENT, OTHER_SESSION)).rejects.toThrow(/bound to browser session/);
    expect(calls).toHaveLength(0);
    const ok = await runner.runTask(created.id, CLIENT, SESSION);
    expect(ok.status).toBe("done");
    expect(calls).toHaveLength(1);
  });
});

describe("Phase 2: cancel final report", () => {
  it("reports done/undone/compensations/manual cleanup on cancel, never partial as done", async () => {
    const compensated: string[] = [];
    const store = createMemoryTaskStore();
    let taskId = "";
    let pausedOnce = false;
    const progress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 2) {
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
    const runner = new TaskRunner({
      store,
      executeStep: async () => ({ outputSummary: "ok" }),
      executeCompensation: async (step) => {
        // Step 1's compensation fails, so it must land in manual cleanup.
        if (step.index === 1) throw new Error("cannot navigate back");
        compensated.push(step.compensation.kind);
      },
      audit: () => undefined,
      progress,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
    });
    const created = await runner.createTask(
      {
        goal: "three steps",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {}, compensation: { kind: "close-tab", description: "close the tab" } },
          { tool: "tabs.list", input: {}, compensation: { kind: "navigate-back", description: "go back to the previous page" } },
          { tool: "tabs.list", input: {} },
        ],
        start: false,
      },
      snapshot,
    );
    taskId = created.id;
    const started = await runner.runTask(created.id, CLIENT);
    expect(started.status).toBe("paused");
    const cancelled = await runner.cancelTask(created.id, CLIENT);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finalReport?.done).toEqual([0, 1]);
    expect(cancelled.finalReport?.undone).toEqual([2]);
    expect(cancelled.finalReport?.failed).toEqual([]);
    expect(compensated).toEqual(["close-tab"]);
    expect(cancelled.finalReport?.compensations.join(" ")).toContain("close-tab");
    expect(cancelled.finalReport?.manualCleanup.join(" ")).toContain("navigate-back");
    expect(cancelled.resultSummary).toContain("Done steps: [0, 1]");
  });
});

describe("Host dispatch for dry-run", () => {
  function setupDispatch() {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      },
    });
    const messages: BridgeHostMessage[] = [];
    const seen: { preview?: unknown; create?: unknown } = {};
    const runnerView = {
      id: "task_1",
      goal: "g",
      clientId: CLIENT,
      browserSessionId: SESSION,
      status: "paused",
      steps: [
        {
          index: 0,
          tool: "tabs.list",
          input: {},
          inputSummary: "tabs.list()",
          idempotencyKey: "idem_1",
          state: "pending",
          attempts: 0,
          lastError: null,
          outputSummary: "",
          startedAt: null,
          finishedAt: null,
          timeoutMs: 5000,
          compensation: { kind: "none", description: "" },
          independent: false,
          parallelGroup: null,
          observationSummary: "",
          outsideBoundsReason: null,
        },
      ],
      totalBudgetMs: 60_000,
      correlationId: "corr",
      resultSummary: "",
      planBounds: null,
      finalReport: null,
      policySnapshot: snapshot,
      createdAt: 1000,
      updatedAt: 1000,
      completedAt: null,
      pinned: false,
      pauseReason: null,
      resumeAfterMs: null,
      pinnedTabs: [],
    };
    const port: TaskRunnerPort = {
      createTask: async () => {
        seen.create = true;
        return runnerView as never;
      },
      getTask: async () => runnerView as never,
      listTasks: async () => [runnerView as never],
      runTask: async () => runnerView as never,
      pauseTask: async () => runnerView as never,
      resumeTask: async () => runnerView as never,
      cancelTask: async () => runnerView as never,
      completeTask: async () => runnerView as never,
      previewTask: async (input) => {
        seen.preview = input;
        return { goal: input.goal, totalSteps: (input.steps ?? []).length, totalBudgetMs: 60_000, domains: [], steps: [], approvalsNeeded: [], errors: [], valid: true };
      },
    };
    const handler = new HostProtocolHandler({
      registry: rt.registry,
      executor: rt.executor,
      policy: rt.policy,
      approvals: rt.approvals,
      transport: { post: (message) => messages.push(message) },
      getContext: () => rt.ctx,
      server: { name: "test-host", version: "1.0.0" },
      legacyTools: true,
      tasks: port,
      getBrowserSessionId: () => SESSION,
      getTaskPolicySnapshot: () => snapshot,
    });
    return { handler, messages, seen };
  }

  it("routes tasks.create dryRun to preview only", async () => {
    const { handler, messages, seen } = setupDispatch();
    await handler.handle({
      type: "tool.call",
      id: "a3",
      tool: "tasks.create",
      input: { goal: "dry", description: "Preview this job in words.", dryRun: true },
    });
    expect(seen.preview).toBeDefined();
    expect(seen.create).toBeUndefined();
    const dryMsg = messages[messages.length - 1] as { type: string; dryRun: boolean; result: { valid: boolean } };
    expect(dryMsg.type).toBe("tool.result");
    expect(dryMsg.dryRun).toBe(true);
    expect(dryMsg.result.valid).toBe(true);
  });
});
