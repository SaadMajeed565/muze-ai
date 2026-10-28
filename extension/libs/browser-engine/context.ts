/**
 * The browser operations the tool engine depends on. The Chrome extension
 * supplies a chrome.*-backed implementation; tests supply a mock. Keeping this
 * an interface is what makes the engine reusable and unit-testable.
 */

export interface RawTab {
  id?: number;
  index: number;
  windowId: number;
  active: boolean;
  pinned: boolean;
  highlighted: boolean;
  title?: string;
  url?: string;
  status?: string;
  groupId: number;
  audible?: boolean;
  discarded: boolean;
  incognito: boolean;
  zoom?: number;
}

export interface RawWindow {
  id?: number;
  focused: boolean;
  state?: string;
  type?: string;
  tabs?: RawTab[];
  alwaysOnTop?: boolean;
}

export interface CreateTabOptions {
  url?: string;
  active: boolean;
  windowId?: number;
  groupId?: number;
  pinned?: boolean;
  openerTabId?: number;
  index?: number;
}

export interface UpdateTabProperties {
  active?: boolean;
  pinned?: boolean;
  url?: string;
  muted?: boolean;
}

export interface CreateWindowOptions {
  url?: string;
  focused: boolean;
  incognito: boolean;
}

export interface UpdateWindowProperties {
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  focused?: boolean;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

/** The filters Chrome's own tab search understands. */
export interface TabSearchQuery {
  windowId?: number;
  currentWindowOnly?: boolean;
  pinned?: boolean;
  audible?: boolean;
  discarded?: boolean;
  /** Chrome match pattern, for example https://example.com/* */
  url?: string;
  /** Chrome match pattern, for example *Invoice* */
  title?: string;
}

export interface DownloadRecord {
  id: number;
  filename: string;
  url: string;
  state: "in_progress" | "interrupted" | "complete" | "unknown";
  bytesReceived: number;
  totalBytes?: number;
  paused: boolean;
  startTime: string;
  error?: string;
}

export interface BookmarkRecord {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: string;
  folder: string;
}

export interface HistoryRecord {
  id: string;
  url: string;
  title: string;
  lastVisitTime: string;
  visitCount: number;
}

export interface BrowserInfoData {
  userAgent: string;
  platform: string;
  extensionVersion: string;
  /** The Chrome build the browser is running. */
  browserVersion?: string;
  /** The interface language of the browser, e.g. "en-GB". */
  locale?: string;
  /** The browser's time zone, e.g. "Europe/London". */
  timeZone?: string;
  /** The extension's manifest version. */
  manifestVersion?: number;
}

export interface ScriptInjectionOptions {
  timeoutMs?: number;
  world?: "ISOLATED" | "MAIN";
}

/** One node of a tab's frame tree. */
export interface FrameTreeNode {
  /** `0` is the top frame. */
  frameId: number;
  /** The frame that contains this one, or `-1` for the top frame. */
  parentFrameId: number;
  url: string;
  /** True when the last navigation in this frame failed. */
  errorOccurred: boolean;
}

/** One frame's result from a multi-frame injection. `frameId` 0 is the top frame. */
export interface FrameResult<Arg> {
  frameId: number;
  result?: Arg;
  error?: string;
}

/**
 * A self-contained function that runs in the page's isolated world. It must not
 * close over any outer variables because it is serialized by the browser.
 */
export type PageFunction<Arg, Result> = (arg: Arg) => Result | Promise<Result>;

export interface DownloadsCapability {
  list(query: { limit: number; query?: string }): Promise<DownloadRecord[]>;
  control(id: number, action: "pause" | "resume" | "cancel"): Promise<void>;
  start(opts: {
    url: string;
    /** A path relative to the browser's download folder. */
    filename?: string;
    saveAs: boolean;
    conflictAction?: "uniquify" | "overwrite" | "prompt";
  }): Promise<{ id: number; filename: string }>;
  erase(ids: number[]): Promise<number>;
}

export interface ClipboardCapability {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export interface BookmarkRecordList {
  bookmarks: BookmarkRecord[];
  folders: { id: string; title: string }[];
}

export interface BookmarksCapability {
  search(query: string, limit: number): Promise<BookmarkRecord[]>;
  list(folderId: string | undefined, limit: number): Promise<BookmarkRecordList>;
  create(input: { title: string; url: string; parentId?: string }): Promise<BookmarkRecord>;
  update(input: { id: string; title?: string; url?: string }): Promise<BookmarkRecord>;
  move(input: { id: string; parentId?: string; index?: number }): Promise<BookmarkRecord>;
  createFolder(input: { title: string; parentId?: string; index?: number }): Promise<{ id: string; title: string; parentId?: string }>;
  remove(id: string): Promise<void>;
}

export interface HistoryCapability {
  search(input: { text: string; startTime?: number; endTime?: number; maxResults: number }): Promise<HistoryRecord[]>;
  add(input: { url: string; title?: string; transition?: string }): Promise<void>;
  remove(urls: string[]): Promise<number>;
}

/** One omnibox suggestion. */
export interface SearchSuggestion {
  title: string;
  url: string;
  type: string;
}

export interface SearchCapability {
  query(text: string, maxResults: number): Promise<SearchSuggestion[]>;
}

/** A request the page observer saw. Bodies are never recorded. */
export interface ObservedRequest {
  id: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  startedAt: string;
  durationMs?: number;
  failed?: boolean;
}

/** A JavaScript dialog the page opened. */
export interface ObservedDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  at: string;
  answered: "accept" | "dismiss";
}

export interface ObserverState {
  attached: boolean;
  requests: ObservedRequest[];
  dialogs: ObservedDialog[];
  pendingRequests: number;
  defaultAnswer: "accept" | "dismiss";
}

export interface ObserverCapability {
  /** Turn the observer on or off for a tab, or for every tab when tabId is omitted. */
  setEnabled(enabled: boolean, tabId?: number): Promise<{ enabled: boolean; tabs: number }>;
  /** The observer's state for a tab. */
  read(tabId: number): Promise<ObserverState>;
  /** Answer a pending dialog. */
  respond(input: { tabId: number; dialogId?: string; response: "accept" | "dismiss"; text?: string }): Promise<{ dialogId: string; response: string }>;
  /**
   * Re-apply the persisted on/off state. Implementations that survive a
   * service worker restart use this to report the state the user actually
   * chose rather than a fresh default.
   */
  restore?(): Promise<{ enabled: boolean }>;
}

export interface SavedSession {
  id: string;
  name: string;
  tabs: { url: string; title: string }[];
  createdAt: string;
}

export interface SessionStore {
  save(name: string, tabs: { url: string; title: string }[]): Promise<SavedSession>;
  get(id: string): Promise<SavedSession | null>;
  list(): Promise<{ id: string; name: string; tabCount: number }[]>;
}

export interface CdpCapability {
  available(): boolean;
  click(tabId: number, x: number, y: number, button?: "left" | "right" | "middle", clickCount?: number): Promise<void>;
  move(tabId: number, x: number, y: number): Promise<void>;
  type(tabId: number, text: string): Promise<void>;
  press(tabId: number, key: string, modifiers?: number): Promise<void>;
  scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  drag(tabId: number, fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  captureScreenshot?(tabId: number, clip?: { x: number; y: number; width: number; height: number; scale?: number }, format?: "jpeg" | "png", quality?: number): Promise<string>;
  detach?(tabId: number): Promise<void>;
}

export interface BrowserContext {
  // Tabs
  listTabs(query: TabSearchQuery): Promise<RawTab[]>;
  getActiveTab(): Promise<RawTab | null>;
  getTab(tabId: number): Promise<RawTab>;
  createTab(options: CreateTabOptions): Promise<RawTab>;
  updateTab(tabId: number, properties: UpdateTabProperties): Promise<RawTab>;
  /**
   * Chrome exposes tab zoom through a dedicated API rather than
   * `tabs.update`, so it gets its own method.
   */
  setTabZoom(tabId: number, zoom: number): Promise<void>;
  reloadTab(tabId: number, bypassCache: boolean): Promise<RawTab>;
  duplicateTab(tabId: number): Promise<RawTab>;
  closeTab(tabId: number): Promise<void>;
  groupTabs(tabIds: number[], options: { groupId?: number; title?: string; color?: string }): Promise<number>;
  ungroupTabs(tabIds: number[]): Promise<void>;
  moveTabs(tabIds: number[], windowId: number, index?: number): Promise<void>;
  discardTab(tabId: number): Promise<void>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;

