import { useCallback, useEffect, useState } from "preact/hooks";
import { deriveLoopStatus, sanitizeTaskView, type TaskStatus, type TaskView } from "../../src/task-dashboard.js";
import { sendRequest } from "../logic.js";
import { Badge, Button, Callout, Card, EmptyState, Skeleton } from "../components/primitives.js";

/** Poll interval while the Tasks page is open (matches the App 5s poll). */
const TASKS_POLL_MS = 5000;

/**
 * The service-worker response for task messages. DashboardResponse in
 * messages.ts does not carry task fields yet (coordinator wiring); the
 * cast here keeps this page working until the coordinator adds them.
 */
interface TaskWireResponse {
  tasks?: unknown[];
  task?: unknown;
}

function statusTone(status: TaskStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "done") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "paused" || status === "waiting_approval" || status === "partial") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

function stepTone(state: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (state === "done") return "success";
  if (state === "failed") return "danger";
  if (state === "waiting_approval") return "warning";
  if (state === "running") return "info";
  return "neutral";
}

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function canPause(status: TaskStatus): boolean {
  return status === "running" || status === "created" || status === "waiting_approval";
}

function canResume(status: TaskStatus): boolean {
  return status === "paused" || status === "waiting_approval";
}

function canApprovePlan(status: TaskStatus): boolean {
  return status === "created" || status === "waiting_approval" || status === "paused";
}

function isFinal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "partial";
}

/** First step that is not done, for the "current step" line (Phase 2). */
function currentStep(task: TaskView): TaskView["steps"][number] | null {
  return task.steps.find((step) => step.state !== "done") ?? null;
}

/**
 * Dashboard progress view for durable tasks. Self-contained like
 * FilesPage: it talks to the service worker through sendRequest and owns
 * its own polling, so App.tsx only has to render it.
 *
 * Display rule: only the goal, status, progress ("step X of Y"), step
 * tool + state + outputSummary, done/undone lists, pauseReason, and
 * resultSummary are ever rendered. Step inputs are never requested,
 * never stored here, and never rendered — incoming views are re-run
 * through sanitizeTaskView as defence in depth.
 */
