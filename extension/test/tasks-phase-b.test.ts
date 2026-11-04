/**
 * Phase B task-runner tests (OpenCode adoption plan §6, Phase B):
 * per-iteration tool resolution, post-step verification, budget-exhaustion
 * final reports, abort propagation, snapshot checkpoints, and pinned
 * task modes. Mock executor only — no live browser, no gateway.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskStep,
  type TaskStore,
  type TaskView,
} from "../libs/tasks/index.js";
import { TasksCreateInputSchema, TaskViewSchema } from "../libs/tool-contracts/schemas/tasks.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";

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

function flush(times = 10): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return chain;
}

interface HarnessOptions {
  store?: TaskStore & { snapshot(): import("../libs/tasks/index.js").TaskRecord[] };
  executor?: (tool: string, input: Record<string, unknown>, ctx: { stepIndex: number; signal: AbortSignal }) => Promise<{ outputSummary: string }>;
  resolveTool?: (tool: string, context: { mode: string }) => { allowed: boolean; reason?: string };
  captureSnapshot?: (step: TaskStep) => Promise<{ url: string | null; a11ySummary: string; formSummary: string }>;
  postStepObserve?: (step: TaskStep) => Promise<{ url: string | null; targetPresent: boolean | null; summary: string }>;
  executeCompensation?: (step: TaskStep) => Promise<void>;
  isConsequential?: (tool: string) => boolean;
  reobserve?: (step: TaskStep) => Promise<{ effectObserved: boolean; summary: string }>;
  progress?: (view: TaskView) => void;
}

function makeRunner(options: HarnessOptions = {}) {
  const store = options.store ?? createMemoryTaskStore();
  const calls: { tool: string; stepIndex: number }[] = [];
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
    policySnapshot: () => ({ ...snapshot }),
    resolveTool: options.resolveTool,
    captureSnapshot: options.captureSnapshot,
    postStepObserve: options.postStepObserve,
    reobserve: options.reobserve,
    now: () => nowVal,
    generateId: nextId,
    isConsequential: options.isConsequential,
  });
  return { runner, store, calls };
}

function doneIndices(view: TaskView): number[] {
  return view.steps.filter((s) => s.state === "done").map((s) => s.index);
}

describe("Phase B: post-step verification", () => {
  it("verify-fails marks the step unknown and pauses (never done on dispatch)", async () => {
    const { runner } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      postStepObserve: async () => ({ url: "https://example.com/other", targetPresent: null, summary: "observed other page" }),
    });
    const created = await runner.createTask(
      {
        goal: "click and verify",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { ref: "r1" }, verify: { kind: "url-equals", value: "https://example.com/expected" } }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("verify-failed");
    expect(view.steps[0].state).toBe("unknown");
    expect(view.steps[0].verifyOutcome).toBe("fail");
    expect(doneIndices(view)).toEqual([]);
  });

  it("verify-passes marks the step done and records the observation", async () => {
    const { runner } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      postStepObserve: async () => ({ url: "https://example.com/expected", targetPresent: true, summary: "observed expected page" }),
    });
    const created = await runner.createTask(
      {
        goal: "click and verify",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: { ref: "r1" }, verify: { kind: "url-equals", value: "https://example.com/expected" } }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("done");
    expect(view.steps[0].state).toBe("done");
    expect(view.steps[0].verifyOutcome).toBe("pass");
    expect(view.steps[0].verifySummary).toContain("expected page");
  });

  it("element-present verify uses the observation's target presence, and an unconfirmed target fails fail-closed", async () => {
    const { runner } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      postStepObserve: async () => ({ url: "https://example.com/page", targetPresent: null, summary: "no ref to check" }),
    });
    const created = await runner.createTask(
      {
        goal: "click and verify element",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {}, verify: { kind: "element-present" } }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.steps[0].state).toBe("unknown");
    expect(view.steps[0].verifyOutcome).toBe("fail");
  });

  it("without verify wiring a consequential step is done as before, with outcome skipped (gap visible)", async () => {
    const { runner } = makeRunner({ isConsequential: (tool) => tool === "dom.click" });
    const created = await runner.createTask(
      {
        goal: "click unwired",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {} }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("done");
    expect(view.steps[0].verifyOutcome).toBe("skipped");
  });

  it("a failed verify can be resolved: resolveUnknown re-observes and re-executes through the loop", async () => {
    let verifyCount = 0;
    const { runner } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      postStepObserve: async () => {
        verifyCount += 1;
        // First verify fails; the resolveUnknown re-execution verifies.
        return verifyCount === 1
          ? { url: "https://example.com/other", targetPresent: null, summary: "wrong page" }
          : { url: "https://example.com/expected", targetPresent: null, summary: "expected page" };
      },
      reobserve: async () => ({ effectObserved: false, summary: "not observed; re-execute" }),
    });
    const created = await runner.createTask(
      {
        goal: "click then resolve",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {}, verify: { kind: "url-equals", value: "https://example.com/expected" } }],
      },
      snapshot,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.steps[0].state).toBe("unknown");
    const resolved = await runner.resolveUnknown(created.id, 0);
    expect(resolved.steps[0].state).toBe("done");
    expect(resolved.steps[0].verifyOutcome).toBe("pass");
  });
});

describe("Phase B: per-iteration tool resolution", () => {
  it("tool-becomes-denied mid-task pauses with policy-changed and never executes the step", async () => {
    let denied = false;
    const { runner, calls } = makeRunner({
      resolveTool: (tool) => (tool === "dom.click" && denied ? { allowed: false, reason: "tool disabled by policy" } : { allowed: true }),
      progress: (view) => {
        // Deny the tool as soon as the first (read) step is done.
        if (view.steps[0]?.state === "done") denied = true;
      },
    });
    const created = await runner.createTask(
      {
        goal: "read then click",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {} },
          { tool: "dom.click", input: {} },
        ],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("policy-changed");
    expect(view.steps[1].state).toBe("pending");
    expect(calls.map((c) => c.tool)).toEqual(["tabs.list"]);
  });

  it("a read-mode task refuses a consequential step at the runner mode gate, without any wiring", async () => {
    const { runner, calls } = makeRunner({ isConsequential: (tool) => tool === "dom.click" });
    const created = await runner.createTask(
      {
        goal: "read-only task",
        clientId: CLIENT,
        browserSessionId: SESSION,
        mode: "read",
        steps: [{ tool: "dom.click", input: {} }],
      },
      snapshot,
    );
    expect(created.mode).toBe("read");
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("policy-changed");
    expect(calls).toHaveLength(0);
  });

  it("an unknown mode is rejected at creation, never guessed", async () => {
    const { runner } = makeRunner();
    await expect(
      runner.createTask(
        {
          goal: "bad mode",
          clientId: CLIENT,
          browserSessionId: SESSION,
          // Deliberately invalid at runtime; the type forbids it statically.
          mode: "turbo" as unknown as "act",
          steps: [{ tool: "tabs.list", input: {} }],
        },
        snapshot,
      ),
    ).rejects.toThrow(/unknown mode/);
  });
});

describe("Phase B: budget exhaustion final report", () => {
  it("budget already exhausted at run start ends failed with a final report (nothing done)", async () => {
    const { runner } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "too late",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {} },
          { tool: "tabs.list", input: {} },
        ],
        totalBudgetMs: 1000,
      },
      snapshot,
    );
    // Time passes between creation and run: the budget is gone before
    // any step executes, so the ending is failed, not partial.
    nowVal += 2000;
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("failed");
    expect(view.finalReport?.done).toEqual([]);
    expect(view.finalReport?.undone).toEqual([0, 1]);
    expect(view.finalReport?.failed).toEqual([]);
    expect(view.finalReport?.manualCleanup.length).toBe(2);
  });
});

describe("Phase B: snapshot checkpoints", () => {
  it("captures a bounded snapshot before a consequential step and persists it on the step record", async () => {
    const { runner, store } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      captureSnapshot: async () => ({ url: "https://example.com/before", a11ySummary: "3 accessibility nodes observed", formSummary: "1 forms, 2 fields observed" }),
    });
    const created = await runner.createTask(
      {
        goal: "click with snapshot",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {} }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("done");
    const stored = store.snapshot().find((t) => t.id === created.id);
    expect(stored?.steps[0].preStepSnapshot?.url).toBe("https://example.com/before");
    expect(stored?.steps[0].preStepSnapshot?.a11ySummary).toContain("3 accessibility nodes");
  });

  it("a failed snapshot capture pauses fail-closed and does not execute the step", async () => {
    const { runner, calls } = makeRunner({
      isConsequential: (tool) => tool === "dom.click",
      captureSnapshot: async () => {
        throw new Error("observe failed");
      },
    });
    const created = await runner.createTask(
      {
        goal: "click with broken snapshot",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {} }],
      },
      snapshot,
    );
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("snapshot-failed");
    expect(calls).toHaveLength(0);
  });
});

describe("Phase B: mode pinning", () => {
  it("a stored mode change mid-run pauses with mode-changed instead of being adopted", async () => {
    const store = createMemoryTaskStore();
    let taskId = "";
    let flipped = false;
    const { runner } = makeRunner({
      store,
      progress: (view) => {
        if (!flipped && view.id === taskId && view.steps[0]?.state === "done") {
          flipped = true;
          const all = store.snapshot();
          const found = all.find((t) => t.id === taskId);
          if (found) {
            (found as { mode: string }).mode = "read";
            void store.save(all);
          }
        }
      },
    });
    const created = await runner.createTask(
      {
        goal: "mode flip",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {} },
          { tool: "tabs.list", input: {} },
        ],
      },
      snapshot,
    );
    taskId = created.id;
    const view = await runner.runTask(created.id, CLIENT);
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("mode-changed");
    expect(doneIndices(view)).toEqual([0]);
  });
});

describe("Phase B: abort propagation", () => {
  it("cancel during a step aborts the signal and runs compensations for done steps", async () => {
    const store = createMemoryTaskStore();
    const compensated: number[] = [];
    const abortedSeen: boolean[] = [];
    const runner = new TaskRunner({
      store,
      executeStep: async (_tool, _input, ctx: { stepIndex: number; signal: AbortSignal }) => {
        if (ctx.stepIndex === 0) return { outputSummary: "ok 0" };
        // Step 1 blocks until the cancel aborts its signal, then throws.
        await new Promise<void>((_resolve, reject) => {
          if (ctx.signal.aborted) {
            abortedSeen.push(true);
            reject(Object.assign(new Error("Operation cancelled"), { code: "CANCELLED" }));
            return;
          }
          ctx.signal.addEventListener(
            "abort",
            () => {
              abortedSeen.push(true);
              reject(Object.assign(new Error("Operation cancelled"), { code: "CANCELLED" }));
            },
            { once: true },
          );
        });
        return { outputSummary: "ok 1" };
      },
      executeCompensation: async (step) => {
        compensated.push(step.index);
      },
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
      isConsequential: (tool) => tool === "dom.click",
    });
    const created = await runner.createTask(
      {
        goal: "cancel mid-step",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "dom.click", input: {}, compensation: { kind: "navigate-back", description: "go back" } },
          { tool: "dom.click", input: {} },
        ],
      },
      snapshot,
    );
    const runPromise = runner.runTask(created.id, CLIENT);
    await flush();
    const cancelled = await runner.cancelTask(created.id, CLIENT);
    const finished = await runPromise;
    expect(abortedSeen).toEqual([true]);
    expect(compensated).toEqual([0]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finalReport).not.toBeNull();
    expect(finished.status).toBe("cancelled");
  });

  it("cancel during a pending verify observation aborts the verify instead of marking the step done", async () => {
    const store = createMemoryTaskStore();
    let verifyAborted = false;
    const runner = new TaskRunner({
      store,
      executeStep: async () => ({ outputSummary: "clicked" }),
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
      isConsequential: (tool) => tool === "dom.click",
      postStepObserve: async (_step, signal) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            verifyAborted = true;
            reject(new Error("verify aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              verifyAborted = true;
              reject(new Error("verify aborted"));
            },
            { once: true },
          );
        });
        return { url: null, targetPresent: null, summary: "never reached" };
      },
    });
    const created = await runner.createTask(
      {
        goal: "cancel during verify",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "dom.click", input: {} }],
      },
      snapshot,
    );
    const runPromise = runner.runTask(created.id, CLIENT);
    await flush();
    const cancelled = await runner.cancelTask(created.id, CLIENT);
    const finished = await runPromise;
    expect(verifyAborted).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    expect(finished.status).toBe("cancelled");
    expect(finished.steps[0].state).not.toBe("done");
  });
});

describe("Phase B: mode field contract", () => {
  it("tasks.create schema accepts a valid mode and rejects an unknown one; the view schema carries the pinned mode", () => {
    const parsed = TasksCreateInputSchema.safeParse({
      goal: "g",
      description: "Do the job in words.",
      mode: "read",
    });
    expect(parsed.success).toBe(true);
    const rejected = TasksCreateInputSchema.safeParse({
      goal: "g",
      description: "Do the job in words.",
      mode: "turbo",
    });
    expect(rejected.success).toBe(false);
    const viewOk = TaskViewSchema.safeParse({
      id: "task_1",
      goal: "g",
      clientId: "c",
      mode: "read",
      status: "created",
      steps: [{ index: 0, tool: "tabs.list", inputSummary: "tabs.list()", state: "pending", attempts: 0, outputSummary: "" }],
      totalSteps: 1,
      doneSteps: [],
      undoneSteps: [],
      totalBudgetMs: 60000,
      correlationId: "corr",
      resultSummary: "",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(viewOk.success).toBe(true);
    if (viewOk.success) expect(viewOk.data.mode).toBe("read");
  });
});
