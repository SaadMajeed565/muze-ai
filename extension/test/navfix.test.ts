/**
 * Regression tests for the 2026-10-28 retest3 navigation / windows failures.
 * No live browser is touched: the test runtime runs against the mock context.
 *
 * Failures covered (retest3):
 *  1. navigation.open / navigation.search / tabs.navigate via unified
 *     navigate fail with INVALID_INPUT "Unrecognized key: tabId" because
 *     the navigate handler forwarded tabId into strict granular schemas
 *     that do not accept it (navigation.open/search have no tabId field).
 *  2. navigate category=window list/create/close are swallowed by the tab
 *     branch (list/create/close are tab actions too), so windows tools
 *     returned tabs instead of WindowInfo shapes.
 *  3. navigate category=tab open/reload threw "Unknown tab navigate action".
 *  4. Unified tabs reload failed live because the gateway rewrites it to
 *     navigate category=tab reload, which hit gap (3).
 */
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

function runtime() {
  return createTestRuntime({ context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
}

async function exec(rt: ReturnType<typeof runtime>, tool: string, input: Record<string, unknown>) {
  return rt.executor.execute({ tool, input, client, ctx: rt.ctx });
}

describe("navfix: tabId is never forwarded into strict navigation schemas", () => {
  it("navigate url open works with no tabId (gateway injects tabId: undefined)", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { action: "open", url: "https://b.test/" });
    expect((result.result as { tab: { url: string } }).tab.url).toBe("https://b.test/");
  });

  it("navigate url open with an explicit tabId navigates that tab (tabs.navigate semantics)", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { action: "open", url: "https://b.test/", tabId: 1 });
    const tab = (result.result as { tab: { id: number; url: string } }).tab;
    expect(tab.id).toBe(1);
    expect(tab.url).toBe("https://b.test/");
    expect(rt.ctx.tabs.size).toBe(1);
  });

  it("navigate url search works with no tabId", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", {
      action: "search", query: "example", newTab: true, waitForLoad: false, timeoutMs: 1000,
    });
    expect((result.result as { searchUrl: string }).searchUrl).toContain("example");
  });

  it("navigate url search with an explicit tabId does not fail on tabId", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", {
      action: "search", query: "example", tabId: 1, newTab: true, waitForLoad: false, timeoutMs: 1000,
    });
    expect((result.result as { searchUrl: string }).searchUrl).toContain("example");
  });

  it("granular tabs.navigate still navigates the given tab directly", async () => {
    const rt = runtime();
    const result = await exec(rt, "tabs.navigate", { tabId: 1, url: "https://c.test/" });
    const tab = (result.result as { tab: { id: number; url: string } }).tab;
    expect(tab.id).toBe(1);
    expect(tab.url).toBe("https://c.test/");
  });
});

describe("navfix: navigate window branch wins for window actions", () => {
  it("navigate window list returns windows, not tabs", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "window", action: "list" });
    const out = result.result as { windows?: unknown[]; tabs?: unknown[] };
    expect(out.tabs).toBeUndefined();
    expect(Array.isArray(out.windows)).toBe(true);
    expect(out.windows!.length).toBeGreaterThanOrEqual(1);
  });

  it("navigate window create returns a WindowInfo, not a tab in the main window", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "window", action: "create", url: "https://b.test/" });
    const out = result.result as { window?: { id: number }; tab?: unknown };
    expect(out.tab).toBeUndefined();
    expect(out.window).toBeDefined();
    expect(out.window!.id).not.toBe(1);
  });

  it("navigate window close routes to windows.close, not tabs.close", async () => {
    const rt = runtime();
    const created = await exec(rt, "navigate", { category: "window", action: "create" });
    const windowId = (created.result as { window: { id: number } }).window.id;
    const result = await exec(rt, "navigate", { category: "window", action: "close", windowId });
    expect((result.result as { closed: boolean; windowId: number }).closed).toBe(true);
    expect((result.result as { windowId: number }).windowId).toBe(windowId);
  });

  it("navigate window update still routes to windows.update", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "window", action: "update", windowId: 1, state: "minimized" });
    expect((result.result as { window: { id: number; state: string } }).window.state).toBe("minimized");
  });

  it("unified windows list/create return WindowInfo shapes", async () => {
    const rt = runtime();
    const list = await exec(rt, "windows", { action: "list" });
    const listOut = list.result as { windows?: unknown[]; tabs?: unknown[] };
    expect(listOut.tabs).toBeUndefined();
    expect(Array.isArray(listOut.windows)).toBe(true);
    const created = await exec(rt, "windows", { action: "create", url: "https://b.test/" });
    const createdOut = created.result as { window?: { id: number }; tab?: unknown };
    expect(createdOut.tab).toBeUndefined();
    expect(createdOut.window!.id).not.toBe(1);
  });

  it("navigate window + tab-only actions still reach the tab branch", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "window", action: "get", tabId: 1 });
    expect((result.result as { tab: { id: number } }).tab.id).toBe(1);
  });
});

describe("navfix: navigate tab open/reload and unified tabs reload", () => {
  it("navigate tab open without a tabId creates a tab", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "tab", action: "open", url: "https://b.test/" });
    const tab = (result.result as { tab: { url: string } }).tab;
    expect(tab.url).toBe("https://b.test/");
    expect(rt.ctx.tabs.size).toBe(2);
  });

  it("navigate tab open with a tabId navigates that tab", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "tab", action: "open", url: "https://b.test/", tabId: 1 });
    const tab = (result.result as { tab: { id: number; url: string } }).tab;
    expect(tab.id).toBe(1);
    expect(tab.url).toBe("https://b.test/");
    expect(rt.ctx.tabs.size).toBe(1);
  });

  it("navigate tab reload maps to tabs.reload (not navigation.reload)", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "tab", action: "reload", tabId: 1 });
    expect((result.result as { tab: { id: number } }).tab.id).toBe(1);
  });

  it("unified tabs reload via the gateway form (navigate tab reload) works", async () => {
    // The gateway rewrites unified tabs {action: reload} to navigate
    // {category: tab, action: reload}; this is the exact form that failed live.
    const rt = runtime();
    const result = await exec(rt, "navigate", { category: "tab", action: "reload", tabId: 1 });
    expect((result.result as { tab: { id: number } }).tab.id).toBe(1);
  });

  it("unified tabs reload directly still works", async () => {
    const rt = runtime();
    const result = await exec(rt, "tabs", { action: "reload", tabId: 1 });
    expect((result.result as { tab: { id: number } }).tab.id).toBe(1);
  });

  it("navigate url reload still maps to navigation.reload", async () => {
    const rt = runtime();
    const result = await exec(rt, "navigate", { action: "reload", tabId: 1 });
    expect((result.result as { tab: { id: number } }).tab.id).toBe(1);
  });
});
