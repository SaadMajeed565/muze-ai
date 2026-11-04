import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { PROTOCOL_VERSION, TOOL_SCHEMAS, type BridgeHostMessage } from "../libs/tool-contracts/index.js";
import type { ActivityEvent } from "../libs/activity.js";
import { HostProtocolHandler, type BridgeTransport } from "../src/host-protocol.js";

class FakeTransport implements BridgeTransport {
  readonly messages: BridgeHostMessage[] = [];
  post(message: BridgeHostMessage): void {
    this.messages.push(message);
  }
  find(type: BridgeHostMessage["type"]): BridgeHostMessage | undefined {
    return this.messages.find((m) => m.type === type);
  }
  last(): BridgeHostMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
}

function setup() {
  const rt = createTestRuntime({
    policy: {
      approvalMode: "risk",
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      enabledGroups: { clipboard: true },
    },
    context: { clipboard: "secret-value" },
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
  });
  return { rt, transport, handler };
}

describe("HostProtocolHandler", () => {
  it("completes the handshake and rejects mismatched protocol versions", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: { id: "c", name: "C", transport: "native" } });
    expect(transport.find("hello.ok")).toMatchObject({ id: "h", protocolVersion: PROTOCOL_VERSION });

    const mismatch = setup();
    await mismatch.handler.handle({ type: "hello", id: "h2", protocolVersion: "0.0.1", client: { id: "c", name: "C", transport: "native" } });
    expect(mismatch.transport.find("hello.error")).toBeTruthy();
  });

  it("lists the complete tool registry", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "registry.list", id: "r" });
    const result = transport.find("registry.result") as { tools: { name: string; risk: string }[] };
    expect(result.tools.length).toBe(TOOL_SCHEMAS.length);
    expect(result.tools.map((t) => t.name)).toContain("screenshots.visible");
    expect(result.tools.map((t) => t.name)).toContain("clipboard.read");
  });

  it("executes a read-only tool", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "tool.call", id: "t1", tool: "tabs.list", input: {} });
    const result = transport.find("tool.result");
    expect(result).toMatchObject({ id: "t1", dryRun: false });
  });

  it("runs read-only batches and refuses higher-risk items", async () => {
    const { transport, handler } = setup();
    await handler.handle({
      type: "tool.call.batch",
      id: "b1",
      calls: [
        { tool: "tabs.list", input: {} },
        { tool: "tabs.close", input: { tabId: 1 } },
      ],
    });
    const result = transport.find("tool.batch.result") as {
      results: { tool: string; ok: boolean; error?: { code: string } }[];
    };
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ tool: "tabs.list", ok: true });
    expect(result.results[1]).toMatchObject({ tool: "tabs.close", ok: false, error: { code: "PERMISSION_DENIED" } });
  });

  it("runs the full approval lifecycle for a sensitive tool", async () => {
    const { transport, handler } = setup();

    // 1. Without approval the call is rejected.
    await handler.handle({ type: "tool.call", id: "t2", tool: "clipboard.read", input: {} });
    expect(transport.find("tool.error")).toMatchObject({ id: "t2", error: { code: "APPROVAL_REQUIRED" } });

    // 2. Explicit approval request creates a pending record.
    await handler.handle({ type: "approval.request", id: "a1", tool: "clipboard.read", input: {} });
    const requested = transport.find("approval.requested") as { approval: { id: string } };
    expect(requested.approval.id).toBeTruthy();

    // 3. The user approves.
    await handler.handle({ type: "approval.respond", id: "a2", approvalId: requested.approval.id, approved: true });
    expect(transport.find("approval.resolved")).toMatchObject({ approvalId: requested.approval.id, approved: true });

    // 4. Retry with the token succeeds and returns the clipboard value.
    await handler.handle({ type: "tool.call", id: "t3", tool: "clipboard.read", input: {}, approvalId: requested.approval.id });
    const result = transport.messages.filter((m) => m.type === "tool.result").pop() as { result: { text: string } };
    expect(result.result.text).toBe("secret-value");
  });

  it("ignores client-supplied approval flags on tool input", async () => {
    const { transport, handler } = setup();

    // A client asserting its own approval must NOT self-approve: the call
    // still requires a broker approval, even with every flag variant set.
    await handler.handle({
      type: "tool.call",
      id: "t-flag",
      tool: "clipboard.read",
      input: { confirmed: true, userApproved: true, approved: true },
    });
    const error = transport.find("tool.error");
    expect(error).toMatchObject({ id: "t-flag", error: { code: "APPROVAL_REQUIRED" } });
    expect(transport.find("tool.result")).toBeUndefined();
  });

  it("responds to ping and cancel", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "ping", id: "p" });
    expect(transport.find("pong")).toMatchObject({ id: "p" });
    await handler.handle({ type: "cancel", id: "c", targetId: "nope" });
    expect(transport.find("cancelled")).toMatchObject({ targetId: "nope" });
  });

  it("cancels a dashboard approval wait", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "approval.request", id: "a1", tool: "clipboard.read", input: {} });
    const requested = transport.find("approval.requested") as { approval: { id: string } };
    await handler.handle({ type: "approval.wait", id: "w1", approvalId: requested.approval.id });
    await handler.handle({ type: "cancel", id: "c1", targetId: "w1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transport.messages.filter((m) => m.type === "approval.resolved" && m.id === "w1")).toHaveLength(1);
    expect(transport.messages.find((m) => m.type === "approval.resolved" && m.id === "w1")).toMatchObject({ approved: false });
  });

  it("a client-less single call executes but emits no activity row (gateway housekeeping)", async () => {
    // The gateway's own tab-count probe behind the dashboard browsers
    // list arrives with no client: the socket message only carries
    // client when the gateway call had one. It must still execute and
    // return its result — but it must not plant a phantom "Checked
    // tabs" row in the feed/history.
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
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
    });
    await handler.handle({ type: "tool.call", id: "t-house", tool: "tabs.list", input: {} });
    expect(transport.find("tool.result")).toMatchObject({ id: "t-house", dryRun: false });
    expect(events).toHaveLength(0);
  });

  it("the same call with a client still emits its activity row (AI grounding read)", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
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
    });
    await handler.handle({ type: "tool.call", id: "t-ai", tool: "tabs.list", input: {}, client: { id: "c", name: "C", transport: "native" } });
    expect(transport.find("tool.result")).toMatchObject({ id: "t-ai", dryRun: false });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: "tabs.list", state: "running", summary: "Checked tabs" });
    expect(events[1]).toMatchObject({ tool: "tabs.list", state: "done", summary: "Checked tabs" });
  });

  it("a client-less batch executes but emits no activity rows", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
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
    });
    await handler.handle({
      type: "tool.call.batch",
      id: "b-house",
      calls: [{ tool: "tabs.list", input: {} }],
    });
    const result = transport.find("tool.batch.result") as { results: { tool: string; ok: boolean }[] };
    expect(result.results).toEqual([{ tool: "tabs.list", ok: true, result: expect.anything(), dryRun: false, durationMs: expect.anything() }]);
    expect(events).toHaveLength(0);
  });

  it("a client-less action is still gated with TASK_REQUIRED (silence is not a bypass)", async () => {
    // silentActivity suppresses only the row: a client-less bridge
    // call is not extension-initiated, so the enforcement gate must
    // still reject a direct action exactly as it does for a call with
    // a client. This pins the difference from `internal`, which would
    // have bypassed the gate.
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
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
    });
    await handler.handle({ type: "tool.call", id: "t-gate", tool: "tabs.close", input: { tabId: 1 } });
    expect(transport.find("tool.error")).toMatchObject({ id: "t-gate", error: { code: "TASK_REQUIRED" } });
    expect(events).toHaveLength(0);
  });
});
