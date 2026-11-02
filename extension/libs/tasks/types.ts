/**
 * Durable task model (Phase 0 task engine, Muze AI 0.3.0 plan sections 3.1,
 * 3.5, 3.6 and 8.4). The extension is the source of truth for task state;
 * this module only defines the record shape and the pure helpers around it.
 * It never executes a tool, never touches chrome APIs, and never invents an
 * approval: approval lives in the existing approval flow outside the runner.
 *
 * Privacy invariant: a TaskView (what get/list return) never carries a
 * step's raw input. Step input is stored internally only, so a later
 * resume can re-execute a step with exactly the input it was created
 * with. Summaries, audit entries and progress views carry tool names,
 * argument *keys* and short outcome text only — never input values, page
 * content, screenshots, passwords, tokens or file contents. Callers must
 * not put credentials or page content into a step input; the runner never
 * copies input values into any summary, audit entry or progress view.
 */

/** Task lifecycle states. `partial` is an honest ending, never reported as `done`. */
export type TaskStatus =
  | "created"
  | "running"
  | "paused"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "partial";

export type TaskStepState = "pending" | "running" | "done" | "failed" | "skipped" | "waiting_approval" | "unknown";

/**
 * Phase B agent modes (OpenCode-style, adapted from Phase A gateway
 * modes). A task's mode is pinned at creation and never changes
 * mid-task (see runner.ts); it is NOT the dashboard policy mode in
 * PolicySnapshot.mode (restricted/default/unrestricted), which gates
 * execution separately. "act" is the default (previous behaviour).
 * Stored tasks written before Phase B have no mode field; taskMode()
 * below reads those as "act".
 */
export const AGENT_MODES = ["read", "act", "plan", "explore", "summary", "compaction"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Parse a mode value without guessing: unknown input returns null. */
export function parseAgentMode(value: unknown): AgentMode | null {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value) ? (value as AgentMode) : null;
}

/** Pinned mode of a task, defaulting pre-Phase-B records to "act". */
export function taskMode(task: { mode?: AgentMode | string | null }): AgentMode {
  return parseAgentMode(task.mode) ?? "act";
}

/**
 * Phase C child-task modes (OpenCode adoption plan §6, Phase C).
 * A child task is created only in `explore` (read-only subagent) or
 * `summary` (internal, empty effective tool set) mode — never in
 * `act`/`plan`/`read`/`compaction`. Recursion is blocked separately
 * by the runner (a child may not create a child, mirroring OpenCode's
 * `task: deny` for subagents).
 */
export const CHILD_MODES = ["explore", "summary"] as const;
export type ChildMode = (typeof CHILD_MODES)[number];

/** Parse a child mode without guessing: unknown input returns null. */
export function parseChildMode(value: unknown): ChildMode | null {
  return typeof value === "string" && (CHILD_MODES as readonly string[]).includes(value) ? (value as ChildMode) : null;
}

/** Parent task id of a task, or null for a top-level task (pre-Phase-C
 * records have no parentId field and read as top-level). */
export function taskParentId(task: { parentId?: string | null }): string | null {
  return typeof task.parentId === "string" && task.parentId !== "" ? task.parentId : null;
}

/**
 * Generic verify condition supplied by the client at creation (Phase B).
 * Generic only — never a site procedure: a URL equality/containment
 * check, or an element-presence check for a ref. `element-present`
 * uses `value` as the ref when given, else the step input's `ref`.
 */
export type VerifyConditionKind = "url-equals" | "url-contains" | "element-present";

export interface VerifyCondition {
  kind: VerifyConditionKind;
  /** URL for url-equals, substring for url-contains, ref for element-present (optional). */
  value?: string;
}

/**
 * Bounded page-snapshot checkpoint captured before a consequential
 * step (Phase B, browser analogue of OpenCode's turn-start snapshot).
 * Summaries only, truncated like every other step summary: the
 * service-worker wiring stores counts (node/form counts) and the tab
 * URL, never node text, page content, or screenshots. Used for verify
 * comparison and resolveUnknown — NOT for automatic revert.
 */
export interface PageSnapshotCheckpoint {
  url: string | null;
  a11ySummary: string;
  formSummary: string;
}

export type CompensationKind = "none" | "close-tab" | "navigate-back" | "delete-download" | "manual";

export interface TaskCompensation {
  kind: CompensationKind;
  description: string;
}

