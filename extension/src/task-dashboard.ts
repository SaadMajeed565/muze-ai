/**
 * Dashboard progress view for durable tasks (Phase 0 task engine).
 *
 * This module is the dashboard-side handler the coordinator wires into
 * service-worker.ts. It intentionally does NOT touch service-worker.ts,
 * storage, the task runner, or any tool contract: it only translates
 * dashboard messages into calls on a TaskDashboardPort (supplied by the
 * coordinator's wiring, which owns the client context) and sanitises the
 * result into the frozen TaskView shape.
 *
 * Sanitisation rule (non-negotiable): the dashboard never sees step
 * inputs, tokens, passwords, page content, or screenshots. Only the
 * goal, description, status, progress, step tool + state +
 * outputSummary, done/undone lists, pauseReason, and resultSummary
 * cross this boundary. The
 * sanitiser below rebuilds every view from an allowlist of fields, so a
 * record that happens to carry an `input` (or any other extra field) can
 * never leak through, even if the port returns more than TaskView.
 *
 * The dashboard runs in extension context as the user, not as an MCP
 * client, so pause/resume/cancel take the task id only. There is NO
 * MCP approval flag on these requests: the dashboard's own confirm()
 * dialog (in the Tasks page) is the user confirmation, and the service
 * worker's dashboard trust model is the same as for every other
 * dashboard action. Do not add a `confirmed` field to the request.
 */

export type TaskStatus =
  | "created"
  | "running"
  | "paused"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "partial";

export type TaskStepState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "waiting_approval"
  | "unknown";

/** One step as the dashboard may see it. No `input` field, ever. */
export interface TaskStepView {
  index: number;
  tool: string;
  inputSummary: string;
  state: TaskStepState;
  attempts: number;
  outputSummary: string;
  /** Why this step paused outside the plan bounds, if it did (legacy field). */
  outsideBoundsReason?: string;
}

/** Structured final report (Phase 2), mirroring the runner's report. */
export interface TaskFinalReport {
  done: number[];
  undone: number[];
  failed: number[];
  compensations: string[];
  manualCleanup: string[];
}

/**
 * Frozen view shape (other sections use this — do not rename fields).
 * `resumeAfterMs` / `pauseReason` are present only when applicable.
 */
export interface TaskView {
  id: string;
  goal: string;
  /** Description-based model: the todo-in-words, when the record carries one. */
  description?: string;
  clientId: string;
  browserSessionId: string;
  status: TaskStatus;
  steps: TaskStepView[];
  totalSteps: number;
  doneSteps: number[];
  undoneSteps: number[];
  totalBudgetMs: number;
  correlationId: string;
  resultSummary: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number;
  resumeAfterMs?: number;
  pauseReason?: string;
  /** Phase B: agent mode pinned at creation; omitted for pre-Phase-B tasks (read as act). */
  mode?: string;
  /** Phase D: true when the runner record carries a parentId, i.e. this
   * is a Phase C child task. The parent id itself is never exposed to
   * the dashboard — only the boolean, so the loop-status view can mark
   * child tasks without leaking task linkage beyond that. */
  isChild?: boolean;
  /** Phase 2: present once the task reaches a terminal state. */
  finalReport?: TaskFinalReport;
}

/**
 * The handler's dependency, supplied by the coordinator's service-worker
 * wiring (which owns the client context). Faked in tests.
 */
export interface TaskDashboardPort {
  listTasks(clientId?: string): Promise<TaskView[]>;
  getTask(id: string): Promise<TaskView>;
  pauseTask(id: string, reason?: string): Promise<TaskView>;
  resumeTask(id: string): Promise<TaskView>;
  cancelTask(id: string): Promise<TaskView>;
}

/**
 * Dashboard -> handler request. Deliberately has no approval/confirmed
 * flag: dashboard pause/resume/cancel need no MCP clientId and no MCP
 * approval flag (see module header).
 */
export interface TaskDashboardRequest {
  type: string;
  taskId?: string;
  reason?: string;
}

