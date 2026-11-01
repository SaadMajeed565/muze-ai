import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AuditEvent, PermissionMode, PolicyConfig } from "../libs/security/index.js";
import type { DashboardState } from "../src/messages.js";
import type { Appearance, TabId } from "./logic.js";
import { APPEARANCE_KEY, LEGACY_APPEARANCE_KEY, readAppearance, sendRequest, TABS } from "./logic.js";
import { plainGroupName as groupLabel } from "./ui-logic.js";
import { AppBar, BottomNav } from "./components/AppShell.js";
import { Icon } from "./components/Icon.js";
import { Button, Callout, Skeleton } from "./components/primitives.js";
import { EmptyLine } from "./components/layout.js";
import { ApprovalCard, Sheet } from "./components/shared.js";
import { showToast } from "./components/feedback.js";
import { Onboarding } from "./Onboarding.js";
import { AuthPage, type AuthMode } from "./pages/Auth.js";
import { FilesPage } from "./pages/Files.js";
import { HomePage } from "./pages/Home.js";
import { ConnectionsPage } from "./pages/Connections.js";
import { AccountPage, accountDetailTitle, type AccountDetail } from "./pages/Account.js";
import { TasksPage } from "./pages/Tasks.js";

const POLL_MS = 5000;

const TAB_TITLES: Record<TabId, string> = {
  home: "Home",
  tasks: "Tasks",
  connections: "Connect",
  files: "Files",
  account: "Me",
};

const TAB_SUBTITLES: Record<TabId, string> = {
  home: "Your browser, your rules.",
  tasks: "What your AI app is doing, newest first.",
  connections: "Browsers and AI apps on your account.",
  files: "Files stay on this device.",
  account: "Your account and this browser.",
};

interface Route {
  tab: TabId;
  detail: string | null;
}

