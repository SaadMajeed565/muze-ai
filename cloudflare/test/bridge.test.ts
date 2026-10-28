import { describe, expect, it } from "vitest";
import { DoBridge } from "../src/bridge.js";
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
