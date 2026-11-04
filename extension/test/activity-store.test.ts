/**
 * Persisted activity store: the service worker owns one stored feed
 * (chrome.storage.local, key "muze.activityFeed") so the Home timeline
 * survives page navigation and worker restarts. Tests use an in-memory
 * fake backend; a fresh store over the same backend simulates a worker
 * restart (test 6 in the parent brief).
 */
import { describe, expect, it } from "vitest";
import { ACTIVITY_FEED_CAP, type ActivityRow } from "../libs/activity.js";
import {
  ACTIVITY_FEED_STORAGE_KEY,
  createActivityStore,
  type ActivityStoreBackend,
} from "../libs/activity-store.js";
import type { ActivityEvent } from "../libs/activity.js";

function memoryBackend(initial?: unknown): { backend: ActivityStoreBackend; raw: () => unknown } {
  let stored: unknown = initial;
  return {
    backend: {
      read: async () => (Array.isArray(stored) ? (stored as ActivityRow[]) : null),
      write: async (rows) => {
        stored = [...rows];
      },
    },
    raw: () => stored,
  };
}

function event(id: string, state: ActivityEvent["state"], at: number): ActivityEvent {
  return { kind: "activity", id, tool: "dom.click", summary: "Clicked", state, at };
}

describe("activity store", () => {
  it("uses the muze.activityFeed storage key", () => {
    expect(ACTIVITY_FEED_STORAGE_KEY).toBe("muze.activityFeed");
  });

  it("records rows and resolves a running row by id without duplicating", async () => {
    const { backend } = memoryBackend();
    const store = createActivityStore(backend);
    await store.record(event("act_1", "running", 1));
    await store.record(event("act_2", "running", 2));
    await store.record(event("act_1", "done", 3));
    const rows = await store.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "act_1", state: "done" });
    expect(rows[1]).toMatchObject({ id: "act_2", state: "running" });
  });

  it("trims to exactly 25 rows, oldest dropped", async () => {
    const { backend } = memoryBackend();
    const store = createActivityStore(backend);
    for (let i = 0; i < 30; i++) {
      await store.record(event(`act_${i}`, "done", i));
    }
    const rows = await store.list();
    expect(rows).toHaveLength(25);
    expect(rows[0].id).toBe("act_5");
    expect(rows[24].id).toBe("act_29");
    expect(ACTIVITY_FEED_CAP).toBe(25);
  });

  it("a fresh store over the same backend reads the stored list (simulated worker restart)", async () => {
    const { backend } = memoryBackend();
    const first = createActivityStore(backend);
    await first.record(event("act_1", "done", 1));
    await first.record(event("act_2", "failed", 2));
    // Simulate the worker restarting: new store instance, same storage.
    const restarted = createActivityStore(backend);
    const rows = await restarted.list();
    expect(rows.map((r) => r.id)).toEqual(["act_1", "act_2"]);
    expect(rows[1].state).toBe("failed");
    // And the restarted store keeps appending onto the stored list.
    await restarted.record(event("act_3", "done", 3));
    expect((await restarted.list()).map((r) => r.id)).toEqual(["act_1", "act_2", "act_3"]);
  });

  it("starts empty (never wipes) when storage holds nothing", async () => {
    const { backend } = memoryBackend();
    const store = createActivityStore(backend);
    expect(await store.list()).toEqual([]);
  });

  it("treats a corrupt stored value as empty instead of throwing", async () => {
    const { backend } = memoryBackend({ nope: "not a feed" });
    const store = createActivityStore(backend);
    expect(await store.list()).toEqual([]);
  });

  it("serializes concurrent records so none is lost", async () => {
    const { backend } = memoryBackend();
    const store = createActivityStore(backend);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.record(event(`act_${i}`, "done", i))));
    const rows = await store.list();
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `act_${i}`));
  });

  it("a failing backend write never rejects record()", async () => {
    const backend: ActivityStoreBackend = {
      read: async () => null,
      write: async () => {
        throw new Error("storage unavailable");
      },
    };
    const store = createActivityStore(backend);
    await expect(store.record(event("act_1", "done", 1))).resolves.toHaveLength(1);
    expect((await store.list()).map((r) => r.id)).toEqual(["act_1"]);
  });
});
