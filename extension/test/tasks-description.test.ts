/**
 * Description-based task model: a task is a goal plus a DESCRIPTION
 * (plain words, a todo list in words), NOT predefined tool+input
 * steps. A task created with zero steps is a record only — it never
 * enters the runner's step loop, starts running, accepts filings by
 * task id, and ends only via tasks.complete. Step tasks can no longer
 * be created through tasks.create: any steps input is rejected with a
 * teachable error. The runner's step machinery stays dormant for old
 * step-task records and a future common-sites update.
 */
import { describe, expect, it } from "vitest";
import { TASK_REQUIRED_MESSAGE, TASKS_CREATE_STEPS_REJECTED_MESSAGE, type ClientIdentity } from "../libs/tool-contracts/index.js";
import { TASK_TOOL_NAMES, taskTools } from "../libs/tool-contracts/schemas/tasks.js";
import { createTestRuntime } from "../libs/testing/index.js";
import type { ActivityEvent } from "../libs/activity.js";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
} from "../libs/tasks/index.js";
import { HostProtocolHandler, type BridgeTransport } from "../src/host-protocol.js";
import type { BridgeHostMessage } from "../libs/tool-contracts/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";
const SNAPSHOT: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" };
const BRIDGE_CLIENT: ClientIdentity = { id: CLIENT, name: "Client A", transport: "remote" };

class FakeTransport implements BridgeTransport {
  readonly messages: BridgeHostMessage[] = [];
  post(message: BridgeHostMessage): void {
    this.messages.push(message);
  }
  last(): BridgeHostMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
}

function makeRunner(stepCalls: string[]) {
  return new TaskRunner({
    store: createMemoryTaskStore(),
    executeStep: async (tool) => {
      stepCalls.push(tool);
      return { outputSummary: "ok" };
    },
    audit: () => undefined,
    progress: () => undefined,
    policySnapshot: () => ({ ...SNAPSHOT }),
    now: () => 1_000_000,
  });
}

function makeHost() {
  const events: ActivityEvent[] = [];
  const stepCalls: string[] = [];
  const runner = makeRunner(stepCalls);
  // Unrestricted: filed actions execute without an approval token,
  // so the test measures filing, not the approval flow.
  const rt = createTestRuntime({
    policy: { mode: "unrestricted" },
    onActivity: (e) => events.push(e),
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
    getTaskPolicySnapshot: () => ({ ...SNAPSHOT, clientId: CLIENT }),
  });
  return { runner, transport, handler, events, stepCalls };
}

type ToolResult = { type: string; result: Record<string, unknown> };
type ToolError = { type: string; error: { code: string; message: string } };

async function createDescriptionTask(handler: HostProtocolHandler, transport: FakeTransport): Promise<Record<string, unknown>> {
  await handler.handle({
    type: "tool.call",
    id: "c1",
    tool: "tasks.create",
    input: { goal: "Check the repo", description: "Open the repo page, look around, and report what you find." },
    client: BRIDGE_CLIENT,
  });
  const created = transport.last() as ToolResult;
  expect(created.type).toBe("tool.result");
  return created.result;
}