export function TasksPage(): preact.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const response = await sendRequest({ type: "muze/tasks.list" });
    if (response.ok) {
      const wire = response as unknown as TaskWireResponse;
      const listed = Array.isArray(wire.tasks) ? wire.tasks.map(sanitizeTaskView) : [];
      // Newest first (createdAt descending); the port should already
      // order this way, but the page does not rely on it.
      listed.sort((a, b) => b.createdAt - a.createdAt);
      setTasks(listed);
      setError(null);
    } else {
      setError(response.error ?? "Could not load tasks");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // Phase D push-first: the service worker already sends a
    // `muze/event` message on every runner progress checkpoint
    // (task.progress via the runner's progress callback), and App.tsx
    // already listens for it — the Tasks page now does too, so an open
    // page reloads on the push instead of waiting for the next poll
    // tick. The interval stays as fallback (per plan, polling stays as
    // fallback, not as the design) for events missed while the page
    // was hidden or before the listener attached. The onMessage guard
    // is for environments where the dashboard runs without a runtime
    // message channel; in the real extension it is always present.
    const onEvent = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") void load();
    };
    const onMessage = chrome.runtime.onMessage;
    if (onMessage?.addListener) onMessage.addListener(onEvent);
    // Poll ONLY while this page is open: the interval is created on
    // mount and cleared on unmount, so a closed Tasks page polls nothing.
    const timer = window.setInterval(() => void load(), TASKS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      if (onMessage?.removeListener) onMessage.removeListener(onEvent);
    };
  }, [load]);

  const act = async (task: TaskView, action: "pause" | "resume" | "cancel" | "approvePlan"): Promise<void> => {
    // Cancelling a task is destructive (its remaining steps never run),
    // so confirm first with a native dialog (documented dashboard choice,
    // same pattern as FilesPage remove and ActivityPage cancel-for-client).
    if (action === "cancel") {
      const ok = confirm(`Cancel task "${task.goal}"? Its remaining steps will not run.`);
      if (!ok) return;
    }
    // Approving a plan is the dashboard decision itself: default bounds
    // (only the plan's tools and domains, no purchases, no payments, no
    // external submits) apply unless the task already carries bounds.
    // Steps outside the bounds still pause and ask again.
    if (action === "approvePlan") {
      const ok = confirm(
        `Approve the plan for "${task.goal}"? Steps inside the plan's tools and domains will run without asking again; steps outside them will pause and ask again. No purchases, payments, or external submits are approved.`,
      );
      if (!ok) return;
    }
    setBusyId(task.id);
    setError(null);
    const response = await sendRequest({ type: `muze/tasks.${action}`, taskId: task.id });
    if (!response.ok) setError(response.error ?? `Could not ${action} the task`);
    setBusyId(null);
    await load();
  };

  return (
    <div class="stack">
      {error ? <Callout tone="danger">{error}</Callout> : null}

      <Card
        title="Tasks"
        icon="clock"
        description="Progress of durable tasks created by MCP clients, newest first. The dashboard only shows progress — never step inputs, page content, or screenshots."
        actions={
          <>
            {tasks ? <span class="pill">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span> : null}
            <Button variant="ghost" size="sm" icon="refresh" disabled={loading} onClick={() => void load()}>
              Refresh
            </Button>
          </>
        }
      >
        {tasks === null ? (
          <div class="skeleton-list">
            <Skeleton width="85%" />
            <Skeleton width="70%" />
            <Skeleton width="92%" />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon="clock"
            title="No tasks yet"
            description="Tasks are created by MCP clients via tasks.create. They will appear here as they run, with live progress."
          />
        ) : (
          <div class="approval-list">
            {tasks.map((task) => {
              const expanded = expandedId === task.id;
              const busy = busyId === task.id;
              return (
                <article class="approval-card" key={task.id}>
                  <header class="approval-card-head">
                    <button
                      type="button"
                      class="link-button approval-card-title"
                      aria-expanded={expanded ? "true" : "false"}
                      onClick={() => setExpandedId(expanded ? null : task.id)}
                    >
                      {task.goal || task.id}
                    </button>
                    <Badge tone={statusTone(task.status)}>{task.status}</Badge>
                  </header>
                  <p class="approval-card-summary">
                    step {task.doneSteps.length} of {task.totalSteps}
                  </p>
                  {(() => {
                    // Loop status is derived from the runner-written
                    // view (status / pauseReason / final report), never
                    // set by the dashboard itself.
                    const loop = deriveLoopStatus(task);
                    return (
                      <p class="approval-card-meta">
                        Loop: {loop.loop} · Mode: {loop.mode}
                        {loop.child ? " · Child task" : null}
                      </p>
                    );
                  })()}
                  {(() => {
                    const current = currentStep(task);
                    return current ? (
                      <p class="approval-card-meta">
                        Current step: {current.index + 1}. <code>{current.tool}</code> ({current.state})
                        {current.outsideBoundsReason ? ` — ${current.outsideBoundsReason}` : null}
                      </p>
                    ) : null;
                  })()}
                  {task.pauseReason && (task.status === "paused" || task.status === "waiting_approval") ? (
                    <p class="approval-card-meta">{task.pauseReason}</p>
                  ) : null}
                  <div class="approval-card-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canApprovePlan(task.status)}
                      onClick={() => void act(task, "approvePlan")}
                    >
                      Approve plan
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canPause(task.status)}
                      onClick={() => void act(task, "pause")}
                    >
                      Pause
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !canResume(task.status)}
                      onClick={() => void act(task, "resume")}
                    >
                      Resume
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || isTerminal(task.status)}
                      onClick={() => void act(task, "cancel")}
                    >
                      Cancel
                    </Button>
                  </div>

                  {expanded ? (
                    <div class="task-detail">
                      {task.steps.length === 0 ? (
                        <p class="approval-card-summary">No steps recorded yet.</p>
                      ) : (
                        <ul class="tool-list">
                          {[...task.steps]
                            .sort((a, b) => a.index - b.index)
                            .map((step) => (
                              <li class="tool-row" key={step.index}>
                                <div class="tool-main">
                                  <span class="tool-name">
                                    {step.index + 1}. <code>{step.tool}</code>
                                  </span>
                                  <span class="tool-tags">
                                    <Badge tone={stepTone(step.state)}>{step.state}</Badge>
                                    {step.attempts > 1 ? <Badge tone="neutral">{step.attempts} attempts</Badge> : null}
                                  </span>
                                </div>
                                {step.outputSummary ? <p class="tool-description">{step.outputSummary}</p> : null}
                              </li>
                            ))}
                        </ul>
                      )}
                      <p class="approval-card-meta">
                        Done: {task.doneSteps.length > 0 ? task.doneSteps.join(", ") : "none"}
                        {" · "}
                        Undone: {task.undoneSteps.length > 0 ? task.undoneSteps.join(", ") : "none"}
                        {task.steps.some((step) => step.state === "failed") ? (
                          <>
                            {" · "}
                            Failed: {task.steps.filter((step) => step.state === "failed").map((step) => step.index).join(", ")}
                          </>
                        ) : null}
                      </p>
                      <p class="approval-card-meta">Browser: {task.browserSessionId || "unknown"}</p>
                      {task.resultSummary ? <p class="approval-card-summary">{task.resultSummary}</p> : null}
                      {isFinal(task.status) ? (
                        <div class="task-final-report">
                          <p class="approval-card-summary">Final report</p>
                          {task.finalReport ? (
                            <>
                              <p class="approval-card-meta">
                                Done: {task.finalReport.done.length > 0 ? task.finalReport.done.join(", ") : "none"}
                                {" · "}
                                Undone: {task.finalReport.undone.length > 0 ? task.finalReport.undone.join(", ") : "none"}
                                {" · "}
                                Failed: {task.finalReport.failed.length > 0 ? task.finalReport.failed.join(", ") : "none"}
                              </p>
                              {task.finalReport.compensations.length > 0 ? (
                                <ul class="tool-list">
                                  {task.finalReport.compensations.map((line, i) => (
                                    <li class="tool-row" key={`comp-${i}`}>
                                      <p class="tool-description">Compensation: {line}</p>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {task.finalReport.manualCleanup.length > 0 ? (
                                <ul class="tool-list">
                                  {task.finalReport.manualCleanup.map((line, i) => (
                                    <li class="tool-row" key={`manual-${i}`}>
                                      <p class="tool-description">Manual cleanup: {line}</p>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {task.finalReport.compensations.length === 0 && task.finalReport.manualCleanup.length === 0 ? (
                                <p class="approval-card-meta">No compensations were needed.</p>
                              ) : null}
                            </>
                          ) : (
                            <p class="approval-card-meta">No structured final report is available for this task; see the summary above.</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