export interface TaskStepError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TaskStep {
  index: number;
  tool: string;
  /** Canonical input, stored internally only — never returned in a TaskView. */
  input: Record<string, unknown>;
  /** Safe summary: tool name + argument keys only, never input values. */
  inputSummary: string;
  idempotencyKey: string;
  state: TaskStepState;
  attempts: number;
  lastError: TaskStepError | null;
  /** Truncated to MAX_OUTPUT_SUMMARY_CHARS; never full page content. */
  outputSummary: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** Per-step timeout, validated against the 60s bridge cap (rule 2). */
  timeoutMs: number;
  compensation: TaskCompensation;
  /**
   * Phase 1/3 additions. `independent` + `parallelGroup` gate parallel
   * execution (Phase 3): only read-only, independent steps sharing a
   * group run together, max MAX_PARALLEL_STEPS. `observationSummary`
   * is the truncated pre-step re-observation (Phase 3 grounding).
   * `outsideBoundsReason` is set when a step pauses for being outside
   * the approved plan bounds (Phase 1); null otherwise.
   */
  independent: boolean;
  parallelGroup: number | null;
  observationSummary: string;
  outsideBoundsReason: string | null;
  /**
   * Phase B loop fields. `verify` is the client-supplied generic
   * condition (null = no expectation); `preStepSnapshot` is the
   * bounded checkpoint captured before a consequential step (null
   * for non-consequential steps, batch members, and unwired hosts);
   * `verifySummary` is the truncated post-step observation;
   * `verifyOutcome` is "pass" | "fail" | "skipped" (consequential
   * step, no verify wiring) or null (not a verified step).
   */
  verify: VerifyCondition | null;
  preStepSnapshot: PageSnapshotCheckpoint | null;
  verifySummary: string;
  verifyOutcome: string | null;
}

/**
 * Plan-level approval bounds (Phase 1, plan 3.3). Every field is a
 * restriction, never a permission grant beyond the plan: the defaults
 * deny purchases, payments, and external submits. An absent
 * allowedTools/allowedDomains list means "no restriction from that
 * axis beyond the plan itself" — allowedDomains is filled in from the
 * plan's own domains at approval time when not supplied, so a step
 * touching a new domain still pauses.
 */
export interface PlanBounds {
  allowedTools?: string[];
  allowedRiskLevels?: string[];
  allowedDomains?: string[];
  allowPurchases?: boolean;
  allowPayments?: boolean;
  allowExternalSubmit?: boolean;
  maxSteps?: number;
  maxAttemptsPerStep?: number;
  totalBudgetMs?: number;
}

/** Where a plan approval came from. Never a client-supplied flag: the
 * caller (host dispatch / dashboard port) derives this from transport,
 * and the runner trusts the caller, not the client input. */
export type PlanApprovalSource = "broker-token" | "dashboard" | "elicitation";

export interface PlanApproval {
  source: PlanApprovalSource;
  approvedAt: number;
  /** min(approvedAt + 24h, task lifetime budget end). No token id is
   * stored: the broker token is verified at approval time and then
   * discarded, so a task view can never leak it. */
  expiresAt: number;
  bounds: PlanBounds;
}

/** Structured final report (Phase 2): done/undone/failed step indices,
 * compensations that ran, and manual cleanup still required. External
 * submits listed as done are never listed as compensated. */
export interface TaskFinalReport {
  done: number[];
  undone: number[];
  failed: number[];
  compensations: string[];
  manualCleanup: string[];
}

export interface PolicySnapshot {
  policyVersion: number;
  mode: string;
  clientId: string;
  scope: string;
}

/** One tab pinned by a task at creation, for the tab-close / external-navigation pause checks. */
export interface PinnedTab {
  tabId: number;
  /** Recorded from the step input's `url` when present; null when unknown. */
  url: string | null;
}

