import { describe, expect, it } from "vitest";
import { createTestRuntime, TEST_CLIENT } from "../libs/testing/index.js";
import { PROTOCOL_VERSION, type BridgeHostMessage } from "../libs/tool-contracts/index.js";
import { RateLimiter } from "../libs/security/index.js";
import { HostProtocolHandler, resolveUnifiedToolCall, type BridgeTransport } from "../src/host-protocol.js";
import { resolveUnifiedAction } from "../libs/tool-contracts/action-risk.js";

class FakeTransport implements BridgeTransport {
  readonly messages: BridgeHostMessage[] = [];
  post(message: BridgeHostMessage): void {
    this.messages.push(message);
  }
  find(type: BridgeHostMessage["type"]): BridgeHostMessage | undefined {
    return this.messages.find((m) => m.type === type);
  }
  lastOf(type: BridgeHostMessage["type"]): BridgeHostMessage | undefined {
    return this.messages.filter((m) => m.type === type).pop();
  }
}

function setup(options: { bookmarks?: { id: string; title: string; url: string; folder: string }[] } = {}) {
  const rt = createTestRuntime({
    policy: {
      approvalMode: "risk",
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      enabledGroups: { clipboard: true, bookmarks: true },
    },
    context: { bookmarks: options.bookmarks },
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

async function requestApproval(
  handler: HostProtocolHandler,
  transport: FakeTransport,
  tool: string,
  input: unknown,
): Promise<string> {
  await handler.handle({ type: "approval.request", id: `a-${Math.random()}`, tool, input });
  const requested = transport.lastOf("approval.requested") as { approval: { id: string; tool: string } };
  expect(requested.approval.id).toBeTruthy();
  return requested.approval.id;
}

describe("canonical resolution (Tool Management Phase 1, section B)", () => {
  it("resolves unified actions to the action-risk table's granular tools", () => {
    expect(resolveUnifiedToolCall("tabs", { action: "list" })).toMatchObject({ tool: "tabs.list", calledAs: "tabs" });
    expect(resolveUnifiedToolCall("tabs", { action: "close", tabId: 1 })).toMatchObject({ tool: "tabs.close", input: { tabId: 1 } });
    expect(resolveUnifiedToolCall("navigate", { category: "tab", action: "close", tabId: 1 })).toMatchObject({ tool: "tabs.close" });
    expect(resolveUnifiedToolCall("data", { domain: "bookmarks", action: "delete", id: "b1" })).toMatchObject({ tool: "bookmarks.delete", input: { id: "b1" } });
    expect(resolveUnifiedToolCall("data", { domain: "bookmarks", action: "list" })).toMatchObject({ tool: "bookmarks.list" });
    // The host resolver agrees with the action-risk table itself.
    expect(resolveUnifiedToolCall("tabs", { action: "close", tabId: 1 })?.tool).toBe(
      resolveUnifiedAction("tabs", "close")?.granularTool,
    );
    expect(resolveUnifiedToolCall("data", { domain: "bookmarks", action: "delete", id: "b1" })?.tool).toBe(
      resolveUnifiedAction("data", "delete", "bookmarks")?.granularTool,
    );
    // Multi-target tools and delay waits have no single granular target.
    expect(resolveUnifiedToolCall("observe", { include: ["text"] })).toBeNull();
    expect(resolveUnifiedToolCall("act", { steps: [] })).toBeNull();
    expect(resolveUnifiedToolCall("wait", { for: "delay", timeoutMs: 100 })).toBeNull();
    expect(resolveUnifiedToolCall("tabs.close", { tabId: 1 })).toBeNull();
    expect(resolveUnifiedToolCall("tasks.create", { goal: "x" })).toBeNull();
  });

  it("rate-limit isolation: heavy tabs.list does not consume the tabs.close bucket", () => {
    // The executor keys rate limits by the canonical tool, so the two
    // buckets below are exactly the keys it charges for a unified
    // tabs.list call and a unified tabs.close call.
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0 });
    expect(limiter.take("client_test:tabs.list").allowed).toBe(true);
    expect(limiter.take("client_test:tabs.list").allowed).toBe(true);
    expect(limiter.take("client_test:tabs.list").allowed).toBe(false);
    // The close bucket is untouched by the exhausted list bucket.
    expect(limiter.take("client_test:tabs.close").allowed).toBe(true);
    expect(limiter.take("client_test:tabs.close").allowed).toBe(true);
    expect(limiter.take("client_test:tabs.close").allowed).toBe(false);
  });

  it("rate-limit isolation through the executor: unified tabs.list calls do not block tabs.close", async () => {
    const rt = createTestRuntime({
      rateLimit: { capacity: 1, refillPerSecond: 0 },
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": false, consequential: false, restricted: true },
      },
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }, { url: "https://b.test/", title: "B" }] },
    });
    // One unified tabs.list call exhausts the tabs.list bucket (capacity 1).
    await rt.executor.execute({
      tool: "tabs",
      input: { action: "list" },
      canonical: { tool: "tabs.list", input: {}, calledAs: "tabs" },
      client: TEST_CLIENT,
      ctx: rt.ctx,
    });
    await expect(
      rt.executor.execute({
        tool: "tabs",
        input: { action: "list" },
        canonical: { tool: "tabs.list", input: {}, calledAs: "tabs" },
        client: TEST_CLIENT,
        ctx: rt.ctx,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // tabs.close still has its own untouched bucket. The mock context's
    // first tab id is 1; closing it succeeds through the unified handler.
    const closed = await rt.executor.execute({
      tool: "tabs",
      input: { action: "close", tabId: 1 },
      canonical: { tool: "tabs.close", input: { tabId: 1 }, calledAs: "tabs" },
      client: TEST_CLIENT,
      ctx: rt.ctx,
    });
    expect(closed.result).toMatchObject({ closed: true });
  });

  it("canonical audit: navigate.close, tabs.close, and granular tabs.close all record as tabs.close", async () => {
    const calls: { tool: string; input: unknown }[] = [
      { tool: "navigate", input: { category: "tab", action: "close", tabId: 1 } },
      { tool: "tabs", input: { action: "close", tabId: 1 } },
      { tool: "tabs.close", input: { tabId: 1 } },
    ];
    for (const call of calls) {
      // Fresh runtime per call (closing consumes the tab); the default
      // mock context has one tab with id 1, which is the tab closed here.
      const { rt, transport, handler } = setup();
      await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: TEST_CLIENT });
      await handler.handle({ type: "tool.call", id: "t1", tool: call.tool, input: call.input });
      const result = transport.lastOf("tool.result");
      expect(result).toBeTruthy();
      const tools = rt.audit.list(100).map((e) => e.tool);
      expect(tools.length).toBeGreaterThan(0);
      // Every audit event for this call names the canonical tool; the
      // unified names never appear as an audit tool.
      expect(tools).not.toContain("navigate");
      expect(tools).not.toContain("tabs");
      expect(tools.every((t) => t === "tabs.close")).toBe(true);
      // The executed record carries the unified name only as calledAs.
      const executed = rt.audit.list(100).find((e) => e.decision === "executed");
      expect(executed?.tool).toBe("tabs.close");
      if (call.tool !== "tabs.close") {
        expect(executed?.details).toMatchObject({ calledAs: call.tool });
      }
    }
  });

  it("canonical audit: data.delete on bookmarks audits as bookmarks.delete, not data", async () => {
    const { rt, transport, handler } = setup({
      bookmarks: [{ id: "b1", title: "Example bookmark", url: "https://example.com/bm", folder: "Bar" }],
    });
    await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: TEST_CLIENT });
    // Without approval the unified data.delete call is refused, and even
    // the refusal is audited under the canonical tool.
    await handler.handle({ type: "tool.call", id: "t1", tool: "data", input: { domain: "bookmarks", action: "delete", id: "b1" } });
    const error = transport.lastOf("tool.error") as { error: { code: string } };
    expect(error.error.code).toBe("APPROVAL_REQUIRED");
    const tools = rt.audit.list(100).map((e) => e.tool);
    expect(tools).not.toContain("data");
    expect(tools).toContain("bookmarks.delete");

    // With a real approval for the canonical operation, the approval is
    // consumed (no APPROVAL_DENIED / APPROVAL_REQUIRED), the granular
    // delete actually runs, and the audit trail still names
    // bookmarks.delete. The unified `data` output schema previously typed
    // `deleted` as a number while granular bookmarks.delete returns
    // `{ deleted: true, id }`, which made this call fail output validation
    // even though the bookmark was deleted; Phase 1 integration fixed the
    // unified output to accept boolean or number, so the call now
    // returns tool.result as well.
    const approvalId = await requestApproval(handler, transport, "data", { domain: "bookmarks", action: "delete", id: "b1" });
    const requested = transport.lastOf("approval.requested") as { approval: { tool: string; calledAs?: string } };
    expect(requested.approval.tool).toBe("bookmarks.delete");
    expect(requested.approval.calledAs).toBe("data");
    await handler.handle({ type: "approval.respond", id: "a2", approvalId, approved: true });
    await handler.handle({ type: "tool.call", id: "t2", tool: "data", input: { domain: "bookmarks", action: "delete", id: "b1" }, approvalId });
    const finalResult = transport.lastOf("tool.result") as { result?: { deleted?: unknown; id?: unknown } };
    expect(finalResult.result?.deleted).toBe(true);
    expect(finalResult.result?.id).toBe("b1");
    expect(rt.ctx.bookmarksStore.find((b) => b.id === "b1")).toBeUndefined();
    expect(rt.audit.list(100).map((e) => e.tool)).not.toContain("data");
    expect(rt.audit.list(100).some((e) => e.tool === "bookmarks.delete" && e.decision === "executed")).toBe(true);
  });

  it("approval isolation: an approval granted for tabs.list does not authorise tabs.close, and vice versa", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: TEST_CLIENT });

    // Approval for the list action, created through the unified name.
    const listApproval = await requestApproval(handler, transport, "tabs", { action: "list" });
    const listRequested = transport.lastOf("approval.requested") as { approval: { tool: string; calledAs?: string } };
    expect(listRequested.approval.tool).toBe("tabs.list");
    expect(listRequested.approval.calledAs).toBe("tabs");
    await handler.handle({ type: "approval.respond", id: "a2", approvalId: listApproval, approved: true });

    // Presenting the list approval on a close call must fail: the broker
    // fingerprint binds granular tool + canonical input + client, and
    // tabs.close + {tabId: 1} is not tabs.list + {}.
    await handler.handle({ type: "tool.call", id: "t-close", tool: "tabs", input: { action: "close", tabId: 1 }, approvalId: listApproval });
    const closeError = transport.lastOf("tool.error") as { error: { code: string } };
    expect(closeError.error.code).toBe("APPROVAL_DENIED");

    // And the reverse: a close approval does not authorise a list call.
    const closeApproval = await requestApproval(handler, transport, "tabs", { action: "close", tabId: 1 });
    await handler.handle({ type: "approval.respond", id: "a3", approvalId: closeApproval, approved: true });
    await handler.handle({ type: "tool.call", id: "t-list", tool: "tabs", input: { action: "list" }, approvalId: closeApproval });
    const listError = transport.lastOf("tool.error") as { error: { code: string } };
    expect(listError.error.code).toBe("APPROVAL_DENIED");
  });

  it("batch: a unified read item is allowed and a unified non-read item is refused as before", async () => {
    const { transport, handler } = setup();
    await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: TEST_CLIENT });
    await handler.handle({
      type: "tool.call.batch",
      id: "b1",
      calls: [
        { tool: "tabs", input: { action: "list" } },
        { tool: "tabs", input: { action: "close", tabId: 1 } },
      ],
    });
    const result = transport.find("tool.batch.result") as {
      results: { tool: string; ok: boolean; error?: { code: string; details?: unknown } }[];
    };
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ tool: "tabs", ok: true });
    expect(result.results[1]).toMatchObject({ tool: "tabs", ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(result.results[1].error?.details).toMatchObject({ tool: "tabs.close" });
  });
});