function LoadingScreen({ error }: { error: string | null }): preact.JSX.Element {
  if (error) {
    return (
      <div class="boot-screen">
        <div class="brand">
          <Icon name="logo" size={30} class="brand-mark" />
          <span class="brand-name">Muze AI</span>
        </div>
        <div class="boot-card">
          <h1>Could not open the dashboard</h1>
          <p class="lede">{error}</p>
          <Button variant="primary" icon="refresh" onClick={() => location.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="boot-screen" aria-busy="true">
      <div class="brand">
        <Icon name="logo" size={30} class="brand-mark" />
        <span class="brand-name">Muze AI</span>
      </div>
      <div class="skeleton-list">
        <Skeleton width="52%" />
        <Skeleton width="100%" />
        <Skeleton width="88%" />
        <Skeleton width="72%" />
      </div>
      <span class="sr-only">Loading</span>
    </div>
  );
}

export function App(): preact.JSX.Element {
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyCount = useRef(0);
  const [route, setRoute] = useState<Route>({ tab: "home", detail: null });
  const [connectionsSegment, setConnectionsSegment] = useState<"browsers" | "apps">("browsers");
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [approvalsOpen, setApprovalsOpen] = useState(false);

  const initialised = useRef(false);
  const content = useRef<HTMLElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const currentKey = `${route.tab}:${route.detail ?? "root"}`;
  const keyRef = useRef(currentKey);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/state" });
    if (response.ok && response.state) {
      setState(response.state);
      setLoadError(null);
    } else if (response.error) {
      setLoadError((current) => current ?? response.error ?? "Failed to load state");
    }
  }, []);

  useEffect(() => {
    void refresh();

    const listener = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);

    let timer = 0;
    const poll = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    const restart = (): void => {
      clearInterval(timer);
      timer = window.setInterval(poll, POLL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void refresh();
        restart();
      } else {
        clearInterval(timer);
      }
    };

    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh]);

  useEffect(() => {
    void chrome.storage.local
      .get([APPEARANCE_KEY, LEGACY_APPEARANCE_KEY])
      .then((stored) => {
        const value = readAppearance(stored[APPEARANCE_KEY] ?? stored[LEGACY_APPEARANCE_KEY]);
        setAppearance(value);
        if (stored[APPEARANCE_KEY] === undefined && stored[LEGACY_APPEARANCE_KEY] !== undefined) {
          void chrome.storage.local
            .set({ [APPEARANCE_KEY]: value })
            .then(() => chrome.storage.local.remove([LEGACY_APPEARANCE_KEY]).catch(() => undefined))
            .catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
  }, [appearance]);

  useEffect(() => {
    if (!state || initialised.current) return;
    initialised.current = true;
    setWizardStep(1);
    if (!state.onboarding.completed) setWizardOpen(true);
  }, [state]);

  useEffect(() => {
    const previous = keyRef.current;
    if (previous === currentKey) return;
    scrollPositions.current[previous] = window.scrollY;
    keyRef.current = currentKey;
    requestAnimationFrame(() => {
      content.current?.focus({ preventScroll: true });
      window.scrollTo(0, scrollPositions.current[currentKey] ?? 0);
    });
  }, [currentKey]);

  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    const response = await sendRequest({ type: "muze/audit", limit: 50 });
    if (response.ok && response.audit) setAudit(response.audit);
    else if (response.error) setError(response.error);
    setAuditLoading(false);
  }, []);

  useEffect(() => {
    if (route.tab === "tasks") void loadAudit();
  }, [route.tab, loadAudit, state?.snapshot.auditEvents]);

  const request = async (message: unknown, success?: string): Promise<boolean> => {
    busyCount.current += 1;
    setBusy(true);
    setError(null);
    try {
      const response = await sendRequest(message);
      if (!response.ok) {
        setError(response.error ?? "That action did not go through.");
        return false;
      }
      if (response.state) setState(response.state);
      if (success) showToast(success);
      return true;
    } finally {
      busyCount.current = Math.max(0, busyCount.current - 1);
      setBusy(busyCount.current > 0);
    }
  };

  const run = (message: unknown, success?: string): void => {
    void request(message, success);
  };

  const changeAppearance = (next: Appearance): void => {
    setAppearance(next);
    void chrome.storage.local.set({ [APPEARANCE_KEY]: next }).catch(() => undefined);
  };

  const goToTab = (next: TabId): void => {
    setApprovalsOpen(false);
    setRoute({ tab: next, detail: null });
  };

  const openTask = (taskId: string): void => {
    setRoute({ tab: "tasks", detail: taskId });
  };

  const openAccountDetail = (detail: AccountDetail | null): void => {
    setRoute({ tab: "account", detail });
  };

  const goBack = (): void => {
    setRoute((current) => ({ tab: current.tab, detail: null }));
  };

  const openWizard = (): void => {
    setWizardStep(1);
    setError(null);
    setWizardOpen(true);
  };

  const closeWizard = (step: number): void => {
    setWizardOpen(false);
    setWizardStep(step);
  };

  const setStep = (step: number): void => {
    setWizardStep(Math.min(2, Math.max(1, step)));
  };

  const finishWizard = async (): Promise<void> => {
    const ok = await request({ type: "muze/onboarding/set", patch: { completed: true, step: 2 } }, "Setup complete");
    if (ok) closeWizard(2);
  };

  const submitAuth = async (mode: AuthMode, email: string, password: string): Promise<boolean> => {
    return request({
      type: mode === "sign-up" ? "muze/gateway/sign-up-email" : "muze/gateway/sign-in-email",
      email,
      password,
    });
  };

  const skipWizard = async (): Promise<void> => {
    const ok = await request({ type: "muze/onboarding/set", patch: { completed: true } });
    if (ok) closeWizard(wizardStep);
  };

  const respond = (approvalId: string, approved: boolean): void => {
    run({ type: "muze/approval/respond", approvalId, approved }, approved ? "Request approved" : "Request denied");
  };

  if (!state) return <LoadingScreen error={loadError} />;

  if (!state.gateway.signedIn || state.gateway.authRequired) {
    return <AuthPage busy={busy} error={error} onSubmit={submitAuth} />;
  }

  if (wizardOpen) {
    return (
      <Onboarding
        step={wizardStep}
        busy={busy}
        error={error}
        mode={state.snapshot.mode}
        mcpUrl={state.gateway.mcpUrl}
        connectedClients={state.snapshot.connectedClients}
        onStep={setStep}
        onModeChange={(mode: PermissionMode) => run({ type: "muze/policy/mode", mode }, "Permission level updated")}
        onFinish={() => void finishWizard()}
        onSkip={() => void skipWizard()}
      />
    );
  }

  const { snapshot, approvals } = state;
  const tab = route.tab;
  const detailTitle = tab === "account" ? accountDetailTitle(route.detail as AccountDetail | null) : null;
  const title = route.detail ? (detailTitle ?? (tab === "tasks" ? "Task" : TAB_TITLES[tab])) : TAB_TITLES[tab];

  return (
    <div class="app-shell" data-tab={tab}>
      <AppBar
        title={title}
        subtitle={route.detail ? undefined : TAB_SUBTITLES[tab]}
        icon={TABS.find((entry) => entry.id === tab)?.icon}
        connected={snapshot.bridgeStatus === "connected"}
        clients={snapshot.connectedClients}
        pending={approvals.length}
        onApprovals={() => setApprovalsOpen(true)}
        onBack={route.detail ? goBack : undefined}
      />

      <main class="app-main" ref={content} tabIndex={-1} aria-label={title}>
        <div class="app-content">
          {error ? (
            <div class="notice">
              <Callout tone="danger">{error}</Callout>
              <button type="button" class="notice-close" aria-label="Dismiss" onClick={() => setError(null)}>
                <Icon name="close" size={15} />
              </button>
            </div>
          ) : null}

          {tab === "home" ? (
            <HomePage
              state={state}
              busy={busy}
              approvals={approvals}
              onReconnect={() => run({ type: "muze/bridge/reconnect" }, "Reconnecting")}
              onOpenWizard={openWizard}
              onNavigate={goToTab}
              onOpenTask={openTask}
              onRespond={respond}
              onCancelForClient={(clientId) => run({ type: "muze/approvals/cancel-for-client", clientId }, "Waiting requests cancelled")}
              onKillSwitch={(engaged) => run({ type: "muze/killswitch", engaged }, engaged ? "All activity stopped" : "Activity resumed")}
            />
          ) : null}

          {tab === "connections" ? (
            <ConnectionsPage state={state} busy={busy} segment={connectionsSegment} onSegment={setConnectionsSegment} onNavigate={goToTab} />
          ) : null}

          {tab === "files" ? <FilesPage /> : null}

          {tab === "tasks" ? (
            <TasksPage
              approvals={approvals}
              audit={audit}
              auditLoading={auditLoading}
              busy={busy}
              onRespond={respond}
              onCancelForClient={(clientId) => run({ type: "muze/approvals/cancel-for-client", clientId })}
              onRefreshAudit={() => void loadAudit()}
              selectedId={route.detail}
              onSelectTask={(taskId) => setRoute({ tab: "tasks", detail: taskId })}
            />
          ) : null}

          {tab === "account" ? (
            <AccountPage
              state={state}
              busy={busy}
              appearance={appearance}
              onAppearance={changeAppearance}
              onModeChange={(mode) => run({ type: "muze/policy/mode", mode }, "Permission level updated")}
              onPolicyPatch={(patch: Partial<PolicyConfig>) => run({ type: "muze/policy/update", patch }, "Settings saved")}
              onReadOnly={(enabled) => run({ type: "muze/policy/readonly", enabled }, enabled ? "Read-only mode on" : "Read-only mode off")}
              onKillSwitch={(engaged) => run({ type: "muze/killswitch", engaged }, engaged ? "All activity stopped" : "Activity resumed")}
              onGroupToggle={(group, enabled) =>
                run({ type: "muze/policy/group", group, enabled }, `${groupLabel(group)} ${enabled ? "on" : "off"}`)
              }
              onSignOut={() => run({ type: "muze/gateway/sign-out" }, "Signed out")}
              onDeleteAccount={() => run({ type: "muze/gateway/delete-account" }, "Account deleted")}
              detail={route.detail as AccountDetail | null}
              onOpen={openAccountDetail}
            />
          ) : null}
        </div>
      </main>

      <BottomNav active={tab} onChange={goToTab} pending={approvals.length} />

      <Sheet open={approvalsOpen} label="Waiting for you" onClose={() => setApprovalsOpen(false)}>
        {approvals.length === 0 ? (
          <EmptyLine text="Nothing waiting right now." />
        ) : (
          <div class="approval-list">
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} appName="AI app" busy={busy} onRespond={respond} />
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
