import { ToolErrorException, deprecatedUnifiedAction, toToolError, toolRequiresApproval, type ClientIdentity, type ToolDefinition } from "../tool-contracts/index.js";
import { activityVerb, type ActivityEvent, type ActivityState } from "../activity.js";
import { validateNavigableUrl, type ApprovalBroker, type AuditLog, type PolicyEngine, type PolicyTarget, type RateLimiter } from "../security/index.js";
import type { BrowserContext } from "./context.js";
import type { RuntimeSnapshot, ToolRegistry } from "./registry.js";

export interface ExecuteOptions {
  tool: string;
  input: unknown;
  client: ClientIdentity;
  ctx: BrowserContext;
  approvalId?: string;
  /**
   * Internal only, set only by the extension TaskRunner's service-worker
   * executeStep when the runner has verified an active, in-bounds plan
   * approval (broker token, dashboard decision, or verified elicitation).
   * It is NOT a tool-input field and is never forwarded from an MCP call,
   * so a client cannot set it. Policy checks still run per tool; this
   * only satisfies the approval gate for in-bounds plan steps.
   */
  planApproved?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  target?: PolicyTarget;
  timeoutMs?: number;
  /** Nested workflow invoke: skip a second rate-limit token, keep approvalId. */
  nested?: boolean;
  /**
   * Internal housekeeping (e.g. the task runner's own pre/post-step
   * observe calls): skips live-activity emission ONLY, following the
   * nested precedent. Policy, approval, audit, and rate limiting all
   * still run; the call simply never becomes a timeline row, so the
   * feed shows AI-driven executions only.
   */
  internal?: boolean;
  /**
   * Phase 1 canonicalisation (Tool Management Plan section 2.2), supplied
   * by the host protocol when `tool` is a unified tool that resolved to
   * one granular tool. `tool` still names the tool to execute (the
   * unified handler); `canonical.tool` is the name used for the rate
   * limit key, every audit record, approval consumption, and error
   * details, and `canonical.calledAs` (the unified name) is debug-only
   * and is never used for a security decision. `canonical.input` is the
   * granular input the approval was fingerprinted against; it is NOT
   * the input the handler executes with (that stays the unified input).
   * Absent for granular calls, which are already canonical.
   */
  canonical?: { tool: string; input: unknown; calledAs?: string };
}

export interface ExecuteResult {
  result: unknown;
  dryRun: boolean;
  durationMs: number;
}

export interface ExecutorDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  /** Extra runtime fields contributed by the host (bridge status, clients). */
  runtime?: Partial<RuntimeSnapshot> | (() => Partial<RuntimeSnapshot>);
  /**
   * Live activity feed sink. Called once when an execution truly begins
   * and once when it resolves (done/failed), for top-level calls only.
   * Best-effort: the executor never fails a call for a broken listener.
   * Absent in tests that do not observe activity.
   */
  onActivity?: (event: ActivityEvent) => void;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * The single authorization + execution pipeline. Every tool call from every
 * transport (native messaging, remote MCP, dashboard) goes through here, so the
 * permission model cannot be bypassed.
 */
export class ToolExecutor {
  /**
   * Cached allowed/denied tool lists per client, keyed by the policy version.
   * Only the policy-derived lists are cached; pendingApprovals / auditEvents
   * are still read fresh on every call because they change per call.
   */
  private runtimeCache = new Map<string, {
    key: string;
    toolCount: number;
    categories: string[];
    enabledGroups: Record<string, boolean>;
    readOnlyMode: boolean;
    killSwitch: boolean;
    allowedTools: string[];
    deniedTools: string[];
  }>();

  constructor(private readonly deps: ExecutorDeps) {}

  /** Per-instance activity ids: unique within one executor's lifetime. */
  private activityCounter = 0;