describe("description tasks (zero steps)", () => {
  it("create without steps succeeds, starts running, stores the description, and never enters the runner", async () => {
    const { runner, stepCalls } = makeHost();
    const created = await runner.createTask(
      { goal: "Check the repo", description: "Open the repo page and report.", clientId: CLIENT, browserSessionId: SESSION },
      SNAPSHOT,
    );
    expect(created.status).toBe("running");
    expect(created.steps).toEqual([]);
    expect(stepCalls).toEqual([]);
    // The record is retrievable with its description, still running.
    const fetched = await runner.getTask(created.id, CLIENT);
    expect(fetched.status).toBe("running");
    expect(fetched.description).toBe("Open the repo page and report.");
    expect(fetched.steps).toEqual([]);
  });

  it("a step task created with steps keeps the runner behaviour exactly", async () => {
    const { runner, stepCalls } = makeHost();
    const done = await runner.createTask(
      {
        goal: "List tabs",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
        start: true,
      },
      SNAPSHOT,
    );
    expect(done.status).toBe("done");
    expect(stepCalls).toEqual(["tabs.list"]);
  });

  it("tasks.create with any steps input is rejected with the teachable error and creates no task", async () => {
    const { transport, handler } = makeHost();
    // A 1-step array: the exact shape that used to split one job
    // into a second step task.
    await handler.handle({
      type: "tool.call",
      id: "s1",
      tool: "tasks.create",
      input: { goal: "Play something", description: "Play a video.", steps: [{ tool: "tabs.list", input: {} }] },
      client: BRIDGE_CLIENT,
    });
    const oneStep = transport.last() as ToolError;
    expect(oneStep.type).toBe("tool.error");
    expect(oneStep.error.code).toBe("INVALID_INPUT");
    expect(oneStep.error.message).toBe(TASKS_CREATE_STEPS_REJECTED_MESSAGE);
    // An empty array is still a steps field, so it is rejected too.
    await handler.handle({
      type: "tool.call",
      id: "s2",
      tool: "tasks.create",
      input: { goal: "Play something", description: "Play a video.", steps: [] },
      client: BRIDGE_CLIENT,
    });
    const emptySteps = transport.last() as ToolError;
    expect(emptySteps.type).toBe("tool.error");
    expect(emptySteps.error.code).toBe("INVALID_INPUT");
    expect(emptySteps.error.message).toBe(TASKS_CREATE_STEPS_REJECTED_MESSAGE);
    // Nothing was created by either rejected call.
    await handler.handle({ type: "tool.call", id: "l1", tool: "tasks.list", input: {}, client: BRIDGE_CLIENT });
    expect(((transport.last() as ToolResult).result.tasks as unknown[])).toEqual([]);
  });

  it("a description task's timeline holds exactly its filed interactions, nothing else", async () => {
    const { transport, handler, events } = makeHost();
    const task = await createDescriptionTask(handler, transport);
    const taskId = task.id as string;
    events.length = 0;
    await handler.handle({ type: "tool.call", id: "f1", tool: "clipboard.write", input: { text: "one" }, client: BRIDGE_CLIENT, taskId });
    await handler.handle({ type: "tool.call", id: "f2", tool: "clipboard.write", input: { text: "two" }, client: BRIDGE_CLIENT, taskId });
    // A standalone grounding read files nowhere.
    await handler.handle({ type: "tool.call", id: "r1", tool: "tabs.list", input: {}, client: BRIDGE_CLIENT });
    const rows = new Map(events.map((e) => [e.id, e]));
    const taskRows = [...rows.values()].filter((row) => row.taskId === taskId);
    expect(taskRows).toHaveLength(2);
    expect(taskRows.every((row) => row.state === "done")).toBe(true);
    expect([...rows.values()].filter((row) => row.taskId === undefined)).toHaveLength(1);
  });

  it("a tool call with a taskId executes, returns its result directly, and files exactly one timeline row under that task", async () => {
    const { transport, handler, events } = makeHost();
    const task = await createDescriptionTask(handler, transport);
    const taskId = task.id as string;
    events.length = 0;
    await handler.handle({
      type: "tool.call",
      id: "a1",
      tool: "clipboard.write",
      input: { text: "hi" },
      client: BRIDGE_CLIENT,
      taskId,
    });
    const result = transport.last() as ToolResult;
    expect(result.type).toBe("tool.result");
    // Exactly one timeline row (running + done share one activity id),
    // filed under the task, ending done.
    const rows = new Map(events.map((e) => [e.id, e]));
    expect(rows.size).toBe(1);
    const [row] = [...rows.values()];
    expect(row.taskId).toBe(taskId);
    expect(row.state).toBe("done");
    // The task itself is still running: filings do not end it.
    await handler.handle({ type: "tool.call", id: "g1", tool: "tasks.get", input: { taskId }, client: BRIDGE_CLIENT });
    expect((transport.last() as ToolResult).result.status).toBe("running");
  });

  it("an action without taskId gets TASK_REQUIRED with the new description message", async () => {
    const { transport, handler } = makeHost();
    await handler.handle({ type: "tool.call", id: "a1", tool: "clipboard.write", input: { text: "hi" }, client: BRIDGE_CLIENT });
    const rejected = transport.last() as ToolError;
    expect(rejected.type).toBe("tool.error");
    expect(rejected.error.code).toBe("TASK_REQUIRED");
    expect(rejected.error.message).toBe(TASK_REQUIRED_MESSAGE);
    expect(rejected.error.message).toContain("description of the job");
    expect(rejected.error.message).toContain("task id in every tool call");
    expect(rejected.error.message).not.toContain("steps as the plan");
  });

  it("unknown and wrong-client task ids are rejected for actions; terminal ids tell the AI to create a new task", async () => {
    const { transport, handler } = makeHost();
    const task = await createDescriptionTask(handler, transport);
    const taskId = task.id as string;

    await handler.handle({ type: "tool.call", id: "a1", tool: "clipboard.write", input: { text: "x" }, client: BRIDGE_CLIENT, taskId: "task_missing" });
    const unknown = transport.last() as ToolError;
    expect(unknown.error.code).toBe("TASK_REQUIRED");
    expect(unknown.error.message).toContain("Unknown task id");
    expect(unknown.error.message).toContain("Create a task first");

    await handler.handle({
      type: "tool.call",
      id: "a2",
      tool: "clipboard.write",
      input: { text: "x" },
      client: { id: "client-b", name: "Client B", transport: "remote" },
      taskId,
    });
    const wrongClient = transport.last() as ToolError;
    expect(wrongClient.error.code).toBe("PERMISSION_DENIED");
    expect(wrongClient.error.message).toContain("belongs to a different client");

    // Complete the task, then file into it: rejected as terminal.
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.complete", input: { taskId, summary: "Done" }, client: BRIDGE_CLIENT });
    expect((transport.last() as ToolResult).result.status).toBe("done");
    await handler.handle({ type: "tool.call", id: "a3", tool: "clipboard.write", input: { text: "x" }, client: BRIDGE_CLIENT, taskId });
    const terminal = transport.last() as ToolError;
    expect(terminal.error.code).toBe("INVALID_INPUT");
    expect(terminal.error.message).toContain("cannot accept new filings");
    expect(terminal.error.message).toContain("Create a new task");
  });

  it("a read with an invalid task id executes standalone, never rejected, never filed into a wrong task", async () => {
    const { transport, handler, events } = makeHost();
    events.length = 0;
    await handler.handle({ type: "tool.call", id: "r1", tool: "tabs.list", input: {}, client: BRIDGE_CLIENT, taskId: "task_missing" });
    expect((transport.last() as ToolResult).type).toBe("tool.result");
    const rows = new Map(events.map((e) => [e.id, e]));
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].taskId).toBeUndefined();
  });

  it("tasks.complete moves a description task to done with the summary, and rejects step and terminal tasks", async () => {
    const { runner } = makeHost();
    const desc = await runner.createTask(
      { goal: "Check the repo", description: "Look around.", clientId: CLIENT, browserSessionId: SESSION },
      SNAPSHOT,
    );
    const done = await runner.completeTask(desc.id, CLIENT, "Found three issues.");
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    expect(done.resultSummary).toContain("Found three issues.");
    await expect(runner.completeTask(desc.id, CLIENT)).rejects.toThrow(/is done and cannot be completed/);

    const stepped = await runner.createTask(
      { goal: "List tabs", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {} }], start: true },
      SNAPSHOT,
    );
    expect(stepped.status).toBe("done");
    await expect(runner.completeTask(stepped.id, CLIENT)).rejects.toThrow(/is done and cannot be completed/);

    const runningStep = await runner.createTask(
      { goal: "Paused steps", clientId: CLIENT, browserSessionId: SESSION, steps: [{ tool: "tabs.list", input: {} }] },
      SNAPSHOT,
    );
    await expect(runner.completeTask(runningStep.id, CLIENT)).rejects.toThrow(/step tasks complete when their steps finish/);
  });

  it("tasks.appendSteps no longer exists anywhere in the registry or host dispatch", async () => {
    expect(TASK_TOOL_NAMES).not.toContain("tasks.appendSteps");
    expect(taskTools.map((t) => t.name)).not.toContain("tasks.appendSteps");
    expect(TASK_TOOL_NAMES).toEqual(["tasks.create", "tasks.complete", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel"]);
    const { transport, handler } = makeHost();
    await handler.handle({ type: "tool.call", id: "x1", tool: "tasks.appendSteps", input: { taskId: "task_1", steps: [] }, client: BRIDGE_CLIENT });
    const error = transport.last() as ToolError;
    expect(error.type).toBe("tool.error");
    expect(error.error.code).toBe("TOOL_NOT_FOUND");
  });

  it("a paused description task resumes to running without entering the step loop", async () => {
    const { runner, stepCalls } = makeHost();
    const desc = await runner.createTask(
      { goal: "Check the repo", description: "Look around.", clientId: CLIENT, browserSessionId: SESSION },
      SNAPSHOT,
    );
    const paused = await runner.pauseTask(desc.id, CLIENT, "user asked");
    expect(paused.status).toBe("paused");
    const resumed = await runner.resumeTask(desc.id, CLIENT, SNAPSHOT);
    expect(resumed.status).toBe("running");
    expect(stepCalls).toEqual([]);
  });

  it("concurrent creates and a concurrent complete lose no update (store lock)", async () => {
    const { runner } = makeHost();
    const [a, b] = await Promise.all([
      runner.createTask({ goal: "First job", description: "Do the first thing.", clientId: CLIENT, browserSessionId: SESSION }, SNAPSHOT),
      runner.createTask({ goal: "Second job", description: "Do the second thing.", clientId: CLIENT, browserSessionId: SESSION }, SNAPSHOT),
    ]);
    const listed = await runner.listTasks(CLIENT, SESSION);
    expect(listed.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    const [done, c] = await Promise.all([
      runner.completeTask(a.id, CLIENT, "done"),
      runner.createTask({ goal: "Third job", description: "Do the third thing.", clientId: CLIENT, browserSessionId: SESSION }, SNAPSHOT),
    ]);
    expect(done.status).toBe("done");
    const after = await runner.listTasks(CLIENT, SESSION);
    expect(after.map((t) => t.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(after.find((t) => t.id === a.id)?.status).toBe("done");
  });
});
