/**
 * Per-canonical-tool health aggregates (Phase 3). Computed from audit
 * events ONLY. Aggregates contain counts, rates, and averages — never
 * inputs, page content, or screenshots. An event's details are never
 * copied into an aggregate.
 *
 * Counting rules (matching how the executor audits):
 * - A "call" is a tool.result event, plus a tool.call event whose
 *   decision is denied or approval-required (those never reach a result).
 *   Counting both tool.call "allowed" and its tool.result would double
 *   count every successful call, so "allowed" call events are ignored.
 * - success: outcome === "success"; timeout: outcome === "timeout";
 *   error: outcome === "failure" (cancelled is counted separately and
 *   is NOT an error); denied: tool.call decision === "denied";
 *   approvalRequired: tool.call decision === "approval-required".
 * - Rates are over calls; avgLatencyMs is over result events with a
 *   duration; avgOutputSize is over result events with outputSize;
 *   truncatedRate is truncated result events over result events that
 *   report a truncated flag (events without the flag are not counted
 *   in that denominator, so old events do not dilute it to zero).
 * - No auto-disable: a tool that needs attention only gets flagged
 *   (needsAttention) with the reason; disabling stays a user action.
 */
export interface HealthEventInput {
  kind?: string;
  tool?: string;
  decision?: string;
  outcome?: string;
  durationMs?: number;
  outputSize?: number;
  truncated?: boolean;
}

export interface ToolHealthAggregate {
  tool: string;
  calls: number;
  success: number;
  timeout: number;
  error: number;
  cancelled: number;
  denied: number;
  approvalRequired: number;
  successRate: number;
  timeoutRate: number;
  errorRate: number;
  denialRate: number;
  avgLatencyMs: number | null;
  avgOutputSize: number | null;
  truncatedRate: number | null;
  needsAttention: boolean;
  attentionReasons: string[];
}

/** Thresholds for the dashboard "needs attention" filter (documented, not hidden). */
export const HEALTH_ATTENTION_THRESHOLDS = {
  timeoutRate: 0.2,
  errorRate: 0.2,
  denialRate: 0.2,
} as const;

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function aggregateToolHealth(events: HealthEventInput[]): ToolHealthAggregate[] {
  const byTool = new Map<string, {
    calls: number; success: number; timeout: number; error: number; cancelled: number;
    denied: number; approvalRequired: number; latencies: number[]; outputSizes: number[];
    truncatedTrue: number; truncatedReported: number;
  }>();
  for (const event of events) {
    if (!event.tool) continue;
    const bucket = byTool.get(event.tool) ?? {
      calls: 0, success: 0, timeout: 0, error: 0, cancelled: 0,
      denied: 0, approvalRequired: 0, latencies: [], outputSizes: [],
      truncatedTrue: 0, truncatedReported: 0,
    };
    byTool.set(event.tool, bucket);
    if (event.kind === "tool.call") {
      if (event.decision === "denied" || event.decision === "approval-required") {
        bucket.calls += 1;
        if (event.decision === "denied") bucket.denied += 1;
        else bucket.approvalRequired += 1;
      }
      // "allowed" call events are ignored: the tool.result follows.
      continue;
    }
    if (event.kind !== "tool.result") {
      // Non-result events (policy changes, approvals, etc.) are not calls.
      continue;
    }
    bucket.calls += 1;
    if (event.outcome === "success") bucket.success += 1;
    else if (event.outcome === "timeout") bucket.timeout += 1;
    else if (event.outcome === "failure") bucket.error += 1;
    else if (event.outcome === "cancelled") bucket.cancelled += 1;
    if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) bucket.latencies.push(event.durationMs);
    if (typeof event.outputSize === "number" && Number.isFinite(event.outputSize)) bucket.outputSizes.push(event.outputSize);
    if (typeof event.truncated === "boolean") {
      bucket.truncatedReported += 1;
      if (event.truncated) bucket.truncatedTrue += 1;
    }
  }
  const out: ToolHealthAggregate[] = [];
  for (const [tool, b] of byTool) {
    const timeoutRate = rate(b.timeout, b.calls);
    const errorRate = rate(b.error, b.calls);
    const denialRate = rate(b.denied, b.calls);
    const reasons: string[] = [];
    if (timeoutRate >= HEALTH_ATTENTION_THRESHOLDS.timeoutRate) reasons.push(`high timeout rate (${Math.round(timeoutRate * 100)}%)`);
    if (errorRate >= HEALTH_ATTENTION_THRESHOLDS.errorRate) reasons.push(`high error rate (${Math.round(errorRate * 100)}%)`);
    if (denialRate >= HEALTH_ATTENTION_THRESHOLDS.denialRate) reasons.push(`high denial rate (${Math.round(denialRate * 100)}%)`);
    out.push({
      tool,
      calls: b.calls,
      success: b.success,
      timeout: b.timeout,
      error: b.error,
      cancelled: b.cancelled,
      denied: b.denied,
      approvalRequired: b.approvalRequired,
      successRate: rate(b.success, b.calls),
      timeoutRate,
      errorRate,
      denialRate,
      avgLatencyMs: b.latencies.length > 0 ? b.latencies.reduce((a, x) => a + x, 0) / b.latencies.length : null,
      avgOutputSize: b.outputSizes.length > 0 ? b.outputSizes.reduce((a, x) => a + x, 0) / b.outputSizes.length : null,
      truncatedRate: b.truncatedReported > 0 ? b.truncatedTrue / b.truncatedReported : null,
      needsAttention: reasons.length > 0,
      attentionReasons: reasons,
    });
  }
  out.sort((a, b) => a.tool.localeCompare(b.tool));
  return out;
}

/** Dashboard filters: high timeout, high error, high denial, needs attention. */
export function filterHealth(
  aggregates: ToolHealthAggregate[],
  filter: "all" | "high-timeout" | "high-error" | "high-denial" | "needs-attention",
): ToolHealthAggregate[] {
  switch (filter) {
    case "high-timeout": return aggregates.filter((a) => a.timeoutRate >= HEALTH_ATTENTION_THRESHOLDS.timeoutRate);
    case "high-error": return aggregates.filter((a) => a.errorRate >= HEALTH_ATTENTION_THRESHOLDS.errorRate);
    case "high-denial": return aggregates.filter((a) => a.denialRate >= HEALTH_ATTENTION_THRESHOLDS.denialRate);
    case "needs-attention": return aggregates.filter((a) => a.needsAttention);
    default: return aggregates;
  }
}
