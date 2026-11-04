/**
 * Tool-management metadata (Phases 2-4). This file is DATA about the
 * registry, not a second executor: it never changes what may run.
 *
 * Tags are intent tags, not category labels: every tool carries at least
 * one verb tag (what it does) and at least one object tag (what it acts
 * on). A tool whose tags were only its category would be vacuous filler;
 * the governance test pins >= 2 tags per tool and that no tool's tag set
 * is exactly its category alone. Tags flow into descriptors through
 * toToolDescriptor (tools.ts), so MCP discovery, the dashboard, and the
 * inventory report all read the same values.
 *
 * `requires` / `related` name existing registry tools (or, for unified
 * prerequisites, a plain-English prerequisite note in `requiresNote`).
 * `whenNotToUse` is a one-line steering note, never a policy rule.
 *
 * Deprecation (Phase 3) is per ACTION, not per tool, for navigate and
 * data: the tools themselves still work, and the deprecated actions
 * still work in 2.x with a warning. See isDeprecatedUnifiedAction.
 */

export interface ToolMeta {
  /** Intent tags: verb + object, never just the category. */
  tags: string[];
  /** Registry tool names that should normally run first. */
  requires?: string[];
  /** Plain-English prerequisite note (e.g. preview before submit). */
  requiresNote?: string;
  /** Registry tool names often needed next. */
  related?: string[];
  /** One-line steering note; never a policy rule. */
  whenNotToUse?: string;
  /** Whole-tool deprecation (unused in 2.x: deprecation is per action). */
  deprecated?: boolean;
  /** Tool to use instead, when deprecated. */
  useInstead?: string;
}

function m(tags: string[], extra: Omit<ToolMeta, "tags"> = {}): ToolMeta {
  return { tags, ...extra };
}

