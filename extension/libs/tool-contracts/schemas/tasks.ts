import { z } from "zod";
import type { ToolDefinition } from "../tools.js";

/**
 * Phase 0 task contracts (registry 2.1.0, additive only).
 *
 * A task is a durable job owned by the extension: a goal plus an ordered
 * list of steps, each step naming an existing tool and its input. The
 * extension's task runner executes the steps sequentially through the
 * existing executor/policy/approval path; the gateway never executes a
 * step and never synthesises a task view.
 *
 * Two deliberate boundaries, kept explicit so a later section does not
 * blur them:
 *
 * - Step inputs are NOT validated against the wrapped tool's schema at
 *   create time. A step input is a generic record
 *   (`z.record(z.string(), z.unknown())`) because steps wrap arbitrary
 *   existing tools; validating here would duplicate the executor and
 *   drift from it. The runner/executor validates the wrapped tool input
 *   at execution time, when policy and approval are re-checked.
 * - A TaskView is a summary view, never the stored record: it carries
 *   per-step `inputSummary`/`outputSummary` strings, never step inputs,
 *   never tokens, never raw outputs. Host dispatch validates the
 *   runner's return against TaskViewSchema so a raw record can never
 *   leak across the bridge.
 *
 * No confirmation flags (`confirmed` / `userApproved` / `approved`)
 * appear anywhere in these schemas, and every object is strict: a
 * client-supplied approval flag is rejected at parse time and is never
 * approval, consistent with the 0.3.0 contract change.
 *
 * Dry-run (this file): `tasks.create` with `dryRun: true` returns a
 * preview instead of creating a task. There is no separate tool for
 * approving a plan, and no approval field anywhere in these schemas: a client-supplied
 * approval flag is rejected at parse time and is never approval, and
 * every consequential step still goes through the normal per-step
 * approval path at execution time.
 */

