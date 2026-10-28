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

  it("produces deterministic 128-bit fingerprints independent of key order", () => {
    const first = fingerprintOperation("t", { a: 1, b: 2 }, "c");
    expect(first).toBe(fingerprintOperation("t", { b: 2, a: 1 }, "c"));
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(fingerprintOperation("t", { a: 2, b: 1 }, "c"));
    expect(first).not.toBe(fingerprintOperation("t", { a: 1, b: 2 }, "d"));
  });
});
