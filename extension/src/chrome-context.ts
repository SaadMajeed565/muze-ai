import { ToolErrorException } from "../libs/tool-contracts/index.js";
import type {
  BookmarkRecord,
  BookmarksCapability,
  BrowserContext,
  BrowserInfoData,
  ClipboardCapability,
  CreateTabOptions,
  CreateWindowOptions,
  DownloadRecord,
  DownloadsCapability,
  FrameResult,
  FrameTreeNode,
  HistoryCapability,
  HistoryRecord,
  ObserverCapability,
  PageFunction,
  RawTab,
  RawWindow,
  SavedSession,
  ScriptInjectionOptions,
  SessionStore,
  TabSearchQuery,
  UpdateTabProperties,
  UpdateWindowProperties,
} from "../libs/browser-engine/index.js";
import { pageAgent } from "../libs/browser-engine/page/agent.js";
import { ChromeObserverCapability } from "./observer-controller.js";
import { ChromeCdpCapability } from "./cdp-controller.js";

const PAGE_AGENT_FILE = "page-agent.js";

function isPageAgentFn(fn: unknown): boolean {
  return fn === pageAgent || (typeof fn === "function" && fn.name === "pageAgent");
}

export interface OffscreenMessenger {
  available(): boolean;
  request<T>(type: string, payload?: unknown): Promise<T>;
}

/** Session storage key (v0.3.0 prefix); the legacy key is read as a fallback and migrated on write. */
const SESSION_KEY = "muze.sessions";
const LEGACY_SESSION_KEY = "uabb.sessions";

/**
 * Wait for a tab to report load-complete, capped. This replaces the old
 * fixed 75ms paint wait after activating a background tab: a blind timer
 * guesses at paint timing, while tab status is a real signal from the
 * browser. Honest limit: load-complete is not a paint guarantee — a freshly
 * activated, already-loaded tab still needs one compositor frame — but the
 * capture lock serialises captures and the cap bounds the worst case.
 */
const TAB_COMPLETE_WAIT_CAP_MS = 1000;
const TAB_COMPLETE_POLL_MS = 25;

/** Full-page capture: settle/paint wait between scrolled slices (named, not magic). */
const FULL_PAGE_SLICE_SETTLE_MS = 120;

interface PageMetrics {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  devicePixelRatio: number;
  scrollY: number;
}

/** Reads the page geometry. Runs in the page, so it closes over nothing. */
function pageMetricsOp(): PageMetrics {
  const doc = document;
  return {
    scrollHeight: Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio,
    scrollY: window.scrollY,
  };
}

/** Scrolls the page to an absolute position. Runs in the page. */
function scrollToYOp(args: { y: number }): { scrollY: number } {
  window.scrollTo({ top: args.y, behavior: "instant" as ScrollBehavior });
  return { scrollY: window.scrollY };
}

/**
 * Neutralises sticky and fixed elements while a page is captured.
 *
 * NOTE: the injected style id is "muze-sticky-style" (matching the page
 * agent); any legacy "uabb-sticky-style" element is also removed, for
 * now. The page agent (libs/browser-engine/page/agent.ts, `hideSticky`)
 * manages the same element id; renaming one side without the other would
 * leave orphaned style elements in captured pages. Rename both together
 * (coordinator note).
 */
function hideStickyOp(args: { hidden: boolean }): { hidden: boolean } {
  const doc = document;
  // Remove a legacy pre-0.3.0 style element if present, then manage muze one.
  doc.getElementById("uabb-sticky-style")?.remove();
  const existing = doc.getElementById("muze-sticky-style");
  if (args.hidden) {
    if (!existing) {
      const style = doc.createElement("style");
      style.id = "muze-sticky-style";
      style.textContent =
        "*{scroll-behavior:auto !important}[style*='position:sticky'],[style*='position: fixed'],[style*='position:fixed'],[style*='position:sticky']{position:static !important;visibility:hidden !important}";
      doc.documentElement.appendChild(style);
    }
  } else if (existing) {
    existing.remove();
  }
  return { hidden: args.hidden };
}

