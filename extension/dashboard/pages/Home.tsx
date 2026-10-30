import { useCallback, useEffect, useState } from "preact/hooks";
import { sanitizeTaskView, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import type { TabId } from "../logic.js";
import { formatCountdown, sendRequest, setupChecklist, setupRemaining } from "../logic.js";
import { dedupeAppsByName, homeNextAction, plainTaskStatus, resolveAppName, truncateText } from "../ui-logic.js";
import { tabCountText } from "../browsers-logic.js";
import { Icon } from "../components/Icon.js";
import { Button } from "../components/primitives.js";
import { EmptyLine, ListRow, Page, Section } from "../components/layout.js";
import { AddAppSheet, PauseControl, PlanCard } from "../components/shared.js";

export interface HomePageProps {
  state: DashboardState;
  busy: boolean;
  approvals: ApprovalRequestInfo[];
  onReconnect: () => void;
  onOpenWizard: () => void;
  onNavigate: (tab: TabId) => void;
  onRespond: (approvalId: string, approved: boolean) => void;
  onCancelForClient: (clientId: string) => void;
  onKillSwitch: (engaged: boolean) => void;
}

const TASKS_POLL_MS = 5000;

/**
 * Home (v3): sections in fixed order — this-browser status, needs
 * your OK (only when approvals exist), working now, apps using this
 * browser, account strip, finish-setup checklist (only while
 * unfinished). Removed from v2: metric cards, the "Connected to the
 * gateway" line, the separate browser-connection toggle (see report:
 * the gateway-enabled toggle is NOT a browser disconnect, so it was
 * dropped rather than moved), the Manage browsers primary button, the
 * inline connection URL block, and the email under the title. The
 * connection URL renders only inside AddAppSheet.
 */
export function HomePage({
  state,
  busy,
  approvals,
  onReconnect,
  onOpenWizard,
  onNavigate,
  onRespond,
  onCancelForClient,
  onKillSwitch,
}: HomePageProps): preact.JSX.Element {
  const { snapshot, gateway, onboarding } = state;
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
      setNow(Date.now());
    }, TASKS_POLL_MS);
    return () => window.clearInterval(timer);
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
  const next = homeNextAction({
    signedIn: gateway.signedIn,
    setupRemaining: remaining,
    pendingApprovals: snapshot.pendingApprovals,
  });

  const nextAction =
    next === "setup" ? (
      <Button variant="primary" icon="arrow-right" disabled={busy} onClick={onOpenWizard}>
        Resume setup
      </Button>
    ) : next === "approvals" ? (
      <Button variant="primary" icon="alert" disabled={busy} onClick={() => onNavigate("tasks")}>
        Review requests
      </Button>
    ) : undefined;

  // This browser: the current session's row, else the local row, else
  // no name at all — never an id, never a guess.
  const thisBrowser = browsersData
    ? (browsersData.browsers.find((browser) => browser.sessionId === browsersData.currentSessionId) ??
      browsersData.browsers.find((browser) => browser.isLocal) ??
      null)
    : null;
  const browserConnected = snapshot.bridgeStatus === "connected";
  // Disconnected: one muted "Not connected" + Reconnect, no tab count.
  // Connected: the row's Online/Offline + tab count only when known.
  const statusWord = !browserConnected ? "Not connected" : thisBrowser ? (thisBrowser.connected ? "Online" : "Offline") : null;
  const tabCount = browserConnected && thisBrowser ? tabCountText(thisBrowser) : null;
  const statusLine = [statusWord, tabCount].filter(Boolean).join(" · ");

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

  return (
    <Page title="Home" action={nextAction}>
      <Section title="This browser">
        <div class="ui-row-inline">
          <span class="ui-row-meta">This browser</span>
          {thisBrowser ? <span>{thisBrowser.name}</span> : null}
          {statusLine ? (
            <span>
              <span class={"status-dot " + (statusWord === "Online" ? "is-on" : "")} aria-hidden="true" />
              {statusLine}
            </span>
          ) : null}
          {!browserConnected && gateway.enabled && !gateway.authRequired ? (
            <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
          <span class="ui-row-spacer" />
          <PauseControl paused={snapshot.killSwitch} busy={busy} onToggle={onKillSwitch} />
        </div>
      </Section>

      {approvals.length > 0 ? (
        <Section title="Needs your OK" description={`${approvals.length} request${approvals.length === 1 ? "" : "s"} pending. Each expires after two minutes.`}>
          <ul class="ui-list">
            {approvals.map((approval) => (
              <ListRow
                key={approval.id}
                title={approval.title}
                meta={`${truncateText(approval.summary, 160)} · ${resolveAppName(approval.client, browsersData?.mcpClients ?? [])} · ${formatCountdown(approval.expiresAt, now)}`}
                status="Waiting for you"
                statusTone="warn"
                actions={
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, false)}>
                      Deny
                    </Button>
                    <Button variant="primary" size="sm" icon="check" disabled={busy} onClick={() => onRespond(approval.id, true)}>
                      Allow
                    </Button>
                  </>
                }
              />
            ))}
          </ul>
          <div class="ui-chip-row">
            {[...approvalGroups.values()].map((group) => (
              <Button
                key={group.name}
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const clientId = [...approvalGroups.entries()].find(([, value]) => value === group)?.[0];
                  if (!clientId) return;
                  const ok = confirm(`Cancel all pending requests from ${group.name}? The waiting actions will be denied.`);
                  if (ok) onCancelForClient(clientId);
                }}
              >
                Cancel requests from {group.name}
              </Button>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Working in this browser now">
        {runningTasks.length === 0 ? (
          <EmptyLine text="Nothing running." />
        ) : (
          <ul class="ui-list">
            {runningTasks.map((task) => {
              const percent = task.totalSteps > 0 ? Math.round((task.doneSteps.length / task.totalSteps) * 100) : 0;
              return (
                <ListRow
                  key={task.id}
                  title={task.goal || "Task"}
                  meta={`${plainTaskStatus(task.status)} · Step ${task.doneSteps.length} of ${task.totalSteps}`}
                  progress={percent}
                  onSelect={() => onNavigate("tasks")}
                />
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Apps using this browser"
        action={
          <Button variant="ghost" size="sm" icon="arrow-right" disabled={busy} onClick={() => setAddAppOpen(true)}>
            Add app
          </Button>
        }
      >
        {!browsersData ? null : thisBrowserClients.length === 0 ? (
          <EmptyLine text="No apps using this browser yet." />
        ) : (
          <ul class="ui-list">
            {thisBrowserClients.map((group) => (
              <ListRow
                key={group.name}
                title={group.name}
                status={group.live ? "Connected" : "Not connected"}
                statusTone={group.live ? "ok" : "neutral"}
              />
            ))}
          </ul>
        )}
      </Section>

      {browsersData ? (
        <Section title="Your account">
          <PlanCard browserCount={browsersData.browsers.length} onSelect={() => onNavigate("account")} />
        </Section>
      ) : null}

      {remaining > 0 ? (
        <Section title="Finish setup" description={`${remaining} step${remaining === 1 ? "" : "s"} left`}>
          <ul class="ui-checklist">
            {checklist.map((item) => (
              <li key={item.id} class={item.done ? "is-done" : ""}>
                <span class="ui-checklist-mark" aria-hidden="true">
                  <Icon name={item.done ? "check" : "close"} size={12} strokeWidth={2.6} />
                </span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <AddAppSheet open={addAppOpen} onClose={() => setAddAppOpen(false)} mcpUrl={gateway.mcpUrl} />
    </Page>
  );
}
