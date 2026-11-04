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
  parseAgentMode,
  parseChildMode,
  planDomains,
  taskParentId,
  stableStringify,
  summarizeInput,
  taskMode,
  toTaskView,
  truncateSummary,
  type AgentMode,
  type ChildMode,
  type CompensationKind,
  type PageSnapshotCheckpoint,
  type PinnedTab,
  type PlanBounds,
  type PolicySnapshot,
  type TaskRecord,
  type TaskStatus,
  type TaskStep,
  type TaskStore,
  type TaskView,
  type VerifyCondition,
} from "./types.js";
import {
  buildCompactedView,
  pruneTaskOutputs,
  type CompactedTaskView,
  type CompactedViewOptions,
  type PruneTaskOutputsOptions,
} from "./compaction.js";

export interface StepContext {
  clientId: string;
  taskId: string;
  stepIndex: number;
  timeoutMs: number;
  signal: AbortSignal;
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
 * Phase B per-iteration tool resolution (OpenCode resolveTools per
 * iteration, adapted): re-resolve the step's tool against the current
 * policy snapshot, the task's pinned mode, and scope, instead of
 * trusting the tool set cached at creation. `allowed: false` pauses
 * the task (policy-changed), it never executes the step.
 */
export interface ToolResolution {
  allowed: boolean;
  reason?: string;
}

export interface ToolResolutionContext {
  mode: AgentMode;
  policySnapshot: PolicySnapshot;
  clientId: string;
  step: TaskStep;
}

/**
 * Phase B post-step verify observation (same machinery family as
 * preStepObserve, run after the step). `targetPresent` is the wiring's
 * answer for the step's verify target (verify value, else the step
 * input's ref); null when the step has no ref target to check.
 */
export interface PostStepObservation {
  url: string | null;
  targetPresent: boolean | null;
  summary: string;
}

/** Evaluate a step's generic verify condition against an observation. */
export function evaluateVerifyCondition(
  condition: VerifyCondition | null,
  observed: PostStepObservation,
): { pass: boolean; detail: string } {
  if (!condition) return { pass: true, detail: "no verify condition; observation recorded" };
  if (condition.kind === "url-equals") {
    return observed.url === condition.value
      ? { pass: true, detail: "URL matches the verify condition" }
      : { pass: false, detail: `verify failed: URL does not equal the expected URL` };
  }
  if (condition.kind === "url-contains") {
    return observed.url !== null && condition.value !== undefined && observed.url.includes(condition.value)
      ? { pass: true, detail: "URL contains the verify substring" }
      : { pass: false, detail: `verify failed: URL does not contain the expected substring` };
  }
  // element-present
  if (observed.targetPresent === true) return { pass: true, detail: "verify target is present" };
  if (observed.targetPresent === null) return { pass: false, detail: "verify failed: target presence could not be confirmed" };
  return { pass: false, detail: "verify failed: target is not present" };
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
  preStepObserve?: (step: TaskStep, signal?: AbortSignal) => Promise<PreStepObservation>;
  /**
   * Phase B loop wiring (all optional; absent = Phase 0 behaviour for
   * that check, recorded as verifyOutcome "skipped" for verify):
   * - resolveTool: per-iteration re-resolution against current
   *   policy/mode/scope. Runner-native mode gating runs first, so a
   *   missing dep still denies out-of-mode consequential steps.
   * - captureSnapshot: bounded page snapshot before consequential
   *   steps, stored on the step record for verify comparison and
   *   resolveUnknown — never for automatic revert.
   * - postStepObserve: verify observation after consequential steps.
   *   Every call receives the run's AbortSignal, so a task cancel
   *   interrupts a pending verify observation as well as the step.
   */
  resolveTool?: (tool: string, context: ToolResolutionContext) => ToolResolution | Promise<ToolResolution>;
  captureSnapshot?: (step: TaskStep, signal?: AbortSignal) => Promise<PageSnapshotCheckpoint>;
  postStepObserve?: (step: TaskStep, signal?: AbortSignal) => Promise<PostStepObservation>;
}

export interface CreateStepInput {
  tool: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
  compensation?: { kind: CompensationKind; description?: string };
  /** Phase 3: parallel batch membership; null = sequential. */
  independent?: boolean;
  parallelGroup?: number | null;
  /** Phase B: generic verify condition (see types.ts); absent = no expectation. */
  verify?: VerifyCondition;
}

export interface CreateTaskInput {
  goal: string;
  clientId: string;
  browserSessionId: string;
  steps: CreateStepInput[];
  totalBudgetMs?: number;
  start?: boolean;
  /** Plan bounds supplied at creation (data only; never pre-approval). */
  planBounds?: PlanBounds;
  /**
   * Phase B: agent mode pinned at creation (read/act/plan/explore/
   * summary/compaction). Omitted = "act" (previous behaviour). An
   * unknown value is rejected, never guessed. There is no API to
   * change a task's mode afterwards.
   */
  mode?: AgentMode;
}

/**
 * Phase C child-task creation input. A child is created by the runner
 * (internal to the task system, not a new MCP tool at first): its goal
 * and step list are supplied by the caller, its browser session is
 * inherited from the parent (one account = one browser session), and
 * it inherits NOTHING else — no parent steps, no parent step inputs,
 * no parent policy snapshot and no parent
 * plan bounds unless explicitly supplied here. Its mode must be a
 * child mode (explore or summary); anything else is rejected.
 */
export interface CreateChildInput {
  goal: string;
  steps: CreateStepInput[];
  totalBudgetMs?: number;
  mode: ChildMode;
  start?: boolean;
  planBounds?: PlanBounds;
}

/** Isolated child-task context: the child's own record only. It never
 * carries the parent's goal, steps, step inputs, or policy — a child
 * sees only its own steps/inputs (plus its parentId link). */
export interface ChildTaskContext {
  id: string;
  parentId: string;
  goal: string;
  mode: string;
  status: TaskStatus;
  steps: TaskView["steps"];
  finalReport: TaskView["finalReport"];
  resultSummary: string;
}

/** Phase C prune result as returned to callers (summary view only). */
export interface PruneTaskResult {
  view: TaskView;
  prunedStepIndices: number[];
  reclaimedChars: number;
  applied: boolean;
  reason: string | null;
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
    // Steps appended while this step was executing (tasks.appendSteps
    // only ever pushes at the end, with sequential indices) must
    // survive this checkpoint: the working copy predates them, and a
    // wholesale save would wipe the append. Carry the fresh tail over
    // when the prefix matches by index; otherwise fall back to the
    // working copy. The result summary is left to the next caller-side
    // refresh — recomputing here would drop the caller's extra lines
    // (e.g. a failure note) baked into working.resultSummary.
    if (fresh && fresh.steps.length > toSave.steps.length) {
      const prefixMatches = toSave.steps.every((s, i) => fresh.steps[i]?.index === s.index);
      if (prefixMatches) {
        toSave = { ...toSave, steps: [...toSave.steps, ...fresh.steps.slice(toSave.steps.length)] };
      }
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

  // -- plan bounds helpers (dry-run previews only) ----------------------

  private effectiveBudgetMs(task: TaskRecord): number {
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
    // Phase B: mode is pinned at creation and validated, never guessed.
    const mode = input.mode === undefined ? "act" : parseAgentMode(input.mode);
    if (mode === null) {
      throw new Error(`task creation rejected: unknown mode "${String(input.mode)}"`);
    }

    const now = this.now();
    const id = this.generateId();
    const steps = await this.buildStepRecords(id, input.steps, 0, "task creation rejected");

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
      // Phase C: top-level creation; createChildTask patches parentId
      // on the child record after creation (never on the parent).
      parentId: null,
      goal,
      clientId,
      browserSessionId,
      mode,
      status: "created",
      steps,
      totalBudgetMs,
      correlationId: this.generateId(),
      resultSummary: "",
      planBounds: input.planBounds !== undefined ? cloneJson(input.planBounds) : null,
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

  /**
   * Validate raw step inputs and build stored step records, shared by
   * createTask and appendSteps so appended steps are validated and
   * shaped exactly like created ones. Indices start at startIndex and
   * idempotency keys bind task id + final index, so appended steps
   * never collide with existing ones. Throws with errorPrefix on the
   * first malformed step; nothing is persisted by this helper.
   */
  private async buildStepRecords(
    taskId: string,
    rawSteps: CreateStepInput[],
    startIndex: number,
    errorPrefix: string,
  ): Promise<TaskStep[]> {
    const steps: TaskStep[] = [];
    for (let offset = 0; offset < rawSteps.length; offset += 1) {
      const index = startIndex + offset;
      const raw = rawSteps[offset] as CreateStepInput;
      if (!raw || typeof raw.tool !== "string" || raw.tool.trim() === "") {
        throw new Error(`${errorPrefix}: step ${index} must have a non-empty tool name`);
      }
      if (!raw.input || typeof raw.input !== "object" || Array.isArray(raw.input)) {
        throw new Error(`${errorPrefix}: step ${index} input must be an object`);
      }
      const timeoutMs = raw.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STEP_TIMEOUT_MS) {
        throw new Error(
          `${errorPrefix}: step ${index} timeoutMs must be between 1 and ${MAX_STEP_TIMEOUT_MS}, got ${String(raw.timeoutMs)}`,
        );
      }
      let compensation: TaskStep["compensation"] = { kind: "none", description: "" };
      if (raw.compensation !== undefined) {
        if (!COMPENSATION_KINDS.includes(raw.compensation.kind)) {
          throw new Error(`${errorPrefix}: step ${index} compensation kind must be one of ${COMPENSATION_KINDS.join(", ")}`);
        }
        compensation = {
          kind: raw.compensation.kind,
          description: typeof raw.compensation.description === "string" ? raw.compensation.description : "",
        };
      }
      // Phase B: verify conditions are generic only; a malformed one
      // is a creation error, never silently dropped.
      let verify: VerifyCondition | null = null;
      if (raw.verify !== undefined && raw.verify !== null) {
        const condition = raw.verify as VerifyCondition;
        if (condition.kind !== "url-equals" && condition.kind !== "url-contains" && condition.kind !== "element-present") {
          throw new Error(`${errorPrefix}: step ${index} verify kind must be url-equals, url-contains, or element-present`);
        }
        if (condition.kind !== "element-present" && (typeof condition.value !== "string" || condition.value === "")) {
          throw new Error(`${errorPrefix}: step ${index} verify ${condition.kind} requires a non-empty value`);
        }
        if (condition.value !== undefined && typeof condition.value !== "string") {
          throw new Error(`${errorPrefix}: step ${index} verify value must be a string`);
        }
        verify = { kind: condition.kind, ...(condition.value !== undefined ? { value: condition.value } : {}) };
      }
      const canonical = canonicalizeInput(raw.input);
      steps.push({
        index,
        tool: raw.tool,
        input: canonical,
        inputSummary: summarizeInput(raw.tool, canonical),
        idempotencyKey: await this.computeIdempotencyKey(taskId, index, canonical),
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
        verify,
        preStepSnapshot: null,
        verifySummary: "",
        verifyOutcome: null,
      });
    }
    return steps;
  }

  /**
   * Append steps to an existing task's plan (tasks.appendSteps): the
   * follow-up path for a job that already has a task, so the AI never
   * needs a second task for the same job. Appended steps queue behind
   * unexecuted steps as pending records and run through the identical
   * loop — same per-step executor/policy/approval gates, same taskId
   * attribution into activity/history, same bounds handling — because
   * the run loop reloads the record before every step and picks the
   * next pending one, and step checkpoints merge (never wipe) steps
   * appended while a step was executing. Status is never changed here: a
   * running task picks the steps up on its next reload, a paused or
   * waiting_approval task keeps them waiting with the rest, and a
   * created task keeps them for its first run. Terminal tasks reject;
   * the plan cap (MAX_STEPS_PER_TASK) and the task's own planBounds
   * maxSteps, when set, reject an append that would overflow them.
   */
  async appendSteps(id: string, clientId: string, rawSteps: CreateStepInput[]): Promise<TaskView> {
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new Error("task append rejected: steps must be a non-empty array");
    }
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (isTerminal(task.status)) {
      throw new Error(`task append rejected: task ${id} is ${task.status} and cannot accept new steps`);
    }
    if (task.steps.length + rawSteps.length > MAX_STEPS_PER_TASK) {
      throw new Error(
        `task append rejected: ${task.steps.length + rawSteps.length} steps would exceed the maximum of ${MAX_STEPS_PER_TASK}`,
      );
    }
    if (task.planBounds?.maxSteps !== undefined && task.steps.length + rawSteps.length > task.planBounds.maxSteps) {
      throw new Error(
        `task append rejected: plan bounds maxSteps (${task.planBounds.maxSteps}) is smaller than the plan length (${task.steps.length + rawSteps.length})`,
      );
    }
    const built = await this.buildStepRecords(id, rawSteps, task.steps.length, "task append rejected");
    task.steps.push(...built);
    // Pinned tabs: same rule as creation — a new tabId mentioned by an
    // appended step joins the pinned set with its first recorded url.
    for (const step of built) {
      const tabId = (step.input as Record<string, unknown>).tabId;
      if (typeof tabId === "number" && Number.isInteger(tabId) && !task.pinnedTabs.some((t) => t.tabId === tabId)) {
        const url = (step.input as Record<string, unknown>).url;
        task.pinnedTabs.push({ tabId, url: typeof url === "string" ? url : null });
      }
    }
    task.updatedAt = this.now();
    this.refreshSummary(task);
    const saved = await this.persistOnly(all, task, {
      kind: "task.steps-appended",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "appended",
      outcome: "success",
    });
    return toTaskView(saved);
  }

