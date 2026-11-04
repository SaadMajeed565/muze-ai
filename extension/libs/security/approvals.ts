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
  /**
   * Maximum records held. Default 1000: records were previously never
   * deleted (purgeExpired only flips statuses), so a long-lived broker
   * grew without bound. When the cap is hit, the oldest terminal records
   * (expired/denied/used/cancelled) are dropped; pending/approved records
   * are never evicted, so a live approval cannot be lost to the cap.
   */
  maxRecords?: number;
}

/** Default cap on approval records; see ApprovalBrokerOptions.maxRecords. */
export const APPROVAL_BROKER_DEFAULT_MAX_RECORDS = 1000;

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
  private readonly maxRecords: number;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `apv_${randomId(18)}`);
    if (
      options.maxRecords !== undefined &&
      (!Number.isFinite(options.maxRecords) || options.maxRecords <= 0)
    ) {
      throw new RangeError(`ApprovalBroker maxRecords must be finite and > 0, got ${options.maxRecords}`);
    }
    this.maxRecords = Math.floor(options.maxRecords ?? APPROVAL_BROKER_DEFAULT_MAX_RECORDS);
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
      fingerprint: fingerprintOperation(input.tool, input.input, input.client.id, input.target),
      status: "pending",
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? this.ttlMs),
    };
    this.records.set(record.id, record);
    this.evictTerminalPastCap();
    return record;
  }

  /**
   * Bound record growth: drop the oldest terminal records while over the
   * cap. Pending/approved records are live approvals and are never
   * dropped, even if that leaves the map over cap under pathological
   * pending churn (a fail-safe, not a leak: pending records expire via
   * purgeExpired and become evictable on the next create()).
   */
  private evictTerminalPastCap(): void {
    if (this.records.size <= this.maxRecords) return;
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxRecords) return;
      if (record.status !== "pending" && record.status !== "approved") {
        this.records.delete(id);
      }
    }
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
   * only by callers that already checked approved status and client
   * match before calling this. Returns false unless the record
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
  consume(
    id: string,
    expected: { tool: string; input: unknown; clientId: string; target?: CallTargetHint },
  ): ApprovalRecord {
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
    // Fail closed on a target mismatch: a record created with a target
    // must not be consumable by a caller that omits one (that omission
    // would otherwise silently drop the target from the fingerprint).
    if (record.target !== undefined && expected.target === undefined) {
      throw new ToolErrorException("APPROVAL_DENIED", "Approval does not match this operation");
    }

    const expectedFp = fingerprintOperation(expected.tool, expected.input, expected.clientId, expected.target);
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

/**
 * Deterministic 128-bit fingerprint binding an approval to an exact
 * operation (tool + input + client + target hint, when one was given).
 * The target is included only when defined, so fingerprints for
 * target-less approvals are byte-identical to before this change.
 * NOTE: this is a best-effort binding, not a cryptographic commitment —
 * see cyrb128 below. Its strength comes from single-use tokens, the TTL,
 * and the exact-match check in consume(), not from hash strength.
 */
export function fingerprintOperation(
  tool: string,
  input: unknown,
  clientId: string,
  target?: CallTargetHint,
): string {
  const canonical = canonicalStringify({
    tool,
    input: normalize(input),
    clientId,
    ...(target !== undefined ? { target: normalize(target) } : {}),
  });
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

/**
 * Fast deterministic 128-bit string hash (cyrb128). This is a
 * NON-cryptographic hash: it is NOT collision-resistant, and an earlier
 * comment claiming otherwise was wrong. It is used here only as a
 * compact equality check between a stored approval and the operation
 * presented at consume time (both computed in-process, single-use,
 * TTL-bounded); it must never be treated as a signature, a MAC, or
 * proof against a motivated collision search.
 */
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
