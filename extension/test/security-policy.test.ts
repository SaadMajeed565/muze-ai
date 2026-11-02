import { describe, expect, it } from "vitest";
import { TOOL_SCHEMAS, type ClientIdentity, type RiskLevel } from "../libs/tool-contracts/index.js";
import { MODE_PRESETS, PolicyEngine } from "../libs/security/policy.js";
import { AuditLog } from "../libs/security/audit.js";
import { redact } from "../libs/security/redact.js";

const client: ClientIdentity = { id: "c1", name: "Client", transport: "native" };
const tool = (name: string) => TOOL_SCHEMAS.find((t) => t.name === name)!;

describe("PolicyEngine", () => {
  it("allows every tool by default", () => {
    const policy = new PolicyEngine();
    expect(policy.decide(tool("tabs.list"), client).allowed).toBe(true);
    expect(policy.decide(tool("forms.submit"), client).allowed).toBe(true);
    expect(policy.decide(tool("screenshots.visible"), client).allowed).toBe(true);
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(true);
    expect(policy.decide(tool("history.delete"), client).allowed).toBe(true);
  });

  it("requires approval for sensitive reads and consequential actions in the default level", () => {
    const policy = new PolicyEngine();
    expect(policy.getMode()).toBe("default");
    expect(policy.approvalEnforced()).toBe(true);
    expect(policy.decide(tool("clipboard.read"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("forms.submit"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("tabs.list"), client).requiresApproval).toBe(false);
  });

  it("requires no approval in the unrestricted level", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });
    expect(policy.decide(tool("clipboard.read"), client).requiresApproval).toBe(false);
    expect(policy.decide(tool("forms.submit"), client).requiresApproval).toBe(false);
    expect(policy.approvalEnforced()).toBe(false);
  });

  it("enables every optional permission group by default", () => {
    const policy = new PolicyEngine();
    expect(policy.decide(tool("history.search"), client).allowed).toBe(true);
    expect(policy.decide(tool("bookmarks.list"), client).allowed).toBe(true);
    expect(policy.decide(tool("downloads.list"), client).allowed).toBe(true);
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(true);
  });

  it("requires approval for sensitive reads and consequential actions in risk mode", () => {
    const policy = new PolicyEngine({
      approvalMode: "risk",
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      enabledGroups: { clipboard: true },
    });
    expect(policy.approvalEnforced()).toBe(true);
    expect(policy.decide(tool("clipboard.read"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("forms.submit"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("tabs.list"), client).requiresApproval).toBe(false);
  });

  it("applies the risk tiers when the level switches approvals on", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });
    expect(policy.decide(tool("screenshots.visible"), client).requiresApproval).toBe(false);

    policy.setMode("default");
    expect(policy.approvalEnforced()).toBe(true);
    expect(policy.decide(tool("screenshots.visible"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("forms.submit"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("tabs.list"), client).requiresApproval).toBe(false);
    expect(policy.decide(tool("dom.click"), client).requiresApproval).toBe(false);

    policy.setMode("unrestricted");
    expect(policy.approvalEnforced()).toBe(false);
    expect(policy.decide(tool("screenshots.visible"), client).requiresApproval).toBe(false);
  });

  it("blocks restricted browser pages", () => {
    const policy = new PolicyEngine();
    const decision = policy.decide(tool("page.read"), client, { url: "chrome://extensions" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/restricted/i);
  });

  it("blocks configured domains", () => {
    const policy = new PolicyEngine({ blockedDomains: ["bank.com"] });
    expect(policy.decide(tool("tabs.navigate"), client, { url: "https://www.bank.com/x", domain: "bank.com" }).allowed).toBe(false);
    expect(policy.decide(tool("tabs.navigate"), client, { url: "https://example.com", domain: "example.com" }).allowed).toBe(true);
  });

  it("enforces read-only mode", () => {
    const policy = new PolicyEngine({ readOnlyMode: true });
    expect(policy.decide(tool("tabs.list"), client).allowed).toBe(true);
    expect(policy.decide(tool("tabs.create"), client).allowed).toBe(false);
  });

  it("respects per-client allow/deny lists", () => {
    const policy = new PolicyEngine({ clients: { c1: { deniedTools: ["tabs.create"] } } });
    expect(policy.decide(tool("tabs.create"), client).allowed).toBe(false);
    const allowlisted = new PolicyEngine({ clients: { c1: { allowedTools: ["tabs.list"] } } });
    expect(allowlisted.decide(tool("tabs.get"), client).allowed).toBe(false);
  });

  it("can lock a risk level and a permission group explicitly", () => {
    const policy = new PolicyEngine({ allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: false, restricted: true } });
    expect(policy.decide(tool("forms.submit"), client).allowed).toBe(false);

    const grouped = new PolicyEngine();
    grouped.setGroupEnabled("history", false);
    expect(grouped.decide(tool("history.search"), client).allowed).toBe(false);
    grouped.setGroupEnabled("history", true);
    expect(grouped.decide(tool("history.search"), client).allowed).toBe(true);
  });

  it("never allows restricted risk, even in the unrestricted level", () => {
    // tools.ts defines restricted as never-reachable; the unrestricted
    // preset previously allowed it. No schema tool carries it today, so
    // this is a preventive invariant, including against patches that try
    // to re-enable it (mergePolicy clamps to the level preset).
    expect(MODE_PRESETS.unrestricted.allowByRisk.restricted).toBe(false);
    const policy = new PolicyEngine({ mode: "unrestricted" });
    expect(policy.getConfig().allowByRisk.restricted).toBe(false);
    policy.setConfig({ allowByRisk: { restricted: true } as unknown as Record<RiskLevel, boolean> });
    expect(policy.getConfig().allowByRisk.restricted).toBe(false);
  });

  it("decide() consults the tool definition's own requiresApproval flag", () => {
    // Unrestricted + approvalMode switched to risk: every risk gate says
    // "no approval", so only the tool's own flag can require one.
    const policy = new PolicyEngine({ mode: "unrestricted" });
    policy.setConfig({ approvalMode: "risk" });
    expect(policy.decide(tool("bookmarks.delete"), client).requiresApproval).toBe(true);
    expect(policy.decide(tool("tabs.list"), client).requiresApproval).toBe(false);
    // An explicit per-tool override still wins over the tool flag.
    policy.setConfig({ toolOverrides: { "bookmarks.delete": { requiresApproval: false } } });
    expect(policy.decide(tool("bookmarks.delete"), client).requiresApproval).toBe(false);
    // And approvalMode "never" still means never, regardless of the flag.
    policy.setConfig({ mode: "unrestricted" });
    expect(policy.decide(tool("bookmarks.delete"), client).requiresApproval).toBe(false);
  });

  it("resetOverrides() resets only overrides, not user configuration", () => {
    const policy = new PolicyEngine();
    policy.setToolAllowed("tabs.create", false);
    policy.setGroupEnabled("history", false);
    policy.setConfig({
      clients: { c1: { deniedTools: ["tabs.get"] } },
      maxOutputChars: 1234,
      defaultTimeoutMs: 5000,
      blockedDomains: ["example.com"],
    });
    policy.engageKillSwitch();
    const reset = policy.resetOverrides();
    expect(reset.toolOverrides).toEqual({});
    // The kill switch survives the reset (that is the point), so release
    // it before checking that the tool override itself is gone.
    policy.releaseKillSwitch();
    expect(policy.decide(tool("tabs.create"), client).allowed).toBe(true);
    expect(reset.mode).toBe("default");
    expect(reset.killSwitch).toBe(true);
    // Groups are overrides: reset turns a disabled group back on.
    expect(reset.enabledGroups.history).toBe(true);
    expect(reset.clients.c1.deniedTools).toEqual(["tabs.get"]);
    expect(reset.maxOutputChars).toBe(1234);
    expect(reset.defaultTimeoutMs).toBe(5000);
    expect(reset.blockedDomains).toEqual(["example.com"]);
    expect(policy.decide(tool("tabs.get"), client).allowed).toBe(false);
  });

  it("emergency stop overrides everything", () => {
    const policy = new PolicyEngine();
    policy.engageKillSwitch();
    expect(policy.decide(tool("tabs.list"), client).allowed).toBe(false);
    expect(policy.decide(tool("tabs.list"), client).reason).toMatch(/Emergency/);
    policy.releaseKillSwitch();
    expect(policy.decide(tool("tabs.list"), client).allowed).toBe(true);
  });

  it("increments getVersion() on every mutation, exactly once per call", () => {
    const policy = new PolicyEngine();
    expect(policy.getVersion()).toBe(0);
    policy.setMode("unrestricted");
    expect(policy.getVersion()).toBe(1);
    policy.setConfig({ blockedDomains: ["example.com"] });
    expect(policy.getVersion()).toBe(2);
    // A level change through setConfig is one mutation, so one increment.
    policy.setConfig({ mode: "default" });
    expect(policy.getVersion()).toBe(3);
    policy.setToolAllowed("tabs.create", false);
    expect(policy.getVersion()).toBe(4);
    policy.setGroupEnabled("history", false);
    expect(policy.getVersion()).toBe(5);
    policy.setReadOnlyMode(true);
    expect(policy.getVersion()).toBe(6);
    policy.engageKillSwitch();
    expect(policy.getVersion()).toBe(7);
    policy.releaseKillSwitch();
    expect(policy.getVersion()).toBe(8);
    policy.resetOverrides();
    expect(policy.getVersion()).toBe(9);
    // Client policy changes arrive through setConfig and must bump too, so
    // an executor caching decisions by version cannot serve stale allows.
    policy.setConfig({ clients: { c1: { deniedTools: ["tabs.create"] } } });
    expect(policy.getVersion()).toBe(10);
    // A decision does not mutate, so it must not bump.
    policy.decide(tool("tabs.list"), client);
    expect(policy.getVersion()).toBe(10);
  });
});

describe("audit secret invariant", () => {
  it("stores reason/code-only details unchanged and masks token-shaped values", () => {
    const audit = new AuditLog();
    const clean = audit.record({ kind: "tool.result", decision: "executed", tool: "forms.submit", details: { code: "OK", reason: "Allowed" } });
    expect(clean.details).toEqual({ code: "OK", reason: "Allowed" });
    // A token value must never reach storage, even if a call site slips one in.
    const masked = audit.record({ kind: "tool.result", decision: "executed", details: { token: "sk-secret-value", password: "hunter2" } });
    expect(masked.details).toEqual({ token: "[redacted]", password: "[redacted]" });
  });
});

describe("redact", () => {
  it("masks sensitive keys and truncates long strings", () => {
    const result = redact({ password: "hunter2", token: "abc", nested: { apiKey: "x" }, note: "a".repeat(600) }) as Record<string, unknown>;
    expect(result.password).toBe("[redacted]");
    expect(result.token).toBe("[redacted]");
    expect((result.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect(String(result.note).length).toBeLessThan(600);
  });
});
