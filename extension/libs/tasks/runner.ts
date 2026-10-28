/**
 * Sequential task runner (Phase 0 task engine, plan 3.6 + 8.4).
 *
 * Standalone and injectable: the coordinator wires this into the service
 * worker / MCP layer later, so the runner never imports chrome APIs,
 * the executor, policy or approval code directly. Every side effect
 * (storage, step execution, compensation, audit, progress, policy
 * snapshot, tab checks, re-observation) arrives through constructor
 * dependencies, which is what makes the mock-executor tests possible
 * and what lets a new runner over the same store resume after a
 * service-worker restart.
 *
 * Checkpoint order, without exception (plan 3.6): record the step
 * result, persist the whole store, write the audit entry (task id,
 * step index, tool, decision, outcome — never inputs or secrets),
 * emit the progress view, and only then start the next step.
 *
 * The runner never invents approval and never accepts a client
 * "confirmed" flag: an APPROVAL_REQUIRED step pauses the task in
 * `waiting_approval`, and only an explicit later run/resume — after
 * approval was granted through the existing flow outside the runner —
 * re-runs that step.
 */
import {
  DEFAULT_RESUME_AFTER_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  MAX_PARALLEL_STEPS,
  MAX_RESUME_AFTER_MS,
  MAX_STEPS_PER_TASK,
  MAX_STEP_ATTEMPTS,
  MAX_STEP_TIMEOUT_MS,
  MAX_STORED_TASKS,
  PLAN_APPROVAL_MAX_MS,
  PRUNE_COMPLETED_AFTER_MS,
  buildResultSummary,
  canonicalizeInput,
  checkStepAgainstBounds,
  cloneJson,
  computeFinalReport,
  defaultIsConsequential,
  extractDomainsFromInput,
  isNavigateTool,
  isScopeAtLeastAsStrong,
  planDomains,
  stableStringify,
  summarizeInput,
  toTaskView,
  truncateSummary,
  type CompensationKind,
  type PinnedTab,
  type PlanApproval,
  type PlanApprovalSource,
  type PlanBounds,
  type PolicySnapshot,
  type TaskRecord,
  type TaskStatus,
  type TaskStep,
  type TaskStore,
  type TaskView,
} from "./types.js";

export interface StepContext {
  clientId: string;
  taskId: string;
  stepIndex: number;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Phase 1: true when this step runs under a stored, unexpired plan
   * approval and is inside its bounds. This is a signal to the
   * executor wiring (which maps it onto the approval the user already
   * gave for the plan); the runner itself never invents approval, and
   * an APPROVAL_REQUIRED error from the executor still pauses the task
   * instead of proceeding. Wiring that ignores this flag keeps the old
   * per-step approval behaviour (fail closed).
   */
  planApproved?: boolean;
}

export interface StepExecutionResult {
  outputSummary: string;
}

export interface RunnerAuditEntry {
  kind: string;
  taskId: string;
  stepIndex: number;
  tool: string;
  decision: string;
  outcome: string;
}

export interface TabCheckResult {
  exists: boolean;
  url: string | null;
}

export interface ReobserveResult {
  effectObserved: boolean;
  summary: string;
}

/** Phase 3 grounding: pre-step re-observation of the step's target. */
export interface PreStepObservation {
  /** False when the ref/target the step would act on is stale. */
  refValid: boolean;
  summary: string;
}

/**
 * The working-tab group a task's tabs are moved into while it runs.
 * Structural only, so the runner never imports the browser engine:
 * the service worker supplies the real ChromeWorkingTabGroup, and
 * tests supply a recording stub. Absent = no automatic grouping
 * (the pre-existing behaviour, and what every existing runner test
 * exercises).
 */
export interface WorkingTabGroupLike {
  trackTab(taskId: string, tabId: number): Promise<void>;
  finish(taskId: string): Promise<void>;
}

export interface RunnerDeps {
  store: TaskStore;
  executeStep: (tool: string, input: Record<string, unknown>, ctx: StepContext) => Promise<StepExecutionResult>;
  /**
   * Automatic "Muze AI" tab grouping. When present, every tab a step
   * touches is moved into the working group, and finish() is called
   * exactly once when the task reaches a terminal status (done,
   * failed, partial, cancelled) — never on pause or waiting-approval,
   * so a resumed task keeps its group. finish() ungroups the tabs
   * and leaves them open; it never closes a tab.
   */
  workingGroup?: WorkingTabGroupLike;
  executeCompensation?: (step: TaskStep) => Promise<void>;
  audit: (entry: RunnerAuditEntry) => void;
  progress: (view: TaskView) => void;
  policySnapshot: () => PolicySnapshot;
  tabChecker?: (tabId: number) => Promise<TabCheckResult>;
  reobserve?: (step: TaskStep) => Promise<ReobserveResult>;
  now?: () => number;
  generateId?: () => string;
  computeIdempotencyKey?: (taskId: string, stepIndex: number, canonicalInput: unknown) => Promise<string>;
  /**
   * Optional registry risk lookup. When absent, the name-based default
   * in types.ts is used (see its documented assumption). This is an
   * addition to the frozen dependency list, not a replacement: every
   * frozen dependency above keeps its exact name and shape.
   */
  isConsequential?: (tool: string) => boolean;
  /** Phase 1/3 wiring (coordinator supplies from the registry when available): */
  toolRisk?: (tool: string) => string | undefined;
  toolExists?: (tool: string) => boolean;
  /** Canonical-param validation for dry-run previews; returns error strings, empty when valid. */
  validateStepInput?: (tool: string, input: Record<string, unknown>) => string[];
  /** Phase 3 grounding: re-observe before consequential steps. Absent = no re-observation (Phase 0 behaviour). */
  preStepObserve?: (step: TaskStep) => Promise<PreStepObservation>;
  /**
   * Phase 1: verifies a broker approval token id for tasks.approvePlan.
   * Required when the source is "broker-token"; without it, broker-token
   * approval fails closed instead of trusting the token id.
   */
  verifyApprovalToken?: (tokenId: string, clientId?: string) => boolean | Promise<boolean>;
}

export interface CreateStepInput {
  tool: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
  compensation?: { kind: CompensationKind; description?: string };
  /** Phase 3: parallel batch membership; null = sequential. */
  independent?: boolean;
  parallelGroup?: number | null;
}

export interface CreateTaskInput {
  goal: string;
  clientId: string;
  browserSessionId: string;
  steps: CreateStepInput[];
  totalBudgetMs?: number;
  start?: boolean;
  /** Phase 1: plan bounds supplied at creation; approval still comes via tasks.approvePlan. */
  planBounds?: PlanBounds;
}

/** One step of a dry-run preview: validation only, never execution. */
export interface DryRunPreviewStep {
  index: number;
  tool: string;
  inputSummary: string;
  risk: string;
  needsApproval: boolean;
  domains: string[];
  valid: boolean;
  errors: string[];
  outsideBoundsReason: string | null;
}

export interface DryRunPreview {
  goal: string;
  totalSteps: number;
  totalBudgetMs: number;
  domains: string[];
  steps: DryRunPreviewStep[];
  approvalsNeeded: number[];
  errors: string[];
  valid: boolean;
}

export interface ApprovePlanInput {
  source: PlanApprovalSource;
  /** Required when source is "broker-token"; verified, then discarded (never stored). */
  approvalTokenId?: string;
  /** Bounds for this approval; defaults to the creation bounds, else plan-derived defaults. */
  bounds?: PlanBounds;
}

const TERMINAL_STATUSES: TaskStatus[] = ["done", "failed", "cancelled", "partial"];
const COMPENSATION_KINDS: CompensationKind[] = ["none", "close-tab", "navigate-back", "delete-download", "manual"];
const NON_RETRYABLE_CODES = new Set([
  "PERMISSION_DENIED",
  "INVALID_INPUT",
  "APPROVAL_DENIED",
  "UNAUTHORIZED",
  "TOOL_NOT_FOUND",
  "INVALID_URL",
  "UNSUPPORTED",
  "RESTRICTED_PAGE",
  "KILL_SWITCH",
  "CANCELLED",
]);

type ErrorClass = "rate-limited" | "approval-required" | "bridge-closed" | "retryable" | "non-retryable" | "unknown";

interface ExtractedError {
  code: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
}

