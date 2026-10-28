import { describe, expect, it } from "vitest";
import { PERMISSION_MODES, PolicyEngine } from "../libs/security/policy.js";
import { TOOL_SCHEMAS, type ClientIdentity } from "../libs/tool-contracts/index.js";

const client: ClientIdentity = { id: "c1", name: "Client", transport: "native" };
const tool = (name: string) => TOOL_SCHEMAS.find((t) => t.name === name)!;

describe("permission levels", () => {
  it("exposes exactly three levels", () => {
    expect([...PERMISSION_MODES]).toEqual(["restricted", "default", "unrestricted"]);
  });

  it("starts in the default level", () => {
    const policy = new PolicyEngine();
    expect(policy.getMode()).toBe("default");
    expect(policy.getConfig().mode).toBe("default");
  });

  describe("restricted", () => {
    const policy = new PolicyEngine({ mode: "restricted" });

    it("allows read-only tools", () => {
      expect(policy.decide(tool("tabs.list"), client).allowed).toBe(true);
      expect(policy.decide(tool("page.read"), client).allowed).toBe(true);
      expect(policy.decide(tool("dom.find"), client).allowed).toBe(true);
      expect(policy.decide(tool("page.extract"), client).allowed).toBe(true);
      expect(policy.decide(tool("page.snapshot"), client).allowed).toBe(true);
    });

    it("refuses every action that changes something", () => {
      for (const name of ["dom.click", "forms.fill", "forms.submit", "tabs.create", "tabs.navigate", "navigation.open", "clipboard.write"]) {
        expect(policy.decide(tool(name), client).allowed, name).toBe(false);
      }
    });

    it("refuses reads of personal data", () => {
      for (const name of ["clipboard.read", "history.search", "bookmarks.list", "downloads.list"]) {
        expect(policy.decide(tool(name), client).allowed, name).toBe(false);
      }
    });

    it("never asks for an approval, it just refuses", () => {
      expect(policy.approvalEnforced()).toBe(false);
      for (const schema of TOOL_SCHEMAS) {
        expect(policy.decide(schema, client).requiresApproval, schema.name).toBe(false);
      }
    });
  });

  describe("default", () => {
    const policy = new PolicyEngine({ mode: "default" });

    it("runs reading and reversible actions without a prompt", () => {
      for (const name of ["tabs.list", "page.read", "page.extract", "page.snapshot", "dom.find", "dom.click", "forms.fill"]) {
        const decision = policy.decide(tool(name), client);
        expect(decision.allowed, name).toBe(true);
        expect(decision.requiresApproval, name).toBe(false);
      }
    });

    it("asks once for sensitive reads and consequential actions", () => {
      for (const name of ["clipboard.read", "history.search", "bookmarks.list", "page.dialogs", "forms.submit", "history.delete"]) {
        const decision = policy.decide(tool(name), client);
        expect(decision.allowed, name).toBe(true);
        expect(decision.requiresApproval, name).toBe(true);
      }
    });

    it("has zero restricted-tier tools today, and denies a synthetic restricted-risk definition", () => {
      // Deliberately NOT vacuous: the old test looped over the (empty) set
      // of restricted tools, so it passed no matter what. No new tool was
      // invented just to make this test pass; instead the test pins the
      // current fact (zero restricted tools) and the gate that would stop
      // one. Note decide() canonicalises risk from the registry, so an
      // unregistered synthetic definition is denied by the unknown-tool
      // gate; the restricted tier itself is closed in this level because
      // allowByRisk.restricted is false, which is asserted directly.
      const restricted = TOOL_SCHEMAS.filter((t) => t.risk === "restricted");
      expect(restricted).toEqual([]);
      expect(policy.getConfig().allowByRisk.restricted).toBe(false);
      const synthetic = {
        name: "synthetic.restricted",
        title: "Synthetic restricted",
        description: "A definition that must never run",
        category: "page" as const,
        risk: "restricted" as const,
        requiresApproval: true,
        input: TOOL_SCHEMAS[0].input,
        output: TOOL_SCHEMAS[0].output,
      };
      expect(policy.decide(synthetic, client).allowed).toBe(false);
    });
  });

  describe("unrestricted", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });

    it("allows every registered tool without a prompt", () => {
      for (const schema of TOOL_SCHEMAS) {
        const decision = policy.decide(schema, client);
        expect(decision.allowed, schema.name).toBe(true);
        expect(decision.requiresApproval, schema.name).toBe(false);
      }
    });
  });

  it("keeps a manual per-tool decision across a level change", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });
    policy.setToolAllowed("clipboard.read", false);
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);

    policy.setMode("restricted");
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);

    policy.setMode("unrestricted");
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);
  });

  it("lets a manual allow hand one tool back inside a level", () => {
    const policy = new PolicyEngine({ mode: "restricted" });
    expect(policy.decide(tool("dom.click"), client).allowed).toBe(false);

    policy.setToolAllowed("dom.click", true);
    expect(policy.decide(tool("dom.click"), client).allowed).toBe(true);
  });

  it("still refuses a manually allowed tool when its permission group is off", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });
    policy.setToolAllowed("history.search", true);
    policy.setGroupEnabled("history", false);
    expect(policy.decide(tool("history.search"), client).allowed).toBe(false);
  });

  it("never lets a manual allow beat the kill switch", () => {
    const policy = new PolicyEngine({ mode: "unrestricted" });
    policy.setToolAllowed("clipboard.read", true);
    policy.engageKillSwitch();
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);
  });

  it("never lets a manual allow beat a client policy", () => {
    const policy = new PolicyEngine({ mode: "unrestricted", clients: { c1: { deniedTools: ["clipboard.read"] } } });
    policy.setToolAllowed("clipboard.read", true);
    expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);
  });

  it("applies a mode through setConfig as well", () => {
    const policy = new PolicyEngine();
    policy.setConfig({ mode: "restricted" });
    expect(policy.getMode()).toBe("restricted");
    expect(policy.decide(tool("dom.click"), client).allowed).toBe(false);
  });

  describe("resetting the overrides", () => {
    it("drops the manual per-tool decisions", () => {
      const policy = new PolicyEngine({ mode: "unrestricted" });
      policy.setToolAllowed("clipboard.read", false);
      policy.resetOverrides();
      expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(true);
    });

    it("turns the permission groups back on", () => {
      const policy = new PolicyEngine({ mode: "unrestricted" });
      policy.setGroupEnabled("history", false);
      policy.resetOverrides();
      expect(policy.decide(tool("history.search"), client).allowed).toBe(true);
    });

    it("keeps the level the user chose", () => {
      const policy = new PolicyEngine({ mode: "restricted" });
      policy.setToolAllowed("dom.click", true);
      policy.resetOverrides();
      expect(policy.getMode()).toBe("restricted");
      expect(policy.decide(tool("dom.click"), client).allowed).toBe(false);
    });

    it("never releases the kill switch", () => {
      const policy = new PolicyEngine({ mode: "unrestricted" });
      policy.engageKillSwitch();
      policy.resetOverrides();
      expect(policy.getConfig().killSwitch).toBe(true);
      expect(policy.decide(tool("clipboard.read"), client).allowed).toBe(false);
    });

    it("keeps the blocked domains", () => {
      const policy = new PolicyEngine({ mode: "unrestricted", blockedDomains: ["bank.com"] });
      policy.resetOverrides();
      expect(policy.getConfig().blockedDomains).toEqual(["bank.com"]);
    });
  });
});
