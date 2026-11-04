/**
 * Persisted live-activity feed, owned by the service worker.
 *
 * The Home feed used to live only in component state, so navigating to
 * another dashboard page and back cleared it. The service worker now
 * owns one stored list in chrome.storage.local under
 * `muze.activityFeed` (see ACTIVITY_FEED_STORAGE_KEY): every activity
 * event is appended/resolved here (capped to ACTIVITY_FEED_CAP) and the
 * dashboard seeds from it on mount, then continues live-appending.
 *
 * Design, chosen deliberately:
 * - Load-once + write-through, never wipe on startup: the stored list
 *   is read lazily on first use, never cleared when the worker starts,
 *   and every record writes its result back. A worker restart just
 *   re-reads the stored list.
 * - Serialized updates: records chain on one promise, so concurrent
 *   events apply in order and no read-modify-write race can drop a row.
 * - Best-effort: a storage failure never throws out of record() and
 *   never fails a tool call — the live forward is unaffected, and the
 *   in-memory chain keeps advancing.
 * - Single owner: only the service worker reads/writes this key; the
 *   dashboard reads it through the `muze/activity.list` route only.
 * - Single feed, no per-browser split: activity events carry no browser
 *   attribution, and each browser profile has its own extension storage,
 *   so one stored list per profile already is that browser's feed. No
 *   new multi-browser plumbing was invented for this.
 *
 * Rows are validated on read: a corrupt or foreign stored value is
 * treated as empty (and replaced by the next write) rather than
 * crashing the worker or rendering junk.
 */

import { ACTIVITY_FEED_CAP, applyActivityEvent, type ActivityEvent, type ActivityRow } from "./activity.js";

/** chrome.storage.local key for the persisted feed. Single owner: the service worker. */
export const ACTIVITY_FEED_STORAGE_KEY = "muze.activityFeed";

export interface ActivityStoreBackend {
  read(): Promise<ActivityRow[] | null>;
  write(rows: ActivityRow[]): Promise<void>;
}

export interface ActivityStore {
  /** Append/resolve one event, persist the result. Never throws. */
  record(event: ActivityEvent): Promise<ActivityRow[]>;
  /** Current stored feed (loads from storage on first use). */
  list(): Promise<ActivityRow[]>;
}

function isActivityRow(value: unknown): value is ActivityRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { id?: unknown; tool?: unknown; summary?: unknown; state?: unknown; at?: unknown };
  return (
    typeof row.id === "string" &&
    typeof row.tool === "string" &&
    typeof row.summary === "string" &&
    (row.state === "running" || row.state === "done" || row.state === "failed") &&
    typeof row.at === "number"
  );
}

function isActivityRowArray(value: unknown): value is ActivityRow[] {
  return Array.isArray(value) && value.every(isActivityRow);
}

export function createActivityStore(backend: ActivityStoreBackend, cap: number = ACTIVITY_FEED_CAP): ActivityStore {
  let last: ActivityRow[] = [];
  // Lazy load: nothing touches storage at import/worker-startup time.
  // A failed read starts empty in memory; the next write then replaces
  // storage (documented, not silent — a transient read failure cannot
  // be distinguished from genuinely empty storage here).
  let chain: Promise<ActivityRow[]> | null = null;
  const load = (): Promise<ActivityRow[]> => {
    if (!chain) {
      chain = backend
        .read()
        .then((rows) => {
          last = rows ? rows.slice(-cap) : [];
          return last;
        })
        .catch(() => last);
    }
    return chain;
  };

  const record = (event: ActivityEvent): Promise<ActivityRow[]> => {
    const run = load().then(async (rows) => {
      const updated = applyActivityEvent(rows, event, cap);
      try {
        await backend.write(updated);
      } catch {
        // Best-effort: the live feed must never fail for storage.
      }
      last = updated;
      return updated;
    });
    // Serialize: the next record waits for this one, so no update is lost.
    // On the (unreachable-in-practice) failure path, keep the last known
    // rows rather than resetting to empty.
    chain = run.catch(() => last);
    return run.catch(() => last);
  };

  return {
    record,
    list: () => load(),
  };
}

/**
 * chrome.storage.local backend. Safe to construct anywhere: it touches
 * `chrome` only when read/write are actually called, so importing the
 * service worker in a test without a chrome global never throws here.
 */
export function chromeLocalActivityBackend(): ActivityStoreBackend {
  const local = (): typeof chrome.storage.local | undefined => {
    if (typeof chrome === "undefined") return undefined;
    return chrome.storage?.local;
  };
  return {
    read: async (): Promise<ActivityRow[] | null> => {
      const store = local();
      if (!store) return null;
      const stored = await store.get(ACTIVITY_FEED_STORAGE_KEY);
      const value = (stored as Record<string, unknown> | null)?.[ACTIVITY_FEED_STORAGE_KEY];
      return isActivityRowArray(value) ? value : null;
    },
    write: async (rows: ActivityRow[]): Promise<void> => {
      const store = local();
      if (!store) return;
      await store.set({ [ACTIVITY_FEED_STORAGE_KEY]: rows });
    },
  };
}
