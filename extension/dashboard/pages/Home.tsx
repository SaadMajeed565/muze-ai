import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { sanitizeTaskView, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import type { TabId } from "../logic.js";
import { sendRequest } from "../logic.js";
import { dedupeAppsByName, plainStep, plainStepState, resolveAppName, timelineIconForStep } from "../ui-logic.js";
import { currentBrowser, tabCountText } from "../browsers-logic.js";
import { Icon } from "../components/Icon.js";
import { BrandIcon } from "../components/brand-icons.js";
import { Button } from "../components/primitives.js";
import { SectionSkeleton } from "../components/layout.js";
import { BrowserRowsList } from "../components/browser-rows.js";
import { AddAppSheet, ApprovalCard } from "../components/shared.js";

export interface HomePageProps {
  state: DashboardState;
  busy: boolean;
  approvals: ApprovalRequestInfo[];
  onNavigate: (tab: TabId) => void;
  onRespond: (approvalId: string, approved: boolean) => void;
}

const TASKS_POLL_MS = 5000;
const TIP_KEY = "muze-tip-dismissed";

/**
 * Home in the reference order: tip, browser card (running task
 * timeline, nothing else), approval cards, Browsers section, then the
 * apps section — attach-app empty state when no AI app is connected.
 * The browser card is a native disclosure, collapsed by default; its
 * title is the running task's intent, falling back to the browser name.
 */
export function HomePage({
  state,
  busy,
  approvals,
  onNavigate,
  onRespond,
}: HomePageProps): preact.JSX.Element {
  const { snapshot, gateway } = state;
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  const [tasks, setTasks] = useState<TaskView[] | null>(null);
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDetailsElement | null>(null);
  const [tipDismissed, setTipDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(TIP_KEY) === "1";
    } catch {
      return false;
    }
  });

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
    let timer = 0;
    const poll = (): void => {
      if (document.visibilityState === "visible") void loadTasks();
    };
    const restart = (): void => {
      clearInterval(timer);
      timer = window.setInterval(poll, TASKS_POLL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void loadTasks();
        restart();
      } else {
        clearInterval(timer);
      }
    };
    restart();
    document.addEventListener("visibilitychange", onVisibility);
    const listener = (message: { type?: string }): void => {
      if (message?.type === "muze/event" || message?.type === "uabb/event") void loadTasks();
    };
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
    if (onMessage?.addListener) onMessage.addListener(listener);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (onMessage?.removeListener) onMessage.removeListener(listener);
    };
  }, [loadTasks]);

  // Card tile favicon: the active tab's favIconUrl (the "tabs"
  // permission makes chrome.tabs reachable from this dashboard page).
  // Task steps carry no site, so the reference's per-step-site rule
  // (collapsed = latest step's site, expanded = second visible step)
  // cannot be honoured from real data — the tile follows the tab being
  // worked on instead.
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
    let cancelled = false;
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (!cancelled) setFavicon(tabs[0]?.favIconUrl ?? null);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tasks]);

  const thisBrowser = browsersData ? currentBrowser(browsersData) : null;
  const browserConnected = snapshot.bridgeStatus === "connected";
  const statusWord = browserConnected ? "Online" : "Offline";
  const tabCount = browserConnected && thisBrowser ? tabCountText(thisBrowser) : null;

  // One browser runs one task at a time; the running task is the one
  // the card surfaces. "created" counts as running until it starts.
  const runningTask = (tasks ?? []).find((task) => task.status === "running" || task.status === "created") ?? null;
  const cardTitle = runningTask ? runningTask.goal || "Task" : thisBrowser ? thisBrowser.name : "This browser";

  const thisBrowserClients = browsersData
    ? dedupeAppsByName(browsersData.mcpClients.filter((client) => thisBrowser && client.sessionId === thisBrowser.sessionId))
    : [];

  const scrollToLatest = (smooth: boolean): void => {
    const el = timelineRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  const onTimelineScroll = (): void => {
    const el = timelineRef.current;
    if (!el) return;
    setShowLatest(el.scrollTop + el.clientHeight < el.scrollHeight - 24);
  };

  const onCardToggle = (): void => {
    if (cardRef.current?.open) {
      requestAnimationFrame(() => scrollToLatest(false));
    }
  };

  useEffect(() => {
    if (cardRef.current?.open) scrollToLatest(false);
  }, [tasks]);

  const dismissTip = (): void => {
    setTipDismissed(true);
    try {
      window.localStorage.setItem(TIP_KEY, "1");
    } catch {
      // Dismissal persistence is a nicety, never a failure.
    }
  };

  return (
    <div class="ui-page">
      {!tipDismissed ? (
        <div class="tipbox">
          <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
            <Icon name="bulb" size={14} />
            <p class="muted" style={{ margin: 0, fontSize: "12px", flex: 1 }}>
              Ask your AI app to do something in this browser — its steps will appear in Tasks as a timeline you can follow.
            </p>
            <button type="button" onClick={dismissTip} aria-label="Dismiss tip" style={{ flex: "none", width: "24px", height: "24px", border: "none", background: "none", display: "grid", placeItems: "center", color: "inherit", opacity: 0.7, cursor: "pointer" }}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <details class="card browser-card" ref={cardRef} onToggle={onCardToggle}>
        <summary class="flex">
          <span class="tile">
            {favicon ? (
              <img class="brandimg" src={favicon} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", padding: "4px", background: "#fff", boxShadow: "inset 0 0 0 1px var(--border)" }} onError={(event) => { (event.currentTarget as HTMLImageElement).remove(); }} />
            ) : (
              <BrandIcon name={thisBrowser?.browser ?? thisBrowser?.name} />
            )}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: "15px" }}>{cardTitle}</div>
            <div>
              <span class={"status " + (browserConnected ? "ok" : "grey")}>● {statusWord}</span>{" "}
              {tabCount ? <span class="muted" style={{ fontSize: "12px" }}>{tabCount}</span> : null}
            </div>
          </div>
          <span class="chev" aria-hidden="true">
            <Icon name="chevron-right" size={18} />
          </span>
        </summary>
        <div style={{ position: "relative" }}>
          {runningTask ? (
            <div id="browserTimeline" class="tl mt12" ref={timelineRef} onScroll={onTimelineScroll}>
              {[...runningTask.steps].sort((a, b) => a.index - b.index).map((step) => {
                const plain = plainStep(step);
                const stateWord = step.state === "done" ? "" : plainStepState(step.state);
                return (
                  <div class="step" key={step.index}>
                    <span class="node">
                      <Icon name={timelineIconForStep(step.tool, step.state)} size={16} />
                    </span>
                    <div class="verb">{plain.summary}</div>
                    {stateWord ? <div class="tmeta">{stateWord}</div> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div class="muted mt12" style={{ fontSize: "13px" }}>Nothing running right now</div>
          )}
          {showLatest ? (
            <button type="button" id="toLatestBtn" onClick={() => scrollToLatest(true)}>
              ↓ Latest
            </button>
          ) : null}
        </div>
      </details>

      {approvals.length > 0 ? (
        <div>
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
      ) : null}

      <div style={{ marginTop: "16px" }}>
        <h2 class="sec">Browsers</h2>
        {!browsersData ? (
          <SectionSkeleton />
        ) : (
          <BrowserRowsList data={browsersData} withMenus={false} busy={busy} onRowSelect={() => onNavigate("connections")} />
        )}
      </div>

      <div>
        {!browsersData ? (
          <SectionSkeleton />
        ) : thisBrowserClients.length === 0 ? (
          <div style={{ padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
            <div class="flex" style={{ alignItems: "center", gap: "12px" }}>
              <span class="tile sm" style={{ background: "var(--surface2)", color: "var(--muted)" }}>
                <Icon name="plus" size={20} />
              </span>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: "14px" }}>No AI app connected yet</b>
                <div class="muted" style={{ fontSize: "12px" }}>Attach ChatGPT, Claude or Gemini so it can work in this browser.</div>
              </div>
            </div>
            <Button variant="primary" block class="mt12" onClick={() => setAddAppOpen(true)}>
              Attach an AI app
            </Button>
          </div>
        ) : (
          <>
            <h2 class="sec">Connected AI Apps</h2>
            {thisBrowserClients.map((group) => (
              <button type="button" class="row" key={group.name} onClick={() => onNavigate("connections")}>
                <BrandIcon name={group.name} small />
                <span style={{ flex: 1 }}>
                  <span class="name">{group.name}</span>
                </span>
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <span class={"status-dot " + (group.live ? "is-on" : "")} aria-hidden="true" />
                  <span class={"status " + (group.live ? "ok" : "grey")}>{group.live ? "Connected" : "Not connected"}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      <AddAppSheet open={addAppOpen} onClose={() => setAddAppOpen(false)} mcpUrl={gateway.mcpUrl} />
    </div>
  );
}
