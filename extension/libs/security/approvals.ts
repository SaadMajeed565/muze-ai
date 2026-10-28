import { ToolErrorException, type CallTargetHint, type ClientIdentity, type RiskLevel } from "../tool-contracts/index.js";

export type ApprovalStatus = "pending" | "approved" | "denied" | "used" | "expired" | "cancelled";

export interface ApprovalRecord {
  id: string;
  tool: string;
  summary: string;
  risk: RiskLevel;
  target?: CallTargetHint;
  client: ClientIdentity;
  fingerprint: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

export interface CreateApprovalInput {
  tool: string;
  risk: RiskLevel;
  summary: string;
  client: ClientIdentity;
  input: unknown;
  target?: CallTargetHint;
  ttlMs?: number;
}

export interface ApprovalBrokerOptions {
  ttlMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

/**
 * Issues short-lived, single-use approval tokens bound to an exact operation
 * (tool + input + client). An approval for "fill form X" can never authorize a
 * later "submit form X" or a different target.
 */
export class ApprovalBroker {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `apv_${randomId(18)}`);
  }

  create(input: CreateApprovalInput): ApprovalRecord {
    this.purgeExpired();
    const now = this.now();
    const record: ApprovalRecord = {
      id: this.idFactory(),
      tool: input.tool,
      summary: input.summary,
      risk: input.risk,
      target: input.target,
      client: input.client,
      fingerprint: fingerprintOperation(input.tool, input.input, input.client.id),
      status: "pending",
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
    };
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ApprovalRecord | undefined {
    const record = this.records.get(id);
    if (record && record.status === "pending" && record.expiresAt <= this.now()) {
      record.status = "expired";
    }
    return record;
  }

  list(status?: ApprovalStatus): ApprovalRecord[] {
    this.purgeExpired();
    const all = [...this.records.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }

  pendingCount(): number {
    this.purgeExpired();
    return [...this.records.values()].filter((r) => r.status === "pending").length;
  }

  approve(id: string, decidedBy = "user"): ApprovalRecord {
    const record = this.requirePending(id);
    record.status = "approved";
    record.decidedAt = this.now();
    record.decidedBy = decidedBy;
    return record;
  }

  deny(id: string, reason?: string): ApprovalRecord {
    const record = this.requirePending(id);
    record.status = "denied";
    record.decidedAt = this.now();
    record.reason = reason;
    return record;
  }

  /**
   * Burn an approved token without re-checking its fingerprint. Used
   * only by the service worker's plan-approval verification, which
   * already checked tool (tasks.approvePlan), approved status, and
   * client match before calling this. Returns false unless the record
   * was approved at call time.
   */
  markUsed(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== "approved") return false;
    record.status = "used";
    record.decidedAt = record.decidedAt ?? this.now();
    return true;
  }

  cancel(id: string): ApprovalRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.status === "pending" || record.status === "approved") {
      record.status = "cancelled";
      record.decidedAt = this.now();
    }
    return record;
  }

  cancelForClient(clientId: string): string[] {
    const cancelled: string[] = [];
    for (const record of this.records.values()) {
      if (record.client.id === clientId && (record.status === "pending" || record.status === "approved")) {
        record.status = "cancelled";
        cancelled.push(record.id);
      }
    }
    return cancelled;
  }

  /**
   * Validate and burn an approval token immediately before execution.
   * Throws a typed error when the token is missing, mismatched, expired or used.
   */
  consume(id: string, expected: { tool: string; input: unknown; clientId: string }): ApprovalRecord {
    const record = this.records.get(id);
    if (!record) throw new ToolErrorException("APPROVAL_DENIED", "Unknown approval token");
    if (record.expiresAt <= this.now()) {
      record.status = "expired";
      throw new ToolErrorException("APPROVAL_EXPIRED", "Approval has expired");
    }
    if (record.status === "denied") throw new ToolErrorException("APPROVAL_DENIED", "Approval was denied");
    if (record.status === "cancelled") throw new ToolErrorException("APPROVAL_DENIED", "Approval was cancelled");
    if (record.status === "used") throw new ToolErrorException("APPROVAL_DENIED", "Approval token was already used");
    if (record.status !== "approved") throw new ToolErrorException("APPROVAL_REQUIRED", "Approval is still pending");

    const expectedFp = fingerprintOperation(expected.tool, expected.input, expected.clientId);
    if (record.tool !== expected.tool || record.client.id !== expected.clientId || record.fingerprint !== expectedFp) {
      throw new ToolErrorException("APPROVAL_DENIED", "Approval does not match this operation");
    }

    record.status = "used";
    record.decidedAt = record.decidedAt ?? this.now();
    return record;
  }

  purgeExpired(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if ((record.status === "pending" || record.status === "approved") && record.expiresAt <= now) {
        record.status = "expired";
      }
    }
  }

  private requirePending(id: string): ApprovalRecord {
    const record = this.get(id);
    if (!record) throw new ToolErrorException("APPROVAL_DENIED", "Unknown approval token");
    if (record.status === "expired") throw new ToolErrorException("APPROVAL_EXPIRED", "Approval has expired");
    if (record.status !== "pending") {
      throw new ToolErrorException("CONFLICT", `Approval already ${record.status}`);
    }
    return record;
  }
}

/** Deterministic 128-bit fingerprint binding an approval to an exact operation. */
export function fingerprintOperation(tool: string, input: unknown, clientId: string): string {
  const canonical = canonicalStringify({ tool, input: normalize(input), clientId });
  return cyrb128(canonical);
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Fast deterministic 128-bit string hash (cyrb128), used as a collision-resistant binding. */
function cyrb128(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

export function randomId(bytes = 16): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}