export interface TaskDashboardResponse {
  ok: boolean;
  tasks?: TaskView[];
  task?: TaskView;
  error?: string;
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "running",
  "paused",
  "waiting_approval",
  "done",
  "failed",
  "cancelled",
  "partial",
]);

const TASK_STEP_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
  "waiting_approval",
  "unknown",
]);

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) out.push(entry);
  }
  return out;
}

function sanitizeStep(value: unknown): TaskStepView {
  const step = (value ?? {}) as Record<string, unknown>;
  const state = asString(step.state, "pending");
  const view: TaskStepView = {
    index: asNumber(step.index, 0),
    tool: asString(step.tool),
    inputSummary: asString(step.inputSummary),
    state: TASK_STEP_STATES.has(state) ? (state as TaskStepState) : "pending",
    attempts: asNumber(step.attempts, 0),
    outputSummary: asString(step.outputSummary),
    // NOTE: `input` (and every other field) is dropped here by
    // construction — only the allowlisted fields above are copied.
  };
  if (typeof step.outsideBoundsReason === "string" && step.outsideBoundsReason !== "") {
    view.outsideBoundsReason = step.outsideBoundsReason;
  }
  return view;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function sanitizeFinalReport(value: unknown): TaskFinalReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    done: asNumberList(record.done),
    undone: asNumberList(record.undone),
    failed: asNumberList(record.failed),
    compensations: asStringList(record.compensations),
    manualCleanup: asStringList(record.manualCleanup),
  };
}

/**
 * Rebuild a TaskView from an allowlist of fields. Anything else on the
 * source record — step inputs, tokens, page content, screenshots, or
 * future fields — is dropped, never forwarded to the dashboard.
 */
export function sanitizeTaskView(value: unknown): TaskView {
  const record = (value ?? {}) as Record<string, unknown>;
  const status = asString(record.status, "created");
  const steps = Array.isArray(record.steps) ? record.steps.map(sanitizeStep) : [];
  const view: TaskView = {
    id: asString(record.id),
    goal: asString(record.goal),
    clientId: asString(record.clientId),
    ...(typeof record.description === "string" && record.description !== "" ? { description: record.description } : {}),
    browserSessionId: asString(record.browserSessionId),
    status: TASK_STATUSES.has(status) ? (status as TaskStatus) : "created",
    steps,
    totalSteps: asNumber(record.totalSteps, steps.length),
    doneSteps: asNumberList(record.doneSteps),
    undoneSteps: asNumberList(record.undoneSteps),
    totalBudgetMs: asNumber(record.totalBudgetMs, 0),
    correlationId: asString(record.correlationId),
    resultSummary: asString(record.resultSummary),
    createdAt: asNumber(record.createdAt, 0),
    updatedAt: asNumber(record.updatedAt, 0),
    completedAt: asNumber(record.completedAt, 0),
  };
  if (typeof record.resumeAfterMs === "number" && Number.isFinite(record.resumeAfterMs)) {
    view.resumeAfterMs = record.resumeAfterMs;
  }
  // Phase B: pinned task mode passes through when present; pre-Phase-B
  // views omit it and read as act.
  if (typeof record.mode === "string" && record.mode !== "") {
    view.mode = record.mode;
  }
  // Phase D: child status passes through as a boolean only; the parent
  // id itself is dropped by the allowlist, like every other non-listed
  // field.
  if (typeof record.parentId === "string" && record.parentId !== "") {
    view.isChild = true;
  }
  if (typeof record.pauseReason === "string") view.pauseReason = record.pauseReason;
  const finalReport = sanitizeFinalReport(record.finalReport);
  if (finalReport) view.finalReport = finalReport;
  return view;
}