export interface TaskRecord {
  id: string;
  /**
   * Phase C: parent task id for a child task, null for a top-level
   * task. Optional because pre-Phase-C records have no such field
   * (absent reads as top-level, see taskParentId). A child task's
   * context contains only its own steps/inputs, never the parent's
   * full history; a child may not create children (enforced by the
   * runner) and may not change its parent's mode, policy, or plan
   * (creation never mutates the parent record).
   */
  parentId?: string | null;
  goal: string;
  clientId: string;
  browserSessionId: string;
  /**
   * Phase B: agent mode pinned at creation (see AGENT_MODES). Never
   * changes mid-task: the run loop pauses with "mode-changed" if the
   * stored mode differs from the mode pinned at run start.
   */
  mode: AgentMode;
  status: TaskStatus;
  steps: TaskStep[];
  totalBudgetMs: number;
  correlationId: string;
  resultSummary: string;
  /** Phase 1: bounds supplied at creation (may be null) and the stored
   * plan approval (null until tasks.approvePlan succeeds). */
  planBounds: PlanBounds | null;
  planApproval: PlanApproval | null;
  /** Phase 2: set when the task reaches a terminal state; null before. */
  finalReport: TaskFinalReport | null;
  policySnapshot: PolicySnapshot;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  pinned: boolean;
  /**
   * Additive to the frozen interface (the coordinator's other sections read
   * status, not this field): why the task last paused, e.g.
   * 'budget-exceeded', 'tab-closed', 'tab-navigated-externally',
   * 'rate-limited', 'policy-changed', 'reobserve-unavailable', or the
   * reason passed to pauseTask / markStepUnknown. Null when not paused
   * for a recorded reason.
   */
  pauseReason: string | null;
  /**
   * Additive: set only by the rate-limit pause path. Milliseconds the
   * caller should wait before resuming (from the error's retryAfterMs,
   * default 1000, capped at 60000). Null when no rate-limit pause is in
   * effect.
   */
  resumeAfterMs: number | null;
  /** Additive: tabs pinned at creation (see PinnedTab). */
  pinnedTabs: PinnedTab[];
}

/** A step as exposed to clients: identical to TaskStep minus raw `input`. */
export type TaskStepView = Omit<TaskStep, "input">;

/** What get/list/resume/cancel return: a TaskRecord with raw inputs stripped. */
export type TaskView = Omit<TaskRecord, "steps"> & { steps: TaskStepView[] };

/** Minimal store surface the runner needs; implemented in store.ts. */
export interface TaskStore {
  load(): Promise<TaskRecord[]>;
  save(tasks: TaskRecord[]): Promise<void>;
}

/** Caps and defaults (plan 3.1 storage rules + task brief rules 1–2). */
export const MAX_STEPS_PER_TASK = 100;
export const MAX_STORED_TASKS = 50;
/** Completed tasks older than this are pruned on creation, unless pinned. */
export const PRUNE_COMPLETED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_STEP_TIMEOUT_MS = 30000;
export const MAX_STEP_TIMEOUT_MS = 60000;
export const DEFAULT_TOTAL_BUDGET_MS = 600000;
/** Output summaries are truncated to this length before being stored. */
export const MAX_OUTPUT_SUMMARY_CHARS = 500;
/** Rate-limit pause: default wait and hard cap (rule 7). */
export const DEFAULT_RESUME_AFTER_MS = 1000;
export const MAX_RESUME_AFTER_MS = 60000;
/** Retryable errors may be retried up to this many attempts per step per run. */
export const MAX_STEP_ATTEMPTS = 2;
/** Plan approval lifetime cap (Phase 1, plan 3.3): task lifetime or 24h, whichever shorter. */
export const PLAN_APPROVAL_MAX_MS = 24 * 60 * 60 * 1000;
/** Parallel read-only batch cap (Phase 3, same limit workflows already use for mapPool). */
export const MAX_PARALLEL_STEPS = 4;
/** Cap on the stored result summary so a long task cannot grow its record without bound. */
export const MAX_RESULT_SUMMARY_CHARS = 4000;

/**
 * Deterministic JSON with sorted object keys, so the same logical input
 * always hashes to the same idempotency key regardless of key order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Deep-copy via JSON. Task inputs/outputs are JSON-shaped by contract. */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function truncateSummary(text: string): string {
  return text.length > MAX_OUTPUT_SUMMARY_CHARS ? text.slice(0, MAX_OUTPUT_SUMMARY_CHARS) : text;
}

/** Safe step summary: tool name plus argument keys, never argument values. */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  return keys.length > 0 ? `${tool}(${keys.join(", ")})` : `${tool}()`;
}

/**
 * Canonicalise an input object (sorted keys, JSON round-trip) so the stored
 * form is exactly the form the idempotency key was computed from.
 */
export function canonicalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(stableStringify(input)) as Record<string, unknown>;
}

