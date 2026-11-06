import { describe, expect, test } from "vitest";
import { BridgeForwardError, ForwardingBridge } from "../src/bridge.js";

type ResolveFn = (clientId: string, userId: string, currentSessionId: string) => Promise<{
  sessionId: string;
  defaultSessionId: string;
  browsers?: Array<Record<string, unknown>>;
}>;
type CallFn = (targetSessionId: string, body: Record<string, unknown>) => Promise<Record<string, any>>;

interface Harness {
  bridge: ForwardingBridge;
  resolveCalls: Array<{ clientId: string; userId: string; currentSessionId: string }>;
  browserCalls: Array<{ target: string; body: Record<string, unknown> }>;
}

function harness(opts: {
  routes: string[];
  callBehaviour?: (target: string, body: Record<string, unknown>) => Record<string, any> | Promise<Record<string, any>>;
}): Harness {
  const resolveCalls: Harness["resolveCalls"] = [];
  const browserCalls: Harness["browserCalls"] = [];
  let routeIndex = 0;
  const resolveRoute: ResolveFn = async (clientId, userId, currentSessionId) => {
    resolveCalls.push({ clientId, userId, currentSessionId });
    const sessionId = opts.routes[Math.min(routeIndex++, opts.routes.length - 1)];
    return {
      sessionId,
      defaultSessionId: opts.routes[opts.routes.length - 1],
      browsers: opts.routes.map((id) => ({ sessionId: id, name: `Browser ${id}` })),
    };
  };
  const callBrowser: CallFn = async (target, body) => {
    browserCalls.push({ target, body });
    if (opts.callBehaviour) return opts.callBehaviour(target, body);
    return { ok: true, connected: true };
  };
  const bridge = new ForwardingBridge({ clientId: "oc_test", userId: "u_test", resolveRoute, callBrowser });
  return { bridge, resolveCalls, browserCalls };
}

