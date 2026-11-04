import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { sanitizeTaskView, type TaskStatus, type TaskView } from "../../src/task-dashboard.js";
import type { ActivityEvent, ActivityRow } from "../../libs/activity.js";
import type { BrowsersDashboard } from "../../src/messages.js";
import { sendRequest } from "../logic.js";
import {
  dayRowPreview,
  groupTasksAndActionsByDay,
  plainFinalSummary,
  plainPauseReason,
  plainStepState,
  resolveAppName,
  stripToolTokens,
  taskExecutedSteps,
  taskProgress,
  taskStatusWord,
  timelineIconForStep,
  truncateText,
} from "../ui-logic.js";
import { Icon } from "../components/Icon.js";
import { Button, SearchInput } from "../components/primitives.js";
import { EmptyLine, ErrorState, Page, Section, SectionSkeleton } from "../components/layout.js";
import { showToast } from "../components/feedback.js";
import { useConfirm } from "../components/confirm.js";

const TASKS_POLL_MS = 5000;

interface TaskWireResponse {
  tasks?: unknown[];
  task?: unknown;
}

function statusClass(status: TaskStatus): "warn" | "ok" | "bad" | "grey" {
  if (status === "done") return "ok";
  if (status === "failed") return "bad";
  if (status === "paused" || status === "waiting_approval" || status === "running" || status === "created") return "warn";
  return "grey";
}

function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "partial";
}

