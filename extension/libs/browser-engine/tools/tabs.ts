import {
  tabsActivate,
  tabsActive,
  tabsClose,
  tabsCreate,
  tabsDiscard,
  tabsDuplicate,
  tabsGet,
  tabsGroup,
  tabsList,
  tabsMove,
  tabsMute,
  tabsNavigate,
  tabsPin,
  tabsReload,
  tabsSearch,
  tabsSetZoom,
  tabsUngroup,
  windowsClose,
  windowsCreate,
  windowsList,
  windowsUpdate,
} from "../../tool-contracts/index.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import type { BrowserContext, RawWindow } from "../context.js";
import { raceWithAbort, toTabInfo, toWindowInfo, validateUrlInput } from "./helpers.js";

/**
 * Retest4 tabCount fallback: a RawWindow without a populated tabs list
 * (as chrome-context used to produce for create/update, and as any
 * non-populating context still can) must not report tabCount 0. When
 * tabs are absent, count the window's tabs via listTabs; when tabs
 * are present, use them as-is. A listTabs failure must not fail the
 * window call itself — it degrades to the unpopulated count (0),
 * exactly as before, rather than breaking list/create/update.
 */
async function withTabCount(
  ctx: BrowserContext,
  win: RawWindow,
  signal?: AbortSignal,
): Promise<RawWindow> {
  if (win.tabs !== undefined || typeof win.id !== "number") return win;
  try {
    const tabs = await raceWithAbort(ctx.listTabs({ windowId: win.id }), signal);
    return { ...win, tabs };
  } catch {
    return win;
  }
}

