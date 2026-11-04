/**
 * tasks.appendSteps: follow-up work for a job that already has a task
 * appends to that task's plan instead of becoming a second task.
 *
 * The create call returns the task id (TaskView.id); the AI reuses
 * that id here. Appended steps queue behind unexecuted steps as
 * ordinary pending records — no pre-approval, no special flag — so
 * they run through the identical loop, with the same per-step
 * executor/policy/approval gates and the same taskId attribution into
 * activity/history, as created steps. A failed task reopens as paused
 * on append (resume runs the retry steps in the same record); done,
 * cancelled, and partial tasks reject; a paused/waiting task keeps
 * appended steps waiting with the rest.
 */
import { describe, expect, it } from "vitest";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
} from "../libs/tasks/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";

let nowVal = 1_000_000;
let idCounter = 9000;

function nextId(): string {
  idCounter += 1;
  return `task_${idCounter.toString(16).padStart(32, "0")}`;
}

function snapshotFor(mode: string): PolicySnapshot {
  return { policyVersion: 1, mode, clientId: CLIENT, scope: "call:tools" };
}

interface ExecutedStep {
  tool: string;
  taskId: string | undefined;
  stepIndex: number | undefined;
}

function makeRunner(executeStep: (tool: string, input: unknown, ctx: Record<string, unknown>) => Promise<{ outputSummary: string }>) {
  return new TaskRunner({
    store: createMemoryTaskStore(),
    executeStep: executeStep as never,
    audit: () => undefined,
    progress: () => undefined,
    policySnapshot: () => snapshotFor("unrestricted"),
    now: () => nowVal,
    generateId: nextId,
  });
}

const OBSERVE = { tool: "observe", input: { include: ["text"] } };
const CLICK = { tool: "dom.click", input: { ref: "r1" } };