function toRawTab(tab: chrome.tabs.Tab): RawTab {
  const id = tab.id;
  if (typeof id !== "number") throw new ToolErrorException("NOT_FOUND", "Tab has no id");
  return {
    id,
    index: tab.index,
    windowId: tab.windowId,
    active: tab.active,
    pinned: tab.pinned,
    highlighted: tab.highlighted,
    title: tab.title ?? "",
    url: tab.url,
    status: tab.status,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    audible: tab.audible,
    discarded: tab.discarded,
    incognito: tab.incognito,
  };
}

function toRawWindow(window: chrome.windows.Window): RawWindow {
  return {
    id: window.id,
    focused: window.focused,
    state: window.state,
    type: window.type,
    alwaysOnTop: window.alwaysOnTop,
  };
}

/** BrowserContext backed by the real chrome.* extension APIs. */
export class ChromeBrowserContext implements BrowserContext {
  readonly clipboard?: ClipboardCapability;
  readonly downloads?: DownloadsCapability;
  readonly bookmarks?: BookmarksCapability;
  readonly history?: HistoryCapability;
  readonly observer?: ObserverCapability;
  readonly sessions: SessionStore;
  readonly cdp: ChromeCdpCapability;
  captureElement?: BrowserContext["captureElement"];
  private readonly captureLocks = new Map<number, Promise<void>>();
  private readonly injectionLocks = new Map<number, Promise<void>>();

  constructor(private readonly offscreen?: OffscreenMessenger) {
    if (offscreen?.available()) {
      this.clipboard = {
        read: () => offscreen.request<string>("clipboardRead"),
        write: (text) => offscreen.request<void>("clipboardWrite", { text }).then(() => undefined),
      };
      this.captureElement = async (_tabId, rect, options) => {
        const dataUrl = await this.captureVisibleTab(_tabId, options);
        const cropped = await offscreen.request<{ dataUrl: string; width: number; height: number }>("cropImage", {
          dataUrl: dataUrl.dataUrl,
          rect,
          format: options.format,
          quality: options.quality,
        });
        return cropped;
      };
    }

    if (chrome.downloads) this.downloads = this.createDownloads();
    if (chrome.bookmarks) this.bookmarks = this.createBookmarks();
    if (chrome.history) this.history = this.createHistory();
    this.observer = new ChromeObserverCapability();
    this.sessions = this.createSessions();
    this.cdp = new ChromeCdpCapability();
  }

  // Tabs
  async listTabs(query: TabSearchQuery): Promise<RawTab[]> {
    const tabs = await chrome.tabs.query({
      ...(typeof query.windowId === "number" ? { windowId: query.windowId } : {}),
      ...(query.currentWindowOnly ? { currentWindow: true } : {}),
      ...(typeof query.pinned === "boolean" ? { pinned: query.pinned } : {}),
      ...(typeof query.audible === "boolean" ? { audible: query.audible } : {}),
      ...(typeof query.discarded === "boolean" ? { discarded: query.discarded } : {}),
      ...(query.url ? { url: query.url } : {}),
      ...(query.title ? { title: query.title } : {}),
    });
    return tabs.map(toRawTab);
  }

