import { describe, expect, it } from "vitest";
import { TOOL_SCHEMAS, ToolErrorException, type ClientIdentity } from "../libs/tool-contracts/index.js";
import { createTestRuntime } from "../libs/testing/index.js";

const readClient: ClientIdentity = { id: "c1", name: "Client", transport: "native" };

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(ToolErrorException.is(error)).toBe(true);
    expect((error as ToolErrorException).code).toBe(code);
  }
}

describe("ToolExecutor pipeline", () => {
  it("rejects unknown tools", async () => {
    const rt = createTestRuntime();
    await expectCode(rt.executor.execute({ tool: "does.notExist", input: {}, client: readClient, ctx: rt.ctx }), "TOOL_NOT_FOUND");
  });

  it("rejects invalid input with details", async () => {
    const rt = createTestRuntime();
    await expectCode(rt.executor.execute({ tool: "tabs.get", input: { tabId: -5 }, client: readClient, ctx: rt.ctx }), "INVALID_INPUT");
  });

  it("executes read-only tools and validates output", async () => {
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx });
    expect(result.dryRun).toBe(false);
    expect((result.result as { tabs: unknown[] }).tabs.length).toBeGreaterThan(0);
  });

  it("denies tools whose risk is not allowed by policy", async () => {
    const rt = createTestRuntime({
      policy: { allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: false, restricted: true } },
    });
    await expectCode(rt.executor.execute({ tool: "forms.submit", input: { formRef: "r1" }, client: readClient, ctx: rt.ctx }), "PERMISSION_DENIED");
  });

  it("allows every tool without an approval prompt in the unrestricted level", async () => {
    const rt = createTestRuntime({ policy: { mode: "unrestricted" }, context: { clipboard: "secret" } });
    for (const schema of TOOL_SCHEMAS) {
      expect(rt.policy.decide(schema, readClient).allowed, schema.name).toBe(true);
      expect(rt.policy.decide(schema, readClient).requiresApproval, schema.name).toBe(false);
    }
    const result = await rt.executor.execute({ tool: "clipboard.read", input: {}, client: readClient, ctx: rt.ctx });
    expect(result.dryRun).toBe(false);
    expect((result.result as { text: string }).text).toBe("secret");
  });

  it("asks for approval on a sensitive read in the default level", async () => {
    const rt = createTestRuntime({ context: { clipboard: "secret" } });
    await expectCode(rt.executor.execute({ tool: "clipboard.read", input: {}, client: readClient, ctx: rt.ctx }), "APPROVAL_REQUIRED");
  });

  it("requires approval, then executes with a valid single-use token", async () => {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
      context: { clipboard: "secret" },
    });
    await expectCode(rt.executor.execute({ tool: "clipboard.read", input: {}, client: readClient, ctx: rt.ctx }), "APPROVAL_REQUIRED");

    const approval = rt.approvals.create({ tool: "clipboard.read", risk: "sensitive-read", summary: "read clipboard", client: readClient, input: {} });
    rt.approvals.approve(approval.id);
    const result = await rt.executor.execute({ tool: "clipboard.read", input: {}, client: readClient, ctx: rt.ctx, approvalId: approval.id });
    expect((result.result as { text: string }).text).toBe("secret");

    // Token is single-use.
    await expectCode(
      rt.executor.execute({ tool: "clipboard.read", input: {}, client: readClient, ctx: rt.ctx, approvalId: approval.id }),
      "APPROVAL_DENIED",
    );
  });

  it("rejects an approval issued for a different target", async () => {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
    });
    const approval = rt.approvals.create({ tool: "clipboard.write", risk: "consequential", summary: "write", client: readClient, input: { text: "a" } });
    rt.approvals.approve(approval.id);
    await expectCode(
      rt.executor.execute({ tool: "clipboard.write", input: { text: "b" }, client: readClient, ctx: rt.ctx, approvalId: approval.id }),
      "APPROVAL_DENIED",
    );
  });

  it("enforces rate limits", async () => {
    const rt = createTestRuntime({ rateLimit: { capacity: 1, refillPerSecond: 0 } });
    await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx });
    await expectCode(rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx }), "RATE_LIMITED");
  });

  it("times out long-running handlers", async () => {
    const rt = createTestRuntime({
      policy: { defaultTimeoutMs: 30 },
      context: { tabs: [{ url: "https://slow.test/", title: "Slow", active: true, status: "loading" }] },
    });
    await expectCode(rt.executor.execute({ tool: "navigation.wait", input: { timeoutMs: 60_000 }, client: readClient, ctx: rt.ctx }), "TIMEOUT");
  });

  it("honours the emergency stop", async () => {
    const rt = createTestRuntime();
    rt.policy.engageKillSwitch();
    await expectCode(rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx }), "PERMISSION_DENIED");
  });

  it("blocks navigation to policy-blocked domains", async () => {
    const rt = createTestRuntime({ policy: { blockedDomains: ["evil.com"] } });
    await expectCode(rt.executor.execute({ tool: "tabs.navigate", input: { tabId: 1, url: "https://evil.com/x" }, client: readClient, ctx: rt.ctx }), "PERMISSION_DENIED");
  });

  it("blocks tab tools whose current page is on a blocked domain", async () => {
    const rt = createTestRuntime({
      policy: { blockedDomains: ["evil.com"] },
      context: { tabs: [{ url: "https://docs.evil.com/secret", title: "Evil", active: true }] },
    });
    await expectCode(
      rt.executor.execute({ tool: "page.read", input: {}, client: readClient, ctx: rt.ctx }),
      "PERMISSION_DENIED",
    );
  });

  it("enforces blocked domains for tools that default to the active tab", async () => {
    const rt = createTestRuntime({
      policy: { blockedDomains: ["evil.com"] },
      context: { tabs: [{ url: "https://docs.evil.com/secret", title: "Evil", active: true }] },
    });
    await expectCode(
      rt.executor.execute({ tool: "navigation.reload", input: {}, client: readClient, ctx: rt.ctx }),
      "PERMISSION_DENIED",
    );
    await expectCode(
      rt.executor.execute({ tool: "browser.observer", input: { enabled: true }, client: readClient, ctx: rt.ctx }),
      "PERMISSION_DENIED",
    );
  });

  it("rejects javascript: navigation before touching the browser", async () => {
    const rt = createTestRuntime();
    await expectCode(rt.executor.execute({ tool: "tabs.navigate", input: { tabId: 1, url: "javascript:alert(1)" }, client: readClient, ctx: rt.ctx }), "INVALID_URL");
  });

  it("dry-run describes without mutating", async () => {
    const rt = createTestRuntime({ policy: { allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: false } } });
    const before = rt.ctx.tabs.size;
    const result = await rt.executor.execute({ tool: "tabs.create", input: { url: "https://example.org" }, client: readClient, ctx: rt.ctx, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(rt.ctx.tabs.size).toBe(before);
  });

  it("audits denials and executions", async () => {
    const rt = createTestRuntime();
    await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx });
    const events = rt.audit.list();
    expect(events.some((e) => e.tool === "tabs.list" && e.decision === "executed")).toBe(true);
  });
});

