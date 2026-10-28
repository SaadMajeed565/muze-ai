/**
 * Phase C compaction and pruning (OpenCode adoption plan §6, Phase C).
 *
 * Pure helpers over TaskRecord — no chrome APIs, no execution, no
 * model calls, no approval or policy changes.
 *
 * Two deliberately separate operations, mirroring OpenCode's split
 * between compaction (a summary view) and pruning (erasing stored
 * output):
 *
 * - Compaction is VIEW-ONLY. buildCompactedView() returns a summary
 *   view in which old steps are replaced by counts, checkpoint
 *   summaries, and the final-report shape. It never mutates the task
 *   and never deletes an underlying step record; the raw records stay
 *   in storage until the existing 7-day task prune.
 * - Pruning is OUTPUT-ONLY. pruneTaskOutputs() clears only the
 *   `outputSummary` field of old completed steps. It never changes a
 *   step's state, outcome, verify result, checkpoint, input,
 *   idempotency key, or the task's policy snapshot / plan approval,
 *   and it never touches approvals, checkpoints, or the latest verify
 *   record (see PROTECTED rules below).
 *
 * Privacy invariant (inherited from types.ts): a compacted view, like
 * a TaskView, never carries raw step inputs — only tool names,
 * argument keys, and bounded summaries.
 */
import type { TaskRecord, TaskStepView, TaskFinalReport } from "./types.js";
import { cloneJson, toTaskView } from "./types.js";

/** Default protected tail: the most recent N steps are never pruned. */
export const COMPACTED_TAIL_STEPS_DEFAULT = 10;
/** Default reclaim threshold: pruning does nothing below this many
 * reclaimed output-summary characters, so storage rewrites do not
 * thrash on tiny savings (OpenCode's PRUNE_MINIMUM analogue, in
 * characters rather than tokens because Muze summaries are char-
 * bounded at write time). */
export const PRUNE_MIN_RECLAIM_CHARS_DEFAULT = 1000;

/** Step states whose outputs may be pruned: finished steps only. */
const PRUNABLE_STATES = new Set(["done", "failed", "skipped"]);

export interface CompactedCheckpointSummary {
  stepIndex: number;
  /** Tab URL from the Phase B page-snapshot checkpoint (metadata
   * only — never node text, page content, or screenshots). */
  url: string | null;
}

export interface CompactedTaskView {
  taskId: string;
  /** Phase C child-task link; null for a top-level task. */
  parentId: string | null;
  goal: string;
  mode: string;
  status: string;
  /** Tail steps only, as full step views (newest N steps). */
  steps: TaskStepView[];
  /** Indices of the steps replaced by the summary below. */
  coveredStepIndices: number[];
  /** Counts over the covered (old) steps only. */
  covered: { done: number[]; undone: number[]; failed: number[] };
  /** Bounded page-snapshot checkpoints, across all steps. */
  checkpoints: CompactedCheckpointSummary[];
  /** Final report when the task has reached a terminal state. */
  finalReport: TaskFinalReport | null;
  resultSummary: string;
  /** True when at least one step was replaced by the summary. */
  compacted: boolean;
}

export interface CompactedViewOptions {
  /** Tail size; defaults to COMPACTED_TAIL_STEPS_DEFAULT. */
  tailSteps?: number;
}

/**
 * Build the compacted view of a task. Pure: the input task is never
 * mutated, and no step record is deleted — old steps simply stop
 * being listed individually.
 */
