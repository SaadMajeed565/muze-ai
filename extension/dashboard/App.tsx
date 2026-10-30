import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AuditEvent, PermissionMode, PolicyConfig } from "../libs/security/index.js";
import type { DashboardState } from "../src/messages.js";
import type { Appearance, TabId } from "./logic.js";
import { APPEARANCE_KEY, LEGACY_APPEARANCE_KEY, readAppearance, sendRequest } from "./logic.js";
import { Icon } from "./components/Icon.js";
import { Button, Callout, Card, Skeleton } from "./components/primitives.js";
import { Nav } from "./Nav.js";
import { Onboarding } from "./Onboarding.js";
import { AuthPage, type AuthMode } from "./pages/Auth.js";
import { FilesPage } from "./pages/Files.js";
import { HomePage } from "./pages/Home.js";
import { ConnectionsPage } from "./pages/Connections.js";
import { AccountPage } from "./pages/Account.js";
import { TasksPage } from "./pages/Tasks.js";

const POLL_MS = 5000;

function LoadingScreen({ error }: { error: string | null }): preact.JSX.Element {
  if (error) {
    return (
      <div class="app app--centered">
        <div class="brand">
          <Icon name="logo" size={26} class="brand-mark" />
          <span class="brand-name">Muze AI</span>
        </div>
        <Card title="Could not open the dashboard" icon="alert">
          <p class="lede">{error}</p>
          <Button variant="primary" icon="refresh" onClick={() => location.reload()}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div class="app app--centered" aria-busy="true">
      <div class="brand">
        <Icon name="logo" size={26} class="brand-mark" />
        <span class="brand-name">Muze AI</span>
      </div>
      <div class="skeleton-list">
        <Skeleton width="70%" />
        <Skeleton width="100%" />
        <Skeleton width="88%" />
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
  const [tab, setTab] = useState<TabId>("home");
  const [connectionsSegment, setConnectionsSegment] = useState<"browsers" | "apps">("browsers");
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);

  const initialised = useRef(false);
  const content = useRef<HTMLElement>(null);

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
        const value = stored[APPEARANCE_KEY] ?? stored[LEGACY_APPEARANCE_KEY];
        setAppearance(readAppearance(value));
        if (stored[APPEARANCE_KEY] === undefined && stored[LEGACY_APPEARANCE_KEY] !== undefined) {
          void chrome.storage.local
            .set({ [APPEARANCE_KEY]: stored[APPEARANCE_KEY] })
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
    // The v2 wizard is compact (permission level + connect an AI app)
    // and only ever shows when signed in; the auth screen covers the
    // signed-out case. Start it at step 1 regardless of the persisted
    // step from the old four-step wizard.
    setWizardStep(1);
    if (!state.onboarding.completed) setWizardOpen(true);
  }, [state]);

  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    const response = await sendRequest({ type: "muze/audit", limit: 50 });
    if (response.ok && response.audit) setAudit(response.audit);
    else if (response.error) setError(response.error);
    setAuditLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "tasks") void loadAudit();
  }, [tab, loadAudit, state?.snapshot.auditEvents]);

  const request = async (message: unknown): Promise<boolean> => {
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
      return true;
    } finally {
      busyCount.current = Math.max(0, busyCount.current - 1);
      setBusy(busyCount.current > 0);
    }
  };

  const changeAppearance = (next: Appearance): void => {
    setAppearance(next);
    void chrome.storage.local.set({ [APPEARANCE_KEY]: next }).catch(() => undefined);
  };

  const goToTab = (next: TabId): void => {
    setTab(next);
    requestAnimationFrame(() => content.current?.focus());
  };

  const openWizard = (): void => {
    setWizardStep(state?.onboarding.step ?? 1);
    setError(null);
    setWizardOpen(true);
  };

  const closeWizard = (step: number): void => {
    setWizardOpen(false);
    setWizardStep(step);
  };

  const setStep = (step: number): void => {
    // Compact wizard steps are local only; only completion is persisted.
    setWizardStep(step);
  };

  const finishWizard = async (): Promise<void> => {
    const ok = await request({ type: "muze/onboarding/set", patch: { completed: true, step: 4 } });
    if (ok) closeWizard(4);
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
    void request({ type: "muze/approval/respond", approvalId, approved });
  };

  if (!state) return <LoadingScreen error={loadError} />;

  // Signed out (or the stored token was rejected): the auth screen
  // replaces the dashboard entirely. There is no separate "not
  // connected" dashboard state; Home handles the disconnected case
  // inline once signed in.
  if (!state.gateway.signedIn || state.gateway.authRequired) {
    return <AuthPage busy={busy} error={error} onSubmit={submitAuth} />;
  }

  if (wizardOpen) {
    return (
      <Onboarding
        compact
        step={wizardStep}
        busy={busy}
        error={error}
        mode={state.snapshot.mode}
        signedIn={state.gateway.signedIn}
        email={state.gateway.email}
        mcpUrl={state.gateway.mcpUrl}
        connectedClients={state.snapshot.connectedClients}
        onStep={setStep}
        onModeChange={(mode: PermissionMode) => void request({ type: "muze/policy/mode", mode })}
        onSignIn={() => undefined}
        onFinish={() => void finishWizard()}
        onSkip={() => void skipWizard()}
      />
    );
  }

  const { snapshot, approvals } = state;

  return (
    <div class="app" data-tab={tab}>
      <Nav
        active={tab}
        onChange={goToTab}
        status={snapshot.bridgeStatus}
        clients={snapshot.connectedClients}
        pending={snapshot.pendingApprovals}
      />

      <div class="shell">
        {/* Slim 48px topbar with brand only, on the options page
            (wide) only; the side panel (narrow) has no in-app brand
            row and no email pill — see styles.css .topbar. */}
        <header class="topbar">
          <span class="brand">
            <Icon name="logo" size={20} class="brand-mark" />
            <span class="brand-name">Muze AI</span>
          </span>
        </header>

        <div class="page">
          {error ? (
            <div class="notice">
              <Callout tone="danger">{error}</Callout>
              <button type="button" class="notice-close" aria-label="Dismiss" onClick={() => setError(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : null}

          <main class="content" ref={content} tabIndex={-1} aria-label={tab}>
            {tab === "home" ? (
              <HomePage
                state={state}
                busy={busy}
                approvals={approvals}
                onReconnect={() => void request({ type: "muze/bridge/reconnect" })}
                onOpenWizard={openWizard}
                onNavigate={goToTab}
                onRespond={respond}
                onCancelForClient={(clientId) => void request({ type: "muze/approvals/cancel-for-client", clientId })}
                onKillSwitch={(engaged) => void request({ type: "muze/killswitch", engaged })}
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
                onCancelForClient={(clientId) => void request({ type: "muze/approvals/cancel-for-client", clientId })}
                onRefreshAudit={() => void loadAudit()}
              />
            ) : null}

            {tab === "account" ? (
              <AccountPage
                state={state}
                busy={busy}
                appearance={appearance}
                onAppearance={changeAppearance}
                onModeChange={(mode) => void request({ type: "muze/policy/mode", mode })}
                onPolicyPatch={(patch: Partial<PolicyConfig>) => void request({ type: "muze/policy/update", patch })}
                onReadOnly={(enabled) => void request({ type: "muze/policy/readonly", enabled })}
                onKillSwitch={(engaged) => void request({ type: "muze/killswitch", engaged })}
                onGroupToggle={(group, enabled) => void request({ type: "muze/policy/group", group, enabled })}
                onSignOut={() => void request({ type: "muze/gateway/sign-out" })}
                onDeleteAccount={() => void request({ type: "muze/gateway/delete-account" })}
              />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