  async getActiveTab(): Promise<RawTab | null> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab ? toRawTab(tab) : null;
  }

  async getTab(tabId: number): Promise<RawTab> {
    return toRawTab(await chrome.tabs.get(tabId));
  }

  async createTab(options: CreateTabOptions): Promise<RawTab> {
    // `groupId` and `openerTabId` are supported by Chrome but missing from the
    // bundled type definitions.
    const createProperties = {
      ...(options.url ? { url: options.url } : {}),
      active: options.active,
      ...(typeof options.windowId === "number" ? { windowId: options.windowId } : {}),
      ...(typeof options.groupId === "number" ? { groupId: options.groupId } : {}),
      ...(options.pinned ? { pinned: true } : {}),
      ...(typeof options.openerTabId === "number" ? { openerTabId: options.openerTabId } : {}),
      ...(typeof options.index === "number" ? { index: options.index } : {}),
    } as chrome.tabs.CreateProperties;
    const tab = await chrome.tabs.create(createProperties);
    return toRawTab(tab);
  }

  async updateTab(tabId: number, properties: UpdateTabProperties): Promise<RawTab> {
    const tab = await chrome.tabs.update(tabId, properties);
    if (!tab) throw new ToolErrorException("INTERNAL", "Failed to update tab");
    return toRawTab(tab);
  }

  async reloadTab(tabId: number, bypassCache: boolean): Promise<RawTab> {
    await chrome.tabs.reload(tabId, { bypassCache });
    return this.getTab(tabId);
  }

  async duplicateTab(tabId: number): Promise<RawTab> {
    const tab = await chrome.tabs.duplicate(tabId);
    if (!tab) throw new ToolErrorException("INTERNAL", "Failed to duplicate tab");
    return toRawTab(tab);
  }

  async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
  }

  async groupTabs(tabIds: number[], options: { groupId?: number; title?: string; color?: string }): Promise<number> {
    const groupId = await chrome.tabs.group({
      tabIds: tabIds as [number, ...number[]],
      ...(typeof options.groupId === "number" ? { groupId: options.groupId } : {}),
    });
    if (options.title || options.color) {
      await chrome.tabGroups.update(groupId, {
        ...(options.title ? { title: options.title } : {}),
        ...(options.color ? { color: options.color as chrome.tabGroups.Color } : {}),
      });
    }
    return groupId;
  }

  async setTabZoom(tabId: number, zoom: number): Promise<void> {
    // `chrome.tabs.update` has no zoom property; the zoom level lives in its
    // own per-tab setting.
    await chrome.tabs.setZoom(tabId, zoom);
  }

  async ungroupTabs(tabIds: number[]): Promise<void> {
    await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
  }

  async moveTabs(tabIds: number[], windowId: number, index?: number): Promise<void> {
    await chrome.tabs.move(tabIds as [number, ...number[]], { windowId, index: index ?? -1 });
  }

  async discardTab(tabId: number): Promise<void> {
    await chrome.tabs.discard(tabId);
  }

  async goBack(tabId: number): Promise<void> {
    await chrome.tabs.goBack(tabId);
  }

  async goForward(tabId: number): Promise<void> {
    await chrome.tabs.goForward(tabId);
  }

  // Windows
  async listWindows(): Promise<RawWindow[]> {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.map(toRawWindow);
  }

  async createWindow(options: CreateWindowOptions): Promise<RawWindow> {
    const window = await chrome.windows.create({ url: options.url, focused: options.focused, incognito: options.incognito });
    if (!window) throw new ToolErrorException("INTERNAL", "Failed to create window");
    return toRawWindow(window);
  }

  async updateWindow(windowId: number, properties: UpdateWindowProperties): Promise<RawWindow> {
    return toRawWindow(await chrome.windows.update(windowId, properties));
  }

  async closeWindow(windowId: number): Promise<void> {
    await chrome.windows.remove(windowId);
  }

  // Page execution & capture
  async executeInPage<Arg, Result>(
    tabId: number,
    fn: PageFunction<Arg, Result>,
    arg: Arg,
    options?: ScriptInjectionOptions,
  ): Promise<Result> {
    if (options?.world !== "MAIN" && isPageAgentFn(fn)) {
      const result = await this.runPersistentPageAgent<Result>(tabId, arg, undefined);
      return result;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: options?.world === "MAIN" ? "MAIN" : "ISOLATED",
      func: fn as unknown as (...args: unknown[]) => unknown,
      args: [arg as unknown],
    });
    const first = results[0] as { result?: unknown; error?: unknown } | undefined;
    if (!first) throw new ToolErrorException("INTERNAL", "Script injection returned no result");
    if (first.error) throw new ToolErrorException("INTERNAL", String(first.error));
    return first.result as Result;
  }

  private async runPersistentPageAgent<Result>(tabId: number, op: unknown, frameId?: number): Promise<Result> {
    // Frame targeting fix (Facebook fbsbx case, 2026-10-28): the manifest
    // loads the page agent in ALL frames, and chrome.tabs.sendMessage
    // with no frameId broadcasts to every frame, so the first frame to
    // answer wins. On Facebook a lightweight fbsbx maw_proxy_page
    // iframe answered before the heavy main frame, so observe returned
    // that iframe's bootloader text, 0 accessibility nodes and a 0x0
    // viewport instead of the profile. A call with no frameId means
    // the main frame, and the main frame is always frame 0 in Chrome,
    // so target it explicitly. Explicit subframe calls are unchanged.
    const targetFrameId = frameId ?? 0;
    const send = async (): Promise<{ ok?: boolean; result?: Result; error?: string }> =>
      chrome.tabs.sendMessage(tabId, { type: "muze/page-op", op }, { frameId: targetFrameId });
    const ensure = async (): Promise<{ ok?: boolean; result?: Result; error?: string }> => {
      try {
        return await send();
      } catch (error) {
        if (!/Receiving end does not exist|Could not establish connection/i.test(String(error))) throw error;
        const key = tabId * 1000 + targetFrameId;
        const previous = this.injectionLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const lock = new Promise<void>((resolve) => { release = resolve; });
        this.injectionLocks.set(key, lock);
        await previous.catch(() => undefined);
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [targetFrameId] },
            files: [PAGE_AGENT_FILE],
            world: "ISOLATED",
          });
        } finally {
          release();
          if (this.injectionLocks.get(key) === lock) this.injectionLocks.delete(key);
        }
        return send();
      }
    };
    const reply = await ensure();
    if (!reply?.ok) throw new ToolErrorException("INTERNAL", reply?.error ?? "Page agent returned no result");
    return reply.result as Result;
  }

  async executeInFrames<Arg, Result>(
    tabId: number,
    fn: PageFunction<Arg, Result>,
    arg: Arg,
    frameIds: number[] | "all",
    options?: ScriptInjectionOptions,
  ): Promise<FrameResult<Result>[]> {
    if (options?.world !== "MAIN" && isPageAgentFn(fn)) {
      const ids = frameIds === "all" ? (await this.listFrameTree(tabId)).map((frame) => frame.frameId) : frameIds;
      const out: FrameResult<Result>[] = [];
      for (const id of ids) {
        try {
          out.push({ frameId: id, result: await this.runPersistentPageAgent<Result>(tabId, arg, id) });
        } catch (err) {
          out.push({ frameId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    }
    const target: chrome.scripting.InjectionTarget =
      frameIds === "all" ? { tabId, allFrames: true } : { tabId, frameIds };
    let results: unknown[];
    try {
      results = await chrome.scripting.executeScript({
        target,
        world: options?.world === "MAIN" ? "MAIN" : "ISOLATED",
        func: fn as unknown as (...args: unknown[]) => unknown,
        args: [arg as unknown],
      });
    } catch (err) {
      // A sandboxed or otherwise uninjectable frame rejects the whole call in
      // some Chrome versions; surface it as an empty set so callers degrade.
      if (String(err).match(/no frame|frame.*not found|cannot access/i)) return [];
      throw err;
    }
    return (results as { frameId?: number; result?: unknown; error?: unknown }[]).map((r) => ({
      frameId: typeof r.frameId === "number" ? r.frameId : 0,
      result: r.result as Result | undefined,
      error: typeof r.error === "string" ? r.error : undefined,
    }));
  }

  /**
   * The frame tree of a tab. The navigation API is the only way to see how
   * frames are nested when some of them are cross-origin, so the hierarchy is
   * reported when it is available and skipped when it is not.
   */
  async listFrameTree(tabId: number): Promise<FrameTreeNode[]> {
    if (!chrome.webNavigation?.getAllFrames) return [];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({
        frameId: f.frameId,
        parentFrameId: typeof f.parentFrameId === "number" ? f.parentFrameId : -1,
        url: (f.url ?? "").slice(0, 2048),
        errorOccurred: Boolean(f.errorOccurred),
      }));
    } catch {
      // The tab may have navigated away or be gone entirely.
      return [];
    }
  }

  private async withCaptureLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.captureLocks.get(tabId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.captureLocks.set(tabId, lock);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.captureLocks.get(tabId) === lock) this.captureLocks.delete(tabId);
    }
  }

  async captureVisibleTab(tabId: number, options: { format: "png" | "jpeg"; quality?: number }): Promise<{ dataUrl: string; width: number; height: number }> {
    return this.withCaptureLock(tabId, () => this.captureVisibleTabUnlocked(tabId, options));
  }

  private async waitForTabComplete(tabId: number): Promise<void> {
    const deadline = Date.now() + TAB_COMPLETE_WAIT_CAP_MS;
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, TAB_COMPLETE_POLL_MS));
    }
  }

  private async captureVisibleTabUnlocked(tabId: number, options: { format: "png" | "jpeg"; quality?: number }): Promise<{ dataUrl: string; width: number; height: number }> {
    const tab = await chrome.tabs.get(tabId);
    // Chrome always captures the *active* tab of the window, whatever tabId is
    // passed here. Without forcing the target forward, a snapshot of a
    // background tab would silently return the user's current tab.
    let previousActiveId: number | undefined;
    if (!tab.active) {
      const [previous] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      previousActiveId = previous?.id;
      await chrome.tabs.update(tabId, { active: true });
      // Wait for the newly activated tab to report complete (capped), instead
      // of the old blind 75ms paint guess. See TAB_COMPLETE_WAIT_CAP_MS.
      await this.waitForTabComplete(tabId);
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: options.format,
        ...(options.quality !== undefined ? { quality: options.quality } : {}),
      });
      const dims =
        this.offscreen?.available()
          ? await this.offscreen.request<{ width: number; height: number }>("imageDimensions", { dataUrl })
          : { width: 0, height: 0 };
      return { dataUrl, ...dims };
    } finally {
      if (previousActiveId !== undefined) {
        await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
      }
    }
  }

  async getBrowserInfo(): Promise<BrowserInfoData> {
    const platform = await chrome.runtime.getPlatformInfo();
    const manifest = chrome.runtime.getManifest();
    return {
      userAgent: navigator.userAgent,
      platform: `${platform.os}/${platform.arch}`,
      extensionVersion: manifest.version,
      browserVersion: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "",
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      manifestVersion: manifest.manifest_version,
    };
  }

  /**
   * Capture a whole scrollable page.
   *
   * Chrome can only capture the visible area of the active tab, so the page is
   * scrolled in viewport sized steps and the slices are stitched together in
   * the offscreen document. The scroll position is always restored.
   */
  async captureFullPage(
    tabId: number,
    options: { format: "png" | "jpeg"; quality?: number; maxHeight: number },
  ): Promise<{ dataUrl: string; width: number; height: number; pages: number }> {
    return this.withCaptureLock(tabId, () => this.captureFullPageUnlocked(tabId, options));
  }

  private async captureFullPageUnlocked(
    tabId: number,
    options: { format: "png" | "jpeg"; quality?: number; maxHeight: number },
  ): Promise<{ dataUrl: string; width: number; height: number; pages: number }> {
    if (!this.offscreen?.available()) {
      throw new ToolErrorException("UNSUPPORTED", "Full page capture needs the offscreen document");
    }
    const metrics = await this.executeInPage<undefined, PageMetrics>(tabId, pageMetricsOp, undefined);
    const viewportHeight = Math.max(1, metrics.viewportHeight);
    const totalHeight = Math.min(metrics.scrollHeight, options.maxHeight);
    const pages = Math.max(1, Math.ceil(totalHeight / viewportHeight));
    if (pages > 40) {
      throw new ToolErrorException("INVALID_INPUT", "The page is too tall to capture in one go");
    }

    // `chrome.tabs.captureVisibleTab` can only see the active tab of a window,
    // so the target has to be brought to the front for the duration of the
    // capture and the user's tab is put back afterwards.
    const original = await chrome.tabs.get(tabId);
    const wasActive = original.active;
    const [previousActive] = wasActive
      ? []
      : await chrome.tabs.query({ windowId: original.windowId, active: true });
    if (!wasActive) await chrome.tabs.update(tabId, { active: true });

    const originalScroll = metrics.scrollY;
    await this.executeInPage(tabId, hideStickyOp, { hidden: true });
    const slices: { dataUrl: string; docStart: number; docEnd: number; scrollY: number }[] = [];
    try {
      for (let i = 0; i < pages; i++) {
        // The last slice is pulled back to the bottom of the page, so it
        // overlaps the previous one. The overlap is cut off when the images
        // are stitched together.
        const scrollY = Math.min(i * viewportHeight, Math.max(0, totalHeight - viewportHeight));
        await this.executeInPage(tabId, scrollToYOp, { y: scrollY });
        // Give the page a moment to settle and to paint the new slice.
        // Named constant (FULL_PAGE_SLICE_SETTLE_MS): slice waits are kept
        // deliberately, because scrolling does not synchronously repaint.
        await new Promise((r) => setTimeout(r, FULL_PAGE_SLICE_SETTLE_MS));
        const shot = await this.captureVisibleTabUnlocked(tabId, { format: options.format, quality: options.quality });
        slices.push({
          dataUrl: shot.dataUrl,
          docStart: i * viewportHeight,
          docEnd: Math.min((i + 1) * viewportHeight, totalHeight),
          scrollY,
        });
      }
    } finally {
      await this.executeInPage(tabId, scrollToYOp, { y: originalScroll });
      await this.executeInPage(tabId, hideStickyOp, { hidden: false });
      if (!wasActive && previousActive?.id !== undefined) {
        await chrome.tabs.update(previousActive.id, { active: true }).catch(() => undefined);
      }
    }

    const width = Math.round(metrics.viewportWidth * metrics.devicePixelRatio);
    const height = Math.round(totalHeight * metrics.devicePixelRatio);
    const stitched = await this.offscreen.request<{ dataUrl: string; width: number; height: number; pages: number }>(
      "stitchImages",
      {
        slices,
        width,
        height,
        viewportHeight,
        documentHeight: totalHeight,
        format: options.format,
        quality: options.quality,
      },
    );
    return stitched;
  }

  private createDownloads(): DownloadsCapability {
    return {
      list: async ({ limit, query }) => {
        const items = await chrome.downloads.search({ ...(query ? { query: [query] } : {}), limit });
        return items.map(toDownloadRecord);
      },
      control: async (id, action) => {
        if (action === "pause") await chrome.downloads.pause(id);
        else if (action === "resume") await chrome.downloads.resume(id);
        else await chrome.downloads.cancel(id);
      },
      start: async ({ url, filename, saveAs, conflictAction }) => {
        const id = await chrome.downloads.download({
          url,
          ...(filename ? { filename } : {}),
          saveAs,
          ...(conflictAction ? { conflictAction } : {}),
        });
        return { id, filename: filename ?? url.split("/").pop() ?? "download" };
      },
      erase: async (ids) => {
        let erased = 0;
        for (const id of ids) {
          await chrome.downloads.erase({ id });
          erased += 1;
        }
        return erased;
      },
    };
  }

  private createBookmarks(): BookmarksCapability {
    return {
      search: async (query, limit) => {
        const nodes = await chrome.bookmarks.search(query);
        return nodes.slice(0, limit).map(toBookmarkRecord);
      },
      list: async (folderId, limit) => {
        const tree: chrome.bookmarks.BookmarkTreeNode[] = folderId
          ? await chrome.bookmarks.getSubTree(folderId)
          : await chrome.bookmarks.getTree();
        return { bookmarks: flattenBookmarks(tree).slice(0, limit), folders: collectFolders(tree) };
      },
      create: async ({ title, url, parentId }) => {
        return toBookmarkRecord(await chrome.bookmarks.create({ title, url, parentId }));
      },
      update: async ({ id, title, url }) => {
        return toBookmarkRecord(await chrome.bookmarks.update(id, { ...(title ? { title } : {}), ...(url ? { url } : {}) }));
      },
      move: async ({ id, parentId, index }) => {
        const node = await chrome.bookmarks.move(id, { ...(parentId ? { parentId } : {}), ...(index !== undefined ? { index } : {}) });
        return toBookmarkRecord(node);
      },
      createFolder: async ({ title, parentId, index }) => {
        const node = await chrome.bookmarks.create({
          title,
          ...(parentId ? { parentId } : {}),
          ...(index !== undefined ? { index } : {}),
        });
        return { id: node.id, title: node.title, parentId: node.parentId };
      },
      remove: async (id) => {
        await chrome.bookmarks.remove(id);
      },
    };
  }

  private createHistory(): HistoryCapability {
    return {
      search: async ({ text, startTime, endTime, maxResults }) => {
        const items = await chrome.history.search({ text, startTime, endTime, maxResults });
        return items.map(
          (item): HistoryRecord => ({
            id: item.id ?? item.url ?? "",
            url: item.url ?? "",
            title: item.title ?? "",
            lastVisitTime: new Date(item.lastVisitTime ?? 0).toISOString(),
            visitCount: item.visitCount ?? 0,
          }),
        );
      },
      remove: async (urls) => {
        let removed = 0;
        for (const url of urls) {
          await chrome.history.deleteUrl({ url });
          removed += 1;
        }
        return removed;
      },
      add: async ({ url, title, transition }) => {
        await chrome.history.addUrl({ url });
        // The title is not settable through the history API; it is filled in
        // by the browser the next time the page is visited.
        void title;
        void transition;
      },
    };
  }

  private createSessions(): SessionStore {
    let lock: Promise<void> = Promise.resolve();
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => { release = resolve; });
      await previous.catch(() => undefined);
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const read = async (): Promise<SavedSession[]> => {
      const stored = await chrome.storage.local.get(SESSION_KEY);
      const value = stored[SESSION_KEY] as SavedSession[] | undefined;
      if (value !== undefined) return value;
      const legacyStored = await chrome.storage.local.get(LEGACY_SESSION_KEY);
      const legacyValue = legacyStored[LEGACY_SESSION_KEY] as SavedSession[] | undefined;
      if (legacyValue !== undefined) {
        // Migrate on first read: copy to the new key, drop the legacy key.
        try {
          await chrome.storage.local.set({ [SESSION_KEY]: legacyValue });
          await chrome.storage.local.remove?.([LEGACY_SESSION_KEY]);
        } catch {
          // Best effort; the legacy value is still returned below.
        }
      }
      return legacyValue ?? [];
    };
    const write = async (sessions: SavedSession[]): Promise<void> => {
      await chrome.storage.local.set({ [SESSION_KEY]: sessions });
      try {
        await chrome.storage.local.remove?.([LEGACY_SESSION_KEY]);
      } catch {
        // Legacy cleanup is best effort.
      }
    };
    return {
      save: async (name, tabs) => withLock(async () => {
        const sessions = await read();
        const session: SavedSession = {
          id: `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name,
          tabs,
          createdAt: new Date().toISOString(),
        };
        sessions.push(session);
        await write(sessions.slice(-100));
        return session;
      }),
      get: async (id) => (await read()).find((s) => s.id === id) ?? null,
      list: async () => (await read()).map((s) => ({ id: s.id, name: s.name, tabCount: s.tabs.length })),
    };
  }
}

function toDownloadRecord(item: chrome.downloads.DownloadItem): DownloadRecord {
  return {
    id: item.id,
    filename: item.filename,
    url: item.url,
    state: item.state as DownloadRecord["state"],
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    paused: item.paused,
    startTime: item.startTime,
    error: item.error,
  };
}

function toBookmarkRecord(node: chrome.bookmarks.BookmarkTreeNode): BookmarkRecord {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded ? new Date(node.dateAdded).toISOString() : undefined,
    folder: "",
  };
}

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]): BookmarkRecord[] {
  const out: BookmarkRecord[] = [];
  const walk = (list: chrome.bookmarks.BookmarkTreeNode[]): void => {
    for (const node of list) {
      if (node.url) out.push(toBookmarkRecord(node));
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function collectFolders(nodes: chrome.bookmarks.BookmarkTreeNode[]): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const walk = (list: chrome.bookmarks.BookmarkTreeNode[]): void => {
    for (const node of list) {
      if (!node.url) out.push({ id: node.id, title: node.title });
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
