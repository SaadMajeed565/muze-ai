import { describe, expect, it } from "vitest";
import { BridgeSlot, DoBridge, type GatewayBridge } from "../src/bridge.js";
import { PROTOCOL_VERSION, ToolErrorException, type BridgeClientMessage } from "../libs/tool-contracts/index.js";

function setup() {
  const sent: BridgeClientMessage[] = [];
  const bridge = new DoBridge({ send: (message) => sent.push(message), isOpen: () => true });
  bridge.start();
  bridge.handleMessage({
    type: "hello.ok",
    id: "gw_1",
    protocolVersion: PROTOCOL_VERSION,
    registryVersion: "1",
    server: { name: "test", version: "1" },
  });
  return { bridge, sent };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DoBridge cancellation", () => {
  it("sends cancel and rejects the pending call when its signal aborts", async () => {
    const { bridge, sent } = setup();
    const controller = new AbortController();
    const pending = bridge.callTool({ tool: "tabs.list", input: {}, signal: controller.signal });
    await nextTick();
    const call = sent.find((message) => message.type === "tool.call");
    expect(call).toBeTruthy();

    controller.abort(new ToolErrorException("CANCELLED", "Cancelled by client"));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sent.some((message) => message.type === "cancel" && message.targetId === call!.id)).toBe(true);
  });

  it("cancels an approval wait instead of leaving it pending", async () => {
    const { bridge, sent } = setup();
    const controller = new AbortController();
    const pending = bridge.waitApproval("approval_1", 10_000, controller.signal);
    await nextTick();
    const wait = sent.find((message) => message.type === "approval.wait");
    expect(wait).toBeTruthy();

    controller.abort(new ToolErrorException("CANCELLED", "Cancelled by client"));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sent.some((message) => message.type === "cancel" && message.targetId === wait!.id)).toBe(true);
  });

  it("an approval wait honors the passed timeout instead of the 120 s default", async () => {
    const { bridge, sent } = setup();
    const pending = bridge.waitApproval("approval_1", 150);
    await nextTick();
    const wait = sent.find((message) => message.type === "approval.wait");
    expect(wait).toMatchObject({ type: "approval.wait", timeoutMs: 150 });
    // No host response: the local timer fires at the passed budget, not 120 s.
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("DoBridge batching", () => {
  it("sends one batch request and settles all item results", async () => {
    const { bridge, sent } = setup();
    const pending = bridge.callToolBatch([
      { tool: "tabs.list", input: {} },
      { tool: "page.read", input: { offset: 0, maxChars: 10 } },
    ]);
    await nextTick();
    const call = sent.find((message) => message.type === "tool.call.batch");
    expect(call).toBeTruthy();
    bridge.handleMessage({
      type: "tool.batch.result",
      id: call!.id,
      results: [
        { tool: "tabs.list", ok: true, result: { tabs: [] }, dryRun: false, durationMs: 1 },
        { tool: "page.read", ok: true, result: { text: "hi" }, dryRun: false, durationMs: 2 },
      ],
    });
    await expect(pending).resolves.toEqual([
      { tool: "tabs.list", ok: true, result: { tabs: [] }, dryRun: false, durationMs: 1 },
      { tool: "page.read", ok: true, result: { text: "hi" }, dryRun: false, durationMs: 2 },
    ]);
  });
});

describe("BridgeSlot grace wait", () => {
  function connectedBridge(): GatewayBridge {
    return {
      isConnected: () => true,
      listTools: async () => [],
      callTool: async () => ({ result: { ok: true }, dryRun: false, durationMs: 1 }),
      callToolBatch: async () => [{ tool: "tabs.list", ok: true, result: {}, dryRun: false, durationMs: 1 }],
      createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
      respondApproval: async () => undefined,
      waitApproval: async () => true,
    };
  }

  it("a bridge arriving within the grace window lets callTool succeed, no CONFLICT", async () => {
    const slot = new BridgeSlot({ graceWaitMs: 1_000 });
    const pending = slot.callTool({ tool: "tabs.list", input: {} });
    setTimeout(() => slot.set(connectedBridge()), 50);
    await expect(pending).resolves.toEqual({ result: { ok: true }, dryRun: false, durationMs: 1 });
  });

  it("a bridge arriving within the grace window lets callToolBatch succeed", async () => {
    const slot = new BridgeSlot({ graceWaitMs: 1_000 });
    const pending = slot.callToolBatch([{ tool: "tabs.list", input: {} }]);
    setTimeout(() => slot.set(connectedBridge()), 50);
    await expect(pending).resolves.toEqual([{ tool: "tabs.list", ok: true, result: {}, dryRun: false, durationMs: 1 }]);
  });

  it("listTools with no bridge in the window throws CONFLICT after the (short test) cap, not immediately", async () => {
    const slot = new BridgeSlot({ graceWaitMs: 50 });
    const started = Date.now();
    await expect(slot.listTools()).rejects.toMatchObject({ code: "CONFLICT" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(500);
  });

  it("a bridge whose hello settles inside the window succeeds", async () => {
    const sent: BridgeClientMessage[] = [];
    const doBridge = new DoBridge({ send: (message) => sent.push(message), isOpen: () => true });
    const slot = new BridgeSlot({ graceWaitMs: 1_000 });
    doBridge.start();
    slot.set(doBridge);
    const pending = slot.callTool({ tool: "tabs.list", input: {} });
    await nextTick();
    // Hello not settled yet: no tool call has been sent.
    expect(sent.some((message) => message.type === "tool.call")).toBe(false);
    doBridge.handleMessage({
      type: "hello.ok",
      id: "gw_1",
      protocolVersion: PROTOCOL_VERSION,
      registryVersion: "1",
      server: { name: "test", version: "1" },
    });
    await nextTick();
    const call = sent.find((message) => message.type === "tool.call");
    expect(call).toBeTruthy();
    doBridge.handleMessage({ type: "tool.result", id: call!.id, result: { tabs: [] }, dryRun: false, durationMs: 1 });
    await expect(pending).resolves.toEqual({ result: { tabs: [] }, dryRun: false, durationMs: 1 });
  });

  it("approval paths still fail fast with no bridge, even with a long grace window", async () => {
    const slot = new BridgeSlot({ graceWaitMs: 5_000 });
    for (const attempt of [
      () => slot.createApproval("tabs.list", {}),
      () => slot.respondApproval("appr_1", true),
      () => slot.waitApproval("appr_1", 1_000),
    ]) {
      const started = Date.now();
      let error: unknown;
      try {
        await attempt();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "CONFLICT" });
      expect(Date.now() - started).toBeLessThan(300);
    }
  });

  it("an aborted grace wait rejects CANCELLED instead of waiting out the window", async () => {
    const slot = new BridgeSlot({ graceWaitMs: 5_000 });
    const controller = new AbortController();
    const pending = slot.callTool({ tool: "tabs.list", input: {}, signal: controller.signal });
    setTimeout(() => controller.abort(new ToolErrorException("CANCELLED", "Cancelled by client")), 10);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
