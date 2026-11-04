/**
 * Persistent day history for the Tasks page (date-wise record).
 *
 * The Home feed keeps only the last 25 rows (ACTIVITY_FEED_CAP) — the
 * live view. The Tasks page needs more: every AI action of each day,
 * grouped by local calendar date, so direct-work days appear even
 * though they create no task record. This store is that longer record.
 * It is deliberately separate from the feed store:
 * - Different key (`muze.activityHistory`), different retention.
 * - The feed's last-25 behavior is untouched by anything here.
 * - Same ownership: only the service worker reads/writes this key;
 *   the dashboard reads it through the `muze/activity.history` route.
 *
 * What is recorded: exactly the events the feed records — AI-driven
 * tool executions only. Internal executions (flagged `internal`),
 * nested invokes, dry runs, and blocked attempts never reach the
 * service worker's onActivity sink, so they never reach this store
 * either. Summaries are tool-name-only, never inputs/outputs/URLs/
 * page content, exactly like the feed.
 *
 * Retention: rows older than 30 days (rolling, by row time) are
 * pruned on record, and the store additionally caps at 5000 rows
 * (oldest dropped) so an extreme burst cannot grow storage without
 * bound. Rows are ~120 bytes, so the cap is ~600 KB worst case.
 *
 * Same durability promises as the feed store: serialized updates,
 * lazy load (never wiped on worker start), validated reads, and
 * best-effort writes — a storage failure never throws out of record()
 * and never fails the tool call that produced the event.
 *
 * History starts when this lands: actions from before are not
 * recoverable (beyond whatever the last-25 feed still holds) and are
 * never backfilled or faked.
 */

import { applyActivityEvent, type ActivityEvent, type ActivityRow } from "./activity.js";
import { isActivityRowArray } from "./activity-store.js";

/** chrome.storage.local key for the day history. Single owner: the service worker. */
export const ACTIVITY_HISTORY_STORAGE_KEY = "muze.activityHistory";

/** Rolling retention window for history rows. */
export const ACTIVITY_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard cap on stored history rows (oldest dropped first). */
export const ACTIVITY_HISTORY_MAX_ROWS = 5000;

export interface ActivityHistoryBackend {
  read(): Promise<ActivityRow[] | null>;
  write(rows: ActivityRow[]): Promise<void>;
}

export interface ActivityHistoryStore {
  /** Append/resolve one event, prune, persist. Never throws. */
  record(event: ActivityEvent): Promise<ActivityRow[]>;
  /** Current stored history (loads from storage on first use). */
  list(): Promise<ActivityRow[]>;
}

export interface ActivityHistoryStoreOptions {
  cap?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export function createActivityHistoryStore(
  backend: ActivityHistoryBackend,
  options: ActivityHistoryStoreOptions = {},
): ActivityHistoryStore {
  const cap = options.cap ?? ACTIVITY_HISTORY_MAX_ROWS;
  const maxAgeMs = options.maxAgeMs ?? ACTIVITY_HISTORY_RETENTION_MS;
  const now = options.now ?? Date.now;
  let last: ActivityRow[] = [];
  // Lazy load: nothing touches storage at import/worker-startup time.
  // A failed read starts empty in memory; the next write then replaces
  // storage (a transient read failure cannot be distinguished from
  // genuinely empty storage here).
  let chain: Promise<ActivityRow[]> | null = null;

  const prune = (rows: ActivityRow[], at: number): ActivityRow[] => {
    const cutoff = at - maxAgeMs;
    return rows.filter((row) => row.at >= cutoff);
  };

  const load = (): Promise<ActivityRow[]> => {
    if (!chain) {
      chain = backend
        .read()
        .then((rows) => {
          last = prune(rows ? rows.slice(-cap) : [], now());
          return last;
        })
        .catch(() => last);
    }
    return chain;
  };

  const record = (event: ActivityEvent): Promise<ActivityRow[]> => {
    const run = load().then(async (rows) => {
      const updated = prune(applyActivityEvent(rows, event, cap), now());
      try {
        await backend.write(updated);
      } catch {
        // Best-effort: history must never fail a tool call.
      }
      last = updated;
      return updated;
    });
    // Serialize: the next record waits for this one, so no update is lost.
    chain = run.catch(() => last);
    return run.catch(() => last);
  };

  return {
    record,
    // Prune in memory on read too, so a list served long after the
    // last record never shows rows past retention (the next record
    // persists the pruned list).
    list: () => load().then((rows) => prune(rows, now())),
  };
}

/**
 * chrome.storage.local backend. Safe to construct anywhere: it touches
 * `chrome` only when read/write are actually called, so importing the
 * service worker in a test without a chrome global never throws here.
 */
export function chromeLocalActivityHistoryBackend(): ActivityHistoryBackend {
  const local = (): typeof chrome.storage.local | undefined => {
    if (typeof chrome === "undefined") return undefined;
    return chrome.storage?.local;
  };
  return {
    read: async (): Promise<ActivityRow[] | null> => {
      const store = local();
      if (!store) return null;
      const stored = await store.get(ACTIVITY_HISTORY_STORAGE_KEY);
      const value = (stored as Record<string, unknown> | null)?.[ACTIVITY_HISTORY_STORAGE_KEY];
      return isActivityRowArray(value) ? value : null;
    },
    write: async (rows: ActivityRow[]): Promise<void> => {
      const store = local();
      if (!store) return;
      await store.set({ [ACTIVITY_HISTORY_STORAGE_KEY]: rows });
    },
  };
}
