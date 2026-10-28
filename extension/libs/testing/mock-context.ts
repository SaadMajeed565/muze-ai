import type {
  BookmarkRecord,
  BookmarksCapability,
  BrowserContext,
  BrowserInfoData,
  CdpCapability,
  ClipboardCapability,
  CreateTabOptions,
  CreateWindowOptions,
  DownloadRecord,
  DownloadsCapability,
  FrameResult,
  FrameTreeNode,
  HistoryCapability,
  HistoryRecord,
  ObservedDialog,
  ObservedRequest,
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
} from "../browser-engine/index.js";
import { ToolErrorException } from "../tool-contracts/index.js";

export interface MockTabInit {
  url?: string;
  title?: string;
  status?: string;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
}

export interface MockObserverState {
  enabled: boolean;
  requests: ObservedRequest[];
  dialogs: ObservedDialog[];
  defaultAnswer: "accept" | "dismiss";
  defaultText?: string;
}

function emptyObserverState(): MockObserverState {
  return { enabled: false, requests: [], dialogs: [], defaultAnswer: "dismiss" };
}

export interface MockContextOptions {
  tabs?: MockTabInit[];
  downloads?: DownloadRecord[];
  clipboard?: string;
  bookmarks?: BookmarkRecord[];
  history?: HistoryRecord[];
  browserInfo?: Partial<BrowserInfoData>;
  /** The frame tree of the first tab, so the hierarchy can be exercised. */
  frameTree?: FrameTreeNode[];
  cdpEnabled?: boolean;
}

/**
 * In-memory BrowserContext used by unit and integration tests. It mirrors the
 * chrome.* semantics closely enough to exercise the full executor pipeline
 * without a browser.
 */
export class MockBrowserContext implements BrowserContext {
  readonly tabs = new Map<number, RawTab>();
  readonly windows = new Map<number, RawWindow>();
  activeTabId: number | null = null;

  downloadsStore: DownloadRecord[];
  clipboardStore: string;
  bookmarksStore: BookmarkRecord[];
  createdFolders: { id: string; title: string; parentId?: string }[] = [];
  historyStore: HistoryRecord[];
  sessionsStore = new Map<string, SavedSession>();
  observerStore = new Map<number, MockObserverState>();
  frameTree: FrameTreeNode[] = [];
  readonly browserInfo: BrowserInfoData;

  private nextTabId = 1;
  private nextWindowId = 1;
  /**
   * Monotonically increasing id counters. Ids must NEVER be derived from the
   * current store length: after an erase/delete, a length-derived id is
   * reused and a test (or a stale client reference) can silently address a
   * different download/bookmark than the one it meant. Counters only move
   * forward, seeded above the highest id already present in the seed data.
   */
  private nextDownloadId: number;
  private nextBookmarkSeq: number;

  readonly downloads?: DownloadsCapability;
  readonly clipboard?: ClipboardCapability;
  readonly bookmarks?: BookmarksCapability;
  readonly history?: HistoryCapability;
  readonly sessions: SessionStore;
  readonly observer: ObserverCapability;
  readonly cdp?: CdpCapability;

  cdpCalls: Array<{ method: string; args: unknown[] }> = [];
  capturedScreenshots = 0;
  injectedScripts: string[] = [];

