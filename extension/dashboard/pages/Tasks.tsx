import { useCallback, useEffect, useState } from "preact/hooks";
import { sanitizeTaskView, type TaskStatus, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard } from "../../src/messages.js";
import { sendRequest } from "../logic.js";
import {
  plainFinalSummary,
  plainPauseReason,
  plainStep,
  plainTaskStatus,
  stripToolTokens,
  truncateText,
} from "../ui-logic.js";
import { Button, EmptyState } from "../components/primitives.js";
import { DetailBack, ErrorState, ListRow, Page, Section, SectionSkeleton, useNarrow } from "../components/layout.js";

const TASKS_POLL_MS = 5000;

interface TaskWireResponse {
  tasks?: unknown[];
  task?: unknown;
}

function statusTone(status: TaskStatus): "neutral" | "ok" | "warn" | "bad" | "info" {
  if (status === "done") return "ok";
  if (status === "failed" || status === "cancelled") return "bad";
  if (status === "paused" || status === "waiting_approval" || status === "partial") return "warn";
  if (status === "running") return "info";
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

function currentStep(task: TaskView): TaskView["steps"][number] | null {
  return task.steps.find((step) => step.state !== "done") ?? null;
}

/**
 * Tasks, re-skinned onto Page / Section / ListRow with a detail rail
 * on wide windows and a full-panel detail view with a back action on
 * narrow windows. Steps show number, status word and short summary
 * only — never a tool name, never a session id, never loop/mode
 * internals, never step-index lists. The browser line shows the
 * browser's name (resolved from the browsers list) or nothing at all.
 */
export function TasksPage(): preact.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browsers, setBrowsers] = useState<BrowsersDashboard | null>(null);
  const narrow = useNarrow();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const response = await sendRequest({ type: "muze/tasks.list" });
    if (response.ok) {
      const wire = response as unknown as TaskWireResponse;
      const listed = Array.isArray(wire.tasks) ? wire.tasks.map(sanitizeTaskView) : [];
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
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsers(response.browsers);
    });
    const onEvent = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") void load();
    };
    const onMessage = chrome.runtime.onMessage;
    if (onMessage?.addListener) onMessage.addListener(onEvent);
    const timer = window.setInterval(() => void load(), TASKS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (onMessage?.removeListener) onMessage.removeListener(onEvent);
    };
  }, [load]);

  const act = async (task: TaskView, action: "pause" | "resume" | "cancel" | "approvePlan"): Promise<void> => {
    if (action === "cancel") {
      const ok = confirm(`Cancel task "${task.goal}"? Its remaining steps will not run.`);
      if (!ok) return;
    }
    if (action === "approvePlan") {
      const ok = confirm(
        `Approve the plan for "${task.goal}"? Steps in the plan will run without asking again; steps outside it will pause and ask again. No purchases, payments, or external submits are approved.`,
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

  const browserName = (sessionId: string): string | null =>
    browsers?.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? null;

  const detail = (task: TaskView): preact.JSX.Element => {
    const busy = busyId === task.id;
    const current = currentStep(task);
    const pause = plainPauseReason(task.pauseReason);
    const name = browserName(task.browserSessionId);
    const steps = [...task.steps].sort((a, b) => a.index - b.index).map(plainStep);
    return (
      <div class="ui-detail">
        <h2 class="ui-section-title">{task.goal || "Task"}</h2>
        <p class="ui-row-meta">
          {plainTaskStatus(task.status)} · Step {task.doneSteps.length} of {task.totalSteps}
        </p>
        {current ? <p class="ui-row-meta">Now: {plainStep(current).summary}</p> : null}
        {pause && (task.status === "paused" || task.status === "waiting_approval") ? (
          <p class="ui-row-meta">{pause}</p>
        ) : null}
        {name ? <p class="ui-row-meta">Browser: {name}</p> : null}
        <div class="ui-row-inline">
          <Button variant="secondary" size="sm" disabled={busy || !canApprovePlan(task.status)} onClick={() => void act(task, "approvePlan")}>
            Approve plan
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || !canPause(task.status)} onClick={() => void act(task, "pause")}>
            Pause
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || !canResume(task.status)} onClick={() => void act(task, "resume")}>
            Resume
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || isTerminal(task.status)} onClick={() => void act(task, "cancel")}>
            Cancel
          </Button>
        </div>
        <h3 class="ui-detail-heading">Steps</h3>
        {steps.length === 0 ? (
          <p class="ui-row-meta">No steps recorded yet.</p>
        ) : (
          <ul class="ui-list">
            {steps.map((step) => (
              <ListRow key={step.number} title={`Step ${step.number}`} meta={step.summary} status={step.state} statusTone={step.state === "Done" ? "ok" : step.state === "Didn't finish" ? "bad" : step.state === "Waiting for you" ? "warn" : "neutral"} />
            ))}
          </ul>
        )}
        {task.resultSummary ? (
          <p class="ui-row-meta">{truncateText(stripToolTokens(task.resultSummary), 240)}</p>
        ) : null}
        {isFinal(task.status) ? (
          <div>
            <h3 class="ui-detail-heading">Final report</h3>
            <p class="ui-row-meta">
              {task.finalReport
                ? plainFinalSummary(task.finalReport.done.length, task.finalReport.undone.length, task.finalReport.failed.length)
                : plainFinalSummary(task.doneSteps.length, task.undoneSteps.length, task.steps.filter((s) => s.state === "failed").length)}
            </p>
            {task.finalReport && task.finalReport.compensations.length > 0 ? (
              <ul class="ui-list">
                {task.finalReport.compensations.map((line, i) => (
                  <li class="ui-row" key={`comp-${i}`}>
                    <p class="ui-row-meta">{truncateText(stripToolTokens(line), 200)}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            {task.finalReport && task.finalReport.manualCleanup.length > 0 ? (
              <ul class="ui-list">
                {task.finalReport.manualCleanup.map((line, i) => (
                  <li class="ui-row" key={`manual-${i}`}>
                    <p class="ui-row-meta">Needs doing by hand: {truncateText(stripToolTokens(line), 200)}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            {task.finalReport && task.finalReport.compensations.length === 0 && task.finalReport.manualCleanup.length === 0 ? (
              <p class="ui-row-meta">No cleanup was needed.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const list = (taskList: TaskView[]): preact.JSX.Element => (
    <ul class="ui-list">
      {taskList.map((task) => {
        const current = currentStep(task);
        const pause = plainPauseReason(task.pauseReason);
        const meta = [
          `Step ${task.doneSteps.length} of ${task.totalSteps}`,
          current ? plainStep(current).summary : null,
          current?.outsideBoundsReason ? truncateText(stripToolTokens(current.outsideBoundsReason), 160) : null,
          pause && (task.status === "paused" || task.status === "waiting_approval") ? pause : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <ListRow
            key={task.id}
            title={task.goal || "Task"}
            meta={meta}
            status={plainTaskStatus(task.status)}
            statusTone={statusTone(task.status)}
            onSelect={() => setSelectedId(task.id)}
            selected={selectedId === task.id}
          />
        );
      })}
    </ul>
  );

  const selected = tasks?.find((task) => task.id === selectedId) ?? null;

  if (narrow && selected) {
    return (
      <Page title="Tasks" subtitle="What your AI app is working on, newest first.">
        <DetailBack onBack={() => setSelectedId(null)} />
        {detail(selected)}
      </Page>
    );
  }

  return (
    <Page
      title="Tasks"
      subtitle="What your AI app is working on, newest first."
      action={
        <Button variant="ghost" size="sm" icon="refresh" disabled={loading} onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      {error ? <ErrorState message={error} /> : null}
      {tasks === null ? (
        <SectionSkeleton />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No tasks yet"
          description="Tasks created by your AI app will appear here as they run, with live progress."
        />
      ) : (
        <div class="ui-grid">
          <Section title="Tasks" description="Tap a task to see its steps.">
            {list(tasks)}
          </Section>
          {selected ? (
            <aside class="ui-rail" aria-label="Task detail">
              <Button variant="ghost" size="sm" icon="close" ariaLabel="Close task detail" onClick={() => setSelectedId(null)}>
                Close
              </Button>
              {detail(selected)}
            </aside>
          ) : null}
        </div>
      )}
    </Page>
  );
}