describe("executor regression fixes", () => {
  it("ignores client-supplied confirmation flags on unified tools", async () => {
    const rt = createTestRuntime();
    // Unified schemas no longer declare confirmed/userApproved at all, so
    // at executor level such a key is rejected as an unknown input field
    // (never treated as approval). At handler level — where a caller could
    // smuggle the flag past validation — the flag must still be ignored:
    // a form submit with confirmed/userApproved set must demand a
    // broker token instead of running.
    await expectCode(
      rt.executor.execute({
        tool: "navigate",
        input: { category: "tab", action: "close", tabId: 1, confirmed: true },
        client: readClient,
        ctx: rt.ctx,
      }),
      "INVALID_INPUT",
    );
    // Handler level: form submit with a client flag must still demand a
    // broker token (tabs.close is reversible and needs no approval under
    // the default policy, so it cannot prove this; form submit can).
    // The invoke wrapper forwards dryRun so requireLegacyApproval's probe
    // stays a probe instead of executing the granular tool.
    const handler = rt.registry.require("form").handler as unknown as (input: unknown, exec: unknown) => Promise<unknown>;
    const invoke = async (name: string, payload: unknown, options?: { dryRun?: boolean }) =>
      (await rt.executor.execute({ tool: name, input: payload, client: readClient, ctx: rt.ctx, dryRun: options?.dryRun })).result;
    const exec = { ctx: rt.ctx, client: readClient, approvalValidated: false, signal: new AbortController().signal, runtime: {}, invoke };
    await expectCode(
      handler({ phase: "submit", formRef: "r1", confirmed: true }, exec),
      "APPROVAL_REQUIRED",
    );
    await expectCode(
      handler({ phase: "submit", formRef: "r1", userApproved: true }, exec),
      "APPROVAL_REQUIRED",
    );
  });

  it("does not double-charge rate-limit tokens for nested invokes", async () => {
    const rt = createTestRuntime({ rateLimit: { capacity: 1, refillPerSecond: 0 } });
    // Same tool, same client key: the top-level call spends the one token.
    await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx });
    // A nested call to the same tool must NOT take a second token.
    const nested = await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx, nested: true });
    expect(nested.result).toBeDefined();
    // And the one token is spent, so a second top-level call is limited.
    await expectCode(rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx }), "RATE_LIMITED");
  });

  it("refreshes the cached runtime snapshot when policy changes", async () => {
    const rt = createTestRuntime();
    const before = await rt.executor.execute({ tool: "browser.permissions", input: {}, client: readClient, ctx: rt.ctx });
    expect((before.result as { allowedTools: string[] }).allowedTools).toContain("tabs.list");
    rt.policy.setToolAllowed("tabs.list", false);
    const after = await rt.executor.execute({ tool: "browser.permissions", input: {}, client: readClient, ctx: rt.ctx });
    expect((after.result as { allowedTools: string[] }).allowedTools).not.toContain("tabs.list");
    expect((after.result as { deniedTools: string[] }).deniedTools).toContain("tabs.list");
  });

  it("reports truncation with total size and a re-call note instead of silently previewing", async () => {
    const rt = createTestRuntime({ policy: { maxOutputChars: 40 } });
    const result = await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx });
    const out = result.result as { truncated?: boolean; totalChars?: number; preview?: string; screenshotOmitted?: boolean; note?: string };
    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBeGreaterThan(40);
    expect(out.preview).toHaveLength(40);
    expect(typeof out.screenshotOmitted).toBe("boolean");
    expect(out.note).toContain("narrower scope");
  });
});