  constructor(options: MockContextOptions = {}) {
    const window: RawWindow = { id: this.nextWindowId++, focused: true, state: "normal", type: "normal", tabs: [] };
    this.windows.set(window.id!, window);

    const initial = options.tabs ?? [{ url: "https://example.com/", title: "Example", active: true }];
    for (const tab of initial) this.addTab(tab);
    if (this.activeTabId === null) {
      const first = [...this.tabs.values()][0];
      if (first && typeof first.id === "number") this.setActive(first.id);
    }

    this.downloadsStore = options.downloads ?? [];
    // Seed the counters above any id the caller pre-loaded, so a fresh id
    // can never collide with (or reuse) a seeded or previously deleted one.
    this.nextDownloadId = this.downloadsStore.reduce((max, d) => Math.max(max, d.id), 0) + 1;
    this.nextBookmarkSeq =
      (options.bookmarks ?? []).reduce((max, b) => {
        const match = /^bm_(\d+)$/.exec(b.id);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 0) + 1;
    this.clipboardStore = options.clipboard ?? "";
    this.bookmarksStore = options.bookmarks ?? [];
    this.historyStore = options.history ?? [];
    this.frameTree = options.frameTree ?? [];
    this.browserInfo = {
      userAgent: "MockBrowser/1.0",
      platform: "test",
      // Product version 0.4.0: the mock must report the same version the
      // real extension reports (manifest.version), or tests that compare
      // browser.info against the product version pass against a stale value.
      extensionVersion: "0.5.0",
      browserVersion: "120.0.0",
      locale: "en-GB",
      timeZone: "Europe/London",
      manifestVersion: 3,
      ...options.browserInfo,
    };

    this.clipboard = {
      read: async () => this.clipboardStore,
      write: async (text: string) => {
        this.clipboardStore = text;
      },
    };
    this.downloads = {
      list: async ({ limit, query }) =>
        this.downloadsStore
          .filter((d) => !query || d.filename.includes(query) || d.url.includes(query))
          .slice(0, limit),
      control: async (id, action) => {
        const record = this.downloadsStore.find((d) => d.id === id);
        if (!record) throw new ToolErrorException("NOT_FOUND", `No download ${id}`);
        if (action === "cancel") this.downloadsStore = this.downloadsStore.filter((d) => d.id !== id);
        if (action === "pause") record.paused = true;
        if (action === "resume") record.paused = false;
      },
      start: async ({ url, filename }) => {
        const id = this.nextDownloadId++;
        const name = filename ?? url.split("/").pop() ?? "download";
        this.downloadsStore.push({
          id,
          filename: name,
          url,
          state: "in_progress",
          bytesReceived: 0,
          paused: false,
          startTime: new Date().toISOString(),
        });
        return { id, filename: name };
      },
      erase: async (ids) => {
        const before = this.downloadsStore.length;
        this.downloadsStore = this.downloadsStore.filter((d) => !ids.includes(d.id));
        return before - this.downloadsStore.length;
      },
    };
    this.bookmarks = {
      search: async (query, limit) => this.bookmarksStore.filter((b) => b.title.includes(query) || (b.url ?? "").includes(query)).slice(0, limit),
      list: async (_folderId, limit) => ({
        bookmarks: this.bookmarksStore.slice(0, limit),
        folders: [{ id: "1", title: "Bookmarks bar" }],
      }),
      create: async ({ title, url, parentId }) => {
        const record: BookmarkRecord = { id: `bm_${this.nextBookmarkSeq++}`, title, url, parentId, folder: "Bookmarks bar" };
        this.bookmarksStore.push(record);
        return record;
      },
      update: async ({ id, title, url }) => {
        const record = this.bookmarksStore.find((b) => b.id === id);
        if (!record) throw new ToolErrorException("NOT_FOUND", `No bookmark ${id}`);
        if (title) record.title = title;
        if (url) record.url = url;
        return record;
      },
      move: async ({ id, parentId }) => {
        const record = this.bookmarksStore.find((b) => b.id === id);
        if (!record) throw new ToolErrorException("NOT_FOUND", `No bookmark ${id}`);
        if (parentId) record.parentId = parentId;
        return record;
      },
      createFolder: async ({ title, parentId }) => {
        const id = `folder_${this.nextBookmarkSeq++}`;
        this.createdFolders.push({ id, title, parentId });
        return { id, title, parentId };
      },
      remove: async (id) => {
        this.bookmarksStore = this.bookmarksStore.filter((b) => b.id !== id);
      },
    };
    this.history = {
      search: async ({ text, maxResults }) => this.historyStore.filter((h) => h.url.includes(text) || h.title.includes(text)).slice(0, maxResults),
      add: async ({ url, title }) => {
        this.historyStore.push({
          // History ids are display-only in the mock (never re-addressed by
          // id after a delete, which removes by URL), so length-derived ids
          // here do not hide a reuse bug; downloads/bookmarks above use
          // monotonic counters because their ids ARE re-addressed.
          id: `h_${this.historyStore.length + 1}`,
          url,
          title: title ?? url,
          lastVisitTime: new Date().toISOString(),
          visitCount: 1,
        });
      },
      remove: async (urls) => {
        const before = this.historyStore.length;
        this.historyStore = this.historyStore.filter((h) => !urls.includes(h.url));
        return before - this.historyStore.length;
      },
    };
    this.sessions = {
      save: async (name, tabs) => {
        const session: SavedSession = { id: `sess_${this.sessionsStore.size + 1}`, name, tabs, createdAt: new Date().toISOString() };
        this.sessionsStore.set(session.id, session);
        return session;
      },
      get: async (id) => this.sessionsStore.get(id) ?? null,
      list: async () => [...this.sessionsStore.values()].map((s) => ({ id: s.id, name: s.name, tabCount: s.tabs.length })),
    };

    this.observer = {
      setEnabled: async (enabled, tabId) => {
        if (tabId === undefined) {
          for (const id of this.tabs.keys()) {
            this.observerStore.set(id, { ...(this.observerStore.get(id) ?? emptyObserverState()), enabled });
          }
          return { enabled, tabs: this.tabs.size };
        }
        this.observerStore.set(tabId, { ...(this.observerStore.get(tabId) ?? emptyObserverState()), enabled });
        return { enabled, tabs: 1 };
      },
      read: async (tabId) => {
        const entry = this.observerStore.get(tabId);
        if (!entry) throw new ToolErrorException("NOT_FOUND", `No observer attached to tab ${tabId}`);
        // Do NOT hardcode attached/pending: the old mock always reported
        // attached=true and 0 pending requests, which hid the real
        // networkIdle stale-snapshot bug from tests. attached reflects the
        // entry's enabled flag, and pending counts requests that have not
        // completed yet — a request with no status (and no duration) is
        // still in flight, matching the real observer's semantics.
        return {
          attached: entry.enabled,
          requests: entry.requests,
          dialogs: entry.dialogs,
          pendingRequests: entry.requests.filter((r) => r.status === undefined).length,
          defaultAnswer: entry.defaultAnswer,
        };
      },
      respond: async ({ tabId, dialogId, response, text }) => {
        const entry = this.observerStore.get(tabId);
        if (!entry) throw new ToolErrorException("NOT_FOUND", `No observer attached to tab ${tabId}`);
        const dialog = entry.dialogs.find((d) => d.id === dialogId) ?? entry.dialogs[entry.dialogs.length - 1];
        if (!dialog) throw new ToolErrorException("NOT_FOUND", "No pending dialog to answer");
        dialog.answered = response;
        if (text !== undefined) dialog.defaultValue = text;
        return { dialogId: dialog.id, response };
      },
    };

    if (options.cdpEnabled) {
      this.cdp = {
        available: () => true,
        click: async (tabId, x, y, button, clickCount) => {
          this.cdpCalls.push({ method: "click", args: [tabId, x, y, button, clickCount] });
        },
        move: async (tabId, x, y) => {
          this.cdpCalls.push({ method: "move", args: [tabId, x, y] });
        },
        type: async (tabId, text) => {
          this.cdpCalls.push({ method: "type", args: [tabId, text] });
        },
        press: async (tabId, key, modifiers) => {
          this.cdpCalls.push({ method: "press", args: [tabId, key, modifiers] });
        },
        scroll: async (tabId, x, y, deltaX, deltaY) => {
          this.cdpCalls.push({ method: "scroll", args: [tabId, x, y, deltaX, deltaY] });
        },
        drag: async (tabId, fromX, fromY, toX, toY) => {
          this.cdpCalls.push({ method: "drag", args: [tabId, fromX, fromY, toX, toY] });
        },
        captureScreenshot: async (tabId, clip, format, quality) => {
          this.cdpCalls.push({ method: "captureScreenshot", args: [tabId, clip, format, quality] });
          return "data:image/png;base64,mockcdp";
        },
        detach: async (tabId) => {
          this.cdpCalls.push({ method: "detach", args: [tabId] });
        },
      };
    }
  }

  /** Attach a fake observer to a tab so the observer tools can be exercised. */
  attachObserver(tabId: number, state: Partial<MockObserverState> = {}): void {
    this.observerStore.set(tabId, {
      enabled: true,
      requests: [],
      dialogs: [],
      defaultAnswer: "dismiss",
      defaultText: "",
      ...state,
    });
  }

  addTab(init: MockTabInit): RawTab {
    const windowId = init.windowId ?? 1;
    const tab: RawTab = {
      id: this.nextTabId++,
      index: this.tabs.size,
      windowId,
      active: init.active ?? false,
      pinned: init.pinned ?? false,
      highlighted: false,
      title: init.title ?? "",
      url: init.url,
      status: init.status ?? "complete",
      groupId: -1,
      discarded: false,
      incognito: false,
    };
    this.tabs.set(tab.id!, tab);
    this.windows.get(windowId)?.tabs?.push(tab);
    if (tab.active) this.setActive(tab.id!);
    return tab;
  }

  private setActive(tabId: number): void {
    for (const tab of this.tabs.values()) tab.active = tab.id === tabId;
    this.activeTabId = tabId;
  }

  async listTabs(query: TabSearchQuery): Promise<RawTab[]> {
    return [...this.tabs.values()].filter((t) => {
      if (query.windowId !== undefined && t.windowId !== query.windowId) return false;
      if (query.pinned !== undefined && t.pinned !== query.pinned) return false;
      if (query.audible !== undefined && (t.audible ?? false) !== query.audible) return false;
      if (query.discarded !== undefined && t.discarded !== query.discarded) return false;
      if (query.url && !(t.url ?? "").includes(query.url.replace("*", ""))) return false;
      if (query.title && !(t.title ?? "").toLowerCase().includes(query.title.replace("*", "").toLowerCase())) return false;
      return true;
    });
  }

  async getActiveTab(): Promise<RawTab | null> {
    if (this.activeTabId === null) {
      const active = [...this.tabs.values()].find((t) => t.active);
      return active ?? null;
    }
    return this.tabs.get(this.activeTabId) ?? null;
  }

  async getTab(tabId: number): Promise<RawTab> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ToolErrorException("NOT_FOUND", `No tab ${tabId}`);
    return tab;
  }