/**
 * Default consequential-step test (task brief rule 4).
 *
 * Assumption, documented because the frozen interface has no registry
 * handle: the runner accepts an optional `isConsequential` callback (see
 * runner.ts) for a registry risk lookup, and this default is used when
 * none is supplied. It treats the generic action/submit tools named in
 * the brief ('act', 'submit'), any *submit-like tool, downloads, and the
 * browser-state mutating tools from the 0.3.0 risk model as
 * consequential; everything else (reads, lists, captures, navigation
 * targets are handled separately by the navigate-tool check) is
 * non-consequential for the idempotency / tab-gate checks. When in
 * doubt a caller should supply the registry lookup instead of relying
 * on this name-based default.
 */
const CONSEQUENTIAL_TOOLS = new Set([
  "act",
  "submit",
  "dom.click",
  "dom.clickAt",
  "dom.fill",
  "dom.type",
  "dom.press",
  "dom.select",
  "dom.setChecked",
  "dom.setRadio",
  "dom.clear",
  "forms.fill",
  "forms.submit",
  "tabs.create",
  "tabs.close",
  "tabs.discard",
  "windows.create",
  "windows.close",
  "bookmarks.create",
  "bookmarks.update",
  // NOTE: "bookmarks.remove" and "history.deleteUrl" below are the
  // chrome.* API method names, not tool names — no tool by either name
  // exists in the registry, so they never matched anything. They are
  // kept for backward compatibility; the real tool names
  // ("bookmarks.delete", "history.delete") are listed alongside them,
  // because with defaultIsConsequential only, those deletes previously
  // skipped the tab gate, pre-step snapshot, pre-step re-observation,
  // verify-after-step, and idempotency dedup.
  "bookmarks.remove",
  "bookmarks.delete",
  "downloads.start",
  // Lowercase spelling of the chrome.* name: defaultIsConsequential
  // lowercases its input before the set lookup, so a camelCase
  // "history.deleteUrl" entry on its own could never match anything
  // (the same trap as the missing real names above). Both spellings
  // are listed so neither lookup form misses.
  "history.deleteurl",
  "history.deleteUrl",
  "history.delete",
  "workflows.fillFormForReview",
  "workflows.openSequence",
  "workflows.organizeTabs",
  "workflows.saveSession",
]);

export function defaultIsConsequential(tool: string): boolean {
  const name = tool.toLowerCase();
  if (CONSEQUENTIAL_TOOLS.has(name)) return true;
  if (name === "act" || name === "submit") return true;
  if (name.includes("submit")) return true;
  if (name.startsWith("downloads.")) return true;
  return false;
}

/** A tool that intentionally navigates a tab: exempt from the external-navigation pause. */
export function isNavigateTool(tool: string): boolean {
  const name = tool.toLowerCase();
  return name === "navigate" || name.includes("navigate");
}

/**
 * Scope strength (resume rule: a task may only resume with a scope at
 * least as strong as the one it was created under; `read:tools` is
 * weaker than `call:tools`).
 *
 * Capability model: `call:tools` implies `read:tools`, and bare `call`
 * implies bare `read`. Any other scope token must be present verbatim.
 * An empty creation scope requires nothing.
 */
export function scopeCapabilities(scope: string): Set<string> {
  const caps = new Set(scope.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean));
  if (caps.has("call:tools")) caps.add("read:tools");
  if (caps.has("call")) caps.add("read");
  return caps;
}

export function isScopeAtLeastAsStrong(resumeScope: string, creationScope: string): boolean {
  if (resumeScope === creationScope) return true;
  const resume = scopeCapabilities(resumeScope);
  for (const cap of scopeCapabilities(creationScope)) {
    if (!resume.has(cap)) return false;
  }
  return true;
}

/** Done/undone lists, always present in a result summary (rule 10). */
export function doneUndoneIndices(task: TaskRecord): { done: number[]; undone: number[] } {
  const done: number[] = [];
  const undone: number[] = [];
  for (const step of task.steps) {
    if (step.state === "done") done.push(step.index);
    else undone.push(step.index);
  }
  return { done, undone };
}

export function buildResultSummary(task: TaskRecord, extraLines: string[] = []): string {
  const { done, undone } = doneUndoneIndices(task);
  const lines = [`Done steps: [${done.join(", ")}]. Undone steps: [${undone.join(", ")}].`, ...extraLines];
  const joined = lines.join("\n");
  return joined.length > MAX_RESULT_SUMMARY_CHARS ? joined.slice(0, MAX_RESULT_SUMMARY_CHARS) : joined;
}