/** Intent tags + prerequisites + related tools for every registry tool. */
export const TOOL_META: Record<string, ToolMeta> = {
  // ---- tabs / windows (granular) ----
  "tabs.list": m(["list", "tabs", "read", "manage-tabs"], { related: ["tabs.active", "tabs.search"] }),
  "tabs.active": m(["get", "tabs", "read", "active-tab"], { related: ["tabs.list", "observe"] }),
  "tabs.get": m(["get", "tabs", "read", "tab-details"], { related: ["tabs.list"] }),
  "tabs.search": m(["search", "tabs", "read", "find-tab"], { related: ["tabs.list"] }),
  "tabs.create": m(["create", "tabs", "open-tab"], { related: ["tabs.activate"] }),
  "tabs.navigate": m(["navigate", "tabs", "open-url"], { related: ["observe"] }),
  "tabs.reload": m(["reload", "tabs", "refresh"], { related: ["observe"] }),
  "tabs.duplicate": m(["duplicate", "tabs", "copy-tab"], { related: ["tabs.list"] }),
  "tabs.activate": m(["activate", "tabs", "switch-tab", "focus-tab"], { related: ["observe"] }),
  "tabs.close": m(["close", "tabs", "discard-tab"], { related: ["tabs.list"] }),
  "tabs.group": m(["group", "tabs", "organize", "manage-tabs"], { related: ["tabs.ungroup", "workflows.organizeTabs"] }),
  "tabs.move": m(["move", "tabs", "reorder", "manage-tabs"], { related: ["tabs.group"] }),
  "tabs.pin": m(["pin", "tabs", "manage-tabs"], { related: ["tabs.list"] }),
  "tabs.ungroup": m(["ungroup", "tabs", "organize", "manage-tabs"], { related: ["tabs.group"] }),
  "tabs.mute": m(["mute", "tabs", "audio", "manage-tabs"], { related: ["tabs.list"] }),
  "tabs.setZoom": m(["zoom", "tabs", "magnify", "manage-tabs"], { related: ["tabs.list"] }),
  "tabs.discard": m(["discard", "tabs", "suspend", "manage-tabs"], { related: ["tabs.list"] }),
  "windows.list": m(["list", "windows", "read", "manage-windows"], { related: ["windows.create"] }),
  "windows.create": m(["create", "windows", "open-window"], { related: ["windows.list"] }),
  "windows.update": m(["update", "windows", "resize", "manage-windows"], { related: ["windows.list"] }),
  "windows.close": m(["close", "windows", "manage-windows"], { related: ["windows.list"] }),

  // ---- page (granular) ----
  "page.read": m(["read", "page-content", "text", "extract"], { related: ["page.metadata", "page.links"] }),
  "page.metadata": m(["read", "page-metadata", "title", "url"], { related: ["page.read", "page.outline"] }),
  "page.outline": m(["read", "page-structure", "headings", "outline"], { related: ["page.metadata"] }),
  "page.links": m(["read", "links", "collect", "page-content"], { related: ["workflows.collectLinks", "page.read"] }),
  "page.selectedText": m(["read", "selection", "text", "page-content"], { related: ["page.read"] }),
  "page.find": m(["find", "search", "page-content", "text"], { related: ["dom.find", "page.read"] }),
  "page.extract": m(["extract", "page-content", "structured-data", "read"], { related: ["page.tables", "page.links"] }),
  "page.waitFor": m(["wait", "sync", "element", "page-content"], { related: ["observe"] }),
  "page.tables": m(["read", "tables", "extract", "structured-data"], { related: ["workflows.extractTable", "page.read"] }),
  "page.networkIdle": m(["wait", "sync", "network-idle", "page-content"], { related: ["observe"] }),
  "page.accessibilityTree": m(["read", "accessibility", "a11y", "page-structure"], { related: ["observe", "dom.find"] }),
  "page.snapshot": m(["read", "snapshot", "page-content", "page-structure"], { related: ["observe"] }),
  "page.dialogs": m(["read", "dialogs", "page-content", "sensitive-read"], { related: ["page.respondDialog"] }),
  "page.respondDialog": m(["respond", "dialogs", "answer-dialog"], { requires: ["page.dialogs"], related: ["page.dialogs"] }),
  "navigation.open": m(["navigate", "open", "open-url", "page-navigation"], { related: ["observe", "page.networkIdle"] }),
  "navigation.back": m(["navigate", "back", "page-navigation"], { related: ["observe"] }),
  "navigation.forward": m(["navigate", "forward", "page-navigation"], { related: ["observe"] }),
  "navigation.reload": m(["reload", "navigate", "refresh", "page-navigation"], { related: ["observe"] }),
  "navigation.search": m(["search", "navigate", "web-search", "open-url"], { related: ["observe"] }),
  "navigation.wait": m(["wait", "sync", "navigation", "page-navigation"], { related: ["observe"] }),
  "frames.list": m(["list", "frames", "read", "page-structure"], { related: ["observe"] }),

  // ---- dom / forms / screenshots (granular) ----
  "dom.find": m(["find", "search", "dom", "elements"], { related: ["dom.read", "observe"] }),
  "dom.read": m(["read", "dom", "elements", "page-content"], { related: ["dom.find"] }),
  "dom.click": m(["click", "dom", "interact", "activate"], { requires: ["observe"], related: ["observe"] }),
  "dom.focus": m(["focus", "dom", "interact"], { requires: ["observe"] }),
  "dom.hover": m(["hover", "dom", "interact"], { requires: ["observe"] }),
  "dom.scroll": m(["scroll", "dom", "interact", "page-content"], { related: ["dom.scrollTo"] }),
  "dom.scrollTo": m(["scroll", "dom", "interact", "scroll-into-view"], { requires: ["observe"] }),
  "dom.select": m(["select", "dom", "interact", "dropdown"], { requires: ["observe"] }),
  "dom.setChecked": m(["check", "dom", "interact", "checkbox"], { requires: ["observe"] }),
  "dom.setRadio": m(["select", "dom", "interact", "radio"], { requires: ["observe"] }),
  "dom.fill": m(["fill", "dom", "interact", "form-field"], { requires: ["observe"], related: ["forms.fill"] }),
  "dom.type": m(["type", "dom", "interact", "typing"], { requires: ["observe"] }),
  "dom.press": m(["press", "dom", "interact", "keyboard"], { requires: ["observe"] }),
  "dom.clickAt": m(["click", "coordinates", "interact", "dom"], { related: ["screenshots.visible"] }),
  "dom.typeAt": m(["type", "coordinates", "interact", "dom"], { related: ["dom.type", "dom.clickAt"] }),
  "dom.pressAt": m(["press", "coordinates", "interact", "keyboard"], { related: ["dom.press", "dom.clickAt"] }),
  "dom.moveTo": m(["move", "coordinates", "interact", "mouse"], { related: ["dom.hover"] }),
  "dom.drag": m(["drag", "dom", "interact", "drag-drop"], { requires: ["observe"] }),
  "dom.dragAt": m(["drag", "coordinates", "interact", "drag-drop"], { related: ["screenshots.visible"] }),
  "dom.boundingBox": m(["read", "dom", "coordinates", "position"], { related: ["dom.clickAt"] }),
  "dom.visible": m(["read", "dom", "visibility", "elements"], { related: ["dom.find"] }),
  "dom.clear": m(["clear", "dom", "interact", "form-field"], { requires: ["observe"] }),
  "dom.submit": m(["submit", "dom", "interact", "form"], { requires: ["forms.preview"], requiresNote: "Preview/inspect the form before submitting.", related: ["forms.submit"] }),
  "dom.waitFor": m(["wait", "dom", "sync", "element"], { related: ["observe"] }),
  "dom.shadow": m(["read", "shadow-dom", "dom", "page-structure"], { related: ["dom.find"] }),
  "forms.inspect": m(["inspect", "forms", "read", "form-fields"], { related: ["forms.fill", "forms.preview"] }),
  "forms.fill": m(["fill", "forms", "form-fields", "interact"], { requires: ["forms.inspect"], related: ["forms.preview", "forms.submit"] }),
  "forms.submit": m(["submit", "forms", "send-form", "external"], { requires: ["forms.preview"], requiresNote: "Preview is required before submit.", related: ["forms.preview", "forms.fill"] }),
  "forms.preview": m(["preview", "forms", "read", "verify-form"], { requires: ["forms.fill"], related: ["forms.submit"] }),
  "forms.upload": m(["upload", "forms", "attach-file", "form-fields"], { requires: ["forms.inspect"], related: ["forms.submit"] }),
  "forms.setFile": m(["set-file", "forms", "attach-file", "form-fields"], { requires: ["forms.inspect"], related: ["forms.submit"] }),
  "screenshots.visible": m(["screenshot", "capture", "visible-page", "image"], { related: ["observe"] }),
  "screenshots.element": m(["screenshot", "capture", "element", "image"], { requires: ["observe"], related: ["screenshots.visible"] }),
  "screenshots.viewport": m(["screenshot", "capture", "viewport", "image"], { related: ["screenshots.visible"] }),
  "screenshots.fullPage": m(["screenshot", "capture", "full-page", "image"], { related: ["screenshots.visible"] }),

  // ---- downloads / clipboard / browser / devtools (granular) ----
  "downloads.list": m(["list", "downloads", "read", "manage-downloads"], { related: ["downloads.start"] }),
  "downloads.control": m(["control", "downloads", "pause", "resume-download"], { requires: ["downloads.list"] }),
  "downloads.start": m(["download", "downloads", "fetch-file", "external"], { related: ["downloads.list"] }),
  "downloads.erase": m(["delete", "downloads", "erase", "manage-downloads"], { requires: ["downloads.list"] }),
  "clipboard.read": m(["read", "clipboard", "paste", "sensitive-read"], { related: ["clipboard.write"] }),
  "clipboard.write": m(["write", "clipboard", "copy", "external"], { related: ["clipboard.read"] }),
  "browser.info": m(["read", "browser", "status", "diagnostics"], { related: ["browser.capabilities"] }),
  "browser.capabilities": m(["read", "browser", "capabilities", "diagnostics"], { related: ["browser.info"] }),
  "browser.permissions": m(["read", "browser", "permissions", "diagnostics"], { related: ["browser.info"] }),
  "browser.activeContext": m(["read", "browser", "active-context", "tabs"], { related: ["tabs.active"] }),
  "browser.diagnostics": m(["read", "browser", "diagnostics", "status"], { related: ["browser.info"] }),
  "browser.observer": m(["observe", "browser", "watch", "page-changes"], { related: ["observe"] }),
  "browser.search": m(["search", "browser", "history", "bookmarks"], { related: ["history.search", "bookmarks.search", "tabs.search"] }),
  "browser.captureTab": m(["screenshot", "capture", "browser", "tab-image"], { related: ["screenshots.visible"] }),
  "devtools.network": m(["read", "devtools", "network", "requests"], { related: ["devtools.console"] }),
  "devtools.dom": m(["read", "devtools", "dom", "page-structure"], { related: ["observe"] }),
  "devtools.performance": m(["read", "devtools", "performance", "timing"], { related: ["devtools.network"] }),
  "devtools.pageErrors": m(["read", "devtools", "errors", "page-errors"], { related: ["devtools.console"] }),
  "devtools.console": m(["read", "devtools", "console", "logs"], { related: ["devtools.pageErrors", "devtools.network"] }),

  // ---- bookmarks / history / files (granular) ----
  "bookmarks.search": m(["search", "bookmarks", "read", "manage-bookmarks"], { related: ["bookmarks.list"] }),
  "bookmarks.list": m(["list", "bookmarks", "read", "manage-bookmarks"], { related: ["bookmarks.search"] }),
  "bookmarks.create": m(["create", "bookmarks", "save-bookmark", "manage-bookmarks"], { related: ["bookmarks.list"] }),
  "bookmarks.update": m(["update", "bookmarks", "edit", "manage-bookmarks"], { requires: ["bookmarks.list"] }),
  "bookmarks.delete": m(["delete", "bookmarks", "remove", "manage-bookmarks"], { requires: ["bookmarks.list"] }),
  "bookmarks.move": m(["move", "bookmarks", "reorder", "manage-bookmarks"], { requires: ["bookmarks.list"] }),
  "bookmarks.createFolder": m(["create", "bookmarks", "folder", "manage-bookmarks"], { related: ["bookmarks.list"] }),
  "history.add": m(["add", "history", "record-visit", "manage-history"], { related: ["history.search"] }),
  "history.search": m(["search", "history", "read", "manage-history"], { related: ["browser.search"] }),
  "history.delete": m(["delete", "history", "erase", "manage-history"], { requires: ["history.search"] }),
  "files.list": m(["list", "files", "read", "manage-files"], { related: ["files.stat"] }),
  "files.stat": m(["stat", "files", "read", "file-details"], { requires: ["files.list"] }),

  // ---- workflows (granular) ----
  "workflows.summarizePage": m(["summarise", "summarize", "page-content", "read", "workflow"], { related: ["page.read", "page.metadata"] }),
  "workflows.compareTabs": m(["compare", "tabs", "read", "workflow"], { requires: ["tabs.list"], related: ["page.read"] }),
  "workflows.extractTable": m(["extract", "tables", "structured-data", "read", "workflow"], { related: ["page.tables"] }),
  "workflows.collectLinks": m(["collect", "links", "read", "workflow"], { related: ["page.links"] }),
  "workflows.openSequence": m(["open", "sequence", "tabs", "workflow"], { related: ["tabs.create"] }),
  "workflows.fillFormForReview": m(["fill", "forms", "review", "workflow"], { requires: ["forms.inspect"], requiresNote: "Fills for review only; it does not submit.", related: ["forms.preview"] }),
  "workflows.organizeTabs": m(["organize", "organise", "tabs", "manage-tabs", "workflow"], { requires: ["tabs.list"], related: ["tabs.group", "tabs"] }),
  "workflows.saveSession": m(["save", "session", "tabs", "workflow"], { requires: ["tabs.list"], related: ["workflows.restoreSession"] }),
  "workflows.restoreSession": m(["restore", "session", "tabs", "workflow"], { related: ["workflows.saveSession"] }),
  "workflows.researchReport": m(["research", "search", "report", "read", "workflow"], { related: ["browser.search", "page.read"] }),

  // ---- unified (13) ----
  browser: m(["browser", "search", "diagnostics", "read", "status"], { related: ["observe", "data"], whenNotToUse: "Do not use browser for page content; use observe." }),
  tabs: m(["tabs", "manage-tabs", "list", "create", "organize"], { related: ["workflows.organizeTabs", "windows", "observe"], whenNotToUse: "For a single precise tab action, the granular tabs.* tool is clearer; tabs is the default client-facing layer." }),
  windows: m(["windows", "manage-windows", "list", "create"], { related: ["tabs"] }),
  navigate: m(["navigate", "open", "reload", "sync", "search"], { related: ["observe", "tabs", "windows"], whenNotToUse: "Do not use navigate tab/window actions; use tabs.* / windows.* instead (deprecated in 2.x, removal in registry 3.0)." }),
  observe: m(["observe", "read", "page-content", "accessibility", "find"], { related: ["act", "form", "screenshots.visible"] }),
  act: m(["act", "click", "type", "fill", "interact"], { requires: ["observe"], requiresNote: "Observe first to obtain element refs.", related: ["observe"] }),
  wait: m(["wait", "sync", "network-idle", "element"], { related: ["navigate", "observe"] }),
  form: m(["form", "fill", "submit", "preview", "inspect"], { requiresNote: "Preview is required before submit.", related: ["observe", "act"] }),
  submit: m(["submit", "form", "upload", "external"], { requires: ["form"], requiresNote: "Preview the form (form preview) before submitting.", related: ["form"] }),
  devtools: m(["devtools", "console", "network", "errors", "performance"], { related: ["observe"] }),
  data: m(["data", "bookmarks", "history", "downloads", "search"], { related: ["browser", "clipboard", "devtools"], whenNotToUse: "Do not use data for clipboard or devtools; use clipboard / devtools instead (deprecated in 2.x, removal in registry 3.0)." }),
  clipboard: m(["clipboard", "read", "write", "sensitive-read"], { related: ["data"] }),
  files: m(["files", "list", "stat", "read"], { related: ["data"] }),

  // ---- tasks (granular, stay granular) ----
  "tasks.create": m(["task", "create", "multi-step", "workflow"], { related: ["tasks.list", "tasks.get"] }),
  "tasks.appendSteps": m(["task", "append", "follow-up", "workflow"], { related: ["tasks.create", "tasks.list"], requires: ["tasks.list"] }),
  "tasks.get": m(["task", "get", "read", "status"], { related: ["tasks.list"] }),
  "tasks.list": m(["list", "task", "read", "status"], { related: ["tasks.get"] }),
  "tasks.pause": m(["task", "pause", "stop-task"], { requires: ["tasks.list"] }),
  "tasks.resume": m(["task", "resume", "continue-task"], { requires: ["tasks.list"] }),
  "tasks.cancel": m(["task", "cancel", "stop-task"], { requires: ["tasks.list"] }),

  // ---- meta tools ----
  "tools.batch": m(["batch", "read", "parallel", "workflow"], { related: ["observe", "tools.discover"] }),
  "tools.discover": m(["discover", "search", "tools", "find-tool"], { related: ["tools.batch"] }),
};