  // -- dry-run ------------------------------------------------------------

  /**
   * Dry-run preview (Phase 1, plan 3.4). Validates the whole plan —
   * tool existence (when the registry lookup is wired), canonical
   * params (when the schema validator is wired), risk per step, domains
   * touched, approvals needed, step count, total budget — and executes
   * NOTHING: no executor call, no store write, no task record. Steps
   * outside the supplied/creation bounds are reported as needing a
   * step approval, not as validation errors, because the plan can still
   * be created and the step will pause at run time under the normal
   * per-step approval path.
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
      // Phase B: preview validates verify conditions like creation does.
      const rawVerify = (raw as CreateStepInput | undefined)?.verify;
      if (rawVerify !== undefined && rawVerify !== null) {
        if (rawVerify.kind !== "url-equals" && rawVerify.kind !== "url-contains" && rawVerify.kind !== "element-present") {
          stepErrors.push(`step ${index} verify kind must be url-equals, url-contains, or element-present`);
        } else if (rawVerify.kind !== "element-present" && (typeof rawVerify.value !== "string" || rawVerify.value === "")) {
          stepErrors.push(`step ${index} verify ${rawVerify.kind} requires a non-empty value`);
        }
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

  // -- Phase C: child tasks, compaction, pruning -----------------------

  /**
   * Create a child task under a parent task (OpenCode subagent
   * analogue, Phase C). Rules, all fail-closed:
   * - The parent must exist and belong to the same client.
   * - A child may NOT create a child: when the named parent is itself
   *   a child task (parentId !== null), creation is denied with a
   *   clear error and nothing is created (mirroring OpenCode's
   *   `task: deny` for subagents) — the parent is unaffected.
   * - The child mode must be explore or summary; other modes are
   *   rejected, never guessed.
   * - The parent record is NEVER mutated: creation only appends the
   *   child, so a child cannot change its parent's mode, policy, or
   *   plan. The child gets a fresh policy snapshot supplied by the
   *   caller (not the parent's snapshot), and the parent's browser session (shared-session
   *   constraint; per-tab serialisation is shared because the
   *   runner's per-tab chains are instance-wide).
   * - Isolation: the child record contains only the supplied goal and
   *   steps. Parent steps and step inputs are never copied in; see
   *   getChildContext(), which returns the child's own record only.
   * - A summary-mode child has no browser tools (existing Phase B
   *   mode gating) and an explore-mode child never runs consequential
   *   steps (existing read/explore gating), so a child cannot act
   *   beyond its mode even though it shares the parent's browser.
   */
  async createChildTask(
    parentId: string,
    clientId: string,
    input: CreateChildInput,
    policySnapshotAtCreation: PolicySnapshot,
  ): Promise<TaskView> {
    const all = await this.loadAll();
    const parent = this.findOrThrow(all, parentId);
    this.assertClient(parent, clientId);
    if (taskParentId(parent) !== null) {
      throw new Error(
        `child task creation denied: task ${parentId} is itself a child task and cannot create children (task:deny)`,
      );
    }
    const childMode = parseChildMode(input.mode);
    if (childMode === null) {
      throw new Error(`child task creation rejected: child mode must be explore or summary, got "${String(input.mode)}"`);
    }
    const created = await this.createTask(
      {
        goal: input.goal,
        clientId,
        browserSessionId: parent.browserSessionId,
        steps: input.steps,
        ...(input.totalBudgetMs !== undefined ? { totalBudgetMs: input.totalBudgetMs } : {}),
        start: false,
        ...(input.planBounds !== undefined ? { planBounds: input.planBounds } : {}),
        mode: childMode,
      },
      policySnapshotAtCreation,
    );
    // Patch parentId onto the child record only. The parent object is
    // never written to; the store save below replaces only the child.
    const freshAll = await this.loadAll();
    const child = this.findOrThrow(freshAll, created.id);
    const patched: TaskRecord = { ...child, parentId: parent.id };
    const next = freshAll.map((task) => (task.id === patched.id ? patched : task));
    const saved = await this.saveList(next, patched, {
      kind: "task.created",
      taskId: patched.id,
      stepIndex: -1,
      tool: "",
      decision: "created",
      outcome: "child",
    });
    if (input.start === true) return this.runTask(patched.id, clientId);
    return toTaskView(saved);
  }