function extractError(error: unknown): ExtractedError {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const details = (record.details ?? {}) as Record<string, unknown>;
    const code = typeof record.code === "string" && record.code ? record.code : "INTERNAL";
    const message =
      error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error);
    const statusRaw = record.status ?? details.status;
    const retryRaw = record.retryAfterMs ?? details.retryAfterMs;
    return {
      code,
      message,
      status: typeof statusRaw === "number" ? statusRaw : undefined,
      retryAfterMs: typeof retryRaw === "number" ? retryRaw : undefined,
      retryable: record.retryable === true,
    };
  }
  return { code: "INTERNAL", message: String(error), retryable: false };
}

function classifyError(error: ExtractedError): ErrorClass {
  if (
    error.code === "RATE_LIMITED" ||
    error.status === 429 ||
    error.status === 503 ||
    /rate[-_ ]limited/i.test(error.message)
  ) {
    return "rate-limited";
  }
  // Bridge disconnect is distinct from a user cancel: the host
  // disposes in-flight work with "Bridge closed" when the socket
  // drops. That step's effect is unknown (it may have completed in
  // the browser even though the result never crossed the bridge), so
  // it must be marked unknown and re-observed, never failed and never
  // blindly retried. A plain "Operation cancelled" (runner pause/cancel
  // aborting its own controller) is NOT bridge-closed and keeps its
  // existing non-retryable handling.
  if (error.code === "BRIDGE_CLOSED" || /bridge closed/i.test(error.message)) {
    return "bridge-closed";
  }
  if (error.code === "APPROVAL_REQUIRED" || error.code === "APPROVAL_EXPIRED" || /approval_required/i.test(error.message)) {
    return "approval-required";
  }
  if (error.retryable === true || error.code === "TIMEOUT" || error.code === "CONFLICT") return "retryable";
  if (NON_RETRYABLE_CODES.has(error.code)) return "non-retryable";
  return "unknown";
}

function rateLimitResumeAfterMs(error: ExtractedError): number {
  if (error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    return Math.min(MAX_RESUME_AFTER_MS, Math.floor(error.retryAfterMs));
  }
  return DEFAULT_RESUME_AFTER_MS;
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultGenerateId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) return `task_${hexBytes(cryptoObj.getRandomValues(new Uint8Array(16)))}`;
  let hex = "";
  for (let i = 0; i < 32; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  return `task_${hex}`;
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function defaultComputeIdempotencyKey(taskId: string, stepIndex: number, canonicalInput: unknown): Promise<string> {
  const material = `${taskId}\n${stepIndex}\n${stableStringify(canonicalInput)}`;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(material));
    return `sha256:${hexBytes(new Uint8Array(digest))}`;
  }
  // Fallback only where SubtleCrypto is unavailable; the key is still
  // deterministic for the same task/step/input within one host.
  return `fnv1a:${fnv1aHex(material)}`;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`task creation rejected: ${field} must be a non-empty string`);
  return value;
}

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Outcome of one step execution attempt sequence, as seen by the run loop.
 * `paused`/`waiting`/`terminal` all stop the loop; only `done` continues.
 */
type StepOutcome = "done" | "paused" | "waiting" | "terminal";

