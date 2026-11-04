// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { TASK_REQUIRED_MESSAGE, ToolErrorException, type ClientIdentity } from "../libs/tool-contracts/index.js";
import { createTestRuntime } from "../libs/testing/index.js";
import type { ActivityEvent } from "../libs/activity.js";
import { HostProtocolHandler, type BridgeTransport } from "../src/host-protocol.js";
import type { BridgeHostMessage } from "../libs/tool-contracts/index.js";

const client: ClientIdentity = { id: "c1", name: "Client", transport: "native" };

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolErrorException> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(ToolErrorException.is(error)).toBe(true);
    expect((error as ToolErrorException).code).toBe(code);
    return error as ToolErrorException;
  }
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

describe("task-required gate (direct actions rejected, reads free)", () => {
  it("rejects direct granular actions with TASK_REQUIRED and the teachable message", async () => {
    const rt = createTestRuntime();
    for (const [tool, input] of [
      ["dom.click", { ref: "r1", button: "left" }],
      ["tabs.close", { tabId: 1 }],
      ["tabs.navigate", { tabId: 1, url: "https://example.com" }],
      ["forms.submit", { formRef: "r1" }],
      ["clipboard.write", { text: "x" }],
    ] as const) {
      const error = await expectCode(rt.executor.execute({ tool, input, client, ctx: rt.ctx }), "TASK_REQUIRED");
      expect(error.message).toBe(TASK_REQUIRED_MESSAGE);
      expect(error.details).toMatchObject({ tool });
    }
  });

  it("rejects restricted delay waits, which have no granular target", async () => {
    const rt = createTestRuntime();
    await expectCode(rt.executor.execute({ tool: "wait", input: { for: "delay" }, client, ctx: rt.ctx }), "TASK_REQUIRED");
    await expectCode(
      rt.executor.execute({ tool: "navigate", input: { category: "sync", for: "delay" }, client, ctx: rt.ctx }),
      "TASK_REQUIRED",
    );
  });

  it("allows reads without a task, including sensitive reads", async () => {
    const rt = createTestRuntime({ policy: { mode: "unrestricted" } });
    for (const [tool, input] of [
      ["tabs.list", {}],
      ["forms.inspect", {}],
    ] as const) {
      const result = await rt.executor.execute({ tool, input, client, ctx: rt.ctx });
      expect(result.dryRun).toBe(false);
    }
    // A sensitive read still passes the gate in the default policy and
    // then follows the normal approval path (not TASK_REQUIRED).
    const rtDefault = createTestRuntime({ context: { clipboard: "secret" } });
    await expectCode(
      rtDefault.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rtDefault.ctx }),
      "APPROVAL_REQUIRED",
    );
  });

  it("resolves unified calls per action from the canonical tool", async () => {
    const rt = createTestRuntime({ policy: { mode: "unrestricted" } });
    // navigate list resolves to tabs.list (read-only) → allowed.
    const listed = await rt.executor.execute({
      tool: "navigate",
      input: { category: "tab", action: "list" },
      canonical: { tool: "tabs.list", input: {}, calledAs: "navigate" },
      client,
      ctx: rt.ctx,
    });
    expect(listed.dryRun).toBe(false);
    // navigate create resolves to tabs.create (reversible) → rejected.
    await expectCode(
      rt.executor.execute({
        tool: "navigate",
        input: { category: "tab", action: "create", url: "https://example.com" },
        canonical: { tool: "tabs.create", input: { url: "https://example.com" }, calledAs: "navigate" },
        client,
        ctx: rt.ctx,
      }),
      "TASK_REQUIRED",
    );
    // form inspect (read-only) → allowed; form fill (reversible) → rejected.
    await rt.executor.execute({
      tool: "form",
      input: { phase: "inspect" },
      canonical: { tool: "forms.inspect", input: {}, calledAs: "form" },
      client,
      ctx: rt.ctx,
    });
    await expectCode(
      rt.executor.execute({
        tool: "form",
        input: { phase: "fill", fields: [{ ref: "r1", value: "x" }] },
        canonical: { tool: "forms.fill", input: { fields: [{ ref: "r1", value: "x" }] }, calledAs: "form" },
        client,
        ctx: rt.ctx,
      }),
      "TASK_REQUIRED",
    );
  });

  it("rejects direct action dry runs too — a dry run is still a direct action call", async () => {
    const rt = createTestRuntime({ policy: { allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: false } } });
    await expectCode(
      rt.executor.execute({ tool: "tabs.create", input: { url: "https://example.org" }, client, ctx: rt.ctx, dryRun: true }),
      "TASK_REQUIRED",
    );
    // A read dry run still describes without mutating.
    const result = await rt.executor.execute({ tool: "tabs.list", input: {}, client, ctx: rt.ctx, dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  it("a rejected call emits no activity row and consumes no approval budget", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
      onActivity: (e) => events.push(e),
    });
    const approval = rt.approvals.create({ tool: "clipboard.write", risk: "consequential", summary: "write", client, input: { text: "a" } });
    rt.approvals.approve(approval.id);
    await expectCode(
      rt.executor.execute({ tool: "clipboard.write", input: { text: "a" }, client, ctx: rt.ctx, approvalId: approval.id }),
      "TASK_REQUIRED",
    );
    expect(events).toHaveLength(0);
    // The token was not consumed: the same token still executes the
    // same call once it runs inside a task (taskId).
    const result = await rt.executor.execute({
      tool: "clipboard.write",
      input: { text: "a" },
      client,
      ctx: rt.ctx,
      approvalId: approval.id,
      taskId: "task_abc",
    });
    expect(result.dryRun).toBe(false);
  });

  it("task-runner steps, internal calls, and nested invokes are unaffected", async () => {
    const rt = createTestRuntime({ policy: { mode: "unrestricted" } });
    // Task step: action with taskId executes.
    const stepped = await rt.executor.execute({
      tool: "clipboard.write",
      input: { text: "hi" },
      client,
      ctx: rt.ctx,
      taskId: "task_abc",
    });
    expect(stepped.dryRun).toBe(false);
    // Nested invoke: an action invoked from inside a handler runs.
    const nested = await rt.executor.execute({
      tool: "clipboard.write",
      input: { text: "hi" },
      client,
      ctx: rt.ctx,
      nested: true,
    });
    expect(nested.dryRun).toBe(false);
    // Internal housekeeping: a read with internal stays silent but runs.
    const events: ActivityEvent[] = [];
    const rt2 = createTestRuntime({ onActivity: (e) => events.push(e) });
    await rt2.executor.execute({ tool: "tabs.list", input: {}, client, ctx: rt2.ctx, internal: true });
    expect(events).toHaveLength(0);
  });

  it("policy denial still precedes the gate, and invalid input still precedes both", async () => {
    const rt = createTestRuntime({
      policy: { blockedDomains: ["evil.com"] },
      context: { tabs: [{ url: "https://docs.evil.com/secret", title: "Evil", active: true }] },
    });
    await expectCode(
      rt.executor.execute({ tool: "navigation.reload", input: {}, client, ctx: rt.ctx }),
      "PERMISSION_DENIED",
    );
    const rt2 = createTestRuntime();
    await expectCode(rt2.executor.execute({ tool: "tabs.get", input: { tabId: -5 }, client, ctx: rt2.ctx }), "INVALID_INPUT");
  });

  it("bridge single calls: a direct action is rejected, a read executes", async () => {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
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
    await handler.handle({ type: "tool.call", id: "a1", tool: "tabs.close", input: { tabId: 1 } });
    const rejected = transport.last() as { type: string; error: { code: string; message: string } };
    expect(rejected.type).toBe("tool.error");
    expect(rejected.error.code).toBe("TASK_REQUIRED");
    expect(rejected.error.message).toBe(TASK_REQUIRED_MESSAGE);
    await handler.handle({ type: "tool.call", id: "a2", tool: "tabs.list", input: {} });
    expect((transport.last() as { type: string }).type).toBe("tool.result");
    // Unified via the bridge: navigate create resolves to tabs.create → rejected.
    await handler.handle({ type: "tool.call", id: "a3", tool: "navigate", input: { category: "tab", action: "create", url: "https://example.com" } });
    const rejectedUnified = transport.last() as { type: string; error: { code: string } };
    expect(rejectedUnified.type).toBe("tool.error");
    expect(rejectedUnified.error.code).toBe("TASK_REQUIRED");
  });
});
