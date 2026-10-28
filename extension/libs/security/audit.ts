import type { ClientIdentity, RiskLevel } from "../tool-contracts/index.js";
import { redact } from "./redact.js";

export type AuditDecision = "allowed" | "approval-required" | "denied" | "error" | "executed" | "preflight-unavailable";
export type AuditOutcome = "success" | "failure" | "cancelled" | "timeout";

export interface AuditEvent {
  id: string;
  at: string;
  kind: "tool.call" | "tool.result" | "policy.change" | "client.connect" | "client.disconnect" | "approval" | "kill-switch" | "token.reveal" | "token.rotate";
  tool?: string;
  client?: ClientIdentity;
  risk?: RiskLevel;
  decision: AuditDecision;
  outcome?: AuditOutcome;
  durationMs?: number;
  /** Bounded result size in characters (health aggregates only; never content). */
  outputSize?: number;
  /** Whether the bounded result was truncated (health aggregates only). */
  truncated?: boolean;
  details?: unknown;
}

export interface AuditLogOptions {
  maxEvents?: number;
  now?: () => number;
  idFactory?: () => string;
}

/**
 * Bounded, in-memory audit log. Every record passes through redaction so that
 * tokens, cookies and credentials never reach storage or logs.
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private counter = 0;

  constructor(options: AuditLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => `audit_${(this.counter += 1)}`);
  }

  /**
   * Record one event. Invariant: details are passed through redact() here,
   * and call sites pass reason/code only — never a token, secret, cookie or
   * credential value. A test pins this: an event whose details carry a
   * token-shaped value under a sensitive key is stored masked, and the
   * reason/code-only shape is stored unchanged.
   */
  record(event: Omit<AuditEvent, "id" | "at"> & { at?: string }): AuditEvent {
    const full: AuditEvent = {
      id: this.idFactory(),
      at: event.at ?? new Date(this.now()).toISOString(),
      ...event,
      details: event.details === undefined ? undefined : redact(event.details),
    };
    this.events.push(full);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return full;
  }

  list(limit = 100): AuditEvent[] {
    return this.events.slice(-limit).reverse();
  }

  size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}