describe("ForwardingBridge", () => {
  test("resolves the target once and forwards listTools to it", async () => {
    const { bridge, resolveCalls, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: () => ({ ok: true, connected: true, tools: [{ name: "tabs.list" }] }),
    });
    const tools = await bridge.listTools();
    expect(tools).toEqual([{ name: "tabs.list" }]);
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toEqual({ clientId: "oc_test", userId: "u_test", currentSessionId: "" });
    // A second call reuses the cached target: no second resolution.
    await bridge.listTools();
    expect(resolveCalls).toHaveLength(1);
    expect(browserCalls).toHaveLength(2);
    expect(browserCalls[0]).toEqual({ target: "browser-a", body: { op: "listTools" } });
  });

  test("callTool forwards tool, input, client and taskId, and passes the result through", async () => {
    const { bridge, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: () => ({ ok: true, connected: true, result: { ok: 1 }, dryRun: false, durationMs: 7 }),
    });
    const outcome = await bridge.callTool({
      tool: "tabs.list",
      input: { a: 1 },
      client: { id: "oc_test", name: "Test", transport: "remote" },
      taskId: "task_1",
    });
    expect(outcome).toEqual({ result: { ok: 1 }, dryRun: false, durationMs: 7 });
    expect(browserCalls[0].body).toMatchObject({
      op: "call",
      tool: "tabs.list",
      input: { a: 1 },
      taskId: "task_1",
    });
    expect((browserCalls[0].body.client as { id: string }).id).toBe("oc_test");
  });

  test("callToolBatch forwards the batch and the client", async () => {
    const { bridge, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: () => ({ ok: true, connected: true, results: [{ result: 1 }, { result: 2 }] }),
    });
    const results = await bridge.callToolBatch(
      [
        { tool: "tabs.list", input: {} },
        { tool: "observe", input: {} },
      ],
      { client: { id: "oc_test", name: "Test", transport: "remote" } },
    );
    expect(results).toEqual([{ result: 1 }, { result: 2 }]);
    expect(browserCalls[0].body.op).toBe("batch");
    expect((browserCalls[0].body.calls as unknown[]).length).toBe(2);
  });

  test("an unexecuted failure re-resolves once and retries on a changed target", async () => {
    const { bridge, resolveCalls, browserCalls } = harness({
      routes: ["browser-b", "browser-a"],
      callBehaviour: (target) =>
        target === "browser-b"
          ? { ok: false, connected: false, error: { code: "CONFLICT", message: "No browser is connected to this session", retryable: true, executed: false } }
          : { ok: true, connected: true, result: { ok: 1 }, dryRun: false, durationMs: 1 },
    });
    const outcome = await bridge.callTool({ tool: "tabs.list", input: {} });
    expect(outcome.result).toEqual({ ok: 1 });
    expect(resolveCalls).toHaveLength(2);
    expect(browserCalls.map((call) => call.target)).toEqual(["browser-b", "browser-a"]);
    expect(bridge.currentTarget()?.sessionId).toBe("browser-a");
  });

  test("an unexecuted failure with an unchanged route surfaces without a retry", async () => {
    const { bridge, resolveCalls, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: () => ({
        ok: false,
        connected: false,
        error: { code: "CONFLICT", message: "No browser is connected to this session", retryable: true, executed: false },
      }),
    });
    await expect(bridge.callTool({ tool: "tabs.list", input: {} })).rejects.toThrow("No browser is connected");
    expect(resolveCalls).toHaveLength(2);
    expect(browserCalls).toHaveLength(1);
    expect(bridge.isConnected()).toBe(false);
  });

  test("an executed failure is never retried, even when the route would change", async () => {
    const { bridge, resolveCalls, browserCalls } = harness({
      routes: ["browser-b", "browser-a"],
      callBehaviour: () => ({
        ok: false,
        connected: true,
        error: { code: "TIMEOUT", message: "tool timed out", retryable: true, executed: true },
      }),
    });
    const error = await bridge.callTool({ tool: "tabs.list", input: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeForwardError);
    expect((error as BridgeForwardError).executed).toBe(true);
    expect((error as BridgeForwardError).code).toBe("TIMEOUT");
    expect(resolveCalls).toHaveLength(1);
    expect(browserCalls).toHaveLength(1);
  });

  test("a fetch-level failure is treated as executed (unknown outcome) and never retried", async () => {
    const { bridge, browserCalls } = harness({
      routes: ["browser-b", "browser-a"],
      callBehaviour: () => {
        throw new Error("socket hung up");
      },
    });
    const error = await bridge.callTool({ tool: "tabs.list", input: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeForwardError);
    expect((error as BridgeForwardError).executed).toBe(true);
    expect(browserCalls).toHaveLength(1);
  });

  test("setTarget moves the next call to the new browser without re-resolving", async () => {
    const { bridge, resolveCalls, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: () => ({ ok: true, connected: true, result: {}, dryRun: false, durationMs: 0 }),
    });
    await bridge.callTool({ tool: "tabs.list", input: {} });
    expect(resolveCalls).toHaveLength(1);
    bridge.setTarget("browser-b", "Browser B");
    await bridge.callTool({ tool: "tabs.list", input: {} });
    expect(resolveCalls).toHaveLength(1);
    expect(browserCalls.map((call) => call.target)).toEqual(["browser-a", "browser-b"]);
    expect(bridge.currentTarget()?.sessionId).toBe("browser-b");
  });

  test("waitApproval forwards the budget and returns the decision", async () => {
    const { bridge, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: (_target, body) => {
        expect(body.op).toBe("approval.wait");
        expect(body.timeoutMs).toBe(50_000);
        return { ok: true, connected: true, approved: true };
      },
    });
    await expect(bridge.waitApproval("appr_1", 50_000)).resolves.toBe(true);
    expect(browserCalls).toHaveLength(1);
  });

  test("createApproval and respondApproval forward through the bridge", async () => {
    const { bridge, browserCalls } = harness({
      routes: ["browser-a"],
      callBehaviour: (_target, body) => {
        if (body.op === "approval.request") return { ok: true, connected: true, approval: { id: "appr_9", tool: "act" } };
        return { ok: true, connected: true };
      },
    });
    const approval = await bridge.createApproval("act", { x: 1 });
    expect((approval as { id: string }).id).toBe("appr_9");
    await bridge.respondApproval("appr_9", true);
    expect(browserCalls.map((call) => call.body.op)).toEqual(["approval.request", "approval.respond"]);
  });

  test("a bridge that can never resolve reports disconnected from the start", async () => {
    const bridge = new ForwardingBridge({ clientId: "oc_test", userId: "u_test" });
    expect(bridge.isConnected()).toBe(false);
    await expect(bridge.listTools()).rejects.toThrow("No browser is connected");
  });

  test("probeConnectivity records the browser DO's liveness", async () => {
    const offline = new ForwardingBridge({
      clientId: "oc_test",
      userId: "u_test",
      resolveRoute: async () => ({ sessionId: "browser-a", defaultSessionId: "browser-a" }),
      callBrowser: async () => ({ ok: true, connected: true }),
      probeBrowser: async () => false,
    });
    await offline.probeConnectivity();
    expect(offline.isConnected()).toBe(false);
    const online = new ForwardingBridge({
      clientId: "oc_test",
      userId: "u_test",
      resolveRoute: async () => ({ sessionId: "browser-a", defaultSessionId: "browser-a" }),
      callBrowser: async () => ({ ok: true, connected: true }),
      probeBrowser: async () => true,
    });
    await online.probeConnectivity();
    expect(online.isConnected()).toBe(true);
  });

  test("generation bumps when the target changes and isConnected recovers on success", async () => {
    const { bridge } = harness({
      routes: ["browser-b", "browser-a"],
      callBehaviour: (target) =>
        target === "browser-b"
          ? { ok: false, connected: false, error: { code: "CONFLICT", message: "gone", retryable: true, executed: false } }
          : { ok: true, connected: true, result: {}, dryRun: false, durationMs: 0 },
    });
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.generation()).toBe(0);
    await bridge.callTool({ tool: "tabs.list", input: {} });
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.generation()).toBe(2);
  });
});
