import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestRuntime } from "../libs/testing/index.js";
import {
  PROTOCOL_VERSION,
  REGISTRY_VERSION,
  TASK_TOOL_SCHEMAS,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  type BridgeHostMessage,
} from "../libs/tool-contracts/index.js";
import {
  TASK_TOOL_NAMES,
  TasksCreateInputSchema,
  TasksGetInputSchema,
  taskTools,
} from "../libs/tool-contracts/schemas/tasks.js";
import type { PolicySnapshot, TaskView as RunnerTaskView } from "../libs/tasks/index.js";
import { HostProtocolHandler, type BridgeTransport, type TaskRunnerPort } from "../src/host-protocol.js";
import type { TaskView } from "../libs/tool-contracts/schemas/tasks.js";

const TASK_NAMES = ["tasks.create", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel", "tasks.approvePlan"];

const SNAPSHOT: PolicySnapshot = { policyVersion: 1, mode: "standard", clientId: "Test Client", scope: "call:tools" };

/** A runner-shaped view (extension/libs/tasks), including the internal
 * fields the bridge contract must never expose. */
function runnerView(overrides: Partial<RunnerTaskView> = {}): RunnerTaskView {
  return {
    id: "task_1",
    goal: "Do the thing",
    clientId: "Test Client",
    browserSessionId: "sess_1",
    status: "created",
    steps: [
      {
        index: 0,
        tool: "observe",
        inputSummary: "observe",
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
        verify: null,
        preStepSnapshot: null,
        verifySummary: "",
        verifyOutcome: null,
      },
    ],
    mode: "act",
    totalBudgetMs: 60_000,
    correlationId: "corr_1",
    resultSummary: "",
    planBounds: null,
    planApproval: null,
    finalReport: null,
    policySnapshot: SNAPSHOT,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
    pinned: false,
    pauseReason: null,
    resumeAfterMs: null,
    pinnedTabs: [],
    ...overrides,
  };
}

class FakeTransport implements BridgeTransport {
  readonly messages: BridgeHostMessage[] = [];
  post(message: BridgeHostMessage): void {
    this.messages.push(message);
  }
  last(): BridgeHostMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
}

function setup(
  runner?: TaskRunnerPort,
  extra: { getBrowserSessionId?: () => string | undefined; snapshot?: PolicySnapshot | null } = {},
) {
  const rt = createTestRuntime({
    policy: {
      approvalMode: "risk",
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
    },
  });
  const transport = new FakeTransport();
  const snapshot = extra.snapshot === undefined ? SNAPSHOT : extra.snapshot;
  const handler = new HostProtocolHandler({
    registry: rt.registry,
    executor: rt.executor,
    policy: rt.policy,
    approvals: rt.approvals,
    transport,
    getContext: () => rt.ctx,
    server: { name: "test-host", version: "1.0.0" },
    legacyTools: true,
    ...(runner ? { tasks: runner } : {}),
    ...(extra.getBrowserSessionId ? { getBrowserSessionId: extra.getBrowserSessionId } : {}),
    ...(snapshot ? { getTaskPolicySnapshot: () => snapshot } : {}),
  });
  return { transport, handler };
}

function validCreateInput() {
  return {
    goal: "Research and organise",
    steps: [{ tool: "observe", input: { include: ["text"] }, timeoutMs: 5000 }],
    totalBudgetMs: 120_000,
    browserSessionId: "input-session",
  };
}

function stubRunner(overrides: Partial<TaskRunnerPort> = {}): TaskRunnerPort {
  return {
    createTask: async () => runnerView({ status: "running" }),
    getTask: async () => runnerView(),
    listTasks: async () => [runnerView()],
    runTask: async () => runnerView(),
    pauseTask: async () => runnerView({ status: "paused" }),
    resumeTask: async () => runnerView({ status: "running" }),
    cancelTask: async () => runnerView({ status: "cancelled" }),
    approvePlan: async () => runnerView({ status: "paused" }),
    previewTask: async () => ({
      goal: "preview",
      totalSteps: 0,
      totalBudgetMs: 60_000,
      domains: [],
      steps: [],
      approvalsNeeded: [],
      errors: [],
      valid: true,
    }),
    ...overrides,
  };
}

describe("tasks.* contracts", () => {
  it("defines exactly the seven task tools (Phase 0's six plus Phase 1's tasks.approvePlan), and no others", () => {
    expect(TASK_NAMES).toEqual([...TASK_TOOL_NAMES]);
    expect(taskTools.map((t) => t.name)).toEqual(TASK_NAMES);
    expect(TASK_TOOL_SCHEMAS.map((t) => t.name)).toEqual(TASK_NAMES);
    // Phase 1: tasks.approvePlan is a separate granular tool; dry-run is
    // a tasks.create flag, not a separate tool, so no tool name contains "dry".
    expect(TASK_TOOL_NAMES).toContain("tasks.approvePlan");
    expect(TASK_TOOL_NAMES.some((name) => name.includes("dry"))).toBe(false);
  });

  it("merges the task tools into the executor registry with runner-owned stub handlers", () => {
    // 0.4.0 integration: task tools live in TOOL_SCHEMAS so registry
    // consumers see them, but their executor handlers are stubs that
    // throw UNSUPPORTED — host dispatch intercepts tasks.* before the
    // executor and routes them to the runner. TASK_TOOL_SCHEMAS is the
    // task subset of TOOL_SCHEMAS, not a disjoint list.
    expect(TASK_TOOL_NAMES.every((name) => TOOL_NAMES.includes(name))).toBe(true);
    expect(TOOL_SCHEMAS.filter((tool) => tool.name.startsWith("tasks."))).toHaveLength(7);
  });

  it("bumps the registry version to 2.3.0 without changing the protocol version", () => {
    expect(REGISTRY_VERSION).toBe("2.3.0");
    expect(PROTOCOL_VERSION).toBe("2.0.0");
  });

  it("gives every task tool a structured output schema, never z.any()", () => {
    for (const tool of taskTools) {
      const schema = z.toJSONSchema(tool.output, { target: "draft-7", io: "output" }) as Record<string, unknown>;
      expect(Object.keys(schema).length, tool.name).toBeGreaterThan(0);
      expect(schema.type, tool.name).toBe("object");
    }
  });

  it("rejects an empty goal, 0 steps, and 101 steps", () => {
    expect(() => TasksCreateInputSchema.parse({ goal: "", steps: [{ tool: "observe", input: {} }] })).toThrow();
    expect(() => TasksCreateInputSchema.parse({ goal: "x", steps: [] })).toThrow();
    const many = Array.from({ length: 101 }, () => ({ tool: "observe", input: {} }));
    expect(() => TasksCreateInputSchema.parse({ goal: "x", steps: many })).toThrow();
  });

  it("rejects out-of-range per-step timeoutMs", () => {
    const base = { goal: "x", steps: [{ tool: "observe", input: {} }] };
    expect(() => TasksCreateInputSchema.parse({ ...base, steps: [{ tool: "observe", input: {}, timeoutMs: 0 }] })).toThrow();
    expect(() => TasksCreateInputSchema.parse({ ...base, steps: [{ tool: "observe", input: {}, timeoutMs: 60_001 }] })).toThrow();
    expect(() => TasksCreateInputSchema.parse({ ...base, steps: [{ tool: "observe", input: {}, timeoutMs: 60_000 }] })).not.toThrow();
  });

  it("rejects client-supplied confirmation flags in task inputs", () => {
    expect(() => TasksCreateInputSchema.parse({ ...validCreateInput(), confirmed: true } as never)).toThrow();
    expect(() => TasksCreateInputSchema.parse({ ...validCreateInput(), userApproved: true } as never)).toThrow();
    expect(() => TasksGetInputSchema.parse({ taskId: "t1", approved: true } as never)).toThrow();
  });

  it("defaults start to true and does not validate wrapped tool inputs at create time", () => {
    const parsed = TasksCreateInputSchema.parse({ goal: "x", steps: [{ tool: "observe", input: { nonsense: [1, 2, 3] } }] });
    expect(parsed.start).toBe(true);
    // The wrapped input is a generic record: the runner/executor, not
    // this schema, validates it against the wrapped tool at execution.
  });

  it("carries the specified risk and approval flags", () => {
    const byName = new Map(taskTools.map((t) => [t.name, t]));
    expect(byName.get("tasks.create")?.risk).toBe("reversible");
    expect(byName.get("tasks.create")?.requiresApproval).toBe(false);
    expect(byName.get("tasks.get")?.risk).toBe("read-only");
    expect(byName.get("tasks.list")?.risk).toBe("read-only");
    expect(byName.get("tasks.pause")?.risk).toBe("reversible");
    expect(byName.get("tasks.resume")?.risk).toBe("reversible");
    expect(byName.get("tasks.cancel")?.risk).toBe("reversible");
    expect(byName.get("tasks.approvePlan")?.risk).toBe("reversible");
    expect(byName.get("tasks.approvePlan")?.requiresApproval).toBe(false);
    for (const tool of taskTools) expect(tool.category).toBe("workflows");
  });

  it("requires tasks.create titles to be concise AI rephrasings, never the user's prompt verbatim", () => {
    const byName = new Map(taskTools.map((t) => [t.name, t]));
    const description = byName.get("tasks.create")?.description ?? "";
    // The displayed task title is the goal field; the client writes it,
    // so the rule lives in this description. Pin the guidance itself:
    // a rephrase requirement, a verbatim ban, and one good example.
    expect(description).toContain("rephrase");
    expect(description).toContain("verbatim");
    expect(description).toContain("Screenshot the Muze AI repo");
    // Description text only: no parameter or behavior change.
    expect(byName.get("tasks.create")?.risk).toBe("reversible");
    expect(TasksCreateInputSchema.shape.goal).toBeDefined();
  });

  it("describes tasks.create as a durable task whose steps still go through approval gates", () => {
    const byName = new Map(taskTools.map((t) => [t.name, t]));
    const description = byName.get("tasks.create")?.description ?? "";
    // The must-create banner is gone from the description: the rule now
    // lives woven into the session instructions, not as a lead sentence.
    expect(description.startsWith("IMPORTANT")).toBe(false);
    expect(description.startsWith("Create a durable multi-step task")).toBe(true);
    expect(description).toContain("start running it");
    expect(description).toContain("reversible");
    expect(description).toContain("never pre-approves");
    // Title guidance intact alongside it.
    expect(description).toContain("rephrase");
    expect(description).toContain("verbatim");
  });

  it("keeps the concise rephrased-title rule with its good/bad example, without a banner lead", () => {
    const byName = new Map(taskTools.map((t) => [t.name, t]));
    const description = byName.get("tasks.create")?.description ?? "";
    // No banner lead: the description opens on the task itself.
    expect(description.startsWith("IMPORTANT: Every task you undertake must be created with tasks.create")).toBe(false);
    expect(description).toContain("rephrase");
    expect(description).toContain("verbatim");
    expect(description).toContain("Screenshot the Muze AI repo");
  });
});

describe("tasks.* host dispatch", () => {
  it("fails with 'task engine not wired' when no runner is wired", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.create", input: validCreateInput() });
    const error = transport.last() as { type: string; error: { message: string } };
    expect(error.type).toBe("tool.error");
    expect(error.error.message).toContain("task engine not wired");
  });

  it("fails closed when a runner is wired but no policy snapshot provider is", async () => {
    const { transport, handler } = setup(stubRunner(), { snapshot: null });
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.create", input: validCreateInput() });
    const error = transport.last() as { type: string; error: { message: string } };
    expect(error.type).toBe("tool.error");
    expect(error.error.message).toContain("task policy snapshot not wired");
  });

  it("routes tasks.create to the runner with the bridge client identity and adapts the view", async () => {
    const seen: { input?: unknown; snapshot?: unknown } = {};
    const runner = stubRunner({
      createTask: async (input, snapshot) => {
        seen.input = input;
        seen.snapshot = snapshot;
        return runnerView({ status: "running" });
      },
    });
    const { transport, handler } = setup(runner);
    await handler.handle({
      type: "tool.call",
      id: "c1",
      tool: "tasks.create",
      input: validCreateInput(),
      client: { id: "cli", name: "Test Client", transport: "remote" },
    });
    const result = transport.last() as { type: string; result: TaskView };
    expect(result.type).toBe("tool.result");
    expect(result.result.status).toBe("running");
    // Contract view: computed progress fields present, runner-internal
    // fields (idempotency key, policy snapshot, pinned tabs) absent.
    expect(result.result.totalSteps).toBe(1);
    expect(result.result.doneSteps).toEqual([]);
    expect(result.result.undoneSteps).toEqual([0]);
    expect(JSON.stringify(result.result)).not.toContain("idem_1");
    expect(JSON.stringify(result.result)).not.toContain("call:tools");
    // Ownership is by bridge client id ("cli"), not name, so two OAuth
    // clients sharing a name cannot own each other's tasks; dispatch
    // stamps the actual client id onto the policy snapshot.
    expect(seen.input).toMatchObject({ clientId: "cli", browserSessionId: "input-session", goal: "Research and organise" });
    expect(seen.snapshot).toEqual({ ...SNAPSHOT, clientId: "cli" });
  });

  it("prefers the host browser session over the input session id", async () => {
    const seen: { input?: unknown } = {};
    const runner = stubRunner({
      createTask: async (input) => {
        seen.input = input;
        return runnerView();
      },
    });
    const { transport, handler } = setup(runner, { getBrowserSessionId: () => "host-session" });
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.create", input: validCreateInput() });
    expect(transport.last()?.type).toBe("tool.result");
    expect(seen.input).toMatchObject({ browserSessionId: "host-session" });
  });

  it("rejects tasks.create with no browser session anywhere", async () => {
    const { transport, handler } = setup(stubRunner());
    const { browserSessionId: _dropped, ...noSession } = validCreateInput();
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.create", input: noSession });
    const error = transport.last() as { type: string; error: { message: string } };
    expect(error.type).toBe("tool.error");
    expect(error.error.message).toContain("browserSessionId");
  });

  it("routes get/list/pause/resume/cancel and returns contract views", async () => {
    const calls: string[] = [];
    const runner = stubRunner({
      getTask: async () => {
        calls.push("get");
        return runnerView({ status: "running" });
      },
      listTasks: async () => {
        calls.push("list");
        return [runnerView()];
      },
      pauseTask: async (_id, _client, reason) => {
        calls.push(`pause:${reason}`);
        return runnerView({ status: "paused", pauseReason: reason });
      },
      resumeTask: async () => {
        calls.push("resume");
        return runnerView({ status: "running" });
      },
      cancelTask: async () => {
        calls.push("cancel");
        return runnerView({ status: "cancelled" });
      },
    });
    const { transport, handler } = setup(runner);
    await handler.handle({ type: "tool.call", id: "g", tool: "tasks.get", input: { taskId: "task_1" } });
    expect((transport.last() as { result: TaskView }).result.status).toBe("running");
    await handler.handle({ type: "tool.call", id: "l", tool: "tasks.list", input: {} });
    expect((transport.last() as { result: { tasks: TaskView[] } }).result.tasks).toHaveLength(1);
    await handler.handle({ type: "tool.call", id: "p", tool: "tasks.pause", input: { taskId: "task_1", reason: "user asked" } });
    expect((transport.last() as { result: TaskView }).result.status).toBe("paused");
    expect((transport.last() as { result: TaskView }).result.pauseReason).toBe("user asked");
    await handler.handle({ type: "tool.call", id: "r", tool: "tasks.resume", input: { taskId: "task_1" } });
    await handler.handle({ type: "tool.call", id: "x", tool: "tasks.cancel", input: { taskId: "task_1" } });
    expect((transport.last() as { result: TaskView }).result.status).toBe("cancelled");
    expect(calls).toEqual(["get", "list", "pause:user asked", "resume", "cancel"]);
  });

  it("rejects unknown tasks.* tools and invalid task input without touching the runner", async () => {
    let runnerCalls = 0;
    const runner = stubRunner({
      createTask: async () => {
        runnerCalls += 1;
        return runnerView();
      },
    });
    const { transport, handler } = setup(runner);
    await handler.handle({ type: "tool.call", id: "u", tool: "tasks.approvePlan", input: {} });
    expect(transport.last()?.type).toBe("tool.error");
    await handler.handle({ type: "tool.call", id: "i", tool: "tasks.create", input: { goal: "", steps: [] } });
    expect(transport.last()?.type).toBe("tool.error");
    expect(runnerCalls).toBe(0);
  });

  it("never returns a raw task record: step inputs are stripped by the adapter", async () => {
    const raw = runnerView();
    (raw.steps[0] as unknown as Record<string, unknown>).input = { secret: true };
    const runner = stubRunner({ createTask: async () => raw });
    const { transport, handler } = setup(runner);
    await handler.handle({ type: "tool.call", id: "c1", tool: "tasks.create", input: validCreateInput() });
    expect(transport.last()?.type).toBe("tool.result");
    expect(JSON.stringify(transport.messages)).not.toContain("secret");
  });

  it("errors when a runner view fails the contract", async () => {
    const runner = stubRunner({ getTask: async () => runnerView({ goal: "" }) });
    const { transport, handler } = setup(runner);
    await handler.handle({ type: "tool.call", id: "g", tool: "tasks.get", input: { taskId: "task_1" } });
    expect(transport.last()?.type).toBe("tool.error");
  });
});
