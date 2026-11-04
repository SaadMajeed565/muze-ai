/**
 * Plan approval is removed: there is no run-start plan gate in any
 * policy mode. A bounded consequential plan runs straight into the
 * loop, where each consequential step faces the normal per-step
 * approval path. A task left waiting by the old gate (legacy
 * pauseReason below, kept only as stored-record fixture data) must
 * be resumable and then run.
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

function makeRunner(mode: string, executeStep?: (tool: string) => Promise<{ outputSummary: string }>) {
  const calls: string[] = [];
  const runner = new TaskRunner({
    store: createMemoryTaskStore(),
    executeStep: executeStep ?? (async (tool: string) => {
      calls.push(tool);
      return { outputSummary: "ok" };
    }),
    audit: () => undefined,
    progress: () => undefined,
    policySnapshot: () => snapshotFor(mode),
    now: () => nowVal,
    generateId: nextId,
  });
  return { runner, calls };
}

const STEPS = [{ tool: "dom.click", input: { url: "https://example.com/page" } }];
const BOUNDS = { allowedDomains: ["example.com"] };

describe("no plan gate", () => {
  it("a bounded consequential plan runs under default and unrestricted without approval", async () => {
    for (const mode of ["default", "unrestricted"]) {
      const { runner, calls } = makeRunner(mode);
      const created = await runner.createTask(
        { goal: "click once", clientId: CLIENT, browserSessionId: SESSION, steps: STEPS, planBounds: BOUNDS, start: true },
        snapshotFor(mode),
      );
      expect(created.status).toBe("done");
      expect(calls).toEqual(["dom.click"]);
    }
  });

  it("a task paused for the old gate reason resumes and runs", async () => {
    const { runner, calls } = makeRunner("default");
    const created = await runner.createTask(
      { goal: "click once", clientId: CLIENT, browserSessionId: SESSION, steps: STEPS, planBounds: BOUNDS, start: false },
      snapshotFor("default"),
    );
    const paused = await runner.pauseTask(created.id, CLIENT, "plan-approval-required");
    expect(paused.status).toBe("paused");
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("default"));
    expect(resumed.status).toBe("done");
    expect(calls).toEqual(["dom.click"]);
  });

  it("per-step approval still pauses a consequential step, with the step reason", async () => {
    let allow = false;
    const error = new Error("approval required") as Error & { code: string };
    error.code = "APPROVAL_REQUIRED";
    const { runner, calls } = makeRunner("default", async (tool: string) => {
      calls.push(tool);
      if (!allow) throw error;
      return { outputSummary: "ok" };
    });
    const created = await runner.createTask(
      { goal: "click once", clientId: CLIENT, browserSessionId: SESSION, steps: STEPS, planBounds: BOUNDS, start: true },
      snapshotFor("default"),
    );
    expect(created.status).toBe("waiting_approval");
    expect(created.pauseReason).toBe("approval-required");
    allow = true;
    const resumed = await runner.resumeTask(created.id, CLIENT, snapshotFor("default"));
    expect(resumed.status).toBe("done");
    expect(calls).toEqual(["dom.click", "dom.click"]);
  });
});
