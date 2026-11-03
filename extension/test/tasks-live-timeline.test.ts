/**
 * Live timeline: the running step must reach the persisted task list
 * (and fire a progress notification) the moment it STARTS, not only
 * when it finishes. Previously the runner set step.state = "running"
 * in memory and awaited execution with no checkpoint and no progress
 * call, so the dashboard timeline could only ever show finished
 * steps — never what the task is doing right now.
 */
import { describe, expect, it } from "vitest";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskView,
} from "../libs/tasks/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";
const SNAPSHOT: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" };

let nowVal = 1_000_000;
let idCounter = 5000;

function nextId(): string {
  idCounter += 1;
  return `task_${idCounter.toString(16).padStart(32, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  runner: TaskRunner;
  progressViews: TaskView[];
  enteredPromise: Promise<void>;
  gate: ReturnType<typeof deferred<{ outputSummary: string }>>;
}

function makeHarness(): Harness {
  const store = createMemoryTaskStore();
  const progressViews: TaskView[] = [];
  const gate = deferred<{ outputSummary: string }>();
  let enterResolve!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    enterResolve = r;
  });
  const runner = new TaskRunner({
    store,
    executeStep: async () => {
      enterResolve();
      return gate.promise;
    },
    audit: () => undefined,
    progress: (view) => {
      progressViews.push(view);
    },
    policySnapshot: () => ({ ...SNAPSHOT }),
    now: () => nowVal,
    generateId: nextId,
  });
  return { runner, progressViews, enteredPromise, gate };
}

async function createOneStepTask(runner: TaskRunner) {
  return runner.createTask(
    { goal: "live timeline", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {} }] },
    SNAPSHOT,
  );
}

describe("live timeline: step start", () => {
  it("persists the running step into the list view the moment it starts", async () => {
    const { runner, enteredPromise, gate } = makeHarness();
    const created = await createOneStepTask(runner);
    const runPromise = runner.runTask(created.id, CLIENT);
    // The executor is entered only AFTER the step-start checkpoint
    // completes (the checkpoint runs before executeStep is called).
    await enteredPromise;
    const listed = (await runner.listAllTasks()).find((t) => t.id === created.id)!;
    expect(listed.status).toBe("running");
    expect(listed.steps).toHaveLength(1);
    expect(listed.steps[0].state).toBe("running");
    gate.resolve({ outputSummary: "ok 0" });
    const done = await runPromise;
    expect(done.status).toBe("done");
    expect(done.steps[0].state).toBe("done");
  });

  it("fires a progress notification at step start exposing summaries only", async () => {
    const { runner, progressViews, enteredPromise, gate } = makeHarness();
    const created = await createOneStepTask(runner);
    const runPromise = runner.runTask(created.id, CLIENT);
    await enteredPromise;
    const startedView = progressViews.find((v) => v.id === created.id && v.steps[0]?.state === "running");
    expect(startedView).toBeDefined();
    // No raw step input leaks: the view carries summaries only, exactly
    // what the task list already exposes.
    expect(startedView!.steps[0]).not.toHaveProperty("input");
    const listed = (await runner.listAllTasks()).find((t) => t.id === created.id)!;
    expect(startedView!.steps[0].inputSummary).toBe(listed.steps[0].inputSummary);
    expect(startedView!.steps[0].outputSummary).toBe(listed.steps[0].outputSummary);
    gate.resolve({ outputSummary: "ok 0" });
    await runPromise;
  });

  it("a pause issued while a step runs still wins and never resurrects running", async () => {
    const { runner, enteredPromise, gate } = makeHarness();
    const created = await createOneStepTask(runner);
    const runPromise = runner.runTask(created.id, CLIENT);
    await enteredPromise;
    // The step is persisted as running at this point (see test above).
    const mid = (await runner.listAllTasks()).find((t) => t.id === created.id)!;
    expect(mid.steps[0].state).toBe("running");
    const paused = await runner.pauseTask(created.id, CLIENT, "paused");
    expect(paused.status).toBe("paused");
    gate.resolve({ outputSummary: "ok 0" });
    const finished = await runPromise;
    // The pause wins on TASK status, while the step result itself is
    // still recorded (checkpoint merge semantics): this step genuinely
    // completed — the executor resolved — so it is done, and the task
    // stays paused instead of resurrecting to running. Had the abort
    // landed mid-execution, the step would have gone pending via
    // abortPending instead; either way the task never runs again.
    expect(finished.status).toBe("paused");
    expect(finished.steps[0].state).toBe("done");
    const listed = (await runner.listAllTasks()).find((t) => t.id === created.id)!;
    expect(listed.status).toBe("paused");
    expect(listed.steps[0].state).not.toBe("running");
  });

  it("persists every member of a parallel batch as running at launch", async () => {
    const store = createMemoryTaskStore();
    const gate = deferred<{ outputSummary: string }>();
    let enteredCount = 0;
    let allEnteredResolve!: () => void;
    const allEnteredPromise = new Promise<void>((r) => {
      allEnteredResolve = r;
    });
    const runner = new TaskRunner({
      store,
      executeStep: async () => {
        enteredCount += 1;
        if (enteredCount === 2) allEnteredResolve();
        return gate.promise;
      },
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...SNAPSHOT }),
      now: () => nowVal,
      generateId: nextId,
    });
    const created = await runner.createTask(
      {
        goal: "live batch",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {}, independent: true, parallelGroup: 1 },
          { tool: "tabs.list", input: {}, independent: true, parallelGroup: 1 },
        ],
      },
      SNAPSHOT,
    );
    const runPromise = runner.runTask(created.id, CLIENT);
    // Both executors are entered only after the batch step-start
    // checkpoint completes, so the list must show both running.
    await allEnteredPromise;
    const listed = (await runner.listAllTasks()).find((t) => t.id === created.id)!;
    expect(listed.status).toBe("running");
    expect(listed.steps.map((s) => s.state)).toEqual(["running", "running"]);
    gate.resolve({ outputSummary: "ok" });
    const done = await runPromise;
    expect(done.status).toBe("done");
  });
});