  async createTab(options: CreateTabOptions): Promise<RawTab> {
    const tab = this.addTab({ url: options.url, windowId: options.windowId ?? 1, active: options.active });
    return tab;
  }

  async updateTab(tabId: number, properties: UpdateTabProperties): Promise<RawTab> {
    const tab = await this.getTab(tabId);
    if (properties.active) this.setActive(tabId);
    if (properties.pinned !== undefined) tab.pinned = properties.pinned;
    if (properties.muted !== undefined) tab.audible = !properties.muted;
    if (properties.url !== undefined) {
      tab.url = properties.url;
      tab.status = "complete";
    }
    return tab;
  }

  async reloadTab(tabId: number, _bypassCache: boolean): Promise<RawTab> {
    return this.getTab(tabId);
  }

  async duplicateTab(tabId: number): Promise<RawTab> {
    const tab = await this.getTab(tabId);
    return this.addTab({ url: tab.url, title: tab.title, windowId: tab.windowId });
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ToolErrorException("NOT_FOUND", `No tab ${tabId}`);
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
  }

  async groupTabs(tabIds: number[], _options: { groupId?: number; title?: string; color?: string }): Promise<number> {
    const groupId = 100;
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = groupId;
    }
    return groupId;
  }

  async setTabZoom(tabId: number, zoom: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ToolErrorException("NOT_FOUND", `No tab ${tabId}`);
    tab.zoom = zoom;
  }

  async ungroupTabs(tabIds: number[]): Promise<void> {
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.groupId = -1;
    }
  }

  async moveTabs(tabIds: number[], windowId: number, _index?: number): Promise<void> {
    for (const id of tabIds) {
      const tab = this.tabs.get(id);
      if (tab) tab.windowId = windowId;
    }
  }

  async discardTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ToolErrorException("NOT_FOUND", `No tab ${tabId}`);
    tab.discarded = true;
    tab.status = "unloaded";
  }

  async goBack(_tabId: number): Promise<void> {}
  async goForward(_tabId: number): Promise<void> {}

  async listWindows(): Promise<RawWindow[]> {
    for (const window of this.windows.values()) window.tabs = [...this.tabs.values()].filter((t) => t.windowId === window.id);
    return [...this.windows.values()];
  }

  async createWindow(options: CreateWindowOptions): Promise<RawWindow> {
    const window: RawWindow = { id: this.nextWindowId++, focused: options.focused, state: "normal", type: "normal", tabs: [] };
    this.windows.set(window.id!, window);
    if (options.url) await this.createTab({ url: options.url, active: true, windowId: window.id });
    return window;
  }

  async updateWindow(windowId: number, properties: UpdateWindowProperties): Promise<RawWindow> {
    const window = this.windows.get(windowId);
    if (!window) throw new ToolErrorException("NOT_FOUND", `No window ${windowId}`);
    if (properties.state) window.state = properties.state;
    if (properties.focused !== undefined) window.focused = properties.focused;
    return window;
  }

  async closeWindow(windowId: number): Promise<void> {
    const window = this.windows.get(windowId);
    if (!window) throw new ToolErrorException("NOT_FOUND", `No window ${windowId}`);
    const tabIds = [...this.tabs.values()].filter((t) => t.windowId === windowId).map((t) => t.id!);
    for (const id of tabIds) await this.closeTab(id);
    this.windows.delete(windowId);
  }

  async executeInPage<Arg, Result>(_tabId: number, fn: PageFunction<Arg, Result>, arg: Arg, _options?: ScriptInjectionOptions): Promise<Result> {
    this.injectedScripts.push(fn.name || "anonymous");
    return await fn(arg);
  }

  /**
   * Simulated multi-frame injection. By default the mock behaves like a page
   * with only a top frame. Tests set `mockFrames` to declare extra frames; the
   * probe function then runs once per frame against the same jsdom document,
   * which is enough to exercise routing, ref prefixing and frames.list.
   */
  mockFrames: number[] = [0];

  async executeInFrames<Arg, Result>(
    _tabId: number,
    fn: PageFunction<Arg, Result>,
    arg: Arg,
    frameIds: number[] | "all",
    _options?: ScriptInjectionOptions,
  ): Promise<FrameResult<Result>[]> {
    this.injectedScripts.push(fn.name || "anonymous");
    const targets = frameIds === "all" ? this.mockFrames : frameIds.filter((id) => this.mockFrames.includes(id));
    const out: FrameResult<Result>[] = [];
    for (const frameId of targets) {
      try {
        out.push({ frameId, result: await fn(arg) });
      } catch (err) {
        out.push({ frameId, error: String(err) });
      }
    }
    return out;
  }

  async captureVisibleTab(_tabId: number, _options: { format: "png" | "jpeg"; quality?: number }): Promise<{ dataUrl: string; width: number; height: number }> {
    this.capturedScreenshots += 1;
    return { dataUrl: "data:image/png;base64,AAAA", width: 1280, height: 720 };
  }

  async captureElement(
    _tabId: number,
    rect: { x: number; y: number; width: number; height: number },
    _options: { format: "png" | "jpeg"; quality?: number },
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    return { dataUrl: "data:image/png;base64,BBBB", width: rect.width, height: rect.height };
  }

  async getBrowserInfo(): Promise<BrowserInfoData> {
    return this.browserInfo;
  }

  /** The frame tree, as the navigation API would report it. */
  async listFrameTree(_tabId: number): Promise<FrameTreeNode[]> {
    return this.frameTree;
  }
}
