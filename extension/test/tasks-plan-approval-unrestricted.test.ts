/**
 * Plan-approval gate vs policy mode: the Unrestricted promise is
 * "every tool runs with no confirmation step", but the run-start
 * plan gate used to ignore policy entirely — even an Unrestricted
 * planned task stopped for plan approval. The gate must now skip
 * when the current policy mode is "unrestricted", and behave exactly
 * as before for Balanced ("default") and Restricted.
 *
 * Note on the key: PolicySnapshot carries mode, not approvalMode,
 * so the gate keys on mode. That is also the correct semantics:
 * Restricted's approvalMode is "never" too (it allows nothing
 * consequential at all), so an approvalMode-only key would wrongly
 * skip the gate for Restricted.
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

interface Harness {
  runner: TaskRunner;
  calls: string[];
  modeRef: { mode: string };
}

function makeHarness(mode: string): Harness {
  const calls: string[] = [];
  const modeRef = { mode };
  const runner = new TaskRunner({
    store: createMemoryTaskStore(),
    executeStep: async (tool: string) => {
      calls.push(tool);
      return { outputSummary: "ok" };
    },
    audit: () => undefined,
    progress: () => undefined,
    policySnapshot: () => snapshotFor(modeRef.mode),
    now: () => nowVal,
    generateId: nextId,
  });
  return { runner, calls, modeRef };
}

const STEPS = [{ tool: "dom.click", input: { url: "https://example.com/page" } }];
const BOUNDS = { allowedDomains: ["example.com"] };

async function createPlanTask(
  runner: TaskRunner,
  snapshot: PolicySnapshot,
  start: boolean,
) {
  return runner.createTask(
    {
      goal: "click once",
      clientId: CLIENT,
      browserSessionId: SESSION,
      steps: STEPS,
      planBounds: BOUNDS,
      start,
    },
    snapshot,
  );
}

describe("plan-approval gate honors the policy mode", () => {
  it("unrestricted: a bounded consequential plan runs without plan approval", async () => {
    const { runner, calls } = makeHarness("unrestricted");
    const created = await createPlanTask(runner, snapshotFor("unrestricted"), true);
    expect(created.status).toBe("done");
    expect(calls).toEqual(["dom.click"]);
  });

  it("balanced: the identical plan still gates to waiting_approval", async () => {
    const { runner, calls } = makeHarness("default");
    const created = await createPlanTask(runner, snapshotFor("default"), true);
    expect(created.status).toBe("waiting_approval");
    expect(created.pauseReason).toBe("plan-approval-required");
    expect(calls).toHaveLength(0);
  });

  it("restricted: the identical plan still gates to waiting_approval", async () => {
    const { runner, calls } = makeHarness("restricted");
    const created = await createPlanTask(runner, snapshotFor("restricted"), true);
    expect(created.status).toBe("waiting_approval");
    expect(created.pauseReason).toBe("plan-approval-required");
    expect(calls).toHaveLength(0);
  });

  it("resume: a paused plan-approval-required task runs under unrestricted without approval", async () => {
    const { runner, calls } = makeHarness("unrestricted");
    const created = await createPlanTask(runner, snapshotFor("unrestricted"), false);
    const paused = await runner.pauseTask(created.id, CLIENT, "plan-approval-required");
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("plan-approval-required");
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("unrestricted"));
    expect(resumed.status).toBe("done");
    expect(calls).toEqual(["dom.click"]);
  });

  it("level flip: a balanced-gated task runs after flipping to unrestricted and resuming twice", async () => {
    const { runner, calls, modeRef } = makeHarness("default");
    const created = await createPlanTask(runner, snapshotFor("default"), true);
    expect(created.status).toBe("waiting_approval");
    expect(created.pauseReason).toBe("plan-approval-required");
    // Flip the live policy to unrestricted, as the dashboard level picker does.
    modeRef.mode = "unrestricted";
    const first = await runner.resumeTask(created.id, CLIENT, snapshotFor("unrestricted"));
    expect(first.status).toBe("paused");
    expect(first.pauseReason).toBe("policy-changed");
    expect(calls).toHaveLength(0);
    const second = await runner.resumeTask(created.id, CLIENT, snapshotFor("unrestricted"));
    expect(second.status).toBe("done");
    expect(calls).toEqual(["dom.click"]);
  });

  it("balanced: approvePlan then resume still runs the plan (flow unchanged)", async () => {
    const { runner, calls } = makeHarness("default");
    const created = await createPlanTask(runner, snapshotFor("default"), true);
    expect(created.status).toBe("waiting_approval");
    const approved = await runner.approvePlan(created.id, CLIENT, { source: "dashboard" });
    expect(approved.status).toBe("paused");
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("default"));
    expect(resumed.status).toBe("done");
    expect(calls).toEqual(["dom.click"]);
  });
});
