/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_HISTORY_MAX_ROWS,
  ACTIVITY_HISTORY_RETENTION_MS,
  ACTIVITY_HISTORY_STORAGE_KEY,
  chromeLocalActivityHistoryBackend,
  createActivityHistoryStore,
  type ActivityHistoryBackend,
} from "../libs/activity-history.js";
import type { ActivityEvent } from "../libs/activity.js";

function ev(
  id: string,
  state: "running" | "done" | "failed",
  at: number,
  tool = "dom.click",
  summary = "Clicked",
): ActivityEvent {
  return { kind: "activity", id, tool, summary, state, at };
}

function memBackend(): {
  backend: ActivityHistoryBackend;
  sets: string[];
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};
  const sets: string[] = [];
  return {
    store,
    sets,
    backend: {
      read: async () => {
        const value = store[ACTIVITY_HISTORY_STORAGE_KEY];
        return Array.isArray(value) ? (value as never[]) : null;
      },
      write: async (rows) => {
        sets.push(ACTIVITY_HISTORY_STORAGE_KEY);
        store[ACTIVITY_HISTORY_STORAGE_KEY] = rows;
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("activity history store", () => {
  // Event times must sit inside the 30-day retention window (the store
  // prunes by wall clock), so every test pins `now` near its events.
  const NOW = 1_000_000_000_000;

  it("records and resolves rows by id (running then done is one row)", async () => {
    const { backend } = memBackend();
    const store = createActivityHistoryStore(backend, { now: () => NOW });
    await store.record(ev("a1", "running", NOW));
    await store.record(ev("a1", "done", NOW + 1000));
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a1", state: "done", at: NOW + 1000 });
  });

  it("prunes rows older than 30 days when a new event lands", async () => {
    let now = 1_000_000_000_000;
    const { backend } = memBackend();
    const store = createActivityHistoryStore(backend, { now: () => now });
    await store.record(ev("old", "done", now));
    // 31 days pass with no activity, then one new action arrives.
    now += 31 * 24 * 60 * 60 * 1000;
    await store.record(ev("new", "done", now));
    const rows = await store.list();
    expect(rows.map((r) => r.id)).toEqual(["new"]);
  });

  it("also hides rows past retention on list without a new record", async () => {
    let now = 1_000_000_000_000;
    const { backend } = memBackend();
    const store = createActivityHistoryStore(backend, { now: () => now });
    await store.record(ev("old", "done", now));
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await store.list()).toHaveLength(0);
  });

  it("caps stored rows (oldest dropped first)", async () => {
    const { backend } = memBackend();
    const store = createActivityHistoryStore(backend, { cap: 3, now: () => NOW });
    for (let i = 0; i < 5; i++) await store.record(ev(`a${i}`, "done", NOW + i));
    expect((await store.list()).map((r) => r.id)).toEqual(["a2", "a3", "a4"]);
  });

  it("survives a simulated worker restart (new store over the same storage)", async () => {
    const { backend } = memBackend();
    const first = createActivityHistoryStore(backend, { now: () => NOW });
    await first.record(ev("a1", "done", NOW));
    await first.record(ev("a2", "failed", NOW + 1000));
    const second = createActivityHistoryStore(backend, { now: () => NOW });
    expect((await second.list()).map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("never throws on a storage write failure", async () => {
    const backend: ActivityHistoryBackend = {
      read: async () => null,
      write: async () => {
        throw new Error("quota");
      },
    };
    const store = createActivityHistoryStore(backend, { now: () => NOW });
    await expect(store.record(ev("a1", "done", NOW))).resolves.toBeDefined();
    expect(await store.list()).toHaveLength(1);
  });

  it("writes only its own key, never the feed key", async () => {
    const { backend, sets } = memBackend();
    const store = createActivityHistoryStore(backend, { now: () => NOW });
    await store.record(ev("a1", "done", NOW));
    expect(sets).toEqual([ACTIVITY_HISTORY_STORAGE_KEY]);
    expect(sets).not.toContain("muze.activityFeed");
  });

  it("treats a corrupt stored value as empty (chrome backend validation)", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async () => ({ [ACTIVITY_HISTORY_STORAGE_KEY]: "not-an-array" }),
          set: vi.fn(async () => undefined),
        },
      },
    });
    const store = createActivityHistoryStore(chromeLocalActivityHistoryBackend());
    expect(await store.list()).toHaveLength(0);
  });

  it("uses the documented defaults (30 days, 5000 rows)", () => {
    expect(ACTIVITY_HISTORY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(ACTIVITY_HISTORY_MAX_ROWS).toBe(5000);
  });
});