/**
 * Phase D loop status for the dashboard, derived purely from the
 * runner-written TaskView — never hand-set by the dashboard. The
 * runner is the loop owner: its status, pauseReason, resultSummary,
 * and final report are the state, and this function only names it for
 * display (the OpenCode TUI `idle | busy | retry` analogue).
 *
 * - `verify-failed`: paused with pauseReason `verify-failed` (Phase B
 *   post-step verify observation did not show the expected state).
 * - `budget-terminal`: terminal (partial/failed) with the runner's own
 *   budget-exhaustion markers — resultSummary "Total budget
 *   exhausted." and/or a final-report manual-cleanup line naming the
 *   total budget. Any other partial/failed ending keeps its own name.
 * - `waiting_approval` / `paused` / `running` / `created` / `done` /
 *   `failed` / `cancelled` / `partial`: the runner status itself,
 *   spelled exactly as the runner writes it.
 * - `child` is a separate flag (Phase C parentId), not a status: a
 *   child task can be running, paused, or verify-failed, and the
 *   dashboard shows both.
 *
 * Deliberately absent: compacted/pruned state. Phase C compaction is
 * view-only and pruning clears step outputSummary fields with no
 * stored flag, so a pruned step is indistinguishable in a TaskView
 * from a step that legitimately had an empty summary. Deriving a
 * "pruned" badge from empty summaries would be a guess, so no such
 * badge is shown until the runner records pruning explicitly.
 */
export type LoopStatus =
  | "running"
  | "paused"
  | "verify-failed"
  | "budget-terminal"
  | "waiting_approval"
  | "created"
  | "done"
  | "failed"
  | "cancelled"
  | "partial";

export interface LoopStatusInfo {
  loop: LoopStatus;
  child: boolean;
  mode: string;
}

function isBudgetTerminal(view: TaskView): boolean {
  if (view.resultSummary.includes("Total budget exhausted")) return true;
  return (view.finalReport?.manualCleanup ?? []).some((line) => line.includes("total budget exhausted"));
}

export function deriveLoopStatus(view: TaskView): LoopStatusInfo {
  const child = view.isChild === true;
  const mode = view.mode ?? "act";
  if (view.status === "paused" && view.pauseReason === "verify-failed") {
    return { loop: "verify-failed", child, mode };
  }
  if ((view.status === "partial" || view.status === "failed") && isBudgetTerminal(view)) {
    return { loop: "budget-terminal", child, mode };
  }
  return { loop: view.status, child, mode };
}

/**
 * Normalise a dashboard task request type. The service worker already
 * normalises "uabb/*" to "muze/*" before dispatch, but the handler
 * accepts the legacy spelling directly too, so it stays correct when
 * called from any wiring.
 */
export function normalizeTaskDashboardRequestType(type: unknown): string | null {
  if (typeof type !== "string") return null;
  if (type.startsWith("muze/tasks.")) return type;
  if (type.startsWith("uabb/tasks.")) return `muze/tasks.${type.slice("uabb/tasks.".length)}`;
  return null;
}

/**
 * Handle one dashboard task request. Never throws: port failures and
 * malformed requests become `{ ok: false, error }`. Never returns a raw
 * task record — every view goes through `sanitizeTaskView`.
 */
export async function handleTaskDashboardRequest(
  request: TaskDashboardRequest,
  port: TaskDashboardPort,
): Promise<TaskDashboardResponse> {
  const type = normalizeTaskDashboardRequestType(request?.type);
  if (type === null) return { ok: false, error: "unknown task dashboard request" };
  try {
    switch (type) {
      case "muze/tasks.list": {
        const tasks = await port.listTasks();
        return { ok: true, tasks: tasks.map(sanitizeTaskView) };
      }
      case "muze/tasks.get":
      case "muze/tasks.pause":
      case "muze/tasks.resume":
      case "muze/tasks.cancel": {
        const taskId = typeof request.taskId === "string" ? request.taskId.trim() : "";
        if (!taskId) return { ok: false, error: "task id required" };
        let task: TaskView;
        if (type === "muze/tasks.get") task = await port.getTask(taskId);
        else if (type === "muze/tasks.pause") task = await port.pauseTask(taskId, request.reason);
        else if (type === "muze/tasks.resume") task = await port.resumeTask(taskId);
        else task = await port.cancelTask(taskId);
        return { ok: true, task: sanitizeTaskView(task) };
      }
      default:
        return { ok: false, error: "unknown task dashboard request" };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