export const tabsToolHandlers: RegisteredTool[] = [
  defineTool(tabsList, async (input, { ctx, signal }) => {
    const data = input as { windowId?: number; currentWindowOnly: boolean };
    const tabs = await raceWithAbort(ctx.listTabs({ windowId: data.windowId, currentWindowOnly: data.currentWindowOnly }), signal);
    return { tabs: tabs.map(toTabInfo) };
  }),

  defineTool(tabsActive, async (_input, { ctx, signal }) => {
    const tab = await raceWithAbort(ctx.getActiveTab(), signal);
    return { tab: tab && typeof tab.id === "number" ? toTabInfo(tab) : null };
  }),

  defineTool(tabsGet, async (input, { ctx, signal }) => {
    const { tabId } = input as { tabId: number };
    const tab = await raceWithAbort(ctx.getTab(tabId), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsSearch, async (input, { ctx, signal }) => {
    const data = input as {
      query?: string;
      match: "title" | "url" | "both";
      limit: number;
      windowId?: number;
      currentWindowOnly: boolean;
      pinned?: boolean;
      audible?: boolean;
      discarded?: boolean;
      url?: string;
      title?: string;
    };
    // Chrome's own filters run first; the substring search is applied on top
    // so a caller can combine both.
    const all = await raceWithAbort(ctx.listTabs({
      windowId: data.windowId,
      currentWindowOnly: data.currentWindowOnly,
      pinned: data.pinned,
      audible: data.audible,
      discarded: data.discarded,
      url: data.url,
      title: data.title,
    }), signal);
    const needle = data.query?.toLowerCase();
    const tabs = all
      .filter((tab) => {
        if (!needle) return true;
        const inTitle = (tab.title ?? "").toLowerCase().includes(needle);
        const inUrl = (tab.url ?? "").toLowerCase().includes(needle);
        return data.match === "title" ? inTitle : data.match === "url" ? inUrl : inTitle || inUrl;
      })
      .slice(0, data.limit)
      .map(toTabInfo);
    return { tabs };
  }),

  defineTool(tabsCreate, async (input, { ctx, signal }) => {
    const data = input as {
      url?: string;
      active: boolean;
      windowId?: number;
      groupId?: number;
      pinned: boolean;
      openerTabId?: number;
      index?: number;
    };
    const url = data.url ? validateUrlInput(data.url) : undefined;
    const tab = await raceWithAbort(ctx.createTab({
      url,
      active: data.active,
      windowId: data.windowId,
      groupId: data.groupId,
      pinned: data.pinned,
      openerTabId: data.openerTabId,
      index: data.index,
    }), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsNavigate, async (input, { ctx, signal }) => {
    const data = input as { tabId: number; url: string };
    const url = validateUrlInput(data.url);
    const tab = await raceWithAbort(ctx.updateTab(data.tabId, { url }), signal);
    // navigationId is null by design: the browser API returns no navigation
    // id, and inventing one would let a caller correlate a tab update with
    // a navigation that was never observed. (Schema change needed: the
    // contracts section must allow navigationId: string | null.)
    return { tab: toTabInfo(tab), navigationId: null };
  }),

  defineTool(tabsReload, async (input, { ctx, signal }) => {
    const data = input as { tabId: number; bypassCache: boolean };
    const tab = await raceWithAbort(ctx.reloadTab(data.tabId, data.bypassCache), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsDuplicate, async (input, { ctx, signal }) => {
    const { tabId } = input as { tabId: number };
    const tab = await raceWithAbort(ctx.duplicateTab(tabId), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsActivate, async (input, { ctx, signal }) => {
    const { tabId } = input as { tabId: number };
    await raceWithAbort(ctx.updateTab(tabId, { active: true }), signal);
    const tab = await raceWithAbort(ctx.getTab(tabId), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsClose, async (input, { ctx, signal }) => {
    const { tabId } = input as { tabId: number };
    await raceWithAbort(ctx.closeTab(tabId), signal);
    return { closed: true as const, tabId };
  }),

  defineTool(tabsGroup, async (input, { ctx, signal }) => {
    const data = input as { tabIds: number[]; groupId?: number; title?: string; color?: string };
    const groupId = await raceWithAbort(ctx.groupTabs(data.tabIds, { groupId: data.groupId, title: data.title, color: data.color }), signal);
    return { groupId };
  }),

  defineTool(tabsUngroup, async (input, { ctx, signal }) => {
    const data = input as { tabIds: number[] };
    await raceWithAbort(ctx.ungroupTabs(data.tabIds), signal);
    return { ungrouped: data.tabIds };
  }),

  defineTool(tabsMove, async (input, { ctx, signal }) => {
    const data = input as { tabIds: number[]; windowId: number; index?: number };
    await raceWithAbort(ctx.moveTabs(data.tabIds, data.windowId, data.index), signal);
    return { moved: data.tabIds };
  }),

  defineTool(tabsPin, async (input, { ctx, signal }) => {
    const data = input as { tabId: number; pinned: boolean };
    const tab = await raceWithAbort(ctx.updateTab(data.tabId, { pinned: data.pinned }), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(tabsMute, async (input, { ctx, signal }) => {
    const data = input as { tabId: number; muted: boolean };
    await raceWithAbort(ctx.updateTab(data.tabId, { muted: data.muted }), signal);
    return { tabId: data.tabId, muted: data.muted };
  }),

  defineTool(tabsSetZoom, async (input, { ctx, signal }) => {
    const data = input as { tabId: number; zoom: number };
    await raceWithAbort(ctx.setTabZoom(data.tabId, data.zoom), signal);
    return { tabId: data.tabId, zoom: data.zoom };
  }),

  defineTool(tabsDiscard, async (input, { ctx, signal }) => {
    const data = input as { tabId: number };
    await raceWithAbort(ctx.discardTab(data.tabId), signal);
    return { discarded: true as const, tabId: data.tabId };
  }),

  defineTool(windowsList, async (_input, { ctx, signal }) => {
    const windows = await raceWithAbort(ctx.listWindows(), signal);
    const enriched = await Promise.all(windows.map((win) => withTabCount(ctx, win, signal)));
    return { windows: enriched.map(toWindowInfo) };
  }),

  defineTool(windowsCreate, async (input, { ctx, signal }) => {
    const data = input as { url?: string; focused: boolean; incognito: boolean };
    const url = data.url ? validateUrlInput(data.url) : undefined;
    const window = await raceWithAbort(ctx.createWindow({ url, focused: data.focused, incognito: data.incognito }), signal);
    return { window: toWindowInfo(await withTabCount(ctx, window, signal)) };
  }),

  defineTool(windowsUpdate, async (input, { ctx, signal }) => {
    const data = input as {
      windowId: number;
      state?: "normal" | "minimized" | "maximized" | "fullscreen";
      focused?: boolean;
      width?: number;
      height?: number;
      left?: number;
      top?: number;
    };
    const window = await raceWithAbort(ctx.updateWindow(data.windowId, {
      state: data.state,
      focused: data.focused,
      width: data.width,
      height: data.height,
      left: data.left,
      top: data.top,
    }), signal);
    return { window: toWindowInfo(await withTabCount(ctx, window, signal)) };
  }),

  defineTool(windowsClose, async (input, { ctx, signal }) => {
    const data = input as { windowId: number };
    await raceWithAbort(ctx.closeWindow(data.windowId), signal);
    return { closed: true as const, windowId: data.windowId };
  }),
];
