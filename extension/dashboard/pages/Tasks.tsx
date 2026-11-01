import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { sanitizeTaskView, type TaskStatus, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard } from "../../src/messages.js";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import type { AuditEvent } from "../../libs/security/index.js";
import { sendRequest } from "../logic.js";
import {
  activityIcon,
  plainFinalSummary,
  plainPauseReason,
  plainStep,
  plainTaskStatus,
  shortDate,
  stripToolTokens,
  truncateText,
} from "../ui-logic.js";
import { Icon } from "../components/Icon.js";
import { Button, SearchInput } from "../components/primitives.js";
import { EmptyLine, ErrorState, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";
import { showToast } from "../components/feedback.js";
import { useConfirm } from "../components/confirm.js";

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

function dayLabel(createdAt: number, now: number): string {
  const startOf = (ms: number): number => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.floor((startOf(now) - startOf(createdAt)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return shortDate(createdAt) ?? "";
}

export interface TasksPageProps {
  approvals?: ApprovalRequestInfo[];
  audit?: AuditEvent[] | null;
  auditLoading?: boolean;
  busy?: boolean;
  busyId?: string | null;
  onRespond?: (approvalId: string, approved: boolean) => void;
  onCancelForClient?: (clientId: string) => void;
  onRefreshAudit?: () => void;
  selectedId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
}

/**
 * Tasks and Activity in one destination. Tasks is the default segment;
 * Activity is the merged, plain-language audit feed. A task opens as a
 * full-screen detail with the app bar back action. Approvals live on
 * Home and in the app-bar pill, never here.
 */
export function TasksPage({
  audit: _audit = null,
  auditLoading: _auditLoading = false,
  busy = false,
  onRefreshAudit: _onRefreshAudit,
  selectedId: selectedIdProp,
  onSelectTask,
}: TasksPageProps): preact.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [browsers, setBrowsers] = useState<BrowsersDashboard | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "completed">("all");
  const confirm = useConfirm();

  const selectedId = selectedIdProp !== undefined ? selectedIdProp : localSelected;
  const select = onSelectTask ?? setLocalSelected;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  useEffect(() => {
    void load();
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsers(response.browsers);
    });
    const onEvent = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") void load();
    };
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
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

  const browserName = (sessionId: string): string | null =>
    browsers?.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? null;

  const filtered = useMemo(() => {
    const list = tasks ?? [];
    const needle = query.trim().toLowerCase();
    let result = needle ? list.filter((task) => (task.goal || "").toLowerCase().includes(needle)) : list;
    if (statusFilter === "running") {
      result = result.filter((task) => task.status === "running" || task.status === "created");
    } else if (statusFilter === "completed") {
      result = result.filter((task) => task.status === "done" || task.status === "failed" || task.status === "cancelled");
    }
    return result;
  }, [tasks, query, statusFilter]);

  const selected = tasks?.find((task) => task.id === selectedId) ?? null;

  if (selected) {
    const taskBusy = busy || busyId === selected.id;
    const current = currentStep(selected);
    const pause = plainPauseReason(selected.pauseReason);
    const name = browserName(selected.browserSessionId);
    const steps = [...selected.steps].sort((a, b) => a.index - b.index).map(plainStep);
    return (
      <div class="ui-page detail-page">
        <header class="detail-head">
          <span class="detail-eyebrow">Task</span>
          <h1 class="detail-title">{selected.goal || "Task"}</h1>
          <div class="detail-badges">
            <span class={`status-chip status-chip--${statusTone(selected.status)}`}>{plainTaskStatus(selected.status)}</span>
            <span class="detail-step-count">
              Step {selected.doneSteps.length} of {selected.totalSteps}
            </span>
          </div>
        </header>

        {current ? (
          <div class="detail-now">
            <span class="detail-now-dot" aria-hidden="true" />
            <div>
              <span class="detail-now-label">Now</span>
              <p>{plainStep(current).summary}</p>
            </div>
          </div>
        ) : null}
        {pause && (selected.status === "paused" || selected.status === "waiting_approval") ? <p class="detail-note">{pause}</p> : null}
        {name ? <p class="detail-note">Browser: {name}</p> : null}

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
            <Button variant="ghost" size="sm" icon="close" class="row-action-danger" disabled={taskBusy} onClick={() => void act(selected, "cancel")}>
              Cancel
            </Button>
          ) : null}
        </div>

        <Section title="Activity log">
          {steps.length === 0 ? (
            <EmptyLine text="No steps recorded yet." />
          ) : (
            <ol class="timeline">
              {steps.map((step) => (
                <li class="timeline-item" key={step.number}>
                  <span
                    class={
                      "timeline-dot" +
                      (step.state === "Done" ? " is-done" : step.state === "Didn't finish" ? " is-bad" : step.state === "Waiting for you" ? " is-warn" : "")
                    }
                    aria-hidden="true"
                  >
                    {step.state === "Done" ? <Icon name="check" size={11} strokeWidth={2.8} /> : null}
                  </span>
                  <div class="timeline-copy">
                    <span class="timeline-title">
                      <span class="timeline-icon" aria-hidden="true">
                        <Icon name={activityIcon(selected.steps.find((raw) => raw.index === step.number - 1)?.tool)} size={13} />
                      </span>
                      Step {step.number}
                      <span class="timeline-state">{step.state}</span>
                    </span>
                    <p>{step.summary}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>

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

  const list = (): preact.JSX.Element => {
    if (tasks === null) return <SectionSkeleton />;
    if (tasks.length === 0) return <EmptyLine text="No tasks yet." />;
    const active = filtered.filter((task) => !isTerminal(task.status));
    const history = filtered.filter((task) => isTerminal(task.status));
    if (filtered.length === 0) return <EmptyLine text="No tasks match your search." />;
    return (
      <>
        {active.length > 0 ? (
          <div class="task-group">
            <h3 class="group-label">Active</h3>
            <div class="task-list-active">
              {active.map((task) => {
                const taskBusy = busy || busyId === task.id;
                return (
                  <div key={task.id} class="task-card-active">
                    <div class="task-card-header">
                      <div class="task-card-source">
                        <div class="task-card-source-icon"><Icon name="browser" size={14} /></div>
                        <span>Chrome · {browserName(task.browserSessionId) ?? "Browser"}</span>
                      </div>
                      <span class={"task-status-pill is-" + task.status}>
                        ● {plainTaskStatus(task.status)}
                      </span>
                    </div>
                    <div class="task-card-title">{task.goal || "Task"}</div>
                    {task.totalSteps > 0 ? (
                      <div class="task-progress-row">
                        <div class="task-progress-bar-wrap">
                          <div class="task-progress-fill" style={{ width: `${Math.round((task.doneSteps.length / task.totalSteps) * 100)}%` }} />
                        </div>
                        <span class="task-progress-pct">{Math.round((task.doneSteps.length / task.totalSteps) * 100)}%</span>
                      </div>
                    ) : null}
                    <div class="task-card-timer">
                      <Icon name="clock" size={13} />
                      Started: {new Date(task.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    <div class="task-card-actions">
                      {canPause(task.status) ? (
                        <button type="button" class="task-action-btn" disabled={taskBusy} onClick={() => void act(task, "pause")}>⏸ Pause</button>
                      ) : null}
                      {canResume(task.status) ? (
                        <button type="button" class="task-action-btn" disabled={taskBusy} onClick={() => void act(task, "resume")}>▶ Resume</button>
                      ) : null}
                      {!isTerminal(task.status) ? (
                        <button type="button" class="task-action-btn is-danger" disabled={taskBusy} onClick={() => void act(task, "cancel")}>✕ Cancel</button>
                      ) : null}
                      <button type="button" class="task-action-btn is-icon" onClick={() => select(task.id)}>↓</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {history.length > 0 ? (
          <div class="task-group">
            <div class="group-label-row">
              <h3 class="group-label">Recent Tasks</h3>
              {!showAll && history.length > 5 ? (
                <button type="button" class="view-all-link" onClick={() => setShowAll(true)}>View all →</button>
              ) : null}
            </div>
            <ul class="ui-list">
              {(showAll ? history : history.slice(0, 5)).map((task) => (
                <div key={task.id} class="task-card-done" onClick={() => select(task.id)}>
                  <div class="task-done-icon-wrap"><Icon name="browser" size={18} /></div>
                  <div class="task-done-main">
                    <div class="task-done-title">{task.goal || "Task"}</div>
                    <div class="task-done-meta">{plainTaskStatus(task.status)} · {shortDate(task.createdAt) ?? "recently"}</div>
                  </div>
                  <div class="task-done-check"><Icon name="check" size={14} /></div>
                </div>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  };

  return (
    <Page title="Tasks" subtitle="What your AI app is doing, newest first.">
      {/* Hero header */}
      <div class="ui-page-hero">
        <div class="ui-page-hero-icon">
          <Icon name="clock" size={24} />
        </div>
        <div class="ui-page-hero-content">
          <h1 class="ui-page-hero-title">Tasks</h1>
          <p class="ui-page-hero-subtitle">Monitor what your AI is doing.</p>
        </div>
        <div class="ui-page-hero-status">
          <span class="status-pill is-online">
            <span class="status-dot" />
            <span class="status-pill-text">Live</span>
          </span>
        </div>
      </div>

      <div class="page-controls">
        <div class="search-wrap" style={{ flex: 1 }}>
          <SearchInput value={query} ariaLabel="Search tasks" placeholder="Search tasks..." onChange={setQuery} />
        </div>
      </div>

      {/* Filter chips */}
      <div class="filter-chips">
        {(["all", "running", "completed"] as const).map((f) => {
          const count =
            f === "all"
              ? (tasks?.length ?? 0)
              : f === "running"
                ? (tasks?.filter((t) => t.status === "running" || t.status === "created").length ?? 0)
                : (tasks?.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled").length ?? 0);
          return (
            <button key={f} type="button" class={"filter-chip" + (statusFilter === f ? " is-active" : "")} onClick={() => setStatusFilter(f)}>
              {f === "all" ? "All" : f === "running" ? "Running" : "Completed"} ({count})
            </button>
          );
        })}
      </div>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}

      {list()}
    </Page>
  );
}
