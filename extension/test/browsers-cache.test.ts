import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowsersDelta } from "../libs/tool-contracts/protocol.js";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../src/messages.js";
import {
  BROWSERS_CACHE_KEY,
  applyBrowsersDelta,
  applyDeltaToCache,
  getLastRefreshFailed,
  isLastRefreshFailed,
  readBrowsersCache,
  refreshBrowsersCache,
  setLastRefreshFailed,
  writeBrowsersCache,
} from "../src/browsers-cache.js";

const browser = (overrides: Partial<DashboardBrowser>): DashboardBrowser => ({
  sessionId: "browser-a",
  name: "Browser A",
  browser: "Chrome",
  os: "Windows",
  version: "141.0",
  createdAt: 1000,
  lastSeenAt: 2000,
  isDefault: true,
  connected: true,
  tabCount: 3,
  isLocal: true,
  ...overrides,
});

const client = (overrides: Partial<DashboardMcpClient>): DashboardMcpClient => ({
  clientId: "oc_1",
  clientName: "ChatGPT",
  scope: "read:tools call:tools",
  sessionId: "browser-a",
  live: true,
  connectedSince: 1500,
  lastActivityAt: 1800,
  authorizedSince: 1200,
  lastRefreshedAt: 1700,
  expiresAt: 9999,
  ...overrides,
});

const base: BrowsersDashboard = {
  browsers: [
    browser({}),
    browser({ sessionId: "browser-b", name: "Browser B", isDefault: false, connected: false, tabCount: null, isLocal: false }),
  ],
  defaultSessionId: "browser-a",
  currentSessionId: "browser-a",
  mcpClients: [
    client({}),
    client({ clientId: "oc_2", clientName: "Claude", sessionId: "browser-b", live: false, connectedSince: null, lastActivityAt: null }),
  ],
};

describe("applyBrowsersDelta", () => {
  it("upserts a new browser with unknown tab count and non-local flag", () => {
    const updated = applyBrowsersDelta(base, {
      type: "browser.upsert",
      browser: {
        sessionId: "browser-c", name: "Browser C", browser: "Edge", os: "macOS", version: "140.0",
        createdAt: 3000, lastSeenAt: 3100, isDefault: false, connected: true,
      },
    });
    expect(updated.browsers).toHaveLength(3);
    expect(updated.browsers[2]).toMatchObject({ sessionId: "browser-c", name: "Browser C", tabCount: null, isLocal: false });
    expect(updated.currentSessionId).toBe("browser-a");
    // Pure: the input dashboard is untouched.
    expect(base.browsers).toHaveLength(2);
  });

  it("upserting an existing browser preserves tabCount/isLocal and updates the rest", () => {
    const updated = applyBrowsersDelta(base, {
      type: "browser.upsert",
      browser: {
        sessionId: "browser-a", name: "Renamed A", browser: "Chrome", os: "Windows", version: "142.0",
        createdAt: 1000, lastSeenAt: 9999, isDefault: true, connected: false,
      },
    });
    expect(updated.browsers).toHaveLength(2);
    expect(updated.browsers[0]).toMatchObject({
      sessionId: "browser-a", name: "Renamed A", version: "142.0", lastSeenAt: 9999, connected: false,
      tabCount: 3, isLocal: true,
    });
    expect(updated.currentSessionId).toBe("browser-a");
  });

  it("removes only the matching browser row", () => {
    const updated = applyBrowsersDelta(base, { type: "browser.removed", sessionId: "browser-b" });
    expect(updated.browsers.map((row) => row.sessionId)).toEqual(["browser-a"]);
    // Clients are untouched by a browser removal; client.revoked is separate.
    expect(updated.mcpClients).toHaveLength(2);
    expect(updated.currentSessionId).toBe("browser-a");
  });

  it("default.changed sets the default and recomputes every row's isDefault", () => {
    const updated = applyBrowsersDelta(base, { type: "default.changed", defaultSessionId: "browser-b" });
    expect(updated.defaultSessionId).toBe("browser-b");
    expect(updated.browsers.map((row) => row.isDefault)).toEqual([false, true]);
    expect(updated.currentSessionId).toBe("browser-a");
  });

  it("client upsert matches on clientId + sessionId, so the same app on two browsers stays distinct", () => {
    const sameAppOtherBrowser = applyBrowsersDelta(base, {
      type: "client.upsert",
      client: client({ clientId: "oc_1", sessionId: "browser-b", live: false, connectedSince: null }),
    });
    expect(sameAppOtherBrowser.mcpClients).toHaveLength(3);

    const updated = applyBrowsersDelta(base, {
      type: "client.upsert",
      client: client({ live: false, lastActivityAt: 5555 }),
    });
    expect(updated.mcpClients).toHaveLength(2);
    expect(updated.mcpClients[0]).toMatchObject({ clientId: "oc_1", sessionId: "browser-a", live: false, lastActivityAt: 5555 });
    expect(updated.currentSessionId).toBe("browser-a");
  });

  it("client.revoked drops one session when sessionId is given, all sessions when it is not", () => {
    const withTwoSessions: BrowsersDashboard = {
      ...base,
      mcpClients: [client({}), client({ sessionId: "browser-b" })],
    };
    const one = applyBrowsersDelta(withTwoSessions, { type: "client.revoked", clientId: "oc_1", sessionId: "browser-b" });
    expect(one.mcpClients.map((row) => row.sessionId)).toEqual(["browser-a"]);
    const all = applyBrowsersDelta(withTwoSessions, { type: "client.revoked", clientId: "oc_1" });
    expect(all.mcpClients).toHaveLength(0);
    expect(all.currentSessionId).toBe("browser-a");
  });

  it("applying the same delta twice is a no-op the second time", () => {
    const deltas: BrowsersDelta[] = [
      {
        type: "browser.upsert",
        browser: {
          sessionId: "browser-a", name: "Renamed A", browser: "Chrome", os: "Windows", version: "142.0",
          createdAt: 1000, lastSeenAt: 9999, isDefault: true, connected: false,
        },
      },
      { type: "browser.removed", sessionId: "browser-b" },
      { type: "default.changed", defaultSessionId: "browser-b" },
      { type: "client.upsert", client: client({ live: false }) },
      { type: "client.revoked", clientId: "oc_2", sessionId: "browser-b" },
    ];
    for (const delta of deltas) {
      const once = applyBrowsersDelta(base, delta);
      const twice = applyBrowsersDelta(once, delta);
      expect(twice).toEqual(once);
    }
  });

  it("never touches currentSessionId, for any delta kind", () => {
    const deltas: BrowsersDelta[] = [
      { type: "browser.upsert", browser: { sessionId: "browser-c", name: "C", browser: "", os: "", version: "", createdAt: null, lastSeenAt: null, isDefault: false, connected: true } },
      { type: "browser.removed", sessionId: "browser-a" },
      { type: "default.changed", defaultSessionId: "browser-b" },
      { type: "client.upsert", client: client({ clientId: "oc_9" }) },
      { type: "client.revoked", clientId: "oc_1" },
    ];
    for (const delta of deltas) {
      expect(applyBrowsersDelta(base, delta).currentSessionId).toBe("browser-a");
    }
  });
});

