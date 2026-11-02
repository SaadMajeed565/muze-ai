import type { BrowsersDelta } from "../libs/tool-contracts/protocol.js";
import type { BrowsersDashboard, DashboardBrowser } from "./messages.js";

/**
 * Browsers dashboard cache (extension side of the browsers data-flow
 * change). The service worker serves `muze/browsers/list` from this cache
 * only; a live gateway fetch happens only via `refreshBrowsersCache`
 * (dashboard refresh request, socket reconnect, or a post-mutation
 * re-fetch in the service worker) or via gateway-pushed `browsers.delta`
 * frames applied with `applyDeltaToCache`. The dashboard event
 * `browsers.changed` carries NO delta payload — pages re-request the
 * cache-only list when they hear it.
 *
 * `applyBrowsersDelta` is pure: it never mutates `current` and never
 * touches `currentSessionId`. Delta browser rows carry no tab count and
 * no local flag, so upserting an existing row preserves its `tabCount`
 * and `isLocal`; a brand-new row starts with `tabCount: null` and
 * `isLocal: false` until the next full refresh corrects them.
 */

export const BROWSERS_CACHE_KEY = "muze.browsersCache";

export interface BrowsersCacheEntry {
  dashboard: BrowsersDashboard;
  fetchedAt: number;
}

/** True when the most recent full refresh attempt failed. */
let lastRefreshFailed = false;

export function isLastRefreshFailed(): boolean {
  return lastRefreshFailed;
}

/** Alias for `isLastRefreshFailed`, for callers that read it as a getter. */
export function getLastRefreshFailed(): boolean {
  return lastRefreshFailed;
}

export function setLastRefreshFailed(failed: boolean): void {
  lastRefreshFailed = failed;
}

export function applyBrowsersDelta(current: BrowsersDashboard, delta: BrowsersDelta): BrowsersDashboard {
  switch (delta.type) {
    case "browser.upsert": {
      const incoming = delta.browser;
      const existing = current.browsers.find((browser) => browser.sessionId === incoming.sessionId);
      const row: DashboardBrowser = existing
        ? { ...existing, ...incoming, tabCount: existing.tabCount, isLocal: existing.isLocal }
        : { ...incoming, tabCount: null, isLocal: false };
      return {
        ...current,
        browsers: existing
          ? current.browsers.map((browser) => (browser.sessionId === incoming.sessionId ? row : browser))
          : [...current.browsers, row],
      };
    }
    case "browser.removed":
      return { ...current, browsers: current.browsers.filter((browser) => browser.sessionId !== delta.sessionId) };
    case "default.changed":
      return {
        ...current,
        defaultSessionId: delta.defaultSessionId,
        browsers: current.browsers.map((browser) => ({ ...browser, isDefault: browser.sessionId === delta.defaultSessionId })),
      };
    case "client.upsert": {
      const incoming = delta.client;
      const existing = current.mcpClients.some(
        (client) => client.clientId === incoming.clientId && client.sessionId === incoming.sessionId,
      );
      return {
        ...current,
        mcpClients: existing
          ? current.mcpClients.map((client) =>
              client.clientId === incoming.clientId && client.sessionId === incoming.sessionId ? { ...incoming } : client,
            )
          : [...current.mcpClients, { ...incoming }],
      };
    }
    case "client.revoked":
      return {
        ...current,
        mcpClients: current.mcpClients.filter(
          (client) => client.clientId !== delta.clientId || (delta.sessionId !== undefined && client.sessionId !== delta.sessionId),
        ),
      };
  }
}

function isCacheEntry(value: unknown): value is BrowsersCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { dashboard?: unknown; fetchedAt?: unknown };
  if (typeof entry.fetchedAt !== "number") return false;
  if (typeof entry.dashboard !== "object" || entry.dashboard === null) return false;
  const dashboard = entry.dashboard as { browsers?: unknown; mcpClients?: unknown; defaultSessionId?: unknown };
  return (
    Array.isArray(dashboard.browsers) && Array.isArray(dashboard.mcpClients) && typeof dashboard.defaultSessionId === "string"
  );
}

export async function readBrowsersCache(): Promise<BrowsersCacheEntry | null> {
  const stored = await chrome.storage.local.get(BROWSERS_CACHE_KEY);
  const value = stored[BROWSERS_CACHE_KEY];
  return isCacheEntry(value) ? value : null;
}

export async function writeBrowsersCache(dashboard: BrowsersDashboard): Promise<BrowsersCacheEntry> {
  const entry: BrowsersCacheEntry = { dashboard, fetchedAt: Date.now() };
  await chrome.storage.local.set({ [BROWSERS_CACHE_KEY]: entry });
  return entry;
}

/**
 * Apply one gateway-pushed delta to the cached dashboard. When there is
 * no cache yet there is nothing to apply the delta to, and synthesising
 * a partial dashboard from a single delta would misrepresent it as a
 * complete snapshot — so the delta is dropped (returns null, writes
 * nothing). The next refresh (dashboard mount, or socket reconnect)
 * fetches the full snapshot instead.
 */
export async function applyDeltaToCache(delta: BrowsersDelta): Promise<BrowsersDashboard | null> {
  const cached = await readBrowsersCache();
  if (!cached) return null;
  const updated = applyBrowsersDelta(cached.dashboard, delta);
  await writeBrowsersCache(updated);
  return updated;
}

let inFlight: Promise<BrowsersDashboard> | null = null;

/**
 * Fetch a fresh dashboard through `load`, write it to the cache, clear
 * the failure flag and call `onChanged` — exactly once per fetch, even
 * when several callers ask at the same time: concurrent callers share
 * the one in-flight fetch. On failure the flag is set and the error is
 * rethrown (the previous cache, if any, is left untouched).
 */
export async function refreshBrowsersCache(
  load: () => Promise<BrowsersDashboard>,
  onChanged: () => void,
): Promise<BrowsersDashboard> {
  if (inFlight) return inFlight;
  const pending = (async (): Promise<BrowsersDashboard> => {
    try {
      const dashboard = await load();
      await writeBrowsersCache(dashboard);
      lastRefreshFailed = false;
      onChanged();
      return dashboard;
    } catch (error) {
      lastRefreshFailed = true;
      throw error;
    }
  })();
  inFlight = pending;
  try {
    return await pending;
  } finally {
    if (inFlight === pending) inFlight = null;
  }
}
