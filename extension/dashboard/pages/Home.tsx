import { useCallback, useEffect, useState } from "preact/hooks";

import { sanitizeTaskView, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import type { TabId } from "../logic.js";
import { sendRequest, setupChecklist, setupRemaining } from "../logic.js";
import { activityIcon, dedupeAppsByName, plainTaskStatus, resolveAppName } from "../ui-logic.js";
import { tabCountText } from "../browsers-logic.js";
import { Icon } from "../components/Icon.js";
import { Button } from "../components/primitives.js";
import { EmptyLine, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";
import { AddAppSheet, ApprovalCard, PauseControl } from "../components/shared.js";
import { useConfirm } from "../components/confirm.js";

export interface HomePageProps {
  state: DashboardState;
  busy: boolean;
  approvals: ApprovalRequestInfo[];
  onReconnect: () => void;
  onOpenWizard: () => void;
  onNavigate: (tab: TabId) => void;
  onOpenTask?: (taskId: string) => void;
  onRespond: (approvalId: string, approved: boolean) => void;
  onCancelForClient: (clientId: string) => void;
  onKillSwitch: (engaged: boolean) => void;
}

const TASKS_POLL_MS = 5000;

/**
 * Home: setup banner, approvals, working now, this browser, apps. The
 * connection URL only appears in the Add app sheet. No plan card, no
 * metrics, no duplicate browser toggle.
 */
export function HomePage({
  state,
  busy,
  approvals,
  onReconnect,
  onOpenWizard,
  onNavigate,
  onOpenTask,
  onRespond,
  onCancelForClient,
  onKillSwitch,
}: HomePageProps): preact.JSX.Element {
  const { snapshot, gateway, onboarding } = state;
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [addAppOpen, setAddAppOpen] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    if (!gateway.signedIn) return;
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsersData(response.browsers);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway.signedIn]);

  const loadTasks = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/tasks.list" });
    if (response.ok) {
      const wire = response as unknown as { tasks?: unknown[] };
      const listed = Array.isArray(wire.tasks) ? wire.tasks.map(sanitizeTaskView) : [];
      listed.sort((a, b) => b.createdAt - a.createdAt);
      setTasks(listed);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => {
      void loadTasks();
    }, TASKS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  useEffect(() => {
    const listener = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") {
        void loadTasks();
      }
    };
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
    if (onMessage?.addListener) onMessage.addListener(listener);
    return () => {
      if (onMessage?.removeListener) onMessage.removeListener(listener);
    };
  }, [loadTasks]);

  const remaining = setupRemaining({
    signedIn: gateway.signedIn,
    connectedClients: snapshot.connectedClients,
    onboardingStep: onboarding.step,
  });
  const checklist = setupChecklist({
    signedIn: gateway.signedIn,
    connectedClients: snapshot.connectedClients,
    onboardingStep: onboarding.step,
  });

  const thisBrowser = browsersData
    ? (browsersData.browsers.find((browser) => browser.sessionId === browsersData.currentSessionId) ??
      browsersData.browsers.find((browser) => browser.isLocal) ??
      null)
    : null;
  const browserConnected = snapshot.bridgeStatus === "connected";
  const statusWord = !browserConnected ? "Not connected" : thisBrowser ? (thisBrowser.connected ? "Online" : "Offline") : "Connected";
  const tabCount = browserConnected && thisBrowser ? tabCountText(thisBrowser) : null;

  const thisBrowserClients = browsersData
    ? dedupeAppsByName(browsersData.mcpClients.filter((client) => thisBrowser && client.sessionId === thisBrowser.sessionId))
    : [];
  const runningTasks = (tasks ?? []).filter((task) => task.status === "running" || task.status === "created");

  const approvalGroups = new Map<string, { name: string; approvals: ApprovalRequestInfo[] }>();
  for (const approval of approvals) {
    const resolved = resolveAppName(approval.client, browsersData?.mcpClients ?? []);
    const existing = approvalGroups.get(approval.client.id);
    if (existing) existing.approvals.push(approval);
    else approvalGroups.set(approval.client.id, { name: resolved, approvals: [approval] });
  }

  const [tipDismissed, setTipDismissed] = useState(false);

  return (
    <Page title="Home" subtitle="Your browser, your rules.">
      {/* Hero header */}
      <div class="ui-page-hero">
        <div class="ui-page-hero-icon">
          <Icon name="home" size={24} />
        </div>
        <div class="ui-page-hero-content">
          <h1 class="ui-page-hero-title">Home</h1>
          <p class="ui-page-hero-subtitle">Your browser, your rules.</p>
        </div>
        <div class="ui-page-hero-status">
          <span class={"status-pill" + (browserConnected ? " is-online" : "")}>
            <span class="status-dot" />
            <span class="status-pill-text">{browserConnected ? "Online" : "Offline"}</span>
          </span>
        </div>
      </div>

      {/* Welcome card (when setup not done) */}
      {remaining > 0 ? (
        <div class="welcome-card">
          <div class="welcome-card-body">
            <div class="welcome-card-icon">
              <Icon name="logo" size={28} />
            </div>
            <div>
              <p class="welcome-card-title">Muze AI is ready!</p>
              <p class="welcome-card-subtitle">Control your browser with AI apps.</p>
            </div>
          </div>
          <div class="welcome-card-footer">
            <Button variant="primary" size="sm" onClick={onOpenWizard}>View Guide →</Button>
          </div>
        </div>
      ) : null}

      {approvals.length > 0 ? (
        <Section
          title="Needs your OK"
          description={`${approvals.length} request${approvals.length === 1 ? "" : "s"} waiting. Each expires after two minutes.`}
        >
          <div class="approval-list">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                appName={resolveAppName(approval.client, browsersData?.mcpClients ?? [])}
                busy={busy}
                onRespond={onRespond}
              />
            ))}
          </div>
          {approvalGroups.size > 0 ? (
            <div class="approval-bulk">
              {[...approvalGroups.entries()].map(([clientId, group]) => (
                <Button
                  key={clientId}
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Cancel requests from ${group.name}?`,
                      body: "Every waiting action from this app will be denied.",
                      confirmLabel: "Cancel requests",
                      cancelLabel: "Keep waiting",
                      tone: "danger",
                    });
                    if (ok) onCancelForClient(clientId);
                  }}
                >
                  Cancel all from {group.name}
                </Button>
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      {/* Active Tasks */}
      <Section title="Active Tasks" description="Tasks your AI app is running in this browser.">
        {tasks === null ? (
          <SectionSkeleton />
        ) : runningTasks.length === 0 ? (
          <EmptyLine text="Nothing running." />
        ) : (
          <ul class="ui-list">
            {runningTasks.map((task) => {
              const percent = task.totalSteps > 0 ? Math.round((task.doneSteps.length / task.totalSteps) * 100) : 0;
              return (
                <ListRow
                  key={task.id}
                  icon={activityIcon(task.steps.find((step) => step.state !== "done")?.tool)}
                  title={task.goal || "Task"}
                  meta={`${plainTaskStatus(task.status)} · Step ${task.doneSteps.length} of ${task.totalSteps}`}
                  progress={percent}
                  onSelect={() => (onOpenTask ? onOpenTask(task.id) : onNavigate("tasks"))}
                />
              );
            })}
          </ul>
        )}
      </Section>

      {/* Browser Status */}
      <Section title="Browser Status">
        <div class="browser-card">
          <div class="browser-card-header">
            <div class="browser-card-icon">
              <Icon name="browser" size={22} />
            </div>
            <div class="browser-card-main">
              <span class="browser-card-name">{thisBrowser ? thisBrowser.name : "This browser"}</span>
              <span class="browser-card-meta">
                <span class={"status-dot " + (statusWord === "Online" ? "is-on" : statusWord === "Not connected" ? "is-warn" : "")} aria-hidden="true" />
                {statusWord}
                {tabCount ? ` · ${tabCount}` : ""}
              </span>
            </div>
            <div class="browser-card-actions">
              {!browserConnected && gateway.enabled && !gateway.authRequired ? (
                <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={onReconnect}>
                  Reconnect
                </Button>
              ) : null}
              <PauseControl paused={snapshot.killSwitch} busy={busy} onToggle={onKillSwitch} />
            </div>
          </div>
          <div class="browser-card-stats">
            <div class="browser-stat">
              <span class="browser-stat-icon"><Icon name="app" size={16} /></span>
              <div class="browser-stat-info">
                <span class="browser-stat-label">Connected Apps</span>
                <span class="browser-stat-value">{thisBrowserClients.length} apps</span>
              </div>
            </div>
            <div class="browser-stat">
              <span class="browser-stat-icon"><Icon name="shield" size={16} /></span>
              <div class="browser-stat-info">
                <span class="browser-stat-label">Browser Control</span>
                <span class={"browser-stat-value" + (browserConnected && !snapshot.killSwitch ? " is-active" : "")}>
                  {snapshot.killSwitch ? "Paused" : browserConnected ? "Active" : "Inactive"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Connected AI Apps */}
      <Section
        title="Connected AI Apps"
        action={
          <Button variant="ghost" size="sm" icon="plus" disabled={busy} onClick={() => setAddAppOpen(true)}>
            Add App
          </Button>
        }
      >
        {!browsersData ? (
          <SectionSkeleton />
        ) : thisBrowserClients.length === 0 ? (
          <button type="button" class="app-empty-card" onClick={() => setAddAppOpen(true)}>
            <div class="app-empty-card-icon"><Icon name="link" size={20} /></div>
            <div class="app-empty-card-text">
              <span class="app-empty-card-title">No AI apps connected yet</span>
              <span class="app-empty-card-desc">Connect Claude, ChatGPT or any MCP client to control your browser.</span>
            </div>
            <span class="app-empty-card-arrow"><Icon name="chevron-right" size={18} /></span>
          </button>
        ) : (
          <ul class="ui-list">
            {thisBrowserClients.map((group) => (
              <ListRow
                key={group.name}
                icon="app"
                title={group.name}
                status={group.live ? "Connected" : "Not connected"}
                statusTone={group.live ? "ok" : "neutral"}
              />
            ))}
          </ul>
        )}
      </Section>

      {/* Tip card */}
      {!tipDismissed && thisBrowserClients.length === 0 ? (
        <div class="tip-card">
          <span class="tip-card-icon"><Icon name="info" size={16} /></span>
          <span class="tip-card-text">Tip: Use the Connect tab to set up your favorite AI application.</span>
          <button class="tip-card-dismiss" onClick={() => setTipDismissed(true)} aria-label="Dismiss tip">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}

      <AddAppSheet open={addAppOpen} onClose={() => setAddAppOpen(false)} mcpUrl={gateway.mcpUrl} />
    </Page>
  );
}