export const TASK_STATUSES = ["created", "running", "paused", "waiting_approval", "done", "failed", "cancelled", "partial"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskStatusSchema = z.enum(TASK_STATUSES);

/**
 * Compensation for one step, best-effort and honestly reported: the
 * runner reports what ran and what is still manual, and never claims
 * true rollback for external actions.
 */
export const TaskCompensationSchema = z
  .object({
    kind: z.enum(["none", "close-tab", "navigate-back", "delete-download", "manual"]),
    description: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type TaskCompensation = z.infer<typeof TaskCompensationSchema>;

/** Phase B generic verify condition for one step (generic only: a URL
 * check or an element-presence check — never a site procedure). The
 * runner validates it at creation (url kinds require a value). */
export const TaskStepVerifySchema = z
  .object({
    kind: z.enum(["url-equals", "url-contains", "element-present"]).describe("Generic verify condition kind"),
    value: z.string().min(1).max(2000).optional().describe("URL for url-equals, substring for url-contains, ref for element-present (else the step input's ref)"),
  })
  .strict();
export type TaskStepVerify = z.infer<typeof TaskStepVerifySchema>;

/** One planned step. `tool` must be a non-empty existing tool name; the
 * wrapped `input` is validated by the runner/executor at execution time,
 * not here (see the header note). */
export const TaskStepInputSchema = z
  .object({
    tool: z.string().min(1).max(128).describe("Name of an existing tool to run for this step"),
    input: z.record(z.string(), z.unknown()).describe("Input for the wrapped tool; validated at execution time, not at create time"),
    timeoutMs: z.number().int().min(1).max(60_000).optional().describe("Per-step timeout, 1..60000 ms"),
    compensation: TaskCompensationSchema.optional(),
    independent: z.boolean().optional().describe("Phase 3: this step does not depend on sibling steps; required for parallel execution"),
    parallelGroup: z.number().int().min(0).optional().describe("Phase 3: steps sharing a group run together when all are independent and read-only (max 4); consequential steps never join a batch and run sequentially through per-step approval"),
    verify: TaskStepVerifySchema.optional().describe("Phase B: generic verify condition checked by the runner after a consequential step; a failed verify marks the step unknown and pauses, never done on dispatch"),
  })
  .strict();
export type TaskStepInput = z.infer<typeof TaskStepInputSchema>;

/**
 * Phase B agent modes for tasks (mirrors the Phase A gateway modes).
 * A task's mode is pinned at creation; the gateway already validates a
 * tasks.create mode field and forwards it unchanged, so this schema is
 * the extension-side acceptance of that field — an unknown mode is
 * rejected at parse time, never guessed.
 */
export const TASK_AGENT_MODES = ["read", "act", "plan", "explore", "summary", "compaction"] as const;
export const TaskAgentModeSchema = z.enum(TASK_AGENT_MODES);
export type TaskAgentMode = z.infer<typeof TaskAgentModeSchema>;

/** One step as reported in a TaskView. `state` is a free string because
 * the runner owns the step-state vocabulary; the view never carries the
 * step's raw input or raw output, only bounded summaries. */
export const TaskStepViewSchema = z
  .object({
    index: z.number().int().min(0),
    tool: z.string().min(1),
    inputSummary: z.string(),
    state: z.string().min(1),
    attempts: z.number().int().min(0),
    outputSummary: z.string(),
    outsideBoundsReason: z.string().max(1000).optional().describe("Legacy field: why this step paused outside the plan bounds, if it did (the run loop no longer pauses on it)"),
    verifySummary: z.string().optional().describe("Phase B: truncated post-step verify observation, when a verify ran"),
    verifyOutcome: z.string().optional().describe("Phase B: pass, fail, or skipped (consequential step without verify wiring)"),
  })
  .strict();
export type TaskStepView = z.infer<typeof TaskStepViewSchema>;

/** Structured final report (Phase 2): done/undone/failed indices plus
 * compensations that ran and manual cleanup still required. */
export const TaskFinalReportSchema = z
  .object({
    done: z.array(z.number().int().min(0)),
    undone: z.array(z.number().int().min(0)),
    failed: z.array(z.number().int().min(0)),
    compensations: z.array(z.string()),
    manualCleanup: z.array(z.string()),
  })
  .strict();
export type TaskFinalReport = z.infer<typeof TaskFinalReportSchema>;

/**
 * Plan-level bounds. All restrictions, all optional: purchases,
 * payments, and external submits default to denied when omitted.
 * Bounds are data for dry-run previews; they never pre-approve a step.
 */
export const PlanBoundsSchema = z
  .object({
    allowedTools: z.array(z.string().min(1)).optional(),
    allowedRiskLevels: z.array(z.string().min(1)).optional(),
    allowedDomains: z.array(z.string().min(1)).optional().describe("Domain list or globs, e.g. example.com or *.example.com"),
    allowPurchases: z.boolean().optional(),
    allowPayments: z.boolean().optional(),
    allowExternalSubmit: z.boolean().optional(),
    maxSteps: z.number().int().min(1).max(100).optional(),
    maxAttemptsPerStep: z.number().int().min(1).max(10).optional(),
    totalBudgetMs: z.number().int().positive().optional(),
  })
  .strict();
export type PlanBounds = z.infer<typeof PlanBoundsSchema>;

/** One step of a dry-run preview. */
export const DryRunPreviewStepSchema = z
  .object({
    index: z.number().int().min(0),
    tool: z.string(),
    inputSummary: z.string(),
    risk: z.string(),
    needsApproval: z.boolean(),
    domains: z.array(z.string()),
    valid: z.boolean(),
    errors: z.array(z.string()),
    outsideBoundsReason: z.string().nullable(),
  })
  .strict();
export type DryRunPreviewStep = z.infer<typeof DryRunPreviewStepSchema>;

/** Dry-run preview: the validated plan, never a task record. */
export const DryRunPreviewSchema = z
  .object({
    goal: z.string(),
    totalSteps: z.number().int().min(0).max(100),
    totalBudgetMs: z.number().int(),
    domains: z.array(z.string()),
    steps: z.array(DryRunPreviewStepSchema).max(100),
    approvalsNeeded: z.array(z.number().int().min(0)),
    errors: z.array(z.string()),
    valid: z.boolean(),
  })
  .strict();
export type DryRunPreview = z.infer<typeof DryRunPreviewSchema>;

export const TaskViewSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1).max(2000),
    clientId: z.string().min(1),
    browserSessionId: z.string().min(1).optional(),
    mode: TaskAgentModeSchema.optional().describe("Phase B: agent mode pinned at creation; omitted for pre-Phase-B tasks (read as act)"),
    status: TaskStatusSchema,
    steps: z.array(TaskStepViewSchema).min(1).max(100),
    totalSteps: z.number().int().min(1).max(100),
    doneSteps: z.array(z.number().int().min(0)),
    undoneSteps: z.array(z.number().int().min(0)),
    totalBudgetMs: z.number().int().positive(),
    correlationId: z.string().min(1),
    resultSummary: z.string(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    completedAt: z.number().int().nullable().optional(),
    resumeAfterMs: z.number().int().min(0).optional(),
    pauseReason: z.string().max(1000).optional(),
    finalReport: TaskFinalReportSchema.optional().describe("Phase 2: structured final report, present once the task reaches a terminal state"),
  })
  .strict();
export type TaskView = z.infer<typeof TaskViewSchema>;

export const TasksCreateInputSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    steps: z.array(TaskStepInputSchema).min(1).max(100),
    totalBudgetMs: z.number().int().positive().optional().describe("Total budget for the whole task in ms; omit for the runner default"),
    start: z.boolean().default(true).describe("Start running immediately; false leaves the task created but not started"),
    browserSessionId: z.string().min(1).max(256).optional().describe("Target browser session; a task never moves to a different browser on its own"),
    bounds: PlanBoundsSchema.optional().describe("Plan bounds supplied at creation (data for dry-run previews; never pre-approval — consequential steps still go through per-step approval)"),
    dryRun: z.boolean().optional().describe("When true, validate the whole plan and return a preview; execute nothing and create no task record"),
    mode: TaskAgentModeSchema.optional().describe("Phase B: agent mode pinned at creation (read/act/plan/explore/summary/compaction); omit for act. Never changes mid-task; this field never changes the caller's session mode"),
  })
  .strict();
