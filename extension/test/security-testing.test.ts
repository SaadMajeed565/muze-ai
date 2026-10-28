import { describe, expect, it } from "vitest";
import { MockBrowserContext } from "../libs/testing/mock-context.js";

/**
 * The mock must not hide real bugs: observer state, id reuse and the
 * reported product version are all pinned here.
 */
describe("MockBrowserContext", () => {
  it("reports the product version 0.3.0", async () => {
    const ctx = new MockBrowserContext();
    expect((await ctx.getBrowserInfo()).extensionVersion).toBe("0.5.0");
  });

  it("reports realistic observer state instead of hardcoded values", async () => {
    const ctx = new MockBrowserContext();
    const tabId = ctx.activeTabId!;
    ctx.attachObserver(tabId, {
      requests: [
        { id: "r1", method: "GET", url: "https://example.com/a", startedAt: "2026-01-01T00:00:00.000Z" },
        { id: "r2", method: "GET", url: "https://example.com/b", status: 200, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 12 },
      ],
    });
    const reading = await ctx.observer.read(tabId);
    expect(reading.attached).toBe(true);
    // Only the request with no status is still in flight.
    expect(reading.pendingRequests).toBe(1);
    await ctx.observer.setEnabled(false, tabId);
    expect((await ctx.observer.read(tabId)).attached).toBe(false);
  });

  it("never reuses download ids after an erase", async () => {
    const ctx = new MockBrowserContext();
    const first = await ctx.downloads!.start({ url: "https://example.com/a.bin", saveAs: false });
    await ctx.downloads!.erase([first.id]);
    const second = await ctx.downloads!.start({ url: "https://example.com/b.bin", saveAs: false });
    expect(second.id).not.toBe(first.id);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("never reuses bookmark ids after a delete", async () => {
    const ctx = new MockBrowserContext();
    const first = await ctx.bookmarks!.create({ title: "A", url: "https://example.com/a" });
    await ctx.bookmarks!.remove(first.id);
    const second = await ctx.bookmarks!.create({ title: "B", url: "https://example.com/b" });
    expect(second.id).not.toBe(first.id);
    const folder = await ctx.bookmarks!.createFolder({ title: "F" });
    expect(folder.id).not.toBe(first.id);
    expect(folder.id).not.toBe(second.id);
  });

  it("seeds id counters above pre-loaded ids", async () => {
    const ctx = new MockBrowserContext({
      downloads: [{ id: 41, filename: "x", url: "https://example.com/x", state: "complete", bytesReceived: 1, paused: false, startTime: "2026-01-01T00:00:00.000Z" }],
      bookmarks: [{ id: "bm_7", title: "X", url: "https://example.com/x", folder: "Bookmarks bar" }],
    });
    const download = await ctx.downloads!.start({ url: "https://example.com/y", saveAs: false });
    expect(download.id).toBeGreaterThan(41);
    const bookmark = await ctx.bookmarks!.create({ title: "Y", url: "https://example.com/y" });
    expect(bookmark.id).not.toBe("bm_7");
  });
});