  /**
   * Isolated child context: the child's own goal, steps, status, and
   * final report — and nothing from the parent. A non-child id is
   * rejected, so this can never be used to read a parent's history
   * through a child id.
   */
  async getChildContext(id: string, clientId: string): Promise<ChildTaskContext> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    const parentId = taskParentId(task);
    if (parentId === null) throw new Error(`task ${id} is not a child task`);
    const view = toTaskView(task);
    return {
      id: view.id,
      parentId,
      goal: view.goal,
      mode: view.mode,
      status: view.status,
      steps: view.steps,
      finalReport: view.finalReport,
      resultSummary: view.resultSummary,
    };
  }

  /**
   * Phase C compacted view (view-only): summary records in place of
   * the full old step list. No store write — the underlying step
   * records are untouched.
   */
  async compactTaskView(id: string, clientId: string, options: CompactedViewOptions = {}): Promise<CompactedTaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    return buildCompactedView(task, options);
  }

  /**
   * Phase C output-only pruning: clears old completed step outputs
   * (see compaction.ts for the protected-record rules). When pruning
   * does not act (below the reclaim threshold) no store write happens
   * and the task is returned unchanged. Pruning never changes a
   * step's state, outcome, or verify result, and never changes the
   * task's status or policy snapshot.
   */
  async pruneTask(id: string, clientId: string, options: PruneTaskOutputsOptions = {}): Promise<PruneTaskResult> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    const result = pruneTaskOutputs(task, options);
    if (!result.applied) {
      return { view: toTaskView(task), prunedStepIndices: [], reclaimedChars: result.reclaimedChars, applied: false, reason: result.reason };
    }
    const next = all.map((entry) => (entry.id === id ? result.task : entry));
    const saved = await this.saveList(next, result.task, {
      kind: "task.pruned",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "pruned",
      outcome: `${result.prunedStepIndices.length} steps`,
    });
    return {
      view: toTaskView(saved),
      prunedStepIndices: result.prunedStepIndices,
      reclaimedChars: result.reclaimedChars,
      applied: true,
      reason: null,
    };
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
    // Phase B abort ordering: persist the pause FIRST, then abort.
    // Aborting first let the in-flight step's abort checkpoint race the
    // pause save and resurrect a "running" status; with the pause
    // durable first, the step's abort checkpoint merges onto it and
    // the run loop observes the paused status.
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
    this.controllers.get(id)?.abort();
    return toTaskView(saved);
  }

  async cancelTask(id: string, clientId: string): Promise<TaskView> {
    const all = await this.loadAll();
    const task = this.findOrThrow(all, id);
    this.assertClient(task, clientId);
    if (task.status === "cancelled" || task.status === "done" || task.status === "failed" || task.status === "partial") {
      return toTaskView(task);
    }
    // Phase B abort ordering (see pauseTask): persist the cancelled
    // status FIRST, then abort the in-flight step/verify, then run
    // compensations and persist the final report. The in-flight step's
    // abort checkpoint merges onto the durable cancelled status
    // instead of racing it back to "running".
    task.status = "cancelled";
    task.pauseReason = null;
    task.resumeAfterMs = null;
    task.completedAt = this.now();
    task.updatedAt = task.completedAt;
    await this.persistOnly(all, task, {
      kind: "task.cancelled",
      taskId: id,
      stepIndex: -1,
      tool: "",
      decision: "cancelled",
      outcome: "success",
    });
    this.controllers.get(id)?.abort();

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
    // Phase B: the mode pinned at run start is the mode for the whole
    // run. There is no resume/change-mode API; if the stored mode
    // differs on a later reload, the run pauses instead of adopting it.
    const pinnedMode = taskMode(task);
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

      // No plan gate: a bounded consequential plan runs straight into
      // the loop, where each consequential step goes through the normal
      // per-step executor/policy/approval path. A task left in
      // waiting_approval by the old gate therefore runs on resume.
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

        // Phase B: mode pinning, re-checked on every reload. A stored
        // mode change mid-run pauses (fail closed); it is never adopted
        // mid-task, and a later run pins whatever is stored then.
        if (taskMode(task) !== pinnedMode) {
          task.status = "paused";
          task.pauseReason = "mode-changed";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          const saved = await this.persistOnly(freshAll, task, {
            kind: "task.paused",
            taskId: id,
            stepIndex: -1,
            tool: "",
            decision: "paused",
            outcome: "mode-changed",
          });
          return toTaskView(saved);
        }

        // Total budget: elapsed since creation, checked before every step.
        // Phase B: budget exhaustion is terminal, not a pause — elapsed
        // time only grows, so a pause here could never resume into
        // success, and a silent dead-end pause is exactly what the
        // OpenCode MAX_STEPS synthetic finish replaces. The task ends
        // partial (something done) or failed (nothing done) with a
        // final report (done/undone/failed + manual cleanup), never a
        // silent loop and never an unbounded retry.
        if (this.now() - task.createdAt > this.effectiveBudgetMs(task)) {
          const anyDone = task.steps.some((s) => s.state === "done");
          task.status = anyDone ? "partial" : "failed";
          task.pauseReason = null;
          task.resumeAfterMs = null;
          task.completedAt = this.now();
          task.updatedAt = task.completedAt;
          const manualCleanup = task.steps
            .filter((s) => s.state !== "done")
            .map((s) => `Step ${s.index} (${s.tool}) not run: total budget exhausted — manual cleanup may be required`);
          this.refreshSummary(task, ["Total budget exhausted."]);
          this.setFinalReport(task, [], manualCleanup);
          const saved = await this.persistOnly(freshAll, task, {
            kind: "task.budget-exhausted",
            taskId: id,
            stepIndex: -1,
            tool: "",
            decision: task.status,
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

        // No plan-bounds pre-pause: a step outside the plan bounds is
        // not held here — it runs through the normal per-step approval
        // path in executeOne, exactly like any other consequential step.

        // Phase 3: a run of consecutive pending, independent steps in
        // the same parallel group runs together (read-only only;
        // consequential steps always stay sequential so each one faces
        // the normal per-step approval path).
        const batch = this.collectBatch(task, next);
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
   * Phase B per-iteration tool resolution. Runner-native mode gating
   * runs first (no registry needed): summary/compaction modes have no
   * browser tools, plan mode never executes, and read/explore modes
   * never run consequential steps. The wired resolveTool dep then
   * re-resolves against the live policy snapshot and scope; a dep
   * failure denies fail-closed. Absent dep = mode gate only.
   */
  private async resolveStepTool(task: TaskRecord, step: TaskStep): Promise<{ allowed: boolean; reason?: string }> {
    const mode = taskMode(task);
    if (mode === "summary" || mode === "compaction") {
      return { allowed: false, reason: `mode "${mode}" has no browser tools` };
    }
    if (mode === "plan") {
      return { allowed: false, reason: `mode "plan" never executes steps; approve the plan and resume in act mode` };
    }
    if (mode !== "act" && this.isConsequential(step.tool)) {
      return { allowed: false, reason: `tool "${step.tool}" is consequential and not allowed in mode "${mode}"` };
    }
    if (!this.deps.resolveTool) return { allowed: true };
    try {
      const resolved = await this.deps.resolveTool(step.tool, {
        mode,
        policySnapshot: task.policySnapshot,
        clientId: task.clientId,
        step: cloneJson(step),
      });
      return { allowed: resolved.allowed, reason: resolved.reason };
    } catch {
      return { allowed: false, reason: "tool resolution failed" };
    }
  }

  /** Phase B: a denied tool pauses the task (extended policy-changed pause), step left pending, never executed. */
  private async pauseForDenied(all: TaskRecord[], task: TaskRecord, step: TaskStep, reason: string): Promise<StepOutcome> {
    step.state = "pending";
    step.lastError = { code: "TOOL_DENIED", message: truncateSummary(reason), retryable: false };
    task.status = "paused";
    task.pauseReason = "policy-changed";
    task.resumeAfterMs = null;
    task.updatedAt = this.now();
    this.refreshSummary(task);
    await this.checkpoint(all, task, {
      kind: "task.policy-changed",
      taskId: task.id,
      stepIndex: step.index,
      tool: step.tool,
      decision: "paused",
      outcome: "policy-changed",
    });
    return "paused";
  }

  /** Phase B: a step interrupted by cancel/pause keeps its pending state; the checkpoint merge preserves the terminal/paused task status. */
  private async abortPending(all: TaskRecord[], task: TaskRecord, step: TaskStep): Promise<StepOutcome> {
    step.state = "pending";
    step.lastError = { code: "CANCELLED", message: "step aborted by task cancel or pause", retryable: false };
    task.updatedAt = this.now();
    this.refreshSummary(task);
    await this.checkpoint(all, task, {
      kind: "task.step-aborted",
      taskId: task.id,
      stepIndex: step.index,
      tool: step.tool,
      decision: "paused",
      outcome: "cancelled",
    });
    return "paused";
  }

  /** Phase B: a failed post-step verify marks the step unknown and pauses — dispatched is never marked done. */
  private async pauseForVerifyFailed(all: TaskRecord[], task: TaskRecord, step: TaskStep, detail: string): Promise<StepOutcome> {
    step.state = "unknown";
    step.verifyOutcome = "fail";
    step.lastError = { code: "VERIFY_FAILED", message: truncateSummary(detail), retryable: false };
    task.status = "paused";
    task.pauseReason = "verify-failed";
    task.updatedAt = this.now();
    this.refreshSummary(task);
    await this.checkpoint(all, task, {
      kind: "task.step-unknown",
      taskId: task.id,
      stepIndex: step.index,
      tool: step.tool,
      decision: "paused",
      outcome: "verify-failed",
    });
    return "paused";
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
   * independent, capped at MAX_PARALLEL_STEPS. Consequential steps
   * never join a batch: the batch stops before one and it runs
   * sequentially through the normal per-step approval path. Returns
   * fewer than 2 steps when no batch is eligible (caller then runs
   * the single step).
   */
  private collectBatch(task: TaskRecord, next: TaskStep): TaskStep[] {
    if (next.state !== "pending" || next.parallelGroup === null || next.independent !== true) return [next];
    const batch: TaskStep[] = [];
    for (const step of task.steps) {
      if (step.index < next.index) continue;
      if (batch.length >= MAX_PARALLEL_STEPS) break;
      if (step.state !== "pending" || step.parallelGroup !== next.parallelGroup || step.independent !== true) break;
      if (this.isConsequential(step.tool)) break;
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
    const signal = options.signal ?? new AbortController().signal;

    // Phase B per-iteration tool resolution: re-resolve before any tab
    // side effect, observation, or execution. A tool that has become
    // denied pauses the task instead of executing.
    const resolution = await this.resolveStepTool(task, step);
    if (!resolution.allowed) {
      return this.pauseForDenied(all, task, step, resolution.reason ?? `tool "${step.tool}" is denied`);
    }

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
        observed = await this.deps.preStepObserve(cloneJson(step), signal);
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

    // Phase B snapshot checkpoint: before a consequential step, capture
    // a bounded page snapshot into the step record and persist it
    // BEFORE executing, so verify comparison and resolveUnknown have a
    // pre-step state even if the worker restarts mid-step. A failed
    // capture pauses fail-closed; a pause/cancel issued during capture
    // wins via the checkpoint merge.
    if (consequential && this.deps.captureSnapshot) {
      let snapshot: PageSnapshotCheckpoint;
      try {
        snapshot = await this.deps.captureSnapshot(cloneJson(step), signal);
      } catch {
        task.status = "paused";
        task.pauseReason = "snapshot-failed";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.paused",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "snapshot-failed",
        });
        return "paused";
      }
      step.preStepSnapshot = {
        url: snapshot.url,
        a11ySummary: truncateSummary(snapshot.a11ySummary),
        formSummary: truncateSummary(snapshot.formSummary),
      };
      // The resolveUnknown re-execution path enters here with the task
      // still paused; executing means running, and the checkpoint merge
      // still lets a fresh pause/cancel win over this working status.
      task.status = "running";
      task.updatedAt = this.now();
      const saved = await this.checkpoint(all, task, {
        kind: "task.step-snapshot",
        taskId: task.id,
        stepIndex: step.index,
        tool: step.tool,
        decision: "snapshot",
        outcome: "success",
      });
      if (saved.status !== "running") return "paused";
      task = saved;
    }

    for (;;) {
      // Phase B abort propagation: a cancel/pause issued while the step
      // waited aborts before the next attempt, not just between steps.
      if (signal.aborted) return this.abortPending(all, task, step);
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
      // Live timeline: persist the step the moment it starts, so the
      // task list (and the dashboard timeline) shows what the task is
      // doing right now, not just finished steps. The checkpoint merge
      // still protects a pause/cancel issued while the step runs: the
      // stored status is never overwritten back to running, and the
      // run loop reloads before the next step and stops on a stored
      // pause. The merged status is deliberately NOT used as a stop
      // signal here: a stored pause predating this step (notably the
      // resolveUnknown re-execution path, where the task is paused by
      // the verify failure itself) is stale, not a fresh pause — gating
      // on it would make re-execution impossible.
      await this.checkpoint(all, task, {
        kind: "task.step-started",
        taskId: task.id,
        stepIndex: step.index,
        tool: step.tool,
        decision: "started",
        outcome: "started",
      });

      let result: StepExecutionResult;
      try {
        const run = (): Promise<StepExecutionResult> =>
          this.deps.executeStep(step.tool, cloneJson(step.input), {
            clientId: task.clientId,
            taskId: task.id,
            stepIndex: step.index,
            timeoutMs: step.timeoutMs,
            signal,
          });
        result = consequential && tabId !== null ? await this.throughTabChain(tabId, run) : await run();
      } catch (error) {
        // Phase B abort propagation: an in-flight tool call aborted by
        // task cancel/pause is an interruption, never a failure — the
        // step stays pending and the checkpoint merge keeps the
        // cancelled/paused task status. Compensations run in cancelTask.
        if (signal.aborted) return this.abortPending(all, task, step);
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
          // A denied step ends the task partial/failed (Phase 0
          // behaviour): a denial is never retried automatically.
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

      // Phase B verification as a runner step, not a client instruction:
      // after a consequential step, run a verify observation and record
      // it on the step. A step whose verify does not show the expected
      // state becomes unknown and pauses — it is never marked done on
      // dispatch. Without verify wiring the step is marked done as
      // before, with verifyOutcome "skipped" so the gap is visible.
      if (consequential && this.deps.postStepObserve) {
        let observed: PostStepObservation;
        try {
          observed = await this.deps.postStepObserve(cloneJson(step), signal);
        } catch {
          if (signal.aborted) return this.abortPending(all, task, step);
          return this.pauseForVerifyFailed(all, task, step, "post-step verify observation failed");
        }
        if (signal.aborted) return this.abortPending(all, task, step);
        step.verifySummary = truncateSummary(observed.summary);
        const verdict = evaluateVerifyCondition(step.verify, observed);
        if (!verdict.pass) {
          return this.pauseForVerifyFailed(all, task, step, verdict.detail);
        }
        step.verifyOutcome = "pass";
      } else if (consequential) {
        step.verifyOutcome = "skipped";
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
    // Phase B pre-flight: per-iteration resolution and snapshot capture
    // for every member BEFORE anything launches, so a denied tool or a
    // failed snapshot pauses the batch without partial execution.
    for (const step of batch) {
      const resolution = await this.resolveStepTool(task, step);
      if (!resolution.allowed) {
        return this.pauseForDenied(all, task, step, resolution.reason ?? `tool "${step.tool}" is denied`);
      }
    }
    if (this.deps.captureSnapshot) {
      for (const step of batch) {
        if (!this.isConsequential(step.tool)) continue;
        try {
          const snapshot = await this.deps.captureSnapshot(cloneJson(step), signal);
          step.preStepSnapshot = {
            url: snapshot.url,
            a11ySummary: truncateSummary(snapshot.a11ySummary),
            formSummary: truncateSummary(snapshot.formSummary),
          };
        } catch {
          task.status = "paused";
          task.pauseReason = "snapshot-failed";
          task.updatedAt = this.now();
          this.refreshSummary(task);
          await this.checkpoint(all, task, {
            kind: "task.paused",
            taskId: task.id,
            stepIndex: step.index,
            tool: step.tool,
            decision: "paused",
            outcome: "snapshot-failed",
          });
          return "paused";
        }
      }
    }
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
    // Live timeline: persist the batch the moment it starts, so the
    // task list shows every in-flight step right away. As in the
    // sequential path, the checkpoint merge still protects a
    // pause/cancel issued while the batch runs (the stored status is
    // never overwritten back to running), and the merged status is
    // deliberately not used as a launch gate: a stored pause predating
    // this batch is stale, not a fresh pause.
    await this.checkpoint(all, task, {
      kind: "task.step-started",
      taskId: task.id,
      stepIndex: batch[0].index,
      tool: batch[0].tool,
      decision: "started",
      outcome: "started",
    });
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
          });
        return this.isConsequential(step.tool) && tabId !== null ? this.throughTabChain(tabId, run) : run();
      }),
    );

    let stop: StepOutcome | null = null;
    for (let i = 0; i < batch.length; i += 1) {
      const step = batch[i];
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        // Phase B verification for consequential batch members, same
        // rule as the sequential path: a failed verify marks the step
        // unknown and pauses (after the whole batch is recorded).
        if (this.isConsequential(step.tool) && this.deps.postStepObserve) {
          let observed: PostStepObservation;
          try {
            observed = await this.deps.postStepObserve(cloneJson(step), signal);
          } catch {
            if (signal.aborted) {
              step.state = "pending";
              step.lastError = { code: "CANCELLED", message: "step aborted by task cancel or pause", retryable: false };
            } else {
              step.state = "unknown";
              step.verifyOutcome = "fail";
              step.lastError = { code: "VERIFY_FAILED", message: "post-step verify observation failed", retryable: false };
            }
            task.status = "paused";
            task.pauseReason = signal.aborted ? "cancelled" : "verify-failed";
            task.updatedAt = this.now();
            this.refreshSummary(task);
            await this.checkpoint(all, task, {
              kind: "task.step-unknown",
              taskId: task.id,
              stepIndex: step.index,
              tool: step.tool,
              decision: "paused",
              outcome: signal.aborted ? "cancelled" : "verify-failed",
            });
            stop = "paused";
            continue;
          }
          step.verifySummary = truncateSummary(observed.summary);
          const verdict = evaluateVerifyCondition(step.verify, observed);
          if (!verdict.pass) {
            step.state = "unknown";
            step.verifyOutcome = "fail";
            step.lastError = { code: "VERIFY_FAILED", message: truncateSummary(verdict.detail), retryable: false };
            task.status = "paused";
            task.pauseReason = "verify-failed";
            task.updatedAt = this.now();
            this.refreshSummary(task);
            await this.checkpoint(all, task, {
              kind: "task.step-unknown",
              taskId: task.id,
              stepIndex: step.index,
              tool: step.tool,
              decision: "paused",
              outcome: "verify-failed",
            });
            stop = "paused";
            continue;
          }
          step.verifyOutcome = "pass";
        } else if (this.isConsequential(step.tool)) {
          step.verifyOutcome = "skipped";
        }
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
      // Phase B abort propagation in batches: an aborted member is an
      // interruption, never a failure.
      if (signal.aborted) {
        step.state = "pending";
        step.lastError = { code: "CANCELLED", message: "step aborted by task cancel or pause", retryable: false };
        task.status = "paused";
        task.pauseReason = "cancelled";
        task.updatedAt = this.now();
        this.refreshSummary(task);
        await this.checkpoint(all, task, {
          kind: "task.step-aborted",
          taskId: task.id,
          stepIndex: step.index,
          tool: step.tool,
          decision: "paused",
          outcome: "cancelled",
        });
        stop = "paused";
        continue;
      }
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
