/**
 * Phase 0 task engine tests (mock executor, no live browser).
 *
 * Style follows the existing extension tests (vitest, stubbed globals
 * where needed): the runner is driven entirely through injectable
 * dependencies, and the in-memory store stands in for chrome.storage.
 * The service-worker-restart test creates a NEW runner over the SAME
 * store, which is exactly what happens when the worker restarts and
 * reloads the task from storage.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type RunnerAuditEntry,
  type TaskStore,
  type TaskView,
} from "../libs/tasks/index.js";

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

interface Call {
  tool: string;
  input: Record<string, unknown>;
  stepIndex: number;
}

interface HarnessOptions {
  store?: TaskStore & { snapshot(): import("../libs/tasks/index.js").TaskRecord[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor?: (tool: string, input: Record<string, unknown>, ctx: any) => Promise<{ outputSummary: string }>;
  tabChecker?: (tabId: number) => Promise<{ exists: boolean; url: string | null }>;
  reobserve?: (step: import("../libs/tasks/index.js").TaskStep) => Promise<{ effectObserved: boolean; summary: string }>;
  executeCompensation?: (step: import("../libs/tasks/index.js").TaskStep) => Promise<void>;
  progress?: (view: TaskView) => void;
  isConsequential?: (tool: string) => boolean;
}

function makeRunner(options: HarnessOptions = {}) {
  const store = options.store ?? createMemoryTaskStore();
  const calls: Call[] = [];
  const audit: RunnerAuditEntry[] = [];
  const progressViews: TaskView[] = [];
  const executor =
    options.executor ??
    (async (tool: string, input: Record<string, unknown>, ctx: { stepIndex: number }) => {
      calls.push({ tool, input, stepIndex: ctx.stepIndex });
      return { outputSummary: `ok ${ctx.stepIndex}` };
    });
  const runner = new TaskRunner({
    store,
    executeStep: executor,
    executeCompensation: options.executeCompensation,
    audit: (entry) => audit.push(entry),
    progress: options.progress ?? ((view) => progressViews.push(view)),
    policySnapshot: () => ({ ...snapshot }),
    tabChecker: options.tabChecker,
    reobserve: options.reobserve,
    now: () => nowVal,
    generateId: nextId,
    isConsequential: options.isConsequential,
  });
  return { runner, store, calls, audit, progressViews };
}

function readSteps(n: number, tool = "tabs.list") {
  return Array.from({ length: n }, (_, i) => ({ tool, input: { url: `https://example.com/page-${i}` } }));
}

function doneIndices(view: TaskView): number[] {
  return view.steps.filter((s) => s.state === "done").map((s) => s.index);
}

function flush(times = 5): Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return chain;
}

describe("createTask validation and views", () => {
  it("rejects more than 100 steps and a per-step timeout above the 60s bridge cap", async () => {
    const { runner } = makeRunner();
    await expect(runner.createTask({ goal: "too big", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(101) }, snapshot)).rejects.toThrow(
      /maximum of 100/,
    );
    await expect(
      runner.createTask(
        { goal: "slow", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {}, timeoutMs: 60001 }] },
        snapshot,
      ),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      runner.createTask(
        { goal: "zero", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {}, timeoutMs: 0 }] },
        snapshot,
      ),
    ).rejects.toThrow(/timeoutMs/);
  });

  it("does not auto-run unless start is true, and views never carry raw input", async () => {
    const { runner, store, calls, audit } = makeRunner();
    const created = await runner.createTask(
      { goal: "peek", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: { marker: "should-not-leak" } }] },
      snapshot,
    );
    expect(calls).toHaveLength(0);
    expect(created.status).toBe("created");
    expect("input" in created.steps[0]).toBe(false);
    expect(created.steps[0].inputSummary).toContain("tabs.list");
    expect(JSON.stringify(audit)).not.toContain("should-not-leak");
    // The stored record keeps the input internally (for resume), the view does not.
    expect((store.snapshot()[0].steps[0].input as Record<string, unknown>).marker).toBe("should-not-leak");
    expect(created.id).toMatch(/^task_[0-9a-f]{32}$/);
    expect(store.snapshot()[0].steps[0].idempotencyKey).toMatch(/^sha256:[0-9a-f]{64}$/);

    const started = await runner.createTask(
      { goal: "go", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {} }], start: true },
      snapshot,
    );
    expect(started.status).toBe("done");
    expect(calls).toHaveLength(1);
  });

  it("getTask rejects another client and listTasks is newest first", async () => {
    const { runner } = makeRunner();
    const first = await runner.createTask({ goal: "one", clientId: CLIENT, browserSessionId: SESSION, steps: [] }, snapshot);
    nowVal += 1000;
    const second = await runner.createTask({ goal: "two", clientId: CLIENT, browserSessionId: SESSION, steps: [] }, snapshot);
    await expect(runner.getTask(first.id, "client-b")).rejects.toThrow(/different client/);
    const listed = await runner.listTasks(CLIENT);
    expect(listed.map((t) => t.id)).toEqual([second.id, first.id]);
    expect(await runner.listTasks(CLIENT, "other-session")).toEqual([]);
  });

  it("enforces the 50-task cap and prunes completed tasks older than 7 days unless pinned", async () => {
    const { runner, store } = makeRunner();
    for (let i = 0; i < 50; i += 1) {
      await runner.createTask({ goal: `task ${i}`, clientId: CLIENT, browserSessionId: SESSION, steps: [] }, snapshot);
    }
    await expect(
      runner.createTask({ goal: "one too many", clientId: CLIENT, browserSessionId: SESSION, steps: [] }, snapshot),
    ).rejects.toThrow(/store is full/);

    const all = store.snapshot();
    const prunable = all[0];
    prunable.status = "done";
    prunable.completedAt = nowVal - 8 * 24 * 60 * 60 * 1000;
    prunable.createdAt = prunable.completedAt;
    const pinned = all[1];
    pinned.status = "done";
    pinned.completedAt = nowVal - 8 * 24 * 60 * 60 * 1000;
    pinned.createdAt = pinned.completedAt;
    pinned.pinned = true;
    await store.save(all);

    const created = await runner.createTask({ goal: "after prune", clientId: CLIENT, browserSessionId: SESSION, steps: [] }, snapshot);
    expect(created.status).toBe("created");
    const remaining = store.snapshot();
    expect(remaining).toHaveLength(50);
    expect(remaining.some((t) => t.id === prunable.id)).toBe(false);
    expect(remaining.some((t) => t.id === pinned.id)).toBe(true);
  });
});

describe("sequential run, checkpoint, restart resume", () => {
  it("10-step read-only task interrupted at step 5 resumes on a new runner with no duplicate work", async () => {
    const store = createMemoryTaskStore();
    const calls: Call[] = [];
    const executor = async (tool: string, input: Record<string, unknown>, ctx: { stepIndex: number }) => {
      calls.push({ tool, input, stepIndex: ctx.stepIndex });
      return { outputSummary: `read ${ctx.stepIndex}` };
    };
    let taskId = "";
    let pausedOnce = false;
    const interruptingProgress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 5) {
        pausedOnce = true;
        const all = store.snapshot();
        const found = all.find((t) => t.id === taskId);
        if (found) {
          found.status = "paused";
          found.pauseReason = "test-interrupt";
          // Memory save has no await inside, so this lands synchronously,
          // before the run loop reloads for the next step.
          void store.save(all);
        }
      }
    };
    const first = new TaskRunner({
      store,
      executeStep: executor,
      audit: () => undefined,
      progress: interruptingProgress,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
    });
    const created = await first.createTask(
      { goal: "read ten pages", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(10) },
      snapshot,
    );
    taskId = created.id;
    const interrupted = await first.runTask(taskId, CLIENT);
    expect(interrupted.status).toBe("paused");
    expect(doneIndices(interrupted)).toEqual([0, 1, 2, 3, 4]);
    expect(calls).toHaveLength(5);

    // Service-worker restart: a brand-new runner over the same store.
    const second = new TaskRunner({
      store,
      executeStep: executor,
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
    });
    const finished = await second.resumeTask(taskId, CLIENT, { ...snapshot });
    expect(finished.status).toBe("done");
    expect(doneIndices(finished)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(calls).toHaveLength(10);
    for (let i = 0; i < 10; i += 1) {
      expect(calls.filter((c) => c.stepIndex === i)).toHaveLength(1);
    }
    expect(finished.resultSummary).toContain("Done steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].");
    expect(finished.resultSummary).toContain("Undone steps: [].");
  });

  it("a done consequential step is never re-executed on a second run or resume", async () => {
    const { runner, calls } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "click once",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "act", input: { kind: "click", target: "submit-button" } },
          { tool: "act", input: { kind: "click", target: "confirm-button" } },
        ],
      },
      snapshot,
    );
    const done = await runner.runTask(created.id, CLIENT);
    expect(done.status).toBe("done");
    expect(calls).toHaveLength(2);
    const again = await runner.runTask(created.id, CLIENT);
    expect(again.status).toBe("done");
    const resumed = await runner.resumeTask(created.id, CLIENT, { ...snapshot });
    expect(resumed.status).toBe("done");
    expect(calls).toHaveLength(2);
    expect(again.steps[0].outputSummary).toBe("ok 0");
  });

  it("output summaries are truncated to 500 chars and checkpoints audit in order", async () => {
    const { runner, store, audit } = makeRunner({
      executor: async () => ({ outputSummary: "x".repeat(1000) }),
    });
    const created = await runner.createTask(
      { goal: "long outputs", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(3) },
      snapshot,
    );
    const finished = await runner.runTask(created.id, CLIENT);
    expect(finished.status).toBe("done");
    expect(finished.steps.every((s) => s.outputSummary.length === 500)).toBe(true);
    expect(store.snapshot()[0].steps.every((s) => s.outputSummary.length === 500)).toBe(true);
    const stepDone = audit.filter((e) => e.kind === "task.step-done");
    expect(stepDone.map((e) => e.stepIndex)).toEqual([0, 1, 2]);
    expect(stepDone.every((e) => e.taskId === created.id)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("xxxx");
  });
});

describe("unknown steps and re-observation", () => {
  it("a generic failure marks the step unknown and pauses; reobserve=true marks done without executing", async () => {
    let fail = true;
    const { runner, calls } = makeRunner({
      executor: async (_tool, _input, ctx: { stepIndex: number }) => {
        calls.push({ tool: "act", input: {}, stepIndex: ctx.stepIndex });
        if (fail) throw new Error("something odd happened");
        return { outputSummary: "recovered" };
      },
      reobserve: async () => ({ effectObserved: true, summary: "effect already happened" }),
    });
    const created = await runner.createTask(
      { goal: "flaky click", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { target: "buy" } }] },
      snapshot,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.steps[0].state).toBe("unknown");
    expect(paused.pauseReason).toBe("unknown-step");
    expect(calls).toHaveLength(1);

    const resolved = await runner.resolveUnknown(created.id, 0);
    expect(resolved.status).toBe("done");
    expect(resolved.steps[0].state).toBe("done");
    expect(resolved.steps[0].outputSummary).toBe("effect already happened");
    expect(calls).toHaveLength(1);
  });

  it("reobserve=false re-executes exactly once; without reobserve it pauses and does not execute", async () => {
    let fail = true;
    const { runner, calls } = makeRunner({
      executor: async (_tool, _input, ctx: { stepIndex: number }) => {
        calls.push({ tool: "act", input: {}, stepIndex: ctx.stepIndex });
        if (fail) throw new Error("bridge dropped mid-click");
        return { outputSummary: "clicked on retry" };
      },
      reobserve: async () => ({ effectObserved: false, summary: "no effect seen" }),
    });
    const created = await runner.createTask(
      { goal: "retry once", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { target: "save" } }] },
      snapshot,
    );
    await runner.runTask(created.id, CLIENT);
    expect(calls).toHaveLength(1);
    fail = false;
    const resolved = await runner.resolveUnknown(created.id, 0);
    expect(resolved.steps[0].state).toBe("done");
    expect(resolved.steps[0].outputSummary).toBe("clicked on retry");
    expect(calls).toHaveLength(2);

    const { runner: runner2, calls: calls2 } = makeRunner();
    const created2 = await runner2.createTask(
      { goal: "no reobserve", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { target: "x" } }] },
      snapshot,
    );
    await runner2.markStepUnknown(created2.id, 0, "bridge dropped");
    const stillPaused = await runner2.resolveUnknown(created2.id, 0);
    expect(stillPaused.status).toBe("paused");
    expect(stillPaused.pauseReason).toBe("reobserve-unavailable");
    expect(stillPaused.steps[0].state).toBe("unknown");
    expect(calls2).toHaveLength(0);
  });
});

describe("tab gates and per-tab serialisation", () => {
  it("pauses with tab-closed and tab-navigated-externally, and lets navigate tools through", async () => {
    const { runner, calls } = makeRunner({
      tabChecker: async (tabId) => {
        if (tabId === 7) return { exists: false, url: null };
        if (tabId === 8) return { exists: true, url: "https://elsewhere.example/" };
        return { exists: true, url: "https://start.example/" };
      },
    });
    const closed = await runner.createTask(
      { goal: "closed", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { tabId: 7, url: "https://start.example/" } }] },
      snapshot,
    );
    const closedView = await runner.runTask(closed.id, CLIENT);
    expect(closedView.status).toBe("paused");
    expect(closedView.pauseReason).toBe("tab-closed");
    expect(closedView.steps[0].state).toBe("pending");
    expect(calls).toHaveLength(0);

    const navigated = await runner.createTask(
      { goal: "navigated", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { tabId: 8, url: "https://start.example/" } }] },
      snapshot,
    );
    const navigatedView = await runner.runTask(navigated.id, CLIENT);
    expect(navigatedView.status).toBe("paused");
    expect(navigatedView.pauseReason).toBe("tab-navigated-externally");
    expect(navigatedView.steps[0].state).toBe("pending");
    expect(calls).toHaveLength(0);

    // A navigate tool on a moved tab is the task's own navigation, not an external one.
    const { runner: runner2, calls: calls2 } = makeRunner({
      tabChecker: async () => ({ exists: true, url: "https://elsewhere.example/" }),
      isConsequential: () => true,
    });
    const nav = await runner2.createTask(
      { goal: "navigate", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.navigate", input: { tabId: 8, url: "https://start.example/" } }] },
      snapshot,
    );
    const navView = await runner2.runTask(nav.id, CLIENT);
    expect(navView.status).toBe("done");
    expect(calls2).toHaveLength(1);

    // Non-consequential steps never pause on navigation.
    const { runner: runner3, calls: calls3 } = makeRunner({
      tabChecker: async () => ({ exists: true, url: "https://elsewhere.example/" }),
    });
    const read = await runner3.createTask(
      { goal: "read moved tab", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: { tabId: 8, url: "https://start.example/" } }] },
      snapshot,
    );
    expect((await runner3.runTask(read.id, CLIENT)).status).toBe("done");
    expect(calls3).toHaveLength(1);
  });

  it("serialises consequential steps on the same tab across concurrent tasks", async () => {
    const resolvers: Array<() => void> = [];
    const { runner, calls } = makeRunner({
      executor: async (_tool, _input, ctx: { stepIndex: number }) => {
        calls.push({ tool: "act", input: {}, stepIndex: ctx.stepIndex });
        return new Promise<{ outputSummary: string }>((resolve) => {
          resolvers.push(() => resolve({ outputSummary: "clicked" }));
        });
      },
    });
    const a = await runner.createTask(
      { goal: "a", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { tabId: 7 } }] },
      snapshot,
    );
    const b = await runner.createTask(
      { goal: "b", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: { tabId: 7 } }] },
      snapshot,
    );
    const runA = runner.runTask(a.id, CLIENT);
    await flush();
    expect(calls).toHaveLength(1);
    const runB = runner.runTask(b.id, CLIENT);
    await flush();
    expect(calls).toHaveLength(1);
    resolvers[0]();
    await flush();
    expect(calls).toHaveLength(2);
    resolvers[1]();
    expect((await runA).status).toBe("done");
    expect((await runB).status).toBe("done");
  });
});

describe("rate limits, approvals, retries and honest endings", () => {
  it("rate-limit pauses with resumeAfterMs, does not fail the step or count the attempt, and caps the wait", async () => {
    let mode: "limit" | "limit-huge" | "ok" = "limit";
    const { runner, calls } = makeRunner({
      executor: async () => {
        calls.push({ tool: "act", input: {}, stepIndex: 0 });
        if (mode === "limit") throw { code: "RATE_LIMITED", message: "rate_limited", retryAfterMs: 5000 };
        if (mode === "limit-huge") throw { status: 429, message: "too many requests", retryAfterMs: 999999 };
        return { outputSummary: "done after wait" };
      },
    });
    const created = await runner.createTask(
      { goal: "limited", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: {} }] },
      snapshot,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("rate-limited");
    expect(paused.resumeAfterMs).toBe(5000);
    expect(paused.steps[0].state).toBe("pending");
    expect(paused.steps[0].attempts).toBe(0);
    expect(calls).toHaveLength(1);

    mode = "limit-huge";
    const pausedAgain = await runner.runTask(created.id, CLIENT);
    expect(pausedAgain.resumeAfterMs).toBe(60000);
    expect(pausedAgain.steps[0].attempts).toBe(0);

    mode = "ok";
    const finished = await runner.runTask(created.id, CLIENT);
    expect(finished.status).toBe("done");
    expect(finished.resumeAfterMs).toBeNull();
  });

  it("approval-required waits, and a later run re-runs that step (approval itself is external)", async () => {
    let needApproval = true;
    const { runner, calls } = makeRunner({
      executor: async () => {
        calls.push({ tool: "act", input: {}, stepIndex: 0 });
        if (needApproval) throw { code: "APPROVAL_REQUIRED", message: "approval required" };
        return { outputSummary: "approved and clicked" };
      },
    });
    const created = await runner.createTask(
      { goal: "needs approval", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "act", input: {} }] },
      snapshot,
    );
    const waiting = await runner.runTask(created.id, CLIENT);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.steps[0].state).toBe("waiting_approval");
    needApproval = false;
    const finished = await runner.runTask(created.id, CLIENT);
    expect(finished.status).toBe("done");
    expect(calls).toHaveLength(2);
  });

  it("retryable errors retry up to 2 attempts then pause; a later run can still succeed", async () => {
    let failuresLeft = 2;
    const { runner, calls } = makeRunner({
      executor: async () => {
        calls.push({ tool: "tabs.list", input: {}, stepIndex: 0 });
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw { code: "TIMEOUT", message: "timed out" };
        }
        return { outputSummary: "eventually read" };
      },
    });
    const created = await runner.createTask(
      { goal: "flaky read", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {} }] },
      snapshot,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("retry-exhausted");
    expect(paused.steps[0].state).toBe("pending");
    expect(paused.steps[0].attempts).toBe(2);
    expect(calls).toHaveLength(2);
    const finished = await runner.runTask(created.id, CLIENT);
    expect(finished.status).toBe("done");
    expect(calls).toHaveLength(3);
  });

  it("non-retryable failures end partial when something is done, failed when nothing is", async () => {
    const { runner } = makeRunner({
      executor: async (_tool, _input, ctx: { stepIndex: number }) => {
        if (ctx.stepIndex === 1) throw { code: "PERMISSION_DENIED", message: "not allowed" };
        return { outputSummary: `ok ${ctx.stepIndex}` };
      },
    });
    const partial = await runner.createTask(
      { goal: "partial", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(3) },
      snapshot,
    );
    const partialView = await runner.runTask(partial.id, CLIENT);
    expect(partialView.status).toBe("partial");
    expect(partialView.resultSummary).toContain("Done steps: [0].");
    expect(partialView.resultSummary).toContain("Undone steps: [1, 2].");
    expect(partialView.resultSummary).toContain("Failed step 1: PERMISSION_DENIED");

    const { runner: runner2 } = makeRunner({
      executor: async () => {
        throw { code: "INVALID_INPUT", message: "bad input" };
      },
    });
    const failed = await runner2.createTask(
      { goal: "failed", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(2) },
      snapshot,
    );
    const failedView = await runner2.runTask(failed.id, CLIENT);
    expect(failedView.status).toBe("failed");
    expect(failedView.resultSummary).toContain("Done steps: [].");
    expect(failedView.resultSummary).toContain("Undone steps: [0, 1].");
    expect(failedView.status).not.toBe("done");
  });
});

describe("policy, client and scope re-checks on resume", () => {
  it("rejects a different client and a weaker scope, and pauses on a policy version change", async () => {
    const { runner, calls } = makeRunner();
    const created = await runner.createTask(
      { goal: "guarded", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(2) },
      snapshot,
    );
    await expect(runner.resumeTask(created.id, "client-b", { ...snapshot })).rejects.toThrow(/different client/);
    await expect(runner.resumeTask(created.id, CLIENT, { ...snapshot, scope: "read:tools" })).rejects.toThrow(/weaker/);
    const policyPaused = await runner.resumeTask(created.id, CLIENT, { ...snapshot, policyVersion: 2 });
    expect(policyPaused.status).toBe("paused");
    expect(policyPaused.pauseReason).toBe("policy-changed");
    expect(calls).toHaveLength(0);

    // The policy change is now the acknowledged baseline: a resume
    // under the new policy (with the runner's policy snapshot updated
    // to match) proceeds.
    snapshot = { ...snapshot, policyVersion: 2 };
    const finished = await runner.resumeTask(created.id, CLIENT, { ...snapshot });
    expect(finished.status).toBe("done");
    expect(calls).toHaveLength(2);
  });
});

describe("budget and cancel", () => {
  it("pauses with budget-exceeded when elapsed time passes the total budget before a step", async () => {
    const { runner, calls } = makeRunner({
      executor: async (_tool, _input, ctx: { stepIndex: number }) => {
        nowVal += 400;
        calls.push({ tool: "tabs.list", input: {}, stepIndex: ctx.stepIndex });
        return { outputSummary: `ok ${ctx.stepIndex}` };
      },
    });
    const created = await runner.createTask(
      { goal: "budgeted", clientId: CLIENT, browserSessionId: SESSION, steps: readSteps(10), totalBudgetMs: 1000 },
      snapshot,
    );
    const paused = await runner.runTask(created.id, CLIENT);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("budget-exceeded");
    expect(doneIndices(paused)).toEqual([0, 1, 2]);
    expect(calls).toHaveLength(3);
  });

  it("cancel at step 7 reports done 0-5 and undone 6-9 with compensations, never throwing on compensation failure", async () => {
    const store = createMemoryTaskStore();
    const compensated: number[] = [];
    let taskId = "";
    let pausedOnce = false;
    const interruptingProgress = (view: TaskView) => {
      if (!pausedOnce && view.id === taskId && doneIndices(view).length === 6) {
        pausedOnce = true;
        const all = store.snapshot();
        const found = all.find((t) => t.id === taskId);
        if (found) {
          found.status = "paused";
          found.pauseReason = "test-pause-before-cancel";
          void store.save(all);
        }
      }
    };
    const runner = new TaskRunner({
      store,
      executeStep: async (_tool, _input, ctx: { stepIndex: number }) => ({ outputSummary: `ok ${ctx.stepIndex}` }),
      executeCompensation: async (step) => {
        compensated.push(step.index);
        if (step.index === 0) throw new Error("compensation failed");
      },
      audit: () => undefined,
      progress: interruptingProgress,
      policySnapshot: () => ({ ...snapshot }),
      now: () => nowVal,
      generateId: nextId,
    });
    const created = await runner.createTask(
      {
        goal: "cancel me",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: readSteps(10).map((s) => ({ ...s, compensation: { kind: "close-tab" as const, description: "close the tab this step opened" } })),
      },
      snapshot,
    );
    taskId = created.id;
    const paused = await runner.runTask(taskId, CLIENT);
    expect(doneIndices(paused)).toEqual([0, 1, 2, 3, 4, 5]);

    const cancelled = await runner.cancelTask(taskId, CLIENT);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resultSummary).toContain("Done steps: [0, 1, 2, 3, 4, 5].");
    expect(cancelled.resultSummary).toContain("Undone steps: [6, 7, 8, 9].");
    expect(compensated).toEqual([5, 4, 3, 2, 1, 0]);
    expect(cancelled.resultSummary).toContain("Compensation for step 5: close-tab — executed.");
    expect(cancelled.resultSummary).toContain("Compensation for step 0: close-tab — manual:");
  });
});
