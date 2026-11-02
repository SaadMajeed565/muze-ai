import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { PermissionMode } from "../libs/security/index.js";
import type { DashboardState } from "../src/messages.js";
import type { Appearance, TabId } from "./logic.js";
import { APPEARANCE_KEY, LEGACY_APPEARANCE_KEY, readAppearance, sendRequest, TABS } from "./logic.js";
import { plainGroupName as groupLabel } from "./ui-logic.js";
import { AppBar, BottomNav } from "./components/AppShell.js";
import { Icon } from "./components/Icon.js";
import { Button, Callout, Skeleton } from "./components/primitives.js";
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
  home: "Muze AI",
  tasks: "Tasks",
  connections: "Connect",
  files: "Files",
  account: "Me",
};

const TAB_SUBTITLES: Record<TabId, string> = {
  home: "Your browser, your rules",
  tasks: "What your AI app is doing, newest first",
  connections: "Browsers and AI apps",
  files: "Files your AI app can use",
  account: "Your account",
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
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [browserCount, setBrowserCount] = useState<number | null>(null);

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

  // Browser count for the header donut: fetched once and on every
  // dashboard event, never on the 5s state poll (the donut does not
  // need to tick that fast).
  useEffect(() => {
    let cancelled = false;
    const fetchCount = (): void => {
      void sendRequest({ type: "muze/browsers/list" }).then((response) => {
        if (!cancelled && response.ok && response.browsers) setBrowserCount(response.browsers.browsers.length);
      });
    };
    fetchCount();
    const listener = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") fetchCount();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

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
    setRoute({ tab: next, detail: null });
  };

  const openAccountDetail = (detail: AccountDetail | null): void => {
    setRoute({ tab: "account", detail });
  };

  const goBack = (): void => {
    setRoute((current) => ({ tab: current.tab, detail: null }));
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
  // Detail headers follow the reference: task detail keeps the Tasks
  // title, Me sub-screens keep their own title with "Me" beneath.
  const title = route.detail ? (detailTitle ?? TAB_TITLES[tab]) : TAB_TITLES[tab];
  const subtitle = route.detail
    ? tab === "account"
      ? "Me"
      : TAB_SUBTITLES[tab]
    : TAB_SUBTITLES[tab];

  return (
    <div class="app-shell" data-tab={tab}>
      <AppBar
        title={title}
        subtitle={subtitle}
        icon={TABS.find((entry) => entry.id === tab)?.icon}
        connected={snapshot.bridgeStatus === "connected"}
        paused={snapshot.killSwitch}
        browserCount={browserCount}
        onPlan={() => setRoute({ tab: "account", detail: "plan" })}
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
              onNavigate={goToTab}
              onRespond={respond}
            />
          ) : null}

          {tab === "connections" ? (
            <ConnectionsPage state={state} busy={busy} segment={connectionsSegment} onSegment={setConnectionsSegment} onNavigate={goToTab} />
          ) : null}

          {tab === "files" ? <FilesPage /> : null}

          {tab === "tasks" ? (
            <TasksPage
              busy={busy}
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
              onKillSwitch={(engaged) => run({ type: "muze/killswitch", engaged }, engaged ? "All activity stopped" : "Activity resumed")}
              onGroupToggle={(group, enabled) =>
                run({ type: "muze/policy/group", group, enabled }, `${groupLabel(group)} ${enabled ? "on" : "off"}`)
              }
              onReset={() => run({ type: "muze/policy/reset" }, "Permissions reset")}
              onSignOut={() => run({ type: "muze/gateway/sign-out" }, "Signed out")}
              onDeleteAccount={() => run({ type: "muze/gateway/delete-account" }, "Account deleted")}
              detail={route.detail as AccountDetail | null}
              onOpen={openAccountDetail}
            />
          ) : null}
        </div>
      </main>

      <BottomNav active={tab} onChange={goToTab} />
    </div>
  );
}
