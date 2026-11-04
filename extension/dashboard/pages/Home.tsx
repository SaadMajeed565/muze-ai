import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { sanitizeTaskView, type TaskView } from "../../src/task-dashboard.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import type { TabId } from "../logic.js";
import { sendRequest } from "../logic.js";
import { dedupeAppsByName, plainStepState, resolveAppName, timelineIconForStep } from "../ui-logic.js";
import { applyActivityEvent, type ActivityEvent, type ActivityRow } from "../../libs/activity.js";
import { currentBrowser, tabCountText } from "../browsers-logic.js";
import { FAVICON_CACHE_KEY, domainOf, prefetchFaviconForTab } from "../../src/favicon-cache.js";
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
 * Home in the reference order: tip, browser card (live activity
 * feed, nothing else), approval cards, Browsers section, then the
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
  // Live activity feed: real tool executions as they happen (direct calls
  // and task steps alike). Live-only: events arriving while the panel is
  // closed are not replayed, because activity is not persisted.
  const [activity, setActivity] = useState<ActivityRow[]>([]);
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

  // Browsers data flow: mount goes through the refresh route (instant
  // from cache, first fetch when there is none); later updates arrive
  // via `browsers.changed` events and re-read the cache-only list.
  // List failures are silently ignored — current data, if any, stays.
  // The tasks poll below is untouched.
  useEffect(() => {
    if (!gateway.signedIn) return;
    let cancelled = false;
    const loadFromCache = (): void => {
      void sendRequest({ type: "muze/browsers/list" }).then((response) => {
        if (!cancelled && response.ok && response.browsers) setBrowsersData(response.browsers);
      });
    };
    void sendRequest({ type: "muze/browsers/refresh" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsersData(response.browsers);
    });
    const listener = (message: { type?: string; event?: { kind?: string } }): void => {
      if (
        (message?.type === "muze/event" || message?.type === "uabb/event") &&
        message.event?.kind === "browsers.changed"
      ) {
        loadFromCache();
      }
    };
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
    if (onMessage?.addListener) onMessage.addListener(listener);
    return () => {
      cancelled = true;
      if (onMessage?.removeListener) onMessage.removeListener(listener);
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

  // Card tile favicon, fallback chain: prefetched per-domain cache
  // first (instant, even while the site is still loading), then the
  // active tab's favIconUrl, then the brand tile. The tab's favIconUrl
  // stays empty until the site finishes loading, so the cache is what
  // makes the tile instant; a storage listener picks up the fresh
  // entry when the background fetch lands. Task steps carry no site,
  // so the reference's per-step-site rule (collapsed = latest step's
  // site, expanded = second visible step) cannot be honoured from
  // real data — the tile follows the tab being worked on instead.
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
    let cancelled = false;
    let lastDomain: string | null = null;
    const resolve = async (): Promise<void> => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (cancelled) return;
        const tab = tabs[0];
        const domain = domainOf(tab?.url);
        lastDomain = domain;
        const src = await prefetchFaviconForTab({ url: tab?.url, favIconUrl: tab?.favIconUrl });
        if (!cancelled && domain === lastDomain) setFavicon(src);
      } catch {
        // Keep the previous tile on any tab-query failure.
      }
    };
    void resolve();
    const onActivated = (): void => {
      void resolve();
    };
    const onUpdated = (_tabId: number, _changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void => {
      if (tab?.active) void resolve();
    };
    const onStorageChanged = (changes: Record<string, { newValue?: unknown }>): void => {
      const next = changes[FAVICON_CACHE_KEY]?.newValue as Record<string, { dataUrl?: string }> | undefined;
      if (lastDomain && next && typeof next[lastDomain]?.dataUrl === "string") {
        setFavicon(next[lastDomain].dataUrl as string);
      }
    };
    chrome.tabs.onActivated?.addListener?.(onActivated);
    chrome.tabs.onUpdated?.addListener?.(onUpdated);
    chrome.storage?.onChanged?.addListener?.(onStorageChanged);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated?.removeListener?.(onActivated);
      chrome.tabs.onUpdated?.removeListener?.(onUpdated);
      chrome.storage?.onChanged?.removeListener?.(onStorageChanged);
    };
  }, []);

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

  // Live activity feed: every tool execution in this browser arrives as a
  // muze/event with kind "activity" (direct calls and task steps alike,
  // in time order). The 5s tasks poll still feeds the card header; the
  // feed itself is event-driven.
  useEffect(() => {
    const onMessage = typeof chrome === "undefined" ? undefined : chrome?.runtime?.onMessage;
    if (!onMessage?.addListener) return undefined;
    const listener = (message: { type?: string; event?: ActivityEvent }) => {
      if (message.type !== "muze/event" && message.type !== "uabb/event") return;
      if (message.event?.kind !== "activity") return;
      setActivity((rows) => applyActivityEvent(rows, message.event as ActivityEvent));
    };
    onMessage.addListener(listener);
    return () => {
      if (onMessage.removeListener) onMessage.removeListener(listener);
    };
  }, []);

  // Scroll to the latest row whenever a new activity row arrives.
  useEffect(() => {
    if (cardRef.current?.open) scrollToLatest(false);
  }, [activity]);

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
          {activity.length === 0 ? (
            <div class="muted mt12" style={{ fontSize: "13px" }}>Actions will appear here as Muze works</div>
          ) : (
            <div id="browserTimeline" class="tl mt12" ref={timelineRef} onScroll={onTimelineScroll}>
              {activity.map((row) => {
                const stateWord = row.state === "done" ? "" : plainStepState(row.state);
                return (
                  <div class="step" key={row.id}>
                    <span class="node">
                      <Icon name={timelineIconForStep(row.tool, row.state)} size={16} />
                    </span>
                    <div class="verb">{row.summary}</div>
                    {stateWord ? <div class="tmeta">{stateWord}</div> : null}
                  </div>
                );
              })}
            </div>
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