  /**
   * Live activity emission. Best-effort by contract: a broken listener
   * must never break execution, and an absent listener is a no-op.
   * Returns the event id so a later completion resolves the same row.
   */
  private emitActivity(tool: string, state: ActivityState, id: string | null = null): string | null {
    if (typeof this.deps.onActivity !== "function") return null;
    const eventId = id ?? `act_${(this.activityCounter += 1)}`;
    try {
      this.deps.onActivity({ kind: "activity", id: eventId, tool, summary: activityVerb(tool), state, at: Date.now() });
    } catch {
      // Observability only; never fail the call for it.
    }
    return eventId;
  }

  /** Resolve a started row; a null id (no listener, or a nested/internal call) is a no-op. */
  private endActivity(id: string | null, tool: string, state: "done" | "failed"): void {
    if (id === null) return;
    this.emitActivity(tool, state, id);
  }

  /**
   * Policy version key for the runtime cache. Prefer PolicyEngine.getVersion()
   * when another section adds it (it increments on every mutation); until
   * then fall back to a hash of the full policy config JSON, which changes
   * on any mutation including per-client and per-tool overrides.
   */
  private policyVersionKey(): string {
    const maybeVersioned = this.deps.policy as PolicyEngine & { getVersion?: () => number };
    if (typeof maybeVersioned.getVersion === "function") {
      return `v${maybeVersioned.getVersion()}`;
    }
    const configJson = JSON.stringify(this.deps.policy.getConfig());
    let hash = 2166136261;
    for (let i = 0; i < configJson.length; i++) {
      hash ^= configJson.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(36)}`;
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const tool = this.deps.registry.require(options.tool);
    const started = Date.now();
    // Canonical name for rate limiting, audit, approval, and errors.
    // For a resolved unified call this is the granular tool; otherwise
    // the tool itself. calledAs is debug-only, never a security input.
    const auditTool = options.canonical?.tool ?? tool.name;
    const calledAs = options.canonical?.calledAs;
    // Phase 3 deprecation warning for audit: computed after input parsing
    // (below) and merged into every audit record for the call. It never
    // blocks the call — deprecated actions still work in 2.x.
    let deprecatedAuditNote: Record<string, unknown> | undefined;
    const withCalledAs = (details: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
      if (!calledAs && !deprecatedAuditNote) return details;
      return { ...(details ?? {}), ...(calledAs ? { calledAs } : {}), ...deprecatedAuditNote };
    };

    // 1. Validate input strictly.
    const parsed = tool.input.safeParse(options.input ?? {});
    if (!parsed.success) {
      throw new ToolErrorException("INVALID_INPUT", `Invalid input for ${tool.name}`, {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const input = parsed.data;
    if (tool.name === "navigate" || tool.name === "data") {
      const rec = input as Record<string, unknown>;
      const dep =
        tool.name === "navigate"
          ? deprecatedUnifiedAction("navigate", typeof rec.action === "string" ? rec.action : "", typeof rec.category === "string" ? rec.category : undefined)
          : deprecatedUnifiedAction("data", typeof rec.action === "string" ? rec.action : "", typeof rec.domain === "string" ? rec.domain : typeof rec.store === "string" ? rec.store : undefined);
      if (dep) deprecatedAuditNote = { deprecatedWarning: dep.note, useInstead: dep.useInstead };
    }

    // 2. Derive a policy target (domain/url) when possible. Tools that act on
    // an existing tab must be judged by that tab's *current* URL, otherwise a
    // blocked domain could be reached by navigating first and then calling a
    // tab-oriented tool without a URL argument.
    const target = options.target ?? (await deriveTarget(tool, input, options.ctx));
    if (target?.url) {
      try {
        const validated = validateNavigableUrl(target.url, { allowAboutBlank: true });
        target.domain = target.domain ?? validated.domain;
      } catch {
        // URL scheme problems are reported by the handler with richer context.
      }
    }

    // 3. Authorize.
    const decision = this.deps.policy.decide(tool, options.client, target);
    if (!decision.allowed) {
      this.deps.audit.record({
        kind: "tool.call",
        tool: auditTool,
        client: options.client,
        risk: tool.risk,
        decision: "denied",
        details: withCalledAs({ reason: decision.reason }),
      });
      throw new ToolErrorException("PERMISSION_DENIED", decision.reason, { details: { tool: auditTool } });
    }

    // 4. Dry run: describe without mutating.
    if (options.dryRun) {
      const requiresApproval = this.requiresApproval(tool, input, decision.requiresApproval);
      return {
        result: {
          dryRun: true,
          tool: auditTool,
          ...(calledAs ? { calledAs } : {}),
          risk: tool.risk,
          requiresApproval,
          target: target ?? null,
        },
        dryRun: true,
        durationMs: Date.now() - started,
      };
    }

    // 5. Approval. A valid token is consumed even when the static policy did
    // not require one, so handlers can escalate dynamically (for example when
    // a click turns out to submit a form) and the retry is still bound to the
    // exact tool + input + client. For a resolved unified call the token
    // must match the GRANULAR tool + canonical input: an approval granted
    // for tabs.list can never be consumed by tabs.close, because the
    // broker fingerprint binds tool + input + client.
    const needsApproval = this.requiresApproval(tool, input, decision.requiresApproval);
    let approvalValidated = Boolean(options.planApproved) || Boolean(options.nested && options.approvalId);
    if (!options.nested && options.approvalId) {
      this.deps.approvals.consume(
        options.approvalId,
        options.canonical
          ? { tool: options.canonical.tool, input: options.canonical.input, clientId: options.client.id }
          : { tool: tool.name, input, clientId: options.client.id },
      );
      approvalValidated = true;
    }
    // Client-supplied confirmation flags (confirmed / userApproved / approved
    // in tool input) are NEVER approval. They are parsed by the schema but
    // ignored here: only a broker approval token consumed above, a dashboard
    // decision, or a verified elicitation decision may set approvalValidated.
    // Unified handlers must not resurrect these flags either (see unified.ts).
    if (needsApproval && !approvalValidated) {
      this.deps.audit.record({
        kind: "tool.call",
        tool: auditTool,
        client: options.client,
        risk: tool.risk,
        decision: "approval-required",
        details: withCalledAs(undefined),
      });
      throw new ToolErrorException("APPROVAL_REQUIRED", `${auditTool} requires user approval`, {
        details: { tool: auditTool, risk: tool.risk, target: target ?? null },
      });
    }

    // 6. Rate limit. A nested invoke runs inside its parent's already-charged
    // call, so it does NOT take a second token (this matches the documented
    // ExecuteOptions.nested contract: "skip a second rate-limit token, keep
    // approvalId"). Only top-level calls are charged. The key is the
    // CANONICAL tool, so heavy tabs.list calls never consume the
    // tabs.close bucket (and vice versa); the limiter algorithm,
    // capacity, and refill are unchanged.
    if (!options.nested) {
      const limit = this.deps.rateLimiter.take(`${options.client.id}:${auditTool}`);
      if (!limit.allowed) {
        throw new ToolErrorException("RATE_LIMITED", `${auditTool} is rate limited`, {
          retryable: true,
          details: { retryAfterMs: limit.retryAfterMs },
        });
      }
    }

    // 7. Execute with timeout + cancellation.
    const timeoutMs = options.timeoutMs ?? this.deps.policy.getConfig().defaultTimeoutMs;
    this.deps.audit.record({ kind: "tool.call", tool: auditTool, client: options.client, risk: tool.risk, decision: "allowed", details: withCalledAs(undefined) });

    // Live activity feed: execution truly begins here — validation,
    // authorization, approval, and rate limiting all passed. Nested
    // invokes are internal sub-steps of the parent call and stay silent,
    // as do internal housekeeping calls (flagged internal); dry runs
    // return before this point and never emit.
    const activityId = options.nested || options.internal ? null : this.emitActivity(auditTool, "running");

    const runtime = this.buildRuntime(options.client);

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new TimeoutError(timeoutMs));
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectAborted = () => {
        const reason = controller.signal.reason;
        reject(
          reason instanceof TimeoutError || ToolErrorException.is(reason)
            ? reason
            : new ToolErrorException("CANCELLED", "Operation cancelled"),
        );
      };
      if (controller.signal.aborted) rejectAborted();
      else controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });

    let raw: unknown;
    try {
      raw = await Promise.race([
        tool.handler(input, {
          ctx: options.ctx,
          client: options.client,
          resolvedTabId: typeof (input as { tabId?: number }).tabId === "number" ? (input as { tabId: number }).tabId : undefined,
          approvalId: options.approvalId,
          approvalValidated,
          signal: controller.signal,
          runtime,
          invoke: async <T = unknown>(nestedTool: string, nestedInput: unknown, invokeOptions?: { dryRun?: boolean }): Promise<T> => {
            const nested = await this.execute({
              tool: nestedTool,
              input: nestedInput,
              client: options.client,
              ctx: options.ctx,
              signal: controller.signal,
              approvalId: options.approvalId,
              planApproved: options.planApproved,
              dryRun: invokeOptions?.dryRun,
              nested: true,
            });
            return nested.result as T;
          },
        }),
        timeoutPromise,
        abortPromise,
      ]);
    } catch (error) {
      const durationMs = Date.now() - started;
      const toolError =
        error instanceof TimeoutError
          ? { code: "TIMEOUT" as const, message: error.message, retryable: true }
          : toToolError(error);
      this.deps.audit.record({
        kind: "tool.result",
        tool: auditTool,
        client: options.client,
        risk: tool.risk,
        decision: "error",
        outcome: toolError.code === "TIMEOUT" ? "timeout" : toolError.code === "CANCELLED" ? "cancelled" : "failure",
        durationMs,
        details: withCalledAs({ code: toolError.code }),
      });
      this.endActivity(activityId, auditTool, "failed");
      throw ToolErrorException.is(error) ? error : new ToolErrorException(toolError.code, toolError.message);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }

    // 8. Validate output and bound size.
    const outputCheck = tool.output.safeParse(raw);
    if (!outputCheck.success) {
      this.endActivity(activityId, auditTool, "failed");
      throw new ToolErrorException("INTERNAL", `Tool ${tool.name} produced output that failed its schema`, {
        details: { issues: outputCheck.error.issues.map((i) => i.path.join(".")) },
      });
    }
    const bounded = boundOutput(outputCheck.data, this.deps.policy.getConfig().maxOutputChars);

    const durationMs = Date.now() - started;
    // Health aggregates only: size (characters) and a top-level truncated
    // flag, never the result content itself.
    let outputSize: number | undefined;
    try {
      outputSize = JSON.stringify(bounded)?.length;
    } catch {
      outputSize = undefined;
    }
    const truncatedFlag =
      bounded && typeof bounded === "object" && !Array.isArray(bounded) && (bounded as Record<string, unknown>).truncated === true
        ? true
        : undefined;
    this.deps.audit.record({
      kind: "tool.result",
      tool: auditTool,
      client: options.client,
      risk: tool.risk,
      decision: "executed",
      outcome: "success",
      durationMs,
      ...(outputSize !== undefined ? { outputSize } : {}),
      ...(truncatedFlag !== undefined ? { truncated: truncatedFlag } : {}),
      details: withCalledAs(undefined),
    });

    this.endActivity(activityId, auditTool, "done");
    return { result: bounded, dryRun: false, durationMs };
  }

  /**
   * A tool needs approval when the policy enforces approvals and either the
   * tool's own declaration or the risk tier asks for one. With
   * `approvalMode: "never"` nothing ever needs a confirmation.
   */
  private requiresApproval(tool: ToolDefinition, input: unknown, riskRequiresApproval: boolean): boolean {
    if (!this.deps.policy.approvalEnforced()) return false;
    return toolRequiresApproval(tool, input) || riskRequiresApproval;
  }

  private buildRuntime(client: ClientIdentity): RuntimeSnapshot {
    const cacheKey = `${client.id}:${this.policyVersionKey()}`;
    let cached = this.runtimeCache.get(cacheKey);
    if (cached) {
      // LRU touch: a hit refreshes recency, so eviction below drops the
      // genuinely least-recently-used entry, not a random one.
      this.runtimeCache.delete(cacheKey);
      this.runtimeCache.set(cacheKey, cached);
    }
    if (!cached) {
      const tools = this.deps.registry.list();
      const allowedTools: string[] = [];
      const deniedTools: string[] = [];
      for (const tool of tools) {
        const decision = this.deps.policy.decide(tool, client);
        (decision.allowed ? allowedTools : deniedTools).push(tool.name);
      }
      const config = this.deps.policy.getConfig();
      cached = {
        key: cacheKey,
        toolCount: tools.length,
        categories: [...new Set(tools.map((t) => t.category))],
        enabledGroups: config.enabledGroups,
        readOnlyMode: config.readOnlyMode,
        killSwitch: config.killSwitch,
        allowedTools,
        deniedTools,
      };
      // One entry per client; stale entries for other clients are harmless
      // but bounded here so a long-lived executor cannot grow without limit.
      // Evict only the least-recently-used entry: the old clear() dropped
      // every client's snapshot at once (a 51st client invalidated 50).
      if (this.runtimeCache.size > 50) {
        const oldest = this.runtimeCache.keys().next().value;
        if (oldest !== undefined) this.runtimeCache.delete(oldest);
      }
      this.runtimeCache.set(cacheKey, cached);
    }
    const extra = typeof this.deps.runtime === "function" ? this.deps.runtime() : this.deps.runtime;
    return {
      toolCount: cached.toolCount,
      categories: cached.categories,
      enabledGroups: cached.enabledGroups,
      readOnlyMode: cached.readOnlyMode,
      killSwitch: cached.killSwitch,
      bridgeStatus: "disconnected",
      connectedClients: 0,
      pendingApprovals: this.deps.approvals.pendingCount(),
      auditEvents: this.deps.audit.size(),
      allowedTools: cached.allowedTools,
      deniedTools: cached.deniedTools,
      ...extra,
    };
  }
}

async function deriveTarget(
  tool: { targetsActiveTab?: boolean },
  input: unknown,
  ctx: BrowserContext,
): Promise<PolicyTarget | undefined> {
  if (!input || typeof input !== "object") return undefined;
  const data = input as Record<string, unknown>;
  if (typeof data.url === "string") return { url: data.url };
  if (!tool.targetsActiveTab && typeof data.tabId !== "number") return undefined;
  try {
    const tab =
      typeof data.tabId === "number" ? await ctx.getTab(data.tabId) : await ctx.getActiveTab();
    if (tab?.url) return { url: tab.url };
  } catch {
    // A missing/closed tab is reported by the handler with richer context.
  }
  return undefined;
}

function boundOutput(value: unknown, maxChars: number): unknown {
  const images: unknown[] = [];
  const stripped = stripImagesForBound(value, images);
  const serialized = JSON.stringify(stripped);
  if (serialized.length <= maxChars) return value;
  // The result is NOT silently replaced by a preview: the truncation is
  // labelled, the full size is reported, and the caller is told to re-call
  // with a narrower scope (smaller limit / maxChars / paged offset) to get
  // the rest. The preview is only the first maxChars characters.
  return {
    truncated: true,
    totalChars: serialized.length,
    reason: `Output exceeded ${maxChars} characters`,
    preview: serialized.slice(0, maxChars),
    screenshotOmitted: images.length > 0,
    note: "Output was truncated; re-call with a narrower scope (a smaller limit, maxChars, or a paged offset) to retrieve the full result.",
  };
}

function stripImagesForBound(value: unknown, images: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((item) => stripImagesForBound(item, images));
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  if (typeof rec.dataUrl === "string" || typeof rec.dataBase64 === "string") {
    images.push(true);
    const { dataUrl: _d, dataBase64: _b, ...rest } = rec;
    return rest;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) out[key] = stripImagesForBound(item, images);
  return out;
}