export function buildCompactedView(task: TaskRecord, options: CompactedViewOptions = {}): CompactedTaskView {
  const tailSteps = options.tailSteps ?? COMPACTED_TAIL_STEPS_DEFAULT;
  const view = toTaskView(task);
  const tail = view.steps.slice(-tailSteps);
  const tailIndices = new Set(tail.map((step) => step.index));
  const coveredSteps = view.steps.filter((step) => !tailIndices.has(step.index));
  return {
    taskId: task.id,
    parentId: (task as { parentId?: string | null }).parentId ?? null,
    goal: task.goal,
    mode: task.mode,
    status: task.status,
    steps: tail,
    coveredStepIndices: coveredSteps.map((step) => step.index),
    covered: {
      done: coveredSteps.filter((step) => step.state === "done").map((step) => step.index),
      undone: coveredSteps.filter((step) => step.state !== "done").map((step) => step.index),
      failed: coveredSteps.filter((step) => step.state === "failed").map((step) => step.index),
    },
    checkpoints: task.steps
      .filter((step) => step.preStepSnapshot !== null)
      .map((step) => ({ stepIndex: step.index, url: step.preStepSnapshot?.url ?? null })),
    finalReport: task.finalReport !== null ? cloneJson(task.finalReport) : null,
    resultSummary: task.resultSummary,
    compacted: coveredSteps.length > 0,
  };
}

export interface PruneTaskOutputsOptions {
  /** Protected tail size; defaults to COMPACTED_TAIL_STEPS_DEFAULT. */
  tailSteps?: number;
  /** Minimum reclaimed characters for pruning to act; defaults to
   * PRUNE_MIN_RECLAIM_CHARS_DEFAULT. */
  minReclaimChars?: number;
}

export interface PruneTaskOutputsResult {
  /** Cloned task with pruning applied (or unchanged when not applied). */
  task: TaskRecord;
  prunedStepIndices: number[];
  reclaimedChars: number;
  applied: boolean;
  reason: string | null;
}

/**
 * Prune old completed step outputs, output-only.
 *
 * NEVER pruned, even when old and completed:
 * - the protected tail (most recent `tailSteps` steps);
 * - steps with a Phase B page-snapshot checkpoint
 *   (`preStepSnapshot !== null`) — checkpoints are protected records;
 * - the latest verify record (highest-index step with a non-null
 *   `verifyOutcome`) — the most recent verification evidence stays;
 * - steps that are not finished (pending/running/unknown/
 *   waiting_approval) — a waiting_approval step is an approval record
 *   in flight and is never pruned.
 *
 * The task's policy snapshot and plan approval are untouched (this
 * function only ever clears step `outputSummary` fields), and a step's
 * state, verify outcome, verify summary, checkpoint, input, and
 * idempotency key are never modified.
 *
 * Pruning acts only when the reclaim meets `minReclaimChars`;
 * otherwise it returns the task unchanged with applied: false.
 */
export function pruneTaskOutputs(task: TaskRecord, options: PruneTaskOutputsOptions = {}): PruneTaskOutputsResult {
  const tailSteps = options.tailSteps ?? COMPACTED_TAIL_STEPS_DEFAULT;
  const minReclaimChars = options.minReclaimChars ?? PRUNE_MIN_RECLAIM_CHARS_DEFAULT;
  const steps = task.steps;
  const tailIndices = new Set(steps.slice(-tailSteps).map((step) => step.index));
  let latestVerifyIndex = -1;
  for (const step of steps) {
    if (step.verifyOutcome !== null && step.verifyOutcome !== undefined && step.index > latestVerifyIndex) {
      latestVerifyIndex = step.index;
    }
  }
  const candidates = steps.filter(
    (step) =>
      PRUNABLE_STATES.has(step.state) &&
      step.outputSummary !== "" &&
      !tailIndices.has(step.index) &&
      step.preStepSnapshot === null &&
      step.index !== latestVerifyIndex,
  );
  const reclaimedChars = candidates.reduce((total, step) => total + step.outputSummary.length, 0);
  if (reclaimedChars < minReclaimChars) {
    return {
      task: cloneJson(task),
      prunedStepIndices: [],
      reclaimedChars,
      applied: false,
      reason: `reclaim ${reclaimedChars} chars below minimum ${minReclaimChars}`,
    };
  }
  const next = cloneJson(task);
  const prunedStepIndices: number[] = [];
  for (const step of next.steps) {
    if (candidates.some((candidate) => candidate.index === step.index)) {
      step.outputSummary = "";
      prunedStepIndices.push(step.index);
    }
  }
  return { task: next, prunedStepIndices, reclaimedChars, applied: true, reason: null };
}
