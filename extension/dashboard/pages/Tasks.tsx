import { useCallback, useEffect, useState } from "preact/hooks";
import { sanitizeTaskView, type TaskStatus, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard } from "../../src/messages.js";
import type { ApprovalRequestInfo, ClientIdentity } from "../../libs/tool-contracts/index.js";
import type { AuditEvent } from "../../libs/security/index.js";
import { formatCountdown, sendRequest } from "../logic.js";
import {
  activityRows,
  plainFinalSummary,
  plainPauseReason,
  plainStep,
  plainTaskStatus,
  resolveAppName,
  shortDate,
  stripToolTokens,
  truncateText,
} from "../ui-logic.js";
import { Button } from "../components/primitives.js";
import { DetailBack, EmptyLine, ErrorState, ListRow, Page, Section, SectionSkeleton, useNarrow } from "../components/layout.js";

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

function pendingByClient(approvals: ApprovalRequestInfo[]): Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }> {
  const groups = new Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }>();
  for (const approval of approvals) {
    const existing = groups.get(approval.client.id);
    if (existing) existing.approvals.push(approval);
    else groups.set(approval.client.id, { client: approval.client, approvals: [approval] });
  }
  return groups;
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
  onRespond?: (approvalId: string, approved: boolean) => void;
  onCancelForClient?: (clientId: string) => void;
  onRefreshAudit?: () => void;
}


/**
 * Tasks, re-skinned onto Page / Section / ListRow with a detail rail
 * on wide windows and a full-panel detail view with a back action on
 * narrow windows. Steps show number, status word and short summary
 * only — never a tool name, never a session id, never loop/mode
 * internals, never step-index lists. The browser line shows the
 * browser's name (resolved from the browsers list) or nothing at all.
 */
export function TasksPage({
  approvals = [],
  audit = null,
  auditLoading = false,
  busy = false,
  onRespond,
  onCancelForClient,
  onRefreshAudit,
}: TasksPageProps): preact.JSX.Element {
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [browsers, setBrowsers] = useState<BrowsersDashboard | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const narrow = useNarrow();

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
        {task.status === "waiting_approval" ? (
          <p class="ui-row-meta">This task is waiting for your approval — answer it in the Waiting for you section.</p>
        ) : null}
        <h3 class="ui-detail-heading">Activity log</h3>
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

  // Running first, then history newest first, grouped by day, capped
  // at ~10 rows with a "Show more" to reveal the rest. No scheduled
  // or queued states are invented: only the runner's real statuses.
  const list = (taskList: TaskView[]): preact.JSX.Element => {
    const active = taskList.filter((task) => !isTerminal(task.status));
    const history = taskList.filter((task) => isTerminal(task.status));
    const ordered = [...active, ...history];
    const shown = showAll ? ordered : ordered.slice(0, 10);
    const groups = new Map<string, TaskView[]>();
    for (const task of shown) {
      const label = dayLabel(task.createdAt, now);
      const bucket = groups.get(label);
      if (bucket) bucket.push(task);
      else groups.set(label, [task]);
    }
    const row = (task: TaskView): preact.JSX.Element => {
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
    };
    return (
      <>
        {[...groups.entries()].map(([label, group]) => (
          <div key={label}>
            <h3 class="ui-detail-heading">{label}</h3>
            <ul class="ui-list">{group.map(row)}</ul>
          </div>
        ))}
        {!showAll && ordered.length > 10 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show more
          </Button>
        ) : null}
      </>
    );
  };

  const selected = tasks?.find((task) => task.id === selectedId) ?? null;
  const approvalGroups = pendingByClient(approvals);
  const multiClient = [...approvalGroups.values()].filter((group) => group.approvals.length > 1);

  const waitingSection = (
    <Section
      title="Waiting for you"
      description={
        approvals.length > 0
          ? `${approvals.length} request${approvals.length === 1 ? "" : "s"} pending. Each expires after two minutes.`
          : "Requests appear here when an action needs your approval."
      }
    >
      {approvals.length === 0 ? (
        <EmptyLine text="Nothing waiting" />
      ) : (
        <ul class="ui-list">
          {approvals.map((approval) => (
            <ListRow
              key={approval.id}
              title={approval.title}
              meta={`${truncateText(approval.summary, 160)} · ${resolveAppName(approval.client, browsers?.mcpClients ?? [])} · ${formatCountdown(approval.expiresAt, now)}`}
              status="Waiting for you"
              statusTone="warn"
              actions={
                onRespond ? (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, false)}>
                      Deny
                    </Button>
                    <Button variant="primary" size="sm" icon="check" disabled={busy} onClick={() => onRespond(approval.id, true)}>
                      Approve
                    </Button>
                  </>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}
      {multiClient.length > 0 && onCancelForClient ? (
        <div class="ui-chip-row">
          {multiClient.map((group) => (
            <Button
              key={group.client.id}
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                const ok = confirm(
                  `Cancel all ${group.approvals.length} pending request${group.approvals.length === 1 ? "" : "s"} from ${resolveAppName(group.client, browsers?.mcpClients ?? [])}? The waiting actions will be denied.`,
                );
                if (ok) onCancelForClient(group.client.id);
              }}
            >
              Cancel {group.approvals.length} from {resolveAppName(group.client, browsers?.mcpClients ?? [])}
            </Button>
          ))}
        </div>
      ) : null}
    </Section>
  );

  const recentSection = (
    <Section
      title="Recent activity"
      description="What happened recently, in plain words."
      action={
        onRefreshAudit ? (
          <Button variant="ghost" size="sm" icon="refresh" disabled={auditLoading} onClick={onRefreshAudit}>
            Refresh
          </Button>
        ) : undefined
      }
    >
      {auditLoading && !audit ? (
        <SectionSkeleton />
      ) : !audit || audit.length === 0 ? (
        <EmptyLine text="No activity yet" />
      ) : (
        <ul class="ui-list">
          {activityRows(audit, browsers?.mcpClients ?? [], now).map((row) => (
            <ListRow
              key={row.id}
              title={row.sentence}
              meta={row.time ?? undefined}
              status={row.state ?? undefined}
              statusTone={row.state === "Denied" || row.state === "Failed" ? "bad" : "neutral"}
            />
          ))}
        </ul>
      )}
    </Section>
  );

  if (narrow && selected) {
    return (
      <Page title="Tasks" subtitle="What your AI app is working on, newest first.">
        <DetailBack onBack={() => setSelectedId(null)} />
        {detail(selected)}
      </Page>
    );
  }

  return (
    <Page title="Tasks" subtitle="What your AI app is working on, newest first.">
      {error ? <ErrorState message={error} /> : null}
      {waitingSection}
      {tasks === null ? (
        <SectionSkeleton />
      ) : tasks.length === 0 ? (
        <EmptyLine text="No tasks yet" />
      ) : (
        <div class="ui-grid">
          <Section title="Tasks" description="Tap a task to see its activity log.">
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
      {recentSection}
    </Page>
  );
}