/** Metadata for one tool name, or undefined when the registry has no entry. */
export function toolMetaFor(name: string): ToolMeta | undefined {
  return TOOL_META[name];
}

// ---------------------------------------------------------------------------
// Phase 3 deprecation (per action, 2.x: warning only, still working)
// ---------------------------------------------------------------------------

const NAVIGATE_TAB_ACTIONS = new Set([
  "list", "get", "active", "search", "create", "close", "activate", "switch",
  "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup",
  "save_session", "restore_session", "organize",
]);

export interface DeprecatedActionInfo {
  deprecated: true;
  useInstead: string;
  note: string;
}

/**
 * Deprecated unified actions (registry 2.2 deprecation, removal only in
 * registry 3.0, and only with live-usage evidence — see the Phase 4
 * removal guard in the report). Returns null for non-deprecated actions.
 *
 * - navigate tab/window actions: any tab action, plus the window-branch
 *   actions (list/create/update/close under category=window, which the
 *   handler routes to windows.*). Tab-only actions under category=window
 *   still route to tabs.*. URL and sync actions are NOT deprecated.
 * - data devtools / clipboard domains: every action in those domains.
 *   data bookmarks/history/downloads/files actions are NOT deprecated.
 */
export function deprecatedUnifiedAction(
  tool: string,
  action: string,
  domain?: string,
): DeprecatedActionInfo | null {
  if (tool === "navigate") {
    if (domain === "tab" || domain === "window") {
      if (action === "update") {
        return { deprecated: true, useInstead: "windows.update", note: "Deprecated: navigate window update is superseded by windows.update; it still works in 2.x and will be removed in registry 3.0." };
      }
      if (domain === "window" && (action === "list" || action === "create" || action === "close")) {
        return { deprecated: true, useInstead: `windows.${action}`, note: `Deprecated: navigate window action "${action}" is superseded by windows.${action}; it still works in 2.x and will be removed in registry 3.0.` };
      }
      if (NAVIGATE_TAB_ACTIONS.has(action)) {
        const useInstead = action === "switch" ? "tabs.activate" : action === "zoom" ? "tabs.setZoom" : `tabs.${action}`;
        return { deprecated: true, useInstead, note: `Deprecated: navigate tab action "${action}" is superseded by ${useInstead}; it still works in 2.x and will be removed in registry 3.0.` };
      }
      return null;
    }
    if (NAVIGATE_TAB_ACTIONS.has(action)) {
      const useInstead = action === "switch" ? "tabs.activate" : action === "zoom" ? "tabs.setZoom" : `tabs.${action}`;
      return { deprecated: true, useInstead, note: `Deprecated: navigate tab action "${action}" is superseded by ${useInstead}; it still works in 2.x and will be removed in registry 3.0.` };
    }
    if (action === "update") {
      return { deprecated: true, useInstead: "windows.update", note: "Deprecated: navigate update is superseded by windows.update; it still works in 2.x and will be removed in registry 3.0." };
    }
    return null;
  }
  if (tool === "data" && (domain === "devtools" || domain === "clipboard")) {
    // The generic devtools.${action} template is wrong for four actions,
    // whose real granular tools live elsewhere (see the action-risk
    // table): errors -> devtools.pageErrors, observer -> browser.observer,
    // dialogs -> page.dialogs, respond_dialog -> page.respondDialog.
    // Only console / network / performance survive the template.
    const DEVTOOLS_USE_INSTEAD: Record<string, string> = {
      errors: "devtools.pageErrors",
      observer: "browser.observer",
      dialogs: "page.dialogs",
      respond_dialog: "page.respondDialog",
    };
    const useInstead = domain === "clipboard" ? `clipboard.${action}` : (DEVTOOLS_USE_INSTEAD[action] ?? `devtools.${action}`);
    return { deprecated: true, useInstead, note: `Deprecated: data domain "${domain}" is superseded by ${useInstead}; it still works in 2.x and will be removed in registry 3.0.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 4: suggestions only (never restrictions), client caps (documented)
// ---------------------------------------------------------------------------

/**
 * Task-type recommendations: SUGGESTIONS in discovery only. They never
 * replace policy, scope, or approval, and they never restrict which tools
 * a client may discover or call.
 */
export const TASK_TYPE_RECOMMENDATIONS: Record<string, { tools: string[]; note: string }> = {
  research: {
    tools: ["observe", "browser.search", "page.read", "page.links", "tools.batch"],
    note: "Research suggestion: start with observe, search with browser.search, and batch independent reads with tools.batch.",
  },
  form: {
    tools: ["form", "forms.inspect", "forms.preview", "forms.fill", "forms.submit"],
    note: "Form suggestion: inspect, fill, preview, then submit — preview is required before submit.",
  },
  organise: {
    tools: ["tabs", "workflows.organizeTabs", "tabs.group", "tabs.list"],
    note: "Organise suggestion: list tabs, group or organise them; organising requires approval through the workflow gate.",
  },
  // American-spelling alias of `organise` (same object): discovery
  // normalises the lookup too, so both spellings resolve either way.
  organize: {
    tools: ["tabs", "workflows.organizeTabs", "tabs.group", "tabs.list"],
    note: "Organise suggestion: list tabs, group or organise them; organising requires approval through the workflow gate.",
  },
};

/**
 * ListTools caps. These are Muze's own conservative caps, NOT vendor
 * limits: no Claude or ChatGPT tool-count limit is asserted here, because
 * no such limit has been verified from a vendor source. All client types
 * share the same conservative value until live tests measure a real
 * difference; the plumbing (classifyClientType + per-type lookup) is
 * what is client-aware, so a measured value can be slotted in later
 * without changing call sites.
 */
export const LISTTOOLS_CAPS: Record<string, number> = {
  claude: 50,
  chatgpt: 50,
  unknown: 50,
};
export const DEFAULT_LISTTOOLS_CAP = 50;
/** Discovery caps live in discovery.ts (single definition, no duplicates). */

/** Record the client type at initialize ONLY if the client declares it. */
export function classifyClientType(clientInfoName?: string): string {
  if (!clientInfoName) return "unknown";
  const name = clientInfoName.toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  return "unknown";
}

export function listToolsCapForClientType(clientType?: string): number {
  if (!clientType) return DEFAULT_LISTTOOLS_CAP;
  return LISTTOOLS_CAPS[clientType] ?? DEFAULT_LISTTOOLS_CAP;
}