export type TasksCreateInput = z.infer<typeof TasksCreateInputSchema>;

export const TasksGetInputSchema = z.object({ taskId: z.string().min(1).max(256) }).strict();
export type TasksGetInput = z.infer<typeof TasksGetInputSchema>;

export const TasksListInputSchema = z.object({ browserSessionId: z.string().min(1).max(256).optional() }).strict();
export type TasksListInput = z.infer<typeof TasksListInputSchema>;

export const TasksPauseInputSchema = z
  .object({ taskId: z.string().min(1).max(256), reason: z.string().min(1).max(1000).optional() })
  .strict();
export type TasksPauseInput = z.infer<typeof TasksPauseInputSchema>;

export const TasksResumeInputSchema = z.object({ taskId: z.string().min(1).max(256) }).strict();
export type TasksResumeInput = z.infer<typeof TasksResumeInputSchema>;

export const TasksCancelInputSchema = z.object({ taskId: z.string().min(1).max(256) }).strict();
export type TasksCancelInput = z.infer<typeof TasksCancelInputSchema>;

export const TasksAppendStepsInputSchema = z
  .object({
    taskId: z.string().min(1).max(256).describe("Id returned by tasks.create for the task to extend"),
    steps: z.array(TaskStepInputSchema).min(1).max(100).describe("Steps to append to the task's plan, same shape as tasks.create steps"),
  })
  .strict();
export type TasksAppendStepsInput = z.infer<typeof TasksAppendStepsInputSchema>;

export const TasksListOutputSchema = z.object({ tasks: z.array(TaskViewSchema) }).strict();
export type TasksListOutput = z.infer<typeof TasksListOutputSchema>;

export const tasksCreate: ToolDefinition = {
  name: "tasks.create",
  title: "Create task",
  description:
    "Create a durable multi-step task in the extension and, by default, start running it. Creating the task is reversible (it can be paused or cancelled); consequential steps inside the task still go through the existing executor, policy, and approval gates at execution time, so creating a task never pre-approves its steps. The task's title (goal) must be a short phrase you rephrase in concise, action-first words — never the user's prompt copied verbatim as the title. Good: a user prompt like \"open github.com/SaadMajeed565/muze-ai in a new tab, scroll down slowly, and take a screenshot\" becomes the title \"Screenshot the Muze AI repo\". Bad: using that prompt itself as the title. tasks.create returns the task id; reuse it with tasks.appendSteps to add follow-up steps to the same task instead of creating a second task for the same job.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  input: TasksCreateInputSchema,
  output: TaskViewSchema,
};

export const tasksGet: ToolDefinition = {
  name: "tasks.get",
  title: "Get task",
  description: "Read the current view of one task: status, step progress, done and undone steps, and result summary. Read-only; returns the summary view, never step inputs or raw outputs.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  input: TasksGetInputSchema,
  output: TaskViewSchema,
};

export const tasksList: ToolDefinition = {
  name: "tasks.list",
  title: "List tasks",
  description: "List tasks for this client, optionally filtered to one browser session. Read-only; returns summary views only.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  input: TasksListInputSchema,
  output: TasksListOutputSchema,
};

export const tasksPause: ToolDefinition = {
  name: "tasks.pause",
  title: "Pause task",
  description: "Pause a running or waiting task; it can be resumed later from its checkpoint. Reversible.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  input: TasksPauseInputSchema,
  output: TaskViewSchema,
};

export const tasksResume: ToolDefinition = {
  name: "tasks.resume",
  title: "Resume task",
  description:
    "Resume a paused task from its checkpoint. Reversible. Resume re-checks the client and scope in the runner; the gateway must not weaken this, and a resume never re-runs steps already recorded done.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  input: TasksResumeInputSchema,
  output: TaskViewSchema,
};

export const tasksCancel: ToolDefinition = {
  name: "tasks.cancel",
  title: "Cancel task",
  description:
    "Cancel a task. Steps already done stay done and are reported as such; remaining steps are reported undone, with best-effort compensations. Reversible in the sense that cancellation itself does not destroy the task record.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  input: TasksCancelInputSchema,
  output: TaskViewSchema,
};

export const tasksAppendSteps: ToolDefinition = {
  name: "tasks.appendSteps",
  title: "Append task steps",
  description:
    "Append steps to an existing task's plan using the id tasks.create returned. Follow-up work for the same job goes here — never create a second task for work that continues an existing one. Appended steps queue behind unexecuted steps and run through the same executor, policy, and approval gates at execution time; appending never pre-approves them. Appending to a finished task (done, failed, cancelled, partial) is rejected.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  input: TasksAppendStepsInputSchema,
  output: TaskViewSchema,
};

export const taskTools: ToolDefinition[] = [tasksCreate, tasksAppendSteps, tasksGet, tasksList, tasksPause, tasksResume, tasksCancel];

export const TASK_TOOL_NAMES: string[] = taskTools.map((t) => t.name);