/** Structured final report from current step states plus compensation outcomes. */
export function computeFinalReport(
  task: TaskRecord,
  compensations: string[] = [],
  manualCleanup: string[] = [],
): TaskFinalReport {
  return {
    done: task.steps.filter((s) => s.state === "done").map((s) => s.index),
    undone: task.steps.filter((s) => s.state !== "done").map((s) => s.index),
    failed: task.steps.filter((s) => s.state === "failed").map((s) => s.index),
    compensations,
    manualCleanup,
  };
}

/**
 * Hostnames touched by a step input, from any string value that parses
 * as an http(s) URL (searched recursively, values only — keys and
 * non-URL strings are ignored). Used for plan-domain bounds and for
 * dry-run previews. Never returns input values, only hostnames.
 */
export function extractDomainsFromInput(input: unknown, depth = 0): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, level: number): void => {
    if (level > 4) return;
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) found.add(url.hostname.toLowerCase());
      } catch {
        // Not a URL; not a domain touched.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, level + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) walk(entry, level + 1);
    }
  };
  walk(input, depth);
  return [...found].sort();
}

/** One domain-glob match: `*.example.com` matches example.com and its subdomains, `*` matches any host. */
export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

const PAYMENT_KEY_PATTERN = /price|payment|checkout/i;
const PURCHASE_TOOL_PATTERN = /purchase|checkout|\bbuy\b/i;

/** True when the step looks like a purchase, a payment, or an external submit, by tool name / input keys only. */
export function stepActionKinds(tool: string, input: Record<string, unknown>): { purchase: boolean; payment: boolean; externalSubmit: boolean } {
  const name = tool.toLowerCase();
  const keys = Object.keys(input);
  return {
    purchase: PURCHASE_TOOL_PATTERN.test(name) || keys.some((k) => /purchase/i.test(k)),
    payment: name.includes("payment") || keys.some((k) => PAYMENT_KEY_PATTERN.test(k)),
    externalSubmit: name.includes("submit"),
  };
}

/**
 * Bounds check for one step (Phase 1). Returns null when the step is
 * inside the bounds, or a short reason string when it is outside.
 * `toolRisk` is the registry risk lookup when the wiring supplies one;
 * an unknown risk never blocks a step on the risk axis alone (the
 * executor still enforces policy and approval at execution time).
 */
export function checkStepAgainstBounds(
  tool: string,
  input: Record<string, unknown>,
  bounds: PlanBounds,
  toolRisk?: (tool: string) => string | undefined,
): string | null {
  if (bounds.allowedTools !== undefined && !bounds.allowedTools.includes(tool)) {
    return `tool ${tool} is not in the approved tool list`;
  }
  if (bounds.allowedRiskLevels !== undefined && toolRisk) {
    const risk = toolRisk(tool);
    if (risk !== undefined && !bounds.allowedRiskLevels.includes(risk)) {
      return `tool ${tool} has risk ${risk}, outside the approved risk levels`;
    }
  }
  if (bounds.allowedDomains !== undefined) {
    for (const domain of extractDomainsFromInput(input)) {
      if (!bounds.allowedDomains.some((pattern) => domainMatches(domain, pattern))) {
        return `domain ${domain} is not in the approved domains`;
      }
    }
  }
  const kinds = stepActionKinds(tool, input);
  if (kinds.purchase && bounds.allowPurchases !== true) return `step looks like a purchase and purchases are not approved`;
  if (kinds.payment && bounds.allowPayments !== true) return `step touches a price/payment field and payments are not approved`;
  if (kinds.externalSubmit && bounds.allowExternalSubmit !== true) return `step is an external submit and external submits are not approved`;
  return null;
}

/** Domains touched by a whole plan, for deriving default approval bounds. */
export function planDomains(steps: { input: Record<string, unknown> }[]): string[] {
  const all = new Set<string>();
  for (const step of steps) {
    for (const domain of extractDomainsFromInput(step.input)) all.add(domain);
  }
  return [...all].sort();
}

/** Strip raw inputs from a record for get/list/return values. */
export function toTaskView(task: TaskRecord): TaskView {
  const { steps, ...rest } = cloneJson(task);
  void steps;
  return {
    ...rest,
    steps: task.steps.map((step) => {
      const { input: _input, ...view } = step;
      void _input;
      return { ...cloneJson(view) };
    }),
  };
}