describe("tasks.appendSteps", () => {
  it("create returns the id and appending to a running task executes the new steps under the same taskId", async () => {
    const executed: ExecutedStep[] = [];
    let releaseFirst!: () => void;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const runner = makeRunner(async (tool, _input, ctx) => {
      executed.push({ tool, taskId: ctx.taskId as string | undefined, stepIndex: ctx.stepIndex as number | undefined });
      if (executed.length === 1) {
        resolveFirstStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { outputSummary: "ok" };
    });
    // With no plan gate, the run starts at once and blocks on the
    // first step's deferred executeStep.
    const runPromise = runner.createTask(
      { goal: "read then click", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE, CLICK], start: true },
      snapshotFor("unrestricted"),
    );
    await firstStarted;
    const [running] = await runner.listTasks(CLIENT);
    expect(running).toBeDefined();
    expect(running!.status).toBe("running");
    // The id the create call will return is the running task's id:
    // appending with it must not create a second task.
    const appended = await runner.appendSteps(running!.id, CLIENT, [OBSERVE]);
    expect(appended.id).toBe(running!.id);
    expect(appended.steps).toHaveLength(3);
    expect(appended.steps.filter((s) => s.state === "done")).toHaveLength(0);
    expect((await runner.listTasks(CLIENT)).length).toBe(1);
    releaseFirst();
    const finished = await runPromise;
    expect(finished.status).toBe("done");
    expect(finished.steps).toHaveLength(3);
    expect(finished.steps.filter((s) => s.state === "done")).toHaveLength(3);
    // All three steps ran through the same loop, each attributed to
    // the one task — including the step appended mid-run.
    expect(executed.map((s) => s.tool)).toEqual(["observe", "dom.click", "observe"]);
    expect(executed.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    for (const step of executed) expect(step.taskId).toBe(running!.id);
  });

  it("appending to a paused task queues the steps; they wait with the rest", async () => {
    const executed: string[] = [];
    const runner = makeRunner(async (tool) => {
      executed.push(tool);
      return { outputSummary: "ok" };
    });
    const created = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: false },
      snapshotFor("unrestricted"),
    );
    await runner.pauseTask(created.id, CLIENT, "test pause");
    const appended = await runner.appendSteps(created.id, CLIENT, [CLICK]);
    expect(appended.status).toBe("paused");
    expect(appended.steps).toHaveLength(2);
    expect(appended.steps.filter((s) => s.state === "done")).toHaveLength(0);
    expect(executed).toEqual([]);
    // Resuming runs the original step and the appended one, in order.
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("unrestricted"));
    expect(resumed.status).toBe("done");
    expect(resumed.steps.filter((s) => s.state === "done")).toHaveLength(2);
    expect(executed).toEqual(["observe", "dom.click"]);
  });

  it("appending to a waiting_approval task joins the pending plan without bypassing approval", async () => {
    const executed: string[] = [];
    let allow = false;
    const runner = new TaskRunner({
      store: createMemoryTaskStore(),
      executeStep: (async (tool: string) => {
        executed.push(tool);
        // Simulate the executor's per-step approval gate.
        if (!allow) {
          const error = new Error("approval required") as Error & { code: string };
          error.code = "APPROVAL_REQUIRED";
          throw error;
        }
        return { outputSummary: "ok" };
      }) as never,
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => snapshotFor("default"),
      now: () => nowVal,
      generateId: nextId,
    });
    // A consequential step facing the per-step approval gate stops
    // the task at waiting_approval before it completes.
    const created = await runner.createTask(
      {
        goal: "submit a form",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "forms.submit", input: { formRef: "r1" } }],
        planBounds: { allowedDomains: ["example.com"] },
        start: true,
      },
      snapshotFor("default"),
    );
    expect(created.status).toBe("waiting_approval");
    expect(created.pauseReason).toBe("approval-required");
    const appended = await runner.appendSteps(created.id, CLIENT, [OBSERVE]);
    expect(appended.status).toBe("waiting_approval");
    expect(appended.steps).toHaveLength(2);
    expect(appended.steps[1].state).toBe("pending");
    // The appended step did not run while approval was outstanding.
    expect(executed).toEqual(["forms.submit"]);
    allow = true;
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("default"));
    expect(resumed.status).toBe("done");
    expect(executed).toEqual(["forms.submit", "forms.submit", "observe"]);
  });

  it("rejects appends to a done task and leaves the plan unchanged", async () => {
    const runner = makeRunner(async () => ({ outputSummary: "ok" }));
    const created = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: true },
      snapshotFor("unrestricted"),
    );
    expect(created.status).toBe("done");
    await expect(runner.appendSteps(created.id, CLIENT, [CLICK])).rejects.toThrow(/is done and cannot accept new steps/);
    const after = await runner.getTask(created.id, CLIENT);
    expect(after.steps).toHaveLength(1);
    expect(after.steps.filter((s) => s.state === "done")).toHaveLength(1);
  });

  it("appending to a failed task reopens it as paused; resume runs the retry steps in the same task", async () => {
    let failNext = true;
    const executed: string[] = [];
    const runner = makeRunner(async (tool) => {
      executed.push(tool);
      if (failNext) {
        failNext = false;
        // A non-retryable code is what turns a step error into a
        // failed task; a plain uncoded error pauses as unknown.
        throw Object.assign(new Error("tool not found"), { code: "TOOL_NOT_FOUND" });
      }
      return { outputSummary: "ok" };
    });
    const failed = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: true },
      snapshotFor("unrestricted"),
    );
    expect(failed.status).toBe("failed");
    expect(failed.steps[0].state).toBe("failed");
    expect(failed.completedAt).not.toBeNull();
    expect(failed.finalReport).not.toBeNull();
    // The retry appends to the SAME task instead of becoming a second
    // task: the append reopens it as paused and clears the stale
    // completion markers, while the failed step stays failed.
    const revived = await runner.appendSteps(failed.id, CLIENT, [CLICK]);
    expect(revived.id).toBe(failed.id);
    expect(revived.status).toBe("paused");
    expect(revived.completedAt).toBeNull();
    expect(revived.finalReport).toBeNull();
    expect(revived.steps).toHaveLength(2);
    expect(revived.steps[0].state).toBe("failed");
    expect(revived.steps[1]).toMatchObject({ tool: "dom.click", state: "pending" });
    expect((await runner.listTasks(CLIENT)).length).toBe(1);
    // Resume runs the retry step in the same record. The task ends
    // partial, honestly: the original step is still failed (failed
    // steps are never re-run), while the retry step reaches done.
    const resumed = await runner.resumeTask(failed.id, CLIENT, snapshotFor("unrestricted"));
    expect(resumed.id).toBe(failed.id);
    expect(resumed.steps[1].state).toBe("done");
    expect(resumed.status).toBe("partial");
    expect(executed).toEqual(["observe", "dom.click"]);
  });

  it("still rejects appends to cancelled and partial tasks and leaves the plan unchanged", async () => {
    const runner = makeRunner(async () => ({ outputSummary: "ok" }));
    const created = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: false },
      snapshotFor("unrestricted"),
    );
    await runner.cancelTask(created.id, CLIENT);
    expect((await runner.getTask(created.id, CLIENT)).status).toBe("cancelled");
    await expect(runner.appendSteps(created.id, CLIENT, [CLICK])).rejects.toThrow(/is cancelled and cannot accept new steps/);
    expect((await runner.getTask(created.id, CLIENT)).steps).toHaveLength(1);

    // Partial: first step done, second fails with a non-retryable code.
    let calls = 0;
    const runner2 = makeRunner(async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("second step blew up"), { code: "TOOL_NOT_FOUND" });
      return { outputSummary: "ok" };
    });
    const partial = await runner2.createTask(
      { goal: "two steps", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE, CLICK], start: true },
      snapshotFor("unrestricted"),
    );
    expect(partial.status).toBe("partial");
    await expect(runner2.appendSteps(partial.id, CLIENT, [OBSERVE])).rejects.toThrow(/is partial and cannot accept new steps/);
    expect((await runner2.getTask(partial.id, CLIENT)).steps).toHaveLength(2);
  });

  it("a failed-task append still enforces caps and client ownership", async () => {
    let failNext = true;
    const runner = makeRunner(async () => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("boom"), { code: "TOOL_NOT_FOUND" });
      }
      return { outputSummary: "ok" };
    });
    const failed = await runner.createTask(
      { goal: "bounded fail", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], planBounds: { maxSteps: 1 }, start: true },
      snapshotFor("unrestricted"),
    );
    expect(failed.status).toBe("failed");
    await expect(runner.appendSteps(failed.id, CLIENT, [CLICK])).rejects.toThrow(/plan bounds maxSteps/);
    await expect(runner.appendSteps(failed.id, "client-b", [CLICK])).rejects.toThrow(/belongs to a different client/);
    const after = await runner.getTask(failed.id, CLIENT);
    expect(after.status).toBe("failed");
    expect(after.steps).toHaveLength(1);
  });

  it("rejects malformed steps and leaves the plan unchanged", async () => {
    const runner = makeRunner(async () => ({ outputSummary: "ok" }));
    const created = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: false },
      snapshotFor("unrestricted"),
    );
    await expect(runner.appendSteps(created.id, CLIENT, [])).rejects.toThrow(/non-empty array/);
    await expect(runner.appendSteps(created.id, CLIENT, [{ tool: "", input: {} } as never])).rejects.toThrow(
      /must have a non-empty tool name/,
    );
    await expect(runner.appendSteps(created.id, CLIENT, [{ tool: "observe" } as never])).rejects.toThrow(
      /input must be an object/,
    );
    const after = await runner.getTask(created.id, CLIENT);
    expect(after.steps).toHaveLength(1);
  });

  it("rejects an append that would overflow the plan cap, leaving the plan unchanged", async () => {
    const runner = makeRunner(async () => ({ outputSummary: "ok" }));
    const created = await runner.createTask(
      { goal: "bounded", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], planBounds: { maxSteps: 1 }, start: false },
      snapshotFor("unrestricted"),
    );
    await expect(runner.appendSteps(created.id, CLIENT, [CLICK])).rejects.toThrow(/plan bounds maxSteps/);
    const after = await runner.getTask(created.id, CLIENT);
    expect(after.steps).toHaveLength(1);
  });

  it("appended steps are ordinary pending steps: no pre-approval, same shape as created ones", async () => {
    const runner = makeRunner(async () => ({ outputSummary: "ok" }));
    const created = await runner.createTask(
      { goal: "read once", clientId: CLIENT, browserSessionId: SESSION, steps: [OBSERVE], start: false },
      snapshotFor("unrestricted"),
    );
    const appended = await runner.appendSteps(created.id, CLIENT, [CLICK]);
    // The appended step is stored pending with the next index, exactly
    // like a created step — so when the loop runs it, it faces the
    // same per-step executor/policy/approval gates; nothing about the
    // append pre-approves it.
    expect(appended.steps[1]).toMatchObject({ tool: "dom.click", state: "pending" });
    expect(appended.steps[0]).toMatchObject({ tool: "observe", state: "pending" });
  });
});