export class TaskRunner {
  private readonly deps: RunnerDeps;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly computeIdempotencyKey: (taskId: string, stepIndex: number, canonicalInput: unknown) => Promise<string>;
  private readonly isConsequential: (tool: string) => boolean;
  /** Per-tab serialisation chains, same pattern as the capture/injection locks in chrome-context. */
  private readonly tabChains = new Map<number, Promise<void>>();
  /** Run loops currently executing in this instance (a restart creates a new instance, so it is not blocked). */
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.generateId = deps.generateId ?? defaultGenerateId;
    this.computeIdempotencyKey = deps.computeIdempotencyKey ?? defaultComputeIdempotencyKey;
    this.isConsequential = deps.isConsequential ?? defaultIsConsequential;
  }

  // -- lookups ---------------------------------------------------------

  private async loadAll(): Promise<TaskRecord[]> {
    return this.deps.store.load();
  }

  private findOrThrow(tasks: TaskRecord[], id: string): TaskRecord {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error(`task not found: ${id}`);
    return task;
  }

  private assertClient(task: TaskRecord, clientId: string): void {
    if (task.clientId !== clientId) throw new Error(`task ${task.id} belongs to a different client`);
  }

  private stepOrThrow(task: TaskRecord, stepIndex: number): TaskStep {
    const step = task.steps[stepIndex];
    if (!step) throw new Error(`task ${task.id} has no step ${stepIndex}`);
    return step;
  }

  /**
   * Working-group helpers. Grouping is cosmetic, so both swallow
   * errors: a grouping failure must never fail or pause a task step,
   * and finish() is idempotent (the group itself clears its tracking
   * on first finish, so a second call is a no-op).
   */
  private async trackWorkingTab(taskId: string, tabId: number | null): Promise<void> {
    if (tabId === null || !this.deps.workingGroup) return;
    try {
      await this.deps.workingGroup.trackTab(taskId, tabId);
    } catch {
      // Cosmetic only; the step still runs on the ungrouped tab.
    }
  }

  private async finishWorkingGroup(taskId: string): Promise<void> {
    if (!this.deps.workingGroup) return;
    try {
      await this.deps.workingGroup.finish(taskId);
    } catch {
      // Ungrouping is best-effort; tabs stay open either way.
    }
  }

  /**
   * Persist, then audit, then progress — in that order. If another
   * caller paused or cancelled the task while this step was executing,
   * that status wins over this step's working status (but the step
   * result itself is still recorded, and a cancellation's final
   * summary is never overwritten). Audit/progress failures never fail
   * a checkpoint; a persist failure does, because the checkpoint
   * itself is the durability guarantee.
   */
  private async checkpoint(all: TaskRecord[], working: TaskRecord, audit: RunnerAuditEntry): Promise<TaskRecord> {
    const freshAll = await this.loadAll();
    const fresh = freshAll.find((t) => t.id === working.id);
    let toSave: TaskRecord = working;
    if (fresh && (fresh.status === "paused" || fresh.status === "cancelled") && working.status === "running") {
      toSave = {
        ...working,
        status: fresh.status,
        pauseReason: fresh.pauseReason,
        resumeAfterMs: fresh.resumeAfterMs,
        completedAt: fresh.completedAt ?? working.completedAt,
        resultSummary: fresh.status === "cancelled" ? fresh.resultSummary : working.resultSummary,
      };
    }
    const next = freshAll.some((t) => t.id === toSave.id)
      ? freshAll.map((t) => (t.id === toSave.id ? toSave : t))
      : [...freshAll, toSave];
    void all;
    await this.deps.store.save(next);
    try {
      this.deps.audit(audit);
    } catch {
      // Audit is best-effort; a broken audit sink must not lose a checkpoint.
    }
    try {
      this.deps.progress(toTaskView(toSave));
    } catch {
      // Same for progress: the checkpoint already persisted.
    }
    return toSave;
  }

  private async persistOnly(all: TaskRecord[], task: TaskRecord, audit: RunnerAuditEntry): Promise<TaskRecord> {
    return this.checkpoint(all, task, audit);
  }

  /**
   * Save the caller's list verbatim (with the task upserted), without
   * the checkpoint's fresh-reload merge. Used only where the caller's
   * list is itself the intended new state: createTask, where the list
   * already reflects the 7-day prune (a fresh reload would resurrect
   * the pruned tasks), and the run-start transition, where the old
   * paused state is exactly what this run is resuming from (merging
   * it back would make a paused task unresumable). Step checkpoints
   * keep the merging behaviour, so a pause/cancel issued while a
   * step executes is never overwritten.
   */
  private async saveList(list: TaskRecord[], task: TaskRecord, audit: RunnerAuditEntry): Promise<TaskRecord> {
    const next = list.some((t) => t.id === task.id) ? list : [...list, task];
    await this.deps.store.save(next);
    try {
      this.deps.audit(audit);
    } catch {
      // Best-effort, as in checkpoint.
    }
    try {
      this.deps.progress(toTaskView(task));
    } catch {
      // Best-effort, as in checkpoint.
    }
    return task;
  }

  private refreshSummary(task: TaskRecord, extraLines: string[] = []): void {
    task.resultSummary = buildResultSummary(task, extraLines);
  }

  private currentPolicySnapshot(): PolicySnapshot | null {
    try {
      return this.deps.policySnapshot();
    } catch {
      return null;
    }
  }

  // -- Phase 1 plan approval helpers --------------------------------------

  /** Normalise bounds: deny purchases/payments/external submits unless
   * explicitly allowed, cap steps at the plan length, attempts at the
   * runner default, budget at the task budget, domains from the plan
   * when not supplied. Throws on an inconsistent bound. */
  private normalizeBounds(task: TaskRecord, bounds: PlanBounds): PlanBounds {
    const maxSteps = bounds.maxSteps ?? task.steps.length;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps < task.steps.length) {
      throw new Error(`plan approval rejected: maxSteps must be at least the plan length (${task.steps.length})`);
    }
    const maxAttemptsPerStep = bounds.maxAttemptsPerStep ?? MAX_STEP_ATTEMPTS;
    if (!Number.isInteger(maxAttemptsPerStep) || maxAttemptsPerStep < 1) {
      throw new Error("plan approval rejected: maxAttemptsPerStep must be a positive integer");
    }
    const totalBudgetMs = bounds.totalBudgetMs ?? task.totalBudgetMs;
    if (!Number.isFinite(totalBudgetMs) || totalBudgetMs <= 0) {
      throw new Error("plan approval rejected: totalBudgetMs must be positive");
    }
    return {
      ...(bounds.allowedTools !== undefined ? { allowedTools: [...bounds.allowedTools] } : {}),
      ...(bounds.allowedRiskLevels !== undefined ? { allowedRiskLevels: [...bounds.allowedRiskLevels] } : {}),
      allowedDomains: bounds.allowedDomains !== undefined ? [...bounds.allowedDomains] : planDomains(task.steps),
      allowPurchases: bounds.allowPurchases === true,
      allowPayments: bounds.allowPayments === true,
      allowExternalSubmit: bounds.allowExternalSubmit === true,
      maxSteps,
      maxAttemptsPerStep,
      totalBudgetMs,
    };
  }

  /** A plan approval counts only while unexpired; expiry pauses, never silently lapses into per-step approval. */
  private activeApproval(task: TaskRecord): PlanApproval | null {
    if (!task.planApproval) return null;
    return this.now() <= task.planApproval.expiresAt ? task.planApproval : null;
  }

  private stepBoundsReason(step: TaskStep, approval: PlanApproval | null): string | null {
    if (!approval) return null;
    return checkStepAgainstBounds(step.tool, step.input, approval.bounds, this.deps.toolRisk);
  }

  private effectiveBudgetMs(task: TaskRecord): number {
    const approval = this.activeApproval(task);
    if (approval?.bounds.totalBudgetMs !== undefined) return Math.min(task.totalBudgetMs, approval.bounds.totalBudgetMs);
    return task.totalBudgetMs;
  }

  private setFinalReport(task: TaskRecord, compensations: string[] = [], manualCleanup: string[] = []): void {
    task.finalReport = computeFinalReport(task, compensations, manualCleanup);
  }

  /** Validate creation bounds without storing anything (shared by createTask and previewTask). */
  private validateCreationBounds(steps: CreateStepInput[], planBounds: PlanBounds | undefined): string[] {
    const errors: string[] = [];
    if (planBounds === undefined) return errors;
    if (planBounds.maxSteps !== undefined && planBounds.maxSteps < steps.length) {
      errors.push(`plan bounds maxSteps (${planBounds.maxSteps}) is smaller than the plan length (${steps.length})`);
    }
    if (planBounds.maxAttemptsPerStep !== undefined && (!Number.isInteger(planBounds.maxAttemptsPerStep) || planBounds.maxAttemptsPerStep < 1)) {
      errors.push("plan bounds maxAttemptsPerStep must be a positive integer");
    }
    if (planBounds.totalBudgetMs !== undefined && (!Number.isFinite(planBounds.totalBudgetMs) || planBounds.totalBudgetMs <= 0)) {
      errors.push("plan bounds totalBudgetMs must be positive");
    }
    return errors;
  }

  // -- creation / reads --------------------------------------------------

  async createTask(input: CreateTaskInput, policySnapshotAtCreation: PolicySnapshot): Promise<TaskView> {
    const goal = requireNonEmpty(input.goal, "goal");
    const clientId = requireNonEmpty(input.clientId, "clientId");
    const browserSessionId = requireNonEmpty(input.browserSessionId, "browserSessionId");
    if (!Array.isArray(input.steps)) throw new Error("task creation rejected: steps must be an array");
    if (input.steps.length > MAX_STEPS_PER_TASK) {
      throw new Error(`task creation rejected: ${input.steps.length} steps exceeds the maximum of ${MAX_STEPS_PER_TASK}`);
    }
    const totalBudgetMs = input.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    if (!Number.isFinite(totalBudgetMs) || totalBudgetMs <= 0) {
      throw new Error(`task creation rejected: totalBudgetMs must be a positive number, got ${String(input.totalBudgetMs)}`);
    }
    const boundsErrors = this.validateCreationBounds(input.steps, input.planBounds);
    if (boundsErrors.length > 0) throw new Error(`task creation rejected: ${boundsErrors.join("; ")}`);

    const now = this.now();
    const id = this.generateId();
    const steps: TaskStep[] = [];
    for (let index = 0; index < input.steps.length; index += 1) {
      const raw = input.steps[index] as CreateStepInput;
      if (!raw || typeof raw.tool !== "string" || raw.tool.trim() === "") {
        throw new Error(`task creation rejected: step ${index} must have a non-empty tool name`);
      }
      if (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input)) {
        throw new Error(`task creation rejected: step ${index} input must be an object`);
      }
      const timeoutMs = raw.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STEP_TIMEOUT_MS) {
        throw new Error(
          `task creation rejected: step ${index} timeoutMs must be between 1 and ${MAX_STEP_TIMEOUT_MS}, got ${String(raw.timeoutMs)}`,
        );
      }
      let compensation: TaskStep["compensation"] = { kind: "none", description: "" };
      if (raw.compensation !== undefined) {
        if (!COMPENSATION_KINDS.includes(raw.compensation.kind)) {
          throw new Error(`task creation rejected: step ${index} compensation kind must be one of ${COMPENSATION_KINDS.join(", ")}`);
        }
        compensation = {
          kind: raw.compensation.kind,
          description: typeof raw.compensation.description === "string" ? raw.compensation.description : "",
        };
      }
      const canonical = canonicalizeInput(raw.input);
      steps.push({
        index,
        tool: raw.tool,
        input: canonical,
        inputSummary: summarizeInput(raw.tool, canonical),
        idempotencyKey: await this.computeIdempotencyKey(id, index, canonical),
        state: "pending",
        attempts: 0,
        lastError: null,
        outputSummary: "",
        startedAt: null,
        finishedAt: null,
        timeoutMs,
        compensation,
        independent: raw.independent === true,
        parallelGroup: typeof raw.parallelGroup === "number" ? raw.parallelGroup : null,
        observationSummary: "",
        outsideBoundsReason: null,
      });
    }

    // Pinned tabs: unique tabIds from step inputs, with the recorded url
    // from the first step that mentions that tab.
    const pinnedById = new Map<number, PinnedTab>();
    for (const step of steps) {
      const tabId = (step.input as Record<string, unknown>).tabId;
      if (typeof tabId === "number" && Number.isInteger(tabId) && !pinnedById.has(tabId)) {
        const url = (step.input as Record<string, unknown>).url;
        pinnedById.set(tabId, { tabId, url: typeof url === "string" ? url : null });
      }
    }

    const task: TaskRecord = {
      id,
      goal,
      clientId,
      browserSessionId,
      status: "created",
      steps,
      totalBudgetMs,
      correlationId: this.generateId(),
      resultSummary: "",
      planBounds: input.planBounds !== undefined ? cloneJson(input.planBounds) : null,
      planApproval: null,
      finalReport: null,
      policySnapshot: cloneJson(policySnapshotAtCreation),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      pinned: false,
      pauseReason: null,
      resumeAfterMs: null,
      pinnedTabs: [...pinnedById.values()],
    };
    this.refreshSummary(task);

    // Cap enforcement: prune completed tasks older than 7 days (unless
    // pinned) first; if the store is still at the cap, reject rather
    // than silently deleting recent work.
    let all = await this.loadAll();
    const pruned = all.filter((t) => {
      if (!isTerminal(t.status) || t.pinned) return true;
      const finishedAt = t.completedAt ?? t.createdAt;
      return now - finishedAt <= PRUNE_COMPLETED_AFTER_MS;
    });
    if (pruned.length !== all.length) all = pruned;
    if (all.length >= MAX_STORED_TASKS) {
      throw new Error(
        `task creation rejected: task store is full (${MAX_STORED_TASKS} tasks stored); complete, cancel or delete older tasks first`,
      );
    }
    all = [...all, task];
    const saved = await this.saveList(all, task, {
      kind: "task.created",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "created",
      outcome: "success",
    });
    if (input.start === true) return this.runTask(id, clientId);
    return toTaskView(saved);
  }

  // -- Phase 1: plan approval + dry-run -----------------------------------

  /**
   * Approve a task's plan with bounds (Phase 1, plan 3.3). This is a
   * SEPARATE granular tool, never an action parameter, and never a
   * client-supplied confirmed/approved flag: the caller supplies the
   * verified source (broker approval token id, dashboard decision, or
   * verified elicitation decision) and the runner verifies a broker
   * token through its verifier dep, then discards the token id. The
   * approval expires at min(now + 24h, task budget end) and dies with
   * the task's terminal state. Approving does not start the task; the
   * caller resumes it, so an approval can be inspected before running.
   */
  async approvePlan(id: string, clientId: string, opts: ApprovePlanInput): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (isTerminal(task.status)) return toTaskView(task);
    if (opts.source === "broker-token") {
      if (typeof opts.approvalTokenId !== "string" || opts.approvalTokenId === "") {
        throw new Error("plan approval rejected: broker-token approval requires an approval token id");
      }
      if (!this.deps.verifyApprovalToken) {
        throw new Error("plan approval rejected: broker-token verification is not wired, failing closed");
      }
      const verified = await this.deps.verifyApprovalToken(opts.approvalTokenId, clientId);
      if (verified !== true) throw new Error("plan approval rejected: approval token did not verify");
    } else if (opts.source !== "dashboard" && opts.source !== "elicitation") {
      throw new Error(`plan approval rejected: unknown approval source ${String(opts.source)}`);
    }
    const now = this.now();
    const bounds = this.normalizeBounds(task, opts.bounds ?? task.planBounds ?? {});
    const budgetEnd = task.createdAt + Math.min(task.totalBudgetMs, bounds.totalBudgetMs ?? task.totalBudgetMs);
    task.planBounds = cloneJson(bounds);
    task.planApproval = { source: opts.source, approvedAt: now, expiresAt: Math.min(now + PLAN_APPROVAL_MAX_MS, budgetEnd), bounds: cloneJson(bounds) };
    if (task.status === "waiting_approval" && task.pauseReason === "plan-approval-required") {
      task.status = "paused";
      task.pauseReason = null;
    }
    task.updatedAt = now;
    this.refreshSummary(task);
    const saved = await this.persistOnly(all, task, {
      kind: "task.plan-approved",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "plan-approved",
      outcome: opts.source,
    });
    return toTaskView(saved);
  }

  /**
   * Dry-run preview (Phase 1, plan 3.4). Validates the whole plan —
   * tool existence (when the registry lookup is wired), canonical
   * params (when the schema validator is wired), risk per step, domains
   * touched, approvals needed, step count, total budget — and executes
   * NOTHING: no executor call, no store write, no task record. Steps
   * outside the supplied/creation bounds are reported as needing a
   * step approval, not as validation errors, because the plan can still
   * be created and the step will pause at run time.
   */
  async previewTask(input: CreateTaskInput): Promise<DryRunPreview> {
    const errors: string[] = [];
    let goal = "";
    try {
      goal = requireNonEmpty(input.goal, "goal");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (typeof input.clientId !== "string" || input.clientId.trim() === "") errors.push("task creation rejected: clientId must be a non-empty string");
    if (typeof input.browserSessionId !== "string" || input.browserSessionId.trim() === "") {
      errors.push("task creation rejected: browserSessionId must be a non-empty string");
    }
    if (!Array.isArray(input.steps)) errors.push("task creation rejected: steps must be an array");
    const rawSteps: CreateStepInput[] = Array.isArray(input.steps) ? input.steps : [];
    if (rawSteps.length > MAX_STEPS_PER_TASK) errors.push(`task creation rejected: ${rawSteps.length} steps exceeds the maximum of ${MAX_STEPS_PER_TASK}`);
    const totalBudgetMs = input.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
    if (!Number.isFinite(totalBudgetMs) || totalBudgetMs <= 0) errors.push("task creation rejected: totalBudgetMs must be a positive number");
    errors.push(...this.validateCreationBounds(rawSteps, input.planBounds));

    // Bounds used for the preview: creation bounds normalised against
    // the would-be plan (domains derived from the plan itself).
    const draftSteps = rawSteps.map((raw, index) => ({
      index,
      tool: typeof raw?.tool === "string" ? raw.tool : "",
      input: raw?.input && typeof raw.input === "object" && !Array.isArray(raw.input) ? canonicalizeInput(raw.input) : {},
    }));
    const previewBounds: PlanBounds = {
      ...(input.planBounds ?? {}),
      allowedDomains: input.planBounds?.allowedDomains ?? planDomains(draftSteps),
      allowPurchases: input.planBounds?.allowPurchases === true,
      allowPayments: input.planBounds?.allowPayments === true,
      allowExternalSubmit: input.planBounds?.allowExternalSubmit === true,
    };

    const steps: DryRunPreviewStep[] = [];
    const approvalsNeeded: number[] = [];
    const allDomains = new Set<string>();
    for (let index = 0; index < draftSteps.length; index += 1) {
      const raw = rawSteps[index] as CreateStepInput;
      const draft = draftSteps[index];
      const stepErrors: string[] = [];
      if (draft.tool === "") stepErrors.push(`step ${index} must have a non-empty tool name`);
      if (!raw?.input || typeof raw.input !== "object" || Array.isArray(raw.input)) stepErrors.push(`step ${index} input must be an object`);
      const timeoutMs = raw?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STEP_TIMEOUT_MS) {
        stepErrors.push(`step ${index} timeoutMs must be between 1 and ${MAX_STEP_TIMEOUT_MS}`);
      }
      if (this.deps.toolExists && draft.tool !== "" && !this.deps.toolExists(draft.tool)) {
        stepErrors.push(`step ${index} tool ${draft.tool} does not exist`);
      }
      if (this.deps.validateStepInput && draft.tool !== "") {
        stepErrors.push(...this.deps.validateStepInput(draft.tool, draft.input).map((message) => `step ${index}: ${message}`));
      }
      const risk = draft.tool !== "" ? (this.deps.toolRisk?.(draft.tool) ?? "unknown") : "unknown";
      const outsideBoundsReason = draft.tool !== "" ? checkStepAgainstBounds(draft.tool, draft.input, previewBounds, this.deps.toolRisk) : null;
      const needsApproval = risk === "consequential" || outsideBoundsReason !== null;
      if (needsApproval) approvalsNeeded.push(index);
      const domains = extractDomainsFromInput(draft.input);
      for (const domain of domains) allDomains.add(domain);
      if (stepErrors.length > 0) errors.push(...stepErrors);
      steps.push({
        index,
        tool: draft.tool,
        inputSummary: draft.tool !== "" ? summarizeInput(draft.tool, draft.input) : "",
        risk,
        needsApproval,
        domains,
        valid: stepErrors.length === 0,
        errors: stepErrors,
        outsideBoundsReason,
      });
    }
    return {
      goal,
      totalSteps: steps.length,
      totalBudgetMs,
      domains: [...allDomains].sort(),
      steps,
      approvalsNeeded,
      errors,
      valid: errors.length === 0,
    };
  }

  async getTask(id: string, clientId: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    return toTaskView(task);
  }

  async listTasks(clientId: string, browserSessionId?: string): Promise<TaskView[]> {
    const all = await this.loadAll();
    return all
      .map((task, order) => ({ task, order }))
      .filter(({ task }) => task.clientId === clientId && (browserSessionId === undefined || task.browserSessionId === browserSessionId))
      .sort((a, b) => b.task.createdAt - a.task.createdAt || b.order - a.order)
      .map(({ task }) => toTaskView(task));
  }

  /**
   * Dashboard-only listing: the dashboard runs as the user, not as an
   * MCP client, so it lists every task for this browser, newest first,
   * regardless of owning client. MCP callers must use listTasks with
   * their own clientId and never this method.
   */
  async listAllTasks(browserSessionId?: string): Promise<TaskView[]> {
    const all = await this.loadAll();
    return all
      .map((task, order) => ({ task, order }))
      .filter(({ task }) => browserSessionId === undefined || task.browserSessionId === browserSessionId)
      .sort((a, b) => b.task.createdAt - a.task.createdAt || b.order - a.order)
      .map(({ task }) => toTaskView(task));
  }

  // -- pause / cancel ----------------------------------------------------

  async pauseTask(id: string, clientId: string, reason: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (isTerminal(task.status)) return toTaskView(task);
    this.controllers.get(id)?.abort();
    task.status = "paused";
    task.pauseReason = reason;
    task.updatedAt = this.now();
    this.refreshSummary(task);
    const saved = await this.persistOnly(all, task, {
      kind: "task.paused",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "paused",
      outcome: reason,
    });
    return toTaskView(saved);
  }

  async cancelTask(id: string, clientId: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (task.status === "cancelled" || task.status === "done" || task.status === "failed" || task.status === "partial") {
      return toTaskView(task);
    }
    this.controllers.get(id)?.abort();
    task.status = "cancelled";
    task.pauseReason = null;
    task.resumeAfterMs = null;
    task.completedAt = this.now();
    task.updatedAt = task.completedAt;

    // Best-effort compensations, done steps in reverse order. A failing
    // compensation never throws out of cancel: it is listed as manual.
    // (Phase 0 semantics kept: every non-"none" kind goes through the
    // compensation executor when one is wired; without one it is
    // listed as manual. External submits are never compensated by the
    // runner — a done submit step has no undo, so it stays reported
    // done and not undoable, never as a compensation that ran.)
    const compensationLines: string[] = [];
    const compensations: string[] = [];
    const manualCleanup: string[] = [];
    const doneReversed = [...task.steps].filter((s) => s.state === "done").reverse();
    for (const step of doneReversed) {
      if (step.compensation.kind === "none") {
        compensationLines.push(`Compensation for step ${step.index}: none.`);
        continue;
      }
      if (this.deps.executeCompensation) {
        try {
          await this.deps.executeCompensation(cloneJson(step));
          compensationLines.push(`Compensation for step ${step.index}: ${step.compensation.kind} — executed.`);
          compensations.push(`Step ${step.index} (${step.tool}): ${step.compensation.kind} — executed.`);
        } catch {
          compensationLines.push(
            `Compensation for step ${step.index}: ${step.compensation.kind} — manual: ${step.compensation.description || "manual cleanup required"}`,
          );
          manualCleanup.push(`Step ${step.index} (${step.tool}): ${step.compensation.kind} failed, manual cleanup — ${step.compensation.description || "manual cleanup required"}`);
        }
      } else {
        compensationLines.push(
          `Compensation for step ${step.index}: ${step.compensation.kind} — manual: ${step.compensation.description || "manual cleanup required"}`,
        );
        manualCleanup.push(`Step ${step.index} (${step.tool}): ${step.compensation.kind} not run, manual cleanup — ${step.compensation.description || "manual cleanup required"}`);
      }
    }
    this.refreshSummary(task, compensationLines);
    this.setFinalReport(task, compensations, manualCleanup);
    const saved = await this.persistOnly(all, task, {
      kind: "task.cancelled",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "cancelled",
      outcome: "success",
    });
    // Cancelled is terminal: ungroup, keep tabs open.
    await this.finishWorkingGroup(id);
    return toTaskView(saved);
  }

  // -- unknown steps -------------------------------------------------------

  async markStepUnknown(id: string, stepIndex: number, reason: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    if (isTerminal(task.status)) throw new Error(`cannot mark a step unknown on a finished task ${id} (status: ${task.status})`);
    const step = this.stepOrThrow(task, stepIndex);
    step.state = "unknown";
    task.status = "paused";
    task.pauseReason = reason;
    task.updatedAt = this.now();
    this.refreshSummary(task);
    const saved = await this.persistOnly(all, task, {
      kind: "task.step-unknown",
      taskId: id,
      stepIndex,
      tool: step.tool,
      decision: "paused",
      outcome: reason,
    });
    return toTaskView(saved);
  }

  async resolveUnknown(id: string, stepIndex: number): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    const step = this.stepOrThrow(task, stepIndex);
    if (step.state !== "unknown") throw new Error(`task ${id} step ${stepIndex} is not unknown (state: ${step.state})`);
    if (isTerminal(task.status)) throw new Error(`cannot resolve a step on a finished task ${id} (status: ${task.status})`);

    if (!this.deps.reobserve) {
      task.status = "paused";
      task.pauseReason = "reobserve-unavailable";
      task.updatedAt = this.now();
      this.refreshSummary(task);
      const saved = await this.persistOnly(all, task, {
        kind: "task.resolve-unknown",
        taskId: id,
        stepIndex,
        tool: step.tool,
        decision: "paused",
        outcome: "reobserve-unavailable",
      });
      return toTaskView(saved);
    }

    let observed: ReobserveResult;
    try {
      observed = await this.deps.reobserve(cloneJson(step));
    } catch {
      task.status = "paused";
      task.pauseReason = "reobserve-failed";
      task.updatedAt = this.now();
      this.refreshSummary(task);
      const saved = await this.persistOnly(all, task, {
        kind: "task.resolve-unknown",
        taskId: id,
        stepIndex,
        tool: step.tool,
        decision: "paused",
        outcome: "reobserve-failed",
      });
      return toTaskView(saved);
    }

    if (observed.effectObserved === true) {
      step.state = "done";
      step.outputSummary = truncateSummary(observed.summary);
      step.finishedAt = this.now();
      step.lastError = null;
      task.updatedAt = step.finishedAt;
      return toTaskView(await this.finishIfAllDone(all, task, step));
    }

    // Effect not observed: exactly one re-execution through the normal
    // path (tab gates, tab chain, timeout context, error taxonomy).
    // A retryable failure on this single re-execution pauses rather
    // than looping: the operator explicitly re-ran it once already.
    step.state = "pending";
    task.updatedAt = this.now();
    const outcome = await this.executeOne(all, task, step, { allowRetry: false });
    if (outcome === "done") return toTaskView(await this.finishIfAllDone(all, task, step));
    const fresh = (await this.loadAll()).find((t) => t.id === id);
    return toTaskView(fresh ?? task);
  }

  /** After a step reaches `done` outside the run loop, finish the task if nothing is left. */
  private async finishIfAllDone(all: TaskRecord[], task: TaskRecord, step: TaskStep): Promise<TaskRecord> {
    if (task.steps.every((s) => s.state === "done")) {
      task.status = "done";
      task.pauseReason = null;
      task.resumeAfterMs = null;
      task.completedAt = this.now();
      task.updatedAt = task.completedAt;
      this.refreshSummary(task);
      this.setFinalReport(task);
      // Done outside the run loop (for example via resolveUnknown):
      // ungroup, keep tabs open.
      await this.finishWorkingGroup(task.id);
    } else if (task.status !== "done") {
      task.status = "paused";
      task.updatedAt = this.now();
      this.refreshSummary(task);
    }
    return this.persistOnly(all, task, {
      kind: "task.step-done",
      taskId: task.id,
      stepIndex: step.index,
      tool: step.tool,
      decision: "executed",
      outcome: "success",
    });
  }

  // -- resume / run ---------------------------------------------------------

  async resumeTask(id: string, clientId: string, newPolicySnapshot: PolicySnapshot, browserSessionId?: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (newPolicySnapshot.clientId !== task.clientId) {
      throw new Error(`cannot resume task ${id}: policy snapshot belongs to a different client`);
    }
    if (!isScopeAtLeastAsStrong(newPolicySnapshot.scope, task.policySnapshot.scope)) {
      throw new Error(
        `cannot resume task ${id}: resume scope '${newPolicySnapshot.scope}' is weaker than creation scope '${task.policySnapshot.scope}'`,
      );
    }
    if (isTerminal(task.status)) return toTaskView(task);
    if (newPolicySnapshot.policyVersion !== task.policySnapshot.policyVersion || newPolicySnapshot.mode !== task.policySnapshot.mode) {
      // Policy changed: pause and report it, adopting the new snapshot
      // so the pause is a visible stop (and a re-acknowledgement), not
      // a permanent lock. The next explicit resume/run proceeds under
      // the new policy. Scope is never widened silently: a weaker
      // scope above already threw instead of pausing.
      task.policySnapshot = cloneJson(newPolicySnapshot);
      task.status = "paused";
      task.pauseReason = "policy-changed";
      task.resumeAfterMs = null;
      task.updatedAt = this.now();
      this.refreshSummary(task);
      const saved = await this.persistOnly(all, task, {
        kind: "task.policy-changed",
        taskId: id,
        stepIndex: -1,
        tool: "",
        decision: "paused",
        outcome: "policy-changed",
      });
      return toTaskView(saved);
    }
    task.policySnapshot = cloneJson(newPolicySnapshot);
    task.updatedAt = this.now();
    await this.persistOnly(all, task, {
      kind: "task.resumed",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "resumed",
      outcome: "success",
    });
    return this.runTask(id, clientId, browserSessionId);
  }

  /**
   * Run loop entry point. The inner loop returns every outcome
   * (paused, waiting, done, failed, partial, cancelled); only a
   * terminal outcome ungroups the task's working tabs, and the
   * tabs are always left open. A paused or waiting task keeps its
   * group, so a resume continues visibly in the same group.
   */
  async runTask(id: string, clientId: string, browserSessionId?: string): Promise<TaskView> {
    const view = await this.runTaskInner(id, clientId, browserSessionId);
    if (isTerminal(view.status)) await this.finishWorkingGroup(id);
    return view;
  }

  private async runTaskInner(id: string, clientId: string, browserSessionId?: string): Promise<TaskView> {
    const all = await this.loadAll();
    let task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (isTerminal(task.status)) return toTaskView(task);
    // Phase 3 multi-browser binding: when the caller knows its browser
    // session, a task bound to another session never runs here. The
    // user picks the target browser at creation (tasks.create
    // browserSessionId) or in the dashboard; the task never moves
    // browsers on its own. An unknown caller session skips the check
    // (Phase 0 behaviour for direct bridge clients).
    if (browserSessionId !== undefined && browserSessionId !== task.browserSessionId) {
      throw new Error(`task ${id} is bound to browser session ${task.browserSessionId} and cannot run on a different browser session`);
    }
    if (this.running.has(id)) throw new Error(`task ${id} is already running in this runner`);

    this.running.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      // Re-check policy at run start (plan 8.1.7): a version/mode change
      // pauses with 'policy-changed' instead of running under a stale plan.
      const current = this.currentPolicySnapshot();
      if (current && (current.policyVersion !== task.policySnapshot.policyVersion || current.mode !== task.policySnapshot.mode)) {
        task.policySnapshot = cloneJson(current);
        task.status = "paused";
        task.pauseReason = "policy-changed";
        task.resumeAfterMs = null;
        task.updatedAt = this.now();
        this.refreshSummary(task);
        const saved = await this.persistOnly(all, task, {
          kind: "task.policy-changed",
          taskId: id,
          stepIndex: -1,
          tool: "",
          decision: "paused",
          outcome: "policy-changed",
        });
        return toTaskView(saved);
      }

      // Phase 1: a plan with bounds but no stored approval does not
      // execute consequential steps until tasks.approvePlan succeeds.
      // Read-only/reversible-only plans may run: they need no approval
      // under the current policy in the first place.
      if (task.planBounds && !task.planApproval && task.steps.some((s) => this.isConsequential(s.tool))) {
        task.status = "waiting_approval";
        task.pauseReason = "plan-approval-required";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        const saved = await this.persistOnly(all, task, {
          kind: "task.waiting-approval",
          taskId: id,
          stepIndex: -1,
          tool: "",
          decision: "approval-required",
          outcome: "plan-approval-required",
        });
        return toTaskView(saved);
      }
      // Phase 1: an expired plan approval pauses before any step runs.
      if (task.planApproval && this.activeApproval(task) === null) {
        task.status = "paused";
        task.pauseReason = "plan-approval-expired";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        const saved = await this.persistOnly(all, task, {
          kind: "task.paused",
          taskId: id,
          stepIndex: -1,
          tool: "",
          decision: "paused",
          outcome: "plan-approval-expired",
        });
        return toTaskView(saved);
      }

      task.status = "running";
      task.pauseReason = null;
      task.resumeAfterMs = null;
      task.updatedAt = this.now();
      this.refreshSummary(task);
      task = await this.saveList(all, task, {
        kind: "task.started",
        taskId: id,
        stepIndex: -1,
        tool: "",
        decision: "running",
        outcome: "success",
      });

      for (;;) {
        // Reload before every step: this is how a pause/cancel issued
        // while a step was executing, or a restart that left the task
        // in storage, is observed instead of overwritten.
        const freshAll = await this.loadAll();
        const fresh = freshAll.find((t) => t.id === id);
        if (!fresh) throw new Error(`task not found: ${id}`);
        if (fresh.status === "paused" || fresh.status === "cancelled" || isTerminal(fresh.status)) {
          return toTaskView(fresh);
        }
        task = fresh;

        // Total budget: elapsed since creation, checked before every step.
        // A plan approval may narrow the budget further (Phase 1).
        if (this.now() - task.createdAt > this.effectiveBudgetMs(task)) {
          task.status = "paused";
          task.pauseReason = "budget-exceeded";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          const saved = await this.persistOnly(freshAll, task, {
            kind: "task.paused",
            taskId: id,
            stepIndex: -1,
            tool: "",
            decision: "paused",
            outcome: "budget-exceeded",
          });
          return toTaskView(saved);
        }

        // Policy re-check at every step.
        const stepPolicy = this.currentPolicySnapshot();
        if (stepPolicy && (stepPolicy.policyVersion !== task.policySnapshot.policyVersion || stepPolicy.mode !== task.policySnapshot.mode)) {
          task.policySnapshot = cloneJson(stepPolicy);
          task.status = "paused";
          task.pauseReason = "policy-changed";
          task.resumeAfterMs = null;
          task.updatedAt = this.now();
          this.refreshSummary(task);
          const saved = await this.persistOnly(freshAll, task, {
            kind: "task.policy-changed",
            taskId: id,
            stepIndex: -1,
            tool: "",
            decision: "paused",
            outcome: "policy-changed",
          });
          return toTaskView(saved);
        }

        const next = task.steps.find((s) => s.state === "pending" || s.state === "waiting_approval");
        if (!next) {
          const unknownStep = task.steps.find((s) => s.state === "unknown");
          if (unknownStep) {
            // Unknown steps are never executed blindly; they wait for
            // resolveUnknown. If the task got here without being paused,
            // pause it now so the state is honest.
            task.status = "paused";
            task.pauseReason = task.pauseReason ?? "unknown-step";
            task.updatedAt = this.now();
            this.refreshSummary(task);
            const saved = await this.persistOnly(freshAll, task, {
              kind: "task.paused",
              taskId: id,
              stepIndex: unknownStep.index,
              tool: unknownStep.tool,
              decision: "paused",
              outcome: "unknown-step",
            });
            return toTaskView(saved);
          }
          if (task.steps.every((s) => s.state === "done")) {
            task.status = "done";
            task.pauseReason = null;
            task.resumeAfterMs = null;
            task.completedAt = this.now();
            task.updatedAt = task.completedAt;
            this.refreshSummary(task);
            this.setFinalReport(task);
            const saved = await this.persistOnly(freshAll, task, {
              kind: "task.done",
              taskId: id,
              stepIndex: -1,
              tool: "",
              decision: "done",
              outcome: "success",
            });
            return toTaskView(saved);
          }
          // Remaining steps are failed/skipped with no terminal state
          // recorded (defensive; the failure path normally ends the task).
          // Phase 1: a task resumed past a denied step reaches this
          // branch when the denied step is the last one left — end it
          // honestly as partial (or failed when nothing succeeded)
          // with a final report, never as a silently paused task.
          if (task.steps.some((s) => s.state === "failed")) {
            const anyDone = task.steps.some((s) => s.state === "done");
            task.status = anyDone ? "partial" : "failed";
            task.pauseReason = null;
            task.resumeAfterMs = null;
            task.completedAt = this.now();
            task.updatedAt = task.completedAt;
            this.refreshSummary(task);
            this.setFinalReport(task, [], task.steps.filter((s) => s.state === "failed").map((s) => `Step ${s.index} (${s.tool}) failed — manual cleanup may be required`));
            const saved = await this.persistOnly(freshAll, task, {
              kind: "task.done",
              taskId: id,
              stepIndex: -1,
              tool: "",
              decision: task.status,
              outcome: "success",
            });
            return toTaskView(saved);
          }
          return toTaskView(task);
        }

        // Phase 1: an approval that expired mid-run pauses before the
        // next step; a step outside the approved bounds pauses in
        // waiting_approval with the exact tool, input summary, and
        // reason, so a fresh step approval can be sought for it.
        if (task.planApproval && this.activeApproval(task) === null) {
          task.status = "paused";
          task.pauseReason = "plan-approval-expired";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          const saved = await this.persistOnly(freshAll, task, {
            kind: "task.paused",
            taskId: id,
            stepIndex: next.index,
            tool: next.tool,
            decision: "paused",
            outcome: "plan-approval-expired",
          });
          return toTaskView(saved);
        }
        const approval = this.activeApproval(task);
        if (approval) {
          const reason = this.stepBoundsReason(next, approval);
          if (reason !== null) {
            next.state = "waiting_approval";
            next.outsideBoundsReason = reason;
            task.status = "waiting_approval";
            task.pauseReason = `plan-bounds: ${reason}`;
            task.updatedAt = this.now();
            this.refreshSummary(task);
            const saved = await this.persistOnly(freshAll, task, {
              kind: "task.waiting-approval",
              taskId: id,
              stepIndex: next.index,
              tool: next.tool,
              decision: "approval-required",
              outcome: `plan-bounds: ${reason}`,
            });
            return toTaskView(saved);
          }
          next.outsideBoundsReason = null;
        }

        // Phase 3: a run of consecutive pending, independent steps in
        // the same parallel group runs together (read-only only, unless
        // a consequential step is explicitly independent AND covered by
        // an active plan approval). Anything else stays sequential.
        const batch = this.collectBatch(task, next, approval);
        if (batch.length >= 2) {
          const batchOutcome = await this.executeBatch(freshAll, task, batch, controller.signal);
          if (batchOutcome === "done") continue;
          const latest = (await this.loadAll()).find((t) => t.id === id);
          return toTaskView(latest ?? task);
        }

        // Idempotency across the task: a consequential step whose key
        // is already done elsewhere in this task returns the stored
        // result instead of executing again.
        if (this.isConsequential(next.tool)) {
          const prior = task.steps.find((s) => s.index !== next.index && s.idempotencyKey === next.idempotencyKey && s.state === "done");
          if (prior) {
            next.state = "done";
            next.outputSummary = prior.outputSummary;
            next.finishedAt = this.now();
            next.lastError = null;
            task.updatedAt = next.finishedAt;
            task.status = "running";
            this.refreshSummary(task);
            task = await this.checkpoint(freshAll, task, {
              kind: "task.step-done",
              taskId: id,
              stepIndex: next.index,
              tool: next.tool,
              decision: "deduplicated",
              outcome: "success",
            });
            if (task.status !== "running") return toTaskView(task);
            continue;
          }
        }

        const outcome = await this.executeOne(freshAll, task, next, { allowRetry: true, signal: controller.signal });
        if (outcome === "done") continue;
        const latest = (await this.loadAll()).find((t) => t.id === id);
        return toTaskView(latest ?? task);
      }
    } finally {
      this.running.delete(id);
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
    }
  }

  // -- one step -------------------------------------------------------------

  private async throughTabChain(tabId: number, fn: () => Promise<StepExecutionResult>): Promise<StepExecutionResult> {
    const previous = this.tabChains.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tabChains.set(tabId, lock);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tabChains.get(tabId) === lock) this.tabChains.delete(tabId);
    }
  }

  /**
   * Execute one step through the tab gate, tab chain and error taxonomy,
   * checkpointing after the step (and after each failed retryable
   * attempt, so attempts/lastError survive a crash). Returns whether
   * the run loop should continue.
   */
  /**
   * Collect a parallel batch starting at `next` (Phase 3): consecutive
   * pending steps sharing next's non-null parallelGroup, every one
   * independent, capped at MAX_PARALLEL_STEPS. A consequential step
   * joins only when explicitly independent AND covered by an active
   * plan approval inside its bounds; otherwise the batch stops before
   * it and it runs sequentially. Returns fewer than 2 steps when no
   * batch is eligible (caller then runs the single step).
   */
  private collectBatch(task: TaskRecord, next: TaskStep, approval: PlanApproval | null): TaskStep[] {
    if (next.state !== "pending" || next.parallelGroup === null || next.independent !== true) return [next];
    const batch: TaskStep[] = [];
    for (const step of task.steps) {
      if (step.index < next.index) continue;
      if (batch.length >= MAX_PARALLEL_STEPS) break;
      if (step.state !== "pending" || step.parallelGroup !== next.parallelGroup || step.independent !== true) break;
      // Every batch member must be inside the approved bounds; the
      // batch stops before an out-of-bounds member, which then pauses
      // singly with its reason on the next loop iteration.
      if (approval && this.stepBoundsReason(step, approval) !== null) break;
      if (this.isConsequential(step.tool) && !approval) break;
      batch.push(step);
    }
    return batch;
  }

  private async executeOne(
    all: TaskRecord[],
    task: TaskRecord,
    step: TaskStep,
    options: { allowRetry: boolean; signal?: AbortSignal },
  ): Promise<StepOutcome> {
    const consequential = this.isConsequential(step.tool);
    const input = step.input as Record<string, unknown>;
    const tabId = typeof input.tabId === "number" && Number.isInteger(input.tabId) ? input.tabId : null;
    // Working group: the tab this step touches joins the "Muze AI"
    // group before it runs, so the group is visible while Muze works.
    await this.trackWorkingTab(task.id, tabId);
    // Phase 1: this step runs under plan approval only when an active
    // approval covers it (checked by the run loop before calling here).
    const planApproved = this.activeApproval(task) !== null && this.stepBoundsReason(step, this.activeApproval(task)) === null;

    // Per-tab gate, consequential steps only (rule 6). Non-consequential
    // steps never pause on navigation, and never check the tab at all.
    if (consequential && tabId !== null && this.deps.tabChecker) {
      let check: TabCheckResult;
      try {
        check = await this.deps.tabChecker(tabId);
      } catch {
        task.status = "paused";
        task.pauseReason = "tab-check-failed";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "tab-check-failed",
        });
        return "paused";
      }
      if (!check.exists) {
        task.status = "paused";
        task.pauseReason = "tab-closed";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "tab-closed",
        });
        return "paused";
      }
      const pinned: PinnedTab | undefined = task.pinnedTabs.find((p) => p.tabId === tabId);
      if (pinned?.url && check.url && check.url !== pinned.url && !isNavigateTool(step.tool)) {
        task.status = "paused";
        task.pauseReason = "tab-navigated-externally";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "tab-navigated-externally",
        });
        return "paused";
      }
    }

    // Phase 3 grounding: re-observe before a consequential step. A
    // stale ref pauses the step (pending, not failed) and the resume
    // re-observes instead of failing the whole task or silently
    // re-resolving to a different element.
    if (consequential && this.deps.preStepObserve) {
      let observed: PreStepObservation;
      try {
        observed = await this.deps.preStepObserve(cloneJson(step));
      } catch {
        task.status = "paused";
        task.pauseReason = "stale-ref";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "stale-ref",
        });
        return "paused";
      }
      step.observationSummary = truncateSummary(observed.summary);
      if (observed.refValid !== true) {
        task.status = "paused";
        task.pauseReason = "stale-ref";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "stale-ref",
        });
        return "paused";
      }
    }

    const signal = options.signal ?? new AbortController().signal;
    for (;;) {
      // A consequential step that is already done is never re-executed
      // (rule 4): return the stored output. This is the checkpoint
      // resume path — a restart re-enters the step list at a done step
      // and must not click/submit twice.
      if (consequential && step.state === "done") return "done";
      step.state = "running";
      if (step.startedAt === null) step.startedAt = this.now();
      step.attempts += 1;
      task.status = "running";
      task.updatedAt = this.now();

      let result: StepExecutionResult;
      try {
        const run = (): Promise<StepExecutionResult> =>
          this.deps.executeStep(step.tool, cloneJson(step.input), {
            clientId: task.clientId,
            taskId: task.id,
            stepIndex: step.index,
            timeoutMs: step.timeoutMs,
            signal,
            ...(planApproved ? { planApproved: true } : {}),
          });
        result = consequential && tabId !== null ? await this.throughTabChain(tabId, run) : await run();
      } catch (error) {
        const extracted = extractError(error);
        const errorClass = classifyError(extracted);
        const lastError = {
          code: extracted.code,
          message: truncateSummary(extracted.message),
          retryable: errorClass === "retryable" || errorClass === "rate-limited",
        };
        step.lastError = lastError;

        if (errorClass === "rate-limited") {
          // Pause, do not fail, do not increment attempts further (the
          // increment above counts the attempt that hit the limit, but
          // the step stays pending so the attempt is not charged as a
          // failure — so roll the count back), and never retry in a loop.
          step.attempts -= 1;
          step.state = "pending";
          task.status = "paused";
          task.pauseReason = "rate-limited";
          task.resumeAfterMs = rateLimitResumeAfterMs(extracted);
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.paused",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "paused",
            outcome: "rate-limited",
          });
          return "paused";
        }

        if (errorClass === "bridge-closed") {
          step.state = "unknown";
          task.status = "paused";
          task.pauseReason = "bridge-disconnected";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.step-unknown",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "paused",
            outcome: "bridge-disconnected",
          });
          return "paused";
        }

        if (errorClass === "approval-required") {
          step.state = "waiting_approval";
          task.status = "waiting_approval";
          task.pauseReason = "approval-required";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.waiting-approval",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "approval-required",
            outcome: "waiting",
          });
          return "waiting";
        }

        if (errorClass === "retryable" && options.allowRetry && step.attempts < MAX_STEP_ATTEMPTS) {
          step.state = "pending";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.step-retry",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "retry",
            outcome: extracted.code,
          });
          if ((await this.loadAll()).find((t) => t.id === task.id)?.status === "paused") return "paused";
          continue;
        }

        if (errorClass === "retryable") {
          // Attempts exhausted (or a single re-execution spent): pause
          // with the step still pending, never fail it on a transient.
          step.state = "pending";
          task.status = "paused";
          task.pauseReason = "retry-exhausted";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.paused",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "paused",
            outcome: "retry-exhausted",
          });
          return "paused";
        }

        if (errorClass === "non-retryable") {
          step.state = "failed";
          step.finishedAt = this.now();
          task.updatedAt = step.finishedAt;
          // Phase 1: a denial under an active plan approval pauses
          // that step only — it marks the step failed and pauses the
          // task, it does not end the whole task silently. A later
          // resume continues past the failed step (the failed step is
          // never retried automatically). Without a plan approval the
          // Phase 0 behaviour stands: the task ends partial/failed.
          if (extracted.code === "APPROVAL_DENIED" && this.activeApproval(task) !== null) {
            task.status = "paused";
            task.pauseReason = "step-denied";
            task.resumeAfterMs = null;
            this.refreshSummary(task, [`Denied step ${step.index}: ${truncateSummary(extracted.message).slice(0, 200)}`]);
            await this.checkpoint(all, task, {
              kind: "task.step-denied",
              taskId: task.id,
              stepIndex: step.index,
              tool: step.tool,
              decision: "denied",
              outcome: extracted.code,
            });
            return "paused";
          }
          const anyDone = task.steps.some((s) => s.state === "done");
          task.status = anyDone ? "partial" : "failed";
          task.pauseReason = null;
          task.resumeAfterMs = null;
          task.completedAt = step.finishedAt;
          this.refreshSummary(task, [`Failed step ${step.index}: ${extracted.code} — ${truncateSummary(extracted.message).slice(0, 200)}`]);
          this.setFinalReport(task, [], [`Step ${step.index} (${step.tool}) failed: ${extracted.code} — manual cleanup may be required`]);
          await this.checkpoint(all, task, {
            kind: "task.step-failed",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "failed",
            outcome: extracted.code,
          });
          return "terminal";
        }

        // Unknown errors (tab closed, page changed, generic): mark the
        // step unknown and pause. Never blind-retry — resolveUnknown
        // re-observes first and only then decides.
        step.state = "unknown";
        task.status = "paused";
        task.pauseReason = "unknown-step";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.step-unknown",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: extracted.code,
        });
        return "paused";
      }

      step.state = "done";
      step.outputSummary = truncateSummary(result.outputSummary ?? "");
      step.finishedAt = this.now();
      step.lastError = null;
      task.updatedAt = step.finishedAt;
      task.status = "running";
      this.refreshSummary(task);
      await this.checkpoint(all, task, {
        kind: "task.step-done",
        taskId: task.id,
        stepIndex: step.index,
        tool: step.tool,
        decision: "executed",
        outcome: "success",
      });
      return "done";
    }
  }

  /**
   * Execute one parallel batch (Phase 3). All steps launch together
   * (consequential members, when allowed at all, go through their
   * per-tab chain); results are then checkpointed in plan order, one
   * checkpoint per step, before the loop continues. Any pause or
   * terminal outcome stops the loop after every batch result is
   * recorded, so a batch never loses a completed step. Retryable batch
   * failures leave the step pending (bounded by MAX_STEP_ATTEMPTS) and
   * the loop re-picks it; they never loop inside the batch.
   */
  private async executeBatch(
    all: TaskRecord[],
    task: TaskRecord,
    batch: TaskStep[],
    signal: AbortSignal,
  ): Promise<StepOutcome> {
    const planApproved = this.activeApproval(task) !== null;
    for (const step of batch) {
      step.state = "running";
      if (step.startedAt === null) step.startedAt = this.now();
      step.attempts += 1;
    }
    // Working group, tracked sequentially first: parallel trackTab
    // calls could otherwise each create their own "Muze AI" group.
    for (const step of batch) {
      const input = step.input as Record<string, unknown>;
      const tabId = typeof input.tabId === "number" && Number.isInteger(input.tabId) ? input.tabId : null;
      await this.trackWorkingTab(task.id, tabId);
    }
    task.status = "running";
    task.updatedAt = this.now();
    const settled = await Promise.allSettled(
      batch.map(async (step) => {
        const input = step.input as Record<string, unknown>;
        const tabId = typeof input.tabId === "number" && Number.isInteger(input.tabId) ? input.tabId : null;
        const run = (): Promise<StepExecutionResult> =>
          this.deps.executeStep(step.tool, cloneJson(step.input), {
            clientId: task.clientId,
            taskId: task.id,
            stepIndex: step.index,
            timeoutMs: step.timeoutMs,
            signal,
            ...(planApproved ? { planApproved: true } : {}),
          });
        return this.isConsequential(step.tool) && tabId !== null ? this.throughTabChain(tabId, run) : run();
      }),
    );

    let stop: StepOutcome | null = null;
    for (let i = 0; i < batch.length; i += 1) {
      const step = batch[i];
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        step.state = "done";
        step.outputSummary = truncateSummary(outcome.value.outputSummary ?? "");
        step.finishedAt = this.now();
        step.lastError = null;
        task.updatedAt = step.finishedAt;
        task.status = "running";
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.step-done",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "executed",
          outcome: "success",
        });
        continue;
      }
      const extracted = extractError(outcome.reason);
      const errorClass = classifyError(extracted);
      step.lastError = {
        code: extracted.code,
        message: truncateSummary(extracted.message),
        retryable: errorClass === "retryable" || errorClass === "rate-limited",
      };
      if (errorClass === "rate-limited") {
        step.attempts -= 1;
        step.state = "pending";
        task.status = "paused";
        task.pauseReason = "rate-limited";
        task.resumeAfterMs = rateLimitResumeAfterMs(extracted);
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "rate-limited",
        });
        stop = "paused";
        continue;
      }
      if (errorClass === "bridge-closed" || errorClass === "unknown") {
        step.state = "unknown";
        task.status = "paused";
        task.pauseReason = errorClass === "bridge-closed" ? "bridge-disconnected" : "unknown-step";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.step-unknown",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: extracted.code,
        });
        stop = "paused";
        continue;
      }
      if (errorClass === "approval-required") {
        step.state = "waiting_approval";
        task.status = "waiting_approval";
        task.pauseReason = "approval-required";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.waiting-approval",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "approval-required",
          outcome: "waiting",
        });
        stop = "waiting";
        continue;
      }
      if (errorClass === "retryable" && step.attempts < MAX_STEP_ATTEMPTS) {
        step.state = "pending";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.step-retry",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "retry",
          outcome: extracted.code,
        });
        continue;
      }
      if (errorClass === "retryable") {
        step.state = "pending";
        task.status = "paused";
        task.pauseReason = "retry-exhausted";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "retry-exhausted",
        });
        stop = "paused";
        continue;
      }
      // Non-retryable (including APPROVAL_DENIED in a batch): the step
      // fails. The task ends after the whole batch is recorded.
      step.state = "failed";
      step.finishedAt = this.now();
      task.updatedAt = step.finishedAt;
      this.refreshSummary(task);
      await this.checkpoint(all, task, {
        kind: "task.step-failed",
        taskId: task.id,
        stepIndex: step.index,
        tool: step.tool,
        decision: "failed",
        outcome: extracted.code,
      });
      stop = "terminal";
    }
    if (stop === "terminal") {
      const anyDone = task.steps.some((s) => s.state === "done");
      task.status = anyDone ? "partial" : "failed";
      task.pauseReason = null;
      task.resumeAfterMs = null;
      task.completedAt = this.now();
      task.updatedAt = task.completedAt;
      this.refreshSummary(task);
      this.setFinalReport(task, [], task.steps.filter((s) => s.state === "failed").map((s) => `Step ${s.index} (${s.tool}) failed — manual cleanup may be required`));
      await this.checkpoint(all, task, {
        kind: "task.step-failed",
        taskId: task.id,
        stepIndex: -1,
        tool: "",
        decision: task.status,
        outcome: "batch-failed",
      });
      return "terminal";
    }
    if (stop !== null) return stop;
    // Every batch step done, or a retryable step left pending: the run
    // loop re-picks the next step (a pending retry re-batches or runs
    // singly, bounded by MAX_STEP_ATTEMPTS).
    return "done";
  }
}
