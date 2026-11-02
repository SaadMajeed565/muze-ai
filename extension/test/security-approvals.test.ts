import { describe, expect, it } from "vitest";
import { ToolErrorException, type ClientIdentity } from "../libs/tool-contracts/index.js";
import { ApprovalBroker, fingerprintOperation } from "../libs/security/approvals.js";

const client: ClientIdentity = { id: "c1", name: "Client", transport: "remote" };

function broker(nowRef = { value: 1000 }) {
  let counter = 0;
  return {
    nowRef,
    broker: new ApprovalBroker({ ttlMs: 1000, now: () => nowRef.value, idFactory: () => `apv_${++counter}` }),
  };
}

describe("ApprovalBroker", () => {
  it("creates single-use tokens bound to the exact operation", () => {
    const { broker: b } = broker();
    const record = b.create({ tool: "forms.submit", risk: "consequential", summary: "submit", client, input: { formRef: "r1" } });
    b.approve(record.id);
    const consumed = b.consume(record.id, { tool: "forms.submit", input: { formRef: "r1" }, clientId: "c1" });
    expect(consumed.status).toBe("used");
    expect(() => b.consume(record.id, { tool: "forms.submit", input: { formRef: "r1" }, clientId: "c1" })).toThrow(/already used/);
  });

  it("rejects an approval reused for a different operation", () => {
    const { broker: b } = broker();
    const record = b.create({ tool: "forms.submit", risk: "consequential", summary: "submit", client, input: { formRef: "r1" } });
    b.approve(record.id);
    expect(() => b.consume(record.id, { tool: "forms.submit", input: { formRef: "r2" }, clientId: "c1" })).toThrow(/does not match/);
  });

  it("rejects an approval used by a different client", () => {
    const { broker: b } = broker();
    const record = b.create({ tool: "clipboard.read", risk: "sensitive-read", summary: "read", client, input: {} });
    b.approve(record.id);
    expect(() => b.consume(record.id, { tool: "clipboard.read", input: {}, clientId: "other" })).toThrow(/does not match/);
  });

  it("expires approvals after the TTL", () => {
    const { broker: b, nowRef } = broker();
    const record = b.create({ tool: "clipboard.read", risk: "sensitive-read", summary: "read", client, input: {} });
    b.approve(record.id);
    nowRef.value += 2000;
    expect(() => b.consume(record.id, { tool: "clipboard.read", input: {}, clientId: "c1" })).toThrow(ToolErrorException);
  });

  it("does not allow consuming a pending approval", () => {
    const { broker: b } = broker();
    const record = b.create({ tool: "clipboard.read", risk: "sensitive-read", summary: "read", client, input: {} });
    expect(() => b.consume(record.id, { tool: "clipboard.read", input: {}, clientId: "c1" })).toThrow(/still pending/);
  });

  it("binds the target hint into the fingerprint", () => {
    const { broker: b } = broker();
    const target = { tabId: 7, url: "https://example.com" };
    const record = b.create({
      tool: "tabs.navigate",
      risk: "reversible",
      summary: "navigate",
      client,
      input: { url: "https://example.com" },
      target,
    });
    b.approve(record.id);
    // Same tool/input/client but a different target must not consume it.
    expect(() =>
      b.consume(record.id, {
        tool: "tabs.navigate",
        input: { url: "https://example.com" },
        clientId: "c1",
        target: { tabId: 8, url: "https://example.com" },
      }),
    ).toThrow(/does not match/);
    // Omitting the target entirely must also fail closed, not silently
    // drop the target from the fingerprint.
    expect(() =>
      b.consume(record.id, { tool: "tabs.navigate", input: { url: "https://example.com" }, clientId: "c1" }),
    ).toThrow(/does not match/);
    // The exact target consumes it.
    const consumed = b.consume(record.id, {
      tool: "tabs.navigate",
      input: { url: "https://example.com" },
      clientId: "c1",
      target,
    });
    expect(consumed.status).toBe("used");
    // Target-less approvals keep their old fingerprints (no behaviour change).
    expect(fingerprintOperation("t", { a: 1 }, "c")).toBe(fingerprintOperation("t", { a: 1 }, "c"));
    expect(fingerprintOperation("t", { a: 1 }, "c", target)).not.toBe(fingerprintOperation("t", { a: 1 }, "c"));
  });

  it("caps record growth by evicting terminal records, never live approvals", () => {
    let n = 0;
    const small = new ApprovalBroker({
      ttlMs: 1000,
      now: () => 1000,
      maxRecords: 3,
      idFactory: () => `apv_${++n}`,
    });
    const mk = (tool: string) => small.create({ tool, risk: "read-only", summary: tool, client, input: {} });
    const r1 = mk("tabs.list");
    const r2 = mk("tabs.get");
    small.deny(r1.id);
    small.deny(r2.id);
    const r3 = mk("tabs.create"); // size 3, at cap
    mk("tabs.close"); // size 4 -> oldest terminal record (r1) evicted
    expect(small.get(r1.id)).toBeUndefined();
    expect(small.get(r2.id)).toBeDefined();
    expect(small.get(r3.id)).toBeDefined();
    // A pending record is never evicted for the cap, even over it.
    const pending = mk("tabs.reload");
    expect(small.get(pending.id)).toBeDefined();
  });

  it("produces deterministic 128-bit fingerprints independent of key order", () => {
    const first = fingerprintOperation("t", { a: 1, b: 2 }, "c");
    expect(first).toBe(fingerprintOperation("t", { b: 2, a: 1 }, "c"));
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(fingerprintOperation("t", { a: 2, b: 1 }, "c"));
    expect(first).not.toBe(fingerprintOperation("t", { a: 1, b: 2 }, "d"));
  });
});