  // Windows
  listWindows(): Promise<RawWindow[]>;
  createWindow(options: CreateWindowOptions): Promise<RawWindow>;
  updateWindow(windowId: number, properties: UpdateWindowProperties): Promise<RawWindow>;
  closeWindow(windowId: number): Promise<void>;

  // Page execution & capture
  executeInPage<Arg, Result>(tabId: number, fn: PageFunction<Arg, Result>, arg: Arg, options?: ScriptInjectionOptions): Promise<Result>;
  /**
   * Run a self-contained function in the top frame and/or every sub-frame of a
   * tab. `frameIds: "all"` targets every frame; an array targets only those
   * frame ids. Results are returned per frame so callers can tell where each
   * answer came from. Frames the extension cannot script are skipped.
   */
  executeInFrames<Arg, Result>(
    tabId: number,
    fn: PageFunction<Arg, Result>,
    arg: Arg,
    frameIds: number[] | "all",
    options?: ScriptInjectionOptions,
  ): Promise<FrameResult<Result>[]>;
  /**
   * The frame tree of a tab, with each frame's parent. Optional: a browser
   * without the navigation API reports no hierarchy, and the caller falls back
   * to a flat list.
   */
  listFrameTree?(tabId: number): Promise<FrameTreeNode[]>;
  captureVisibleTab(tabId: number, options: { format: "png" | "jpeg"; quality?: number }): Promise<{ dataUrl: string; width: number; height: number }>;
  /** Optional: crop a region out of a visible-tab capture (needs a canvas). */
  captureElement?(
    tabId: number,
    rect: { x: number; y: number; width: number; height: number },
    options: { format: "png" | "jpeg"; quality?: number },
  ): Promise<{ dataUrl: string; width: number; height: number }>;
  /**
   * Optional: capture a whole scrollable page by scrolling, capturing and
   * stitching. Falls back to the viewport capture when the offscreen
   * document cannot stitch.
   */
  captureFullPage?(
    tabId: number,
    options: { format: "png" | "jpeg"; quality?: number; maxHeight: number },
  ): Promise<{ dataUrl: string; width: number; height: number; pages: number }>;

  // Browser info
  getBrowserInfo(): Promise<BrowserInfoData>;

  // Optional capability groups (absent => UNSUPPORTED)
  downloads?: DownloadsCapability;
  clipboard?: ClipboardCapability;
  bookmarks?: BookmarksCapability;
  history?: HistoryCapability;
  observer?: ObserverCapability;
  sessions?: SessionStore;
  cdp?: CdpCapability;
}

export class UnsupportedCapabilityError extends Error {
  constructor(capability: string) {
    super(`Capability "${capability}" is not available in this browser context`);
    this.name = "UnsupportedCapabilityError";
  }
}