describe("browsers cache storage + refresh manager (chrome mocks, storage.test.ts pattern)", () => {
  type Store = Record<string, unknown>;
  let store: Store;

  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
          set: async (items: Store) => Object.assign(store, items),
          remove: async (keys: string[]) => {
            for (const key of keys) delete store[key];
          },
        },
      },
    });
    setLastRefreshFailed(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads null when empty and round-trips a written dashboard with a timestamp", async () => {
    expect(await readBrowsersCache()).toBeNull();
    const entry = await writeBrowsersCache(base);
    expect(typeof entry.fetchedAt).toBe("number");
    expect(store[BROWSERS_CACHE_KEY]).toEqual(entry);
    expect(await readBrowsersCache()).toEqual(entry);
  });

  it("ignores a malformed stored value instead of serving it", async () => {
    store[BROWSERS_CACHE_KEY] = { dashboard: { browsers: "not-an-array" }, fetchedAt: 1 };
    expect(await readBrowsersCache()).toBeNull();
  });

  it("applyDeltaToCache persists the delta and preserves tabCount/isLocal", async () => {
    await writeBrowsersCache(base);
    const updated = await applyDeltaToCache({
      type: "browser.upsert",
      browser: {
        sessionId: "browser-a", name: "Renamed A", browser: "Chrome", os: "Windows", version: "142.0",
        createdAt: 1000, lastSeenAt: 9999, isDefault: true, connected: true,
      },
    });
    expect(updated?.browsers[0]).toMatchObject({ name: "Renamed A", tabCount: 3, isLocal: true });
    expect((await readBrowsersCache())?.dashboard).toEqual(updated);
  });

  it("applyDeltaToCache drops the delta (no write) when there is no cache yet", async () => {
    const updated = await applyDeltaToCache({ type: "browser.removed", sessionId: "browser-a" });
    expect(updated).toBeNull();
    expect(store[BROWSERS_CACHE_KEY]).toBeUndefined();
  });

  it("refresh writes the cache, clears the failure flag and notifies once on success", async () => {
    setLastRefreshFailed(true);
    const onChanged = vi.fn();
    const dashboard = await refreshBrowsersCache(async () => base, onChanged);
    expect(dashboard).toEqual(base);
    expect((await readBrowsersCache())?.dashboard).toEqual(base);
    expect(isLastRefreshFailed()).toBe(false);
    expect(getLastRefreshFailed()).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("concurrent refresh callers share one fetch and one notification", async () => {
    let release!: (value: BrowsersDashboard) => void;
    const gated = new Promise<BrowsersDashboard>((resolve) => {
      release = resolve;
    });
    let loadCalls = 0;
    const onChanged = vi.fn();
    const first = refreshBrowsersCache(async () => {
      loadCalls += 1;
      return gated;
    }, onChanged);
    const second = refreshBrowsersCache(async () => {
      loadCalls += 1;
      return base;
    }, onChanged);
    expect(loadCalls).toBe(1);
    release(base);
    await expect(first).resolves.toEqual(base);
    await expect(second).resolves.toEqual(base);
    expect(loadCalls).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect((await readBrowsersCache())?.dashboard).toEqual(base);
  });

  it("refresh failure sets the flag, rethrows, and leaves the previous cache untouched", async () => {
    await writeBrowsersCache(base);
    const onChanged = vi.fn();
    await expect(refreshBrowsersCache(async () => {
      throw new Error("gateway-unreachable");
    }, onChanged)).rejects.toThrow("gateway-unreachable");
    expect(isLastRefreshFailed()).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect((await readBrowsersCache())?.dashboard).toEqual(base);
  });
});