function isRunning(status: TaskStatus): boolean {
  return status === "running" || status === "created";
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

export interface TasksPageProps {
  busy?: boolean;
  selectedId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
}

/**
 * Tasks in the reference language: search + All / Completed / Failed
 * chips (no Running chip — at most one task runs, it sorts first and
 * Home's card surfaces it), borderless rows with the progress bar
 * inside, honest progress text (fixed plans "Step X of N", unknown
 * totals never invented). Drill-down: the list shows one row per day
 * (date + that day's first task title, or first action summary for
 * action-only days); a day opens its tasks plus its standalone
 * actions; a task opens its executed steps, chronological
 * oldest-first, from the day history. Failed is a real status, red
 * throughout.
 */
export function TasksPage({
  busy = false,
  selectedId: selectedIdProp,
  onSelectTask,
}: TasksPageProps): preact.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [history, setHistory] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [browsers, setBrowsers] = useState<BrowsersDashboard | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "completed" | "failed">("all");
  const confirm = useConfirm();

  const selectedId = selectedIdProp !== undefined ? selectedIdProp : localSelected;
  const select = onSelectTask ?? setLocalSelected;

  const load = useCallback(async (): Promise<void> => {
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
  }, []);

  const loadHistory = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/activity.history" });
    const wire = response as unknown as { activityHistory?: unknown };
    if (response.ok && Array.isArray(wire.activityHistory)) {
      setHistory(
        (wire.activityHistory as ActivityRow[]).filter(
          (row) =>
            row &&
            typeof row.id === "string" &&
            typeof row.tool === "string" &&
            typeof row.summary === "string" &&
            (row.state === "running" || row.state === "done" || row.state === "failed") &&
            typeof row.at === "number",
        ),
      );
    } else {
      // History is additive: a missing or failed fetch must never block
      // the task list or its empty state; the next event or
      // visibility-show retries it.
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadHistory();
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsers(response.browsers);
    });
    const onEvent = (message: { type?: string; event?: ActivityEvent }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") {
        void load();
        // Live-append activity rows (like Home) instead of refetching
        // the whole history on every action.
        if (message.event?.kind === "activity") {
          const event = message.event;
          setHistory((rows) => {
            if (rows === null) return rows;
            const row: ActivityRow = {
              id: event.id,
              tool: event.tool,
              summary: event.summary,
              state: event.state,
              at: event.at,
              ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
            };
            const index = rows.findIndex((r) => r.id === row.id);
            return index >= 0 ? rows.map((r, i) => (i === index ? row : r)) : [...rows, row];
          });
        }
      }
    };
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
    if (onMessage?.addListener) onMessage.addListener(onEvent);
    // Visibility-gated like App's poll: pause while hidden, refresh
    // immediately and restart on show. The interval never changes.
    let timer = 0;
    const poll = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    const restart = (): void => {
      clearInterval(timer);
      timer = window.setInterval(poll, TASKS_POLL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void load();
        void loadHistory();
        restart();
      } else {
        clearInterval(timer);
      }
    };
    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (onMessage?.removeListener) onMessage.removeListener(onEvent);
    };
  }, [load, loadHistory]);

  const act = async (task: TaskView, action: "pause" | "resume" | "cancel" | "approvePlan"): Promise<void> => {
    if (action === "cancel") {
      const ok = await confirm({
        title: "Cancel this task?",
        body: `“${task.goal || "Task"}” will stop and its remaining steps will not run.`,
        confirmLabel: "Cancel task",
        cancelLabel: "Keep running",
        tone: "danger",
      });
      if (!ok) return;
    }
    if (action === "approvePlan") {
      const ok = await confirm({
        title: "Approve this plan?",
        body: "Steps in the plan will run without asking again. Steps outside it will still pause and ask. Purchases, payments, and external submits are never auto-approved.",
        confirmLabel: "Approve plan",
      });
      if (!ok) return;
    }
    setBusyId(task.id);
    setError(null);
    const response = await sendRequest({ type: `muze/tasks.${action}`, taskId: task.id });
    if (!response.ok) {
      setError(response.error ?? `Could not ${action} the task`);
    } else {
      showToast(
        action === "pause" ? "Task paused" : action === "resume" ? "Task resumed" : action === "cancel" ? "Task cancelled" : "Plan approved",
      );
    }
    setBusyId(null);
    await load();
  };

  const appName = (task: TaskView): string =>
    resolveAppName({ id: task.clientId }, browsers?.mcpClients ?? []);

  const browserName = (sessionId: string): string | null =>
    browsers?.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? null;

  const filtered = useMemo(() => {
    const list = tasks ?? [];
    const needle = query.trim().toLowerCase();
    let result = needle
      ? list.filter((task) =>
          (task.goal || "").toLowerCase().includes(needle) ||
          task.steps.some((step) => `${step.outputSummary ?? ""} ${step.inputSummary ?? ""}`.toLowerCase().includes(needle)),
        )
      : list;
    if (statusFilter === "completed") {
      result = result.filter((task) => task.status === "done");
    } else if (statusFilter === "failed") {
      result = result.filter((task) => task.status === "failed");
    }
    // Running first (at most one runs), then newest first.
    return [...result].sort((a, b) => Number(isRunning(b.status)) - Number(isRunning(a.status)) || b.createdAt - a.createdAt);
  }, [tasks, query, statusFilter]);

  // Standalone actions only: rows attributed to a task (taskId set)
  // belong to that task's detail, never to a day's standalone list,
  // so a task's steps are never duplicated across the drill-down.
  // A task's steps executed on a later day still belong to the task
  // (its creation day's section does not gain them); they surface in
  // the task's own detail, not as that later day's content.
  const standaloneHistory = useMemo(() => (history ?? []).filter((row) => !row.taskId), [history]);

  // Date sections: tasks first in their list order, then that day's
  // standalone action rows newest first. The search filters tasks
  // only (it says "tasks and steps"); the chip filters both tasks
  // and actions. A day row appears when its section holds a matching
  // task or a matching standalone action.
  const sections = useMemo(
    () => groupTasksAndActionsByDay(filtered, standaloneHistory, statusFilter),
    [filtered, standaloneHistory, statusFilter],
  );

  const daySection = selectedDay ? (sections.find((section) => section.key === selectedDay) ?? null) : null;

  const selected = tasks?.find((task) => task.id === selectedId) ?? null;

  const renderTaskRow = (task: TaskView): preact.JSX.Element => {
    const progress = taskProgress(task.doneSteps.length, task.totalSteps, task.doneSteps.length);
    return (
      <button type="button" class="row" key={task.id} onClick={() => select(task.id)} style={{ display: "block", borderBottom: "none" }}>
        <span class="between">
          <span>
            <span class="name">{task.goal || "Task"}</span>
            <br />
            <span class="meta">
              {appName(task)} · {progress.text}
            </span>
          </span>
          <span class={"status " + statusClass(task.status)}>{taskStatusWord(task.status)}</span>
        </span>
        <div class="progress" style={{ margin: "10px 0 2px" }}>
          <i class={progress.indeterminate ? "indet" : ""} style={{ width: `${progress.percent}%` }} />
        </div>
      </button>
    );
  };

  const actionTime = (at: number): string => {
    try {
      return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  if (selected) {
    const taskBusy = busy || busyId === selected.id;
    const pause = plainPauseReason(selected.pauseReason);
    const name = browserName(selected.browserSessionId);
    const progress = taskProgress(selected.doneSteps.length, selected.totalSteps, selected.doneSteps.length);
    // Executed steps only, from the day history, chronological
    // oldest-first. A plan step that never executed has no history
    // row and never appears here; only taken steps show.
    const executed = taskExecutedSteps(history ?? [], selected.id);
    return (
      <div class="ui-page detail-page">
        <div class="card">
          <div style={{ fontWeight: 700, fontSize: "15px" }}>{selected.goal || "Task"}</div>
          <div class="muted" style={{ fontSize: "12px" }}>
            {appName(selected)} · {taskStatusWord(selected.status)} · {progress.text}
            {name ? ` · ${name}` : ""}
          </div>
          <div class="progress mt12">
            <i class={progress.indeterminate ? "indet" : ""} style={{ width: `${progress.percent}%` }} />
          </div>
        </div>

        <div class="detail-actions">
          {canApprovePlan(selected.status) ? (
            <Button variant="primary" size="sm" icon="check" disabled={taskBusy} onClick={() => void act(selected, "approvePlan")}>
              Approve plan
            </Button>
          ) : null}
          {canPause(selected.status) ? (
            <Button variant="secondary" size="sm" icon="pause" disabled={taskBusy} onClick={() => void act(selected, "pause")}>
              Pause
            </Button>
          ) : null}
          {canResume(selected.status) ? (
            <Button variant="secondary" size="sm" icon="play" disabled={taskBusy} onClick={() => void act(selected, "resume")}>
              Resume
            </Button>
          ) : null}
          {!isTerminal(selected.status) ? (
            <Button variant="ghost" size="sm" icon="close" disabled={taskBusy} onClick={() => void act(selected, "cancel")}>
              Cancel
            </Button>
          ) : null}
        </div>

        {pause && (selected.status === "paused" || selected.status === "waiting_approval") ? <p class="detail-note">{pause}</p> : null}

        <h2 class="sec">Activity · vertical timeline</h2>
        {executed.length === 0 ? (
          <div>
            <EmptyLine text="No steps recorded yet." />
            {selected.steps.some((step) => step.state === "done") ? (
              <p class="detail-note">Steps taken before this update don't appear here.</p>
            ) : null}
          </div>
        ) : (
          <div class="tl">
            {executed.map((row) => (
              <div class="step" key={row.id}>
                <span class="node">
                  <Icon name={timelineIconForStep(row.tool, row.state)} size={16} />
                </span>
                <div class="verb">{row.summary}</div>
                <div class="tmeta">
                  {row.state === "done" ? actionTime(row.at) : `${plainStepState(row.state)} · ${actionTime(row.at)}`}
                </div>
              </div>
            ))}
          </div>
        )}

        {selected.resultSummary ? <p class="detail-note">{truncateText(stripToolTokens(selected.resultSummary), 240)}</p> : null}

        {isFinal(selected.status) ? (
          <Section title="Final report">
            <p class="detail-note">
              {selected.finalReport
                ? plainFinalSummary(selected.finalReport.done.length, selected.finalReport.undone.length, selected.finalReport.failed.length)
                : plainFinalSummary(
                    selected.doneSteps.length,
                    selected.undoneSteps.length,
                    selected.steps.filter((step) => step.state === "failed").length,
                  )}
            </p>
            {selected.finalReport?.compensations.length ? (
              <ul class="detail-report-list">
                {selected.finalReport.compensations.map((line, index) => (
                  <li key={`comp-${index}`}>{truncateText(stripToolTokens(line), 200)}</li>
                ))}
              </ul>
            ) : null}
            {selected.finalReport?.manualCleanup.length ? (
              <ul class="detail-report-list">
                {selected.finalReport.manualCleanup.map((line, index) => (
                  <li key={`manual-${index}`}>Needs doing by hand: {truncateText(stripToolTokens(line), 200)}</li>
                ))}
              </ul>
            ) : null}
            {selected.finalReport && selected.finalReport.compensations.length === 0 && selected.finalReport.manualCleanup.length === 0 ? (
              <p class="detail-note">No cleanup was needed.</p>
            ) : null}
          </Section>
        ) : null}
      </div>
    );
  }

  // Day detail: that day's tasks (current order) plus its standalone
  // actions newest first. Task-attributed rows never appear here —
  // they belong to their task's detail. Back returns to the day list;
  // the AppBar back from a task's detail returns here, because the
  // selected day survives task selection.
  if (daySection) {
    return (
      <div class="ui-page detail-page">
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={() => setSelectedDay(null)}>
          Back
        </Button>
        <h2 class="sec">{daySection.label}</h2>
        {daySection.tasks.map((task) => renderTaskRow(task))}
        {daySection.actions.length > 0 ? (
          <div class="tl">
            {daySection.actions.map((row) => (
              <div class="step" key={row.id}>
                <span class="node">
                  <Icon name={timelineIconForStep(row.tool, row.state)} size={16} />
                </span>
                <div class="verb">{row.summary}</div>
                <div class="tmeta">
                  {row.state === "done" ? actionTime(row.at) : `${plainStepState(row.state)} · ${actionTime(row.at)}`}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Page title="Tasks" subtitle="What your AI app is doing, newest first.">
      <div class="page-controls">
        <div class="search-wrap" style={{ flex: 1 }}>
          <SearchInput value={query} ariaLabel="Search tasks" placeholder="Search tasks and steps…" onChange={setQuery} />
        </div>
      </div>

      <div class="chips mt12">
        {(["all", "completed", "failed"] as const).map((f) => {
          const count =
            f === "all"
              ? (tasks?.length ?? 0)
              : f === "completed"
                ? (tasks?.filter((t) => t.status === "done").length ?? 0)
                : (tasks?.filter((t) => t.status === "failed").length ?? 0);
          return (
            <button key={f} type="button" class={"chip" + (statusFilter === f ? " on" : "")} onClick={() => setStatusFilter(f)}>
              {f === "all" ? "All" : f === "completed" ? "Completed" : "Failed"} ({count})
            </button>
          );
        })}
      </div>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {tasks === null || (tasks.length === 0 && history === null) ? (
        <SectionSkeleton />
      ) : tasks.length === 0 && standaloneHistory.length === 0 ? (
        <EmptyLine text="No tasks yet." />
      ) : sections.length === 0 ? (
        <EmptyLine text="No tasks match your search." />
      ) : (
        <div>
          {sections.map((section) => (
            <button
              type="button"
              class="row"
              key={section.key}
              onClick={() => setSelectedDay(section.key)}
              style={{ display: "block", borderBottom: "none" }}
            >
              <span>
                <span class="name">{section.label}</span>
                <br />
                <span class="meta">{dayRowPreview(section.tasks, section.actions)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Page>
  );
}
