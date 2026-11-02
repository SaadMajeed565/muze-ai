import type { RiskLevel } from "./tools.js";

/**
 * Per-action risk table for the 13 unified tools (Tool Management Plan
 * section 2.1 / Phase 1, section A). Unified tools are a facade: each
 * dispatch key maps here to the granular tool the browser-engine handler
 * actually invokes, with that granular tool's risk and approval predicate.
 *
 * Dispatch key ("action" column) by tool:
 * - browser, tabs, windows, devtools, clipboard, files, submit: the `action` field.
 * - navigate: the `action` field, plus the `domain` column carrying the
 *   `category` variant (tab / window / url) or, for sync, `sync:<for>`.
 *   An entry with no domain is the action-only dispatch (no category).
 * - data: the `action` field, with `domain` = the data domain
 *   (bookmarks / history / downloads / clipboard / files / devtools).
 *   Only domain x action pairs the handler actually dispatches are listed;
 *   any other pair throws INVALID_INPUT in the handler, it is not a mapping.
 * - form: the `phase` / `action` value (the handler treats them as aliases).
 * - observe: the `include` value (one entry per include; a call may carry
 *   several, each resolved independently).
 * - act: the step `do` value (steps[] are resolved per step).
 * - wait: the `for` value.
 *
 * Approval semantics:
 * - `requiresApproval` mirrors the GRANULAR tool's predicate, not the
 *   policy-by-risk layer. The executor applies policy-by-risk as a second
 *   gate on every nested invoke (default policy: sensitive-read and
 *   consequential require approval), so a table value of `false` for a
 *   sensitive-read granular tool does NOT mean the call runs ungated.
 * - `'granular'` means the approval decision is conditional and must be
 *   deferred to the granular handler at call time. It is used only for
 *   act click / press, whose granular handlers run an activation check:
 *   an ordinary click needs no approval, a click (or Enter/Space press)
 *   on a consequential control (submit, download, buy, ...) does, and that
 *   cannot be expressed as a static boolean. The unified act handler
 *   additionally pre-scans those steps so approval is required BEFORE
 *   any step in the batch runs.
 * - `sideEffect` is separate from risk (plan 2.1): a reversible close is
 *   browser-state, not destructive; destructive is reserved for
 *   delete/erase actions whose data is hard to recover.
 * - `idempotent` means repeating the exact call yields the same end state
 *   (reads, set-to-value ops); it is omitted where that is not clear-cut.
 * - A multi-target action records its PRIMARY granular target and notes
 *   the conditional in `note`; its risk is the HIGHEST among the
 *   conditional targets (fail closed).
 * - An action with NO granular target is flagged, never silently mapped:
 *   its granularTool is a `local:` sentinel, its risk is `restricted`,
 *   and requiresApproval is true, so a per-action manager denies it
 *   until a real granular target exists. There are exactly two such
 *   actions: wait delay and navigate sync delay, both implemented
 *   locally in the handler via abortableDelay (a sleep, no side effect).
 *   The restricted flag is about unmappability, not about danger.
 */

export type ActionSideEffect = "none" | "browser-state" | "external-visible" | "destructive";

export interface ActionRiskEntry {
  unifiedTool: string;
  /** Dispatch key: see the header comment for what this is per tool. */
  action: string;
  /**
   * Dispatch context. For `data` this is the data domain; for `navigate`
   * this is the category variant (`tab`, `window`, `url`, or `sync:<for>`).
   * Undefined means the action-only dispatch (no domain / no category).
   */
  domain?: string;
  /** Granular tool the handler invokes, or a `local:` sentinel (see header). */
  granularTool: string;
  risk: RiskLevel;
  /**
   * Granular approval predicate: a boolean, or 'granular' to defer to the
   * granular handler's conditional check at call time (act click / press).
   */
  requiresApproval: boolean | "granular";
  sideEffect: ActionSideEffect;
  idempotent?: boolean;
  /** Conditional-target note, alias note, or gate note. */
  note?: string;
}

type E = ActionRiskEntry;

function e(
  unifiedTool: string,
  action: string,
  granularTool: string,
  risk: RiskLevel,
  requiresApproval: boolean | "granular",
  sideEffect: ActionSideEffect,
  opts: { domain?: string; idempotent?: boolean; note?: string } = {},
): E {
  return { unifiedTool, action, granularTool, risk, requiresApproval, sideEffect, ...opts };
}

/** Complete per-action risk table for all 13 unified tools (179 entries:
 * browser 5, tabs 19, windows 4, navigate 75 = action-only 25 +
 * category=tab 21 + category=window 19 + category=url 6 + category=sync 4,
 * observe 13, act 13, wait 4, form 6, submit 3, devtools 7, data 26,
 * clipboard 2, files 2). Every unified tool's dispatched actions are
 * covered; an undispatched pair is absent by design and throws
 * INVALID_INPUT in the handler. */
export const UNIFIED_ACTION_RISK: readonly ActionRiskEntry[] = [
  // ---- browser (5) ----
  e("browser", "status", "browser.info", "read-only", false, "none", { idempotent: true }),
  e("browser", "capabilities", "browser.capabilities", "read-only", false, "none", { idempotent: true }),
  e("browser", "permissions", "browser.permissions", "read-only", false, "none", { idempotent: true }),
  e("browser", "diagnostics", "browser.diagnostics", "read-only", false, "none", { idempotent: true }),
  // Granular predicate is false; the executor's sensitive-read policy gate
  // still applies to the nested browser.search call (see header).
  e("browser", "search", "browser.search", "sensitive-read", false, "none", { idempotent: true, note: "Combines history, bookmarks and open tabs; each source is gated by its own optional group at the point of use." }),

  // ---- tabs (19) ----
  e("tabs", "list", "tabs.list", "read-only", false, "none", { idempotent: true }),
  e("tabs", "get", "tabs.get", "read-only", false, "none", { idempotent: true }),
  e("tabs", "active", "tabs.active", "read-only", false, "none", { idempotent: true }),
  e("tabs", "search", "tabs.search", "read-only", false, "none", { idempotent: true }),
  e("tabs", "create", "tabs.create", "reversible", false, "browser-state", { idempotent: false }),
  e("tabs", "close", "tabs.close", "reversible", false, "browser-state", { idempotent: false, note: "Destructive to that tab's content, but granular risk is reversible (recoverable via recently-closed tabs); no granular approval." }),
  e("tabs", "activate", "tabs.activate", "reversible", false, "browser-state", { idempotent: true }),
  e("tabs", "reload", "tabs.reload", "reversible", false, "browser-state", { idempotent: true, note: "Unified tabs reload, added after the 2026-10-28 retest (tabs reload was not a unified action). Distinct from navigate reload, which maps to navigation.reload." }),
  e("tabs", "duplicate", "tabs.duplicate", "reversible", false, "browser-state", { idempotent: false }),
  e("tabs", "discard", "tabs.discard", "reversible", false, "browser-state", { idempotent: true }),
  e("tabs", "move", "tabs.move", "reversible", false, "browser-state", { idempotent: true, note: "Canonical input is {tabIds, windowId?, index?}; a single tabId is wrapped into tabIds by the handler." }),
  e("tabs", "pin", "tabs.pin", "reversible", false, "browser-state", { idempotent: true }),
  e("tabs", "mute", "tabs.mute", "reversible", false, "browser-state", { idempotent: true }),
  e("tabs", "zoom", "tabs.setZoom", "reversible", false, "browser-state", { idempotent: true, note: "Canonical granular tool is tabs.setZoom; there is no granular tabs.zoom tool." }),
  e("tabs", "group", "tabs.group", "reversible", false, "browser-state", { idempotent: false, note: "Creates a new group on each call." }),
  e("tabs", "ungroup", "tabs.ungroup", "reversible", false, "browser-state", { idempotent: true }),
  e("tabs", "save_session", "workflows.saveSession", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("tabs", "restore_session", "workflows.restoreSession", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("tabs", "organize", "workflows.organizeTabs", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing. Strategy is domain | titlePrefix." }),

  // ---- windows (4) ----
  e("windows", "list", "windows.list", "read-only", false, "none", { idempotent: true }),
  e("windows", "create", "windows.create", "reversible", false, "browser-state", { idempotent: false, note: "Creating an incognito window requires a reversible-or-higher policy allowance; it is not granted silently." }),
  e("windows", "update", "windows.update", "reversible", false, "browser-state", { idempotent: true }),
  e("windows", "close", "windows.close", "reversible", false, "browser-state", { idempotent: false, note: "Closes the window and its tabs; granular risk is reversible." }),

  // ---- navigate, action-only (25) ----
  // The tab/window/sync/category logic is in the handler: isTab is
  // category=tab OR action in the tab list; isWindow is category=window
  // OR action=update; isSync is category=sync OR a `for` value. The tab
  // branch is checked first, so category does NOT override a tab action.
  e("navigate", "open", "navigation.open", "reversible", false, "browser-state", { idempotent: false }),
  e("navigate", "back", "navigation.back", "reversible", false, "browser-state", { idempotent: false }),
  e("navigate", "forward", "navigation.forward", "reversible", false, "browser-state", { idempotent: false }),
  e("navigate", "reload", "navigation.reload", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "search", "navigation.search", "reversible", false, "browser-state", { idempotent: false, note: "Action-only search goes to navigation.search (search is not in the tab-action list). Category=tab search is different: see the tab variant below." }),
  e("navigate", "wait", "navigation.wait", "read-only", false, "none", { idempotent: true, note: "Action-only wait (no category, no `for`) goes to navigation.wait. Sync wait is dispatched by `for`: see the sync variants below." }),
  e("navigate", "list", "tabs.list", "read-only", false, "none", { idempotent: true }),
  e("navigate", "get", "tabs.get", "read-only", false, "none", { idempotent: true }),
  e("navigate", "active", "tabs.active", "read-only", false, "none", { idempotent: true }),
  e("navigate", "create", "tabs.create", "reversible", false, "browser-state", { idempotent: false, note: "Action-only create is a tab create. With category=window, create is a window-branch action and lands on windows.create (see window variant)." }),
  e("navigate", "close", "tabs.close", "reversible", false, "browser-state", { idempotent: false, note: "Action-only close is a tab close. With category=window, close is a window-branch action and lands on windows.close (see window variant)." }),
  e("navigate", "activate", "tabs.activate", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "switch", "tabs.activate", "reversible", false, "browser-state", { idempotent: true, note: "Alias: switch is rewritten to activate by the handler." }),
  e("navigate", "duplicate", "tabs.duplicate", "reversible", false, "browser-state", { idempotent: false }),
  e("navigate", "discard", "tabs.discard", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "move", "tabs.move", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "pin", "tabs.pin", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "mute", "tabs.mute", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "zoom", "tabs.setZoom", "reversible", false, "browser-state", { idempotent: true, note: "Canonical granular tool is tabs.setZoom; there is no granular tabs.zoom tool." }),
  e("navigate", "group", "tabs.group", "reversible", false, "browser-state", { idempotent: false }),
  e("navigate", "ungroup", "tabs.ungroup", "reversible", false, "browser-state", { idempotent: true }),
  e("navigate", "save_session", "workflows.saveSession", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "restore_session", "workflows.restoreSession", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "organize", "workflows.organizeTabs", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "update", "windows.update", "reversible", false, "browser-state", { idempotent: true, note: "The only action that reaches the window branch on its own (update is not a tab action)." }),

  // ---- navigate, category=tab (21) ----
  // Category=tab enters the tab branch for every action it handles; URL and
  // window actions under category=tab throw INVALID_INPUT in that branch.
  e("navigate", "list", "tabs.list", "read-only", false, "none", { domain: "tab", idempotent: true }),
  e("navigate", "get", "tabs.get", "read-only", false, "none", { domain: "tab", idempotent: true }),
  e("navigate", "active", "tabs.active", "read-only", false, "none", { domain: "tab", idempotent: true }),
  e("navigate", "search", "tabs.search", "read-only", false, "none", { domain: "tab", idempotent: true, note: "Category=tab search reaches the tab branch (which has a search case) and goes to tabs.search, unlike action-only search which goes to navigation.search." }),
  e("navigate", "create", "tabs.create", "reversible", false, "browser-state", { domain: "tab", idempotent: false }),
  e("navigate", "open", "tabs.navigate", "reversible", false, "browser-state", { domain: "tab", idempotent: false, note: "Category=tab open: with a tabId the handler navigates that tab (tabs.navigate); without one it creates a tab (tabs.create, same risk). Distinct from action-only / category=url open, which maps to navigation.open." }),
  e("navigate", "close", "tabs.close", "reversible", false, "browser-state", { domain: "tab", idempotent: false }),
  e("navigate", "activate", "tabs.activate", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "switch", "tabs.activate", "reversible", false, "browser-state", { domain: "tab", idempotent: true, note: "Alias: switch is rewritten to activate by the handler." }),
  e("navigate", "duplicate", "tabs.duplicate", "reversible", false, "browser-state", { domain: "tab", idempotent: false }),
  e("navigate", "discard", "tabs.discard", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "move", "tabs.move", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "pin", "tabs.pin", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "mute", "tabs.mute", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "zoom", "tabs.setZoom", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "group", "tabs.group", "reversible", false, "browser-state", { domain: "tab", idempotent: false }),
  e("navigate", "ungroup", "tabs.ungroup", "reversible", false, "browser-state", { domain: "tab", idempotent: true }),
  e("navigate", "reload", "tabs.reload", "reversible", false, "browser-state", { domain: "tab", idempotent: true, note: "Category=tab reload maps to tabs.reload, the same target as unified tabs reload (which the gateway rewrites to this form). Distinct from action-only / category=url reload, which maps to navigation.reload." }),
  e("navigate", "save_session", "workflows.saveSession", "consequential", true, "browser-state", { domain: "tab", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "restore_session", "workflows.restoreSession", "consequential", true, "browser-state", { domain: "tab", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "organize", "workflows.organizeTabs", "consequential", true, "browser-state", { domain: "tab", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),

  // ---- navigate, category=window (19) ----
  // Window-branch actions (list/create/update/close) under category=window
  // reach the window branch — the handler diverts exactly those actions
  // away from the tab branch, so windows list/create/close return real
  // WindowInfo shapes instead of tabs. Tab-only actions under
  // category=window still land on the tab granular tool. Window+search
  // throws (search is neither a tab action in the handler's gate nor a
  // window-branch case).
  e("navigate", "list", "windows.list", "read-only", false, "none", { domain: "window", idempotent: true, note: "Category=window list is a window-branch action: this is windows.list, not tabs.list." }),
  e("navigate", "get", "tabs.get", "read-only", false, "none", { domain: "window", idempotent: true, note: "Tab branch wins over the window branch for tab-only actions." }),
  e("navigate", "active", "tabs.active", "read-only", false, "none", { domain: "window", idempotent: true, note: "Tab branch wins over the window branch for tab-only actions." }),
  e("navigate", "create", "windows.create", "reversible", false, "browser-state", { domain: "window", idempotent: false, note: "Category=window create is a window-branch action: this is windows.create, not tabs.create." }),
  e("navigate", "close", "windows.close", "reversible", false, "browser-state", { domain: "window", idempotent: false, note: "Category=window close is a window-branch action: this is windows.close, not tabs.close." }),
  e("navigate", "activate", "tabs.activate", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "switch", "tabs.activate", "reversible", false, "browser-state", { domain: "window", idempotent: true, note: "Alias: switch is rewritten to activate by the handler." }),
  e("navigate", "duplicate", "tabs.duplicate", "reversible", false, "browser-state", { domain: "window", idempotent: false }),
  e("navigate", "discard", "tabs.discard", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "move", "tabs.move", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "pin", "tabs.pin", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "mute", "tabs.mute", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "zoom", "tabs.setZoom", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "group", "tabs.group", "reversible", false, "browser-state", { domain: "window", idempotent: false }),
  e("navigate", "ungroup", "tabs.ungroup", "reversible", false, "browser-state", { domain: "window", idempotent: true }),
  e("navigate", "save_session", "workflows.saveSession", "consequential", true, "browser-state", { domain: "window", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "restore_session", "workflows.restoreSession", "consequential", true, "browser-state", { domain: "window", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "organize", "workflows.organizeTabs", "consequential", true, "browser-state", { domain: "window", idempotent: false, note: "Unified handler dryRun-gates this through the granular workflow gate before executing." }),
  e("navigate", "update", "windows.update", "reversible", false, "browser-state", { domain: "window", idempotent: true, note: "The only action that actually reaches windows.update under category=window." }),

  // ---- navigate, category=url (6) ----
  // Category=url does not override tab actions either (they still hit the
  // tab branch); these are the actions that reach the URL branch.
  e("navigate", "open", "navigation.open", "reversible", false, "browser-state", { domain: "url", idempotent: false }),
  e("navigate", "back", "navigation.back", "reversible", false, "browser-state", { domain: "url", idempotent: false }),
  e("navigate", "forward", "navigation.forward", "reversible", false, "browser-state", { domain: "url", idempotent: false }),
  e("navigate", "reload", "navigation.reload", "reversible", false, "browser-state", { domain: "url", idempotent: true }),
  e("navigate", "search", "navigation.search", "reversible", false, "browser-state", { domain: "url", idempotent: false }),
  e("navigate", "wait", "navigation.wait", "read-only", false, "none", { domain: "url", idempotent: true }),

  // ---- navigate, category=sync (4, dispatched by `for`, action ignored) ----
  // Sync dispatch ignores `action` (unless a tab/window action wins first)
  // and branches on `for`. The canonical sync action value is "wait".
  e("navigate", "wait", "page.waitFor", "read-only", false, "none", { domain: "sync:element", idempotent: true, note: "Sync dispatch is by `for`, not by action: for=element." }),
  e("navigate", "wait", "page.networkIdle", "read-only", false, "none", { domain: "sync:network_idle", idempotent: true, note: "Sync dispatch is by `for`, not by action: for=network_idle." }),
  e("navigate", "wait", "local:abortableDelay", "restricted", true, "none", { domain: "sync:delay", idempotent: true, note: "FLAGGED, no granular target: the handler implements a delay locally via abortableDelay. Marked restricted + approval true (fail closed) so a per-action manager denies it until a real granular target exists." }),
  e("navigate", "wait", "navigation.wait", "read-only", false, "none", { domain: "sync:navigation", idempotent: true, note: "Sync default branch: for=navigation, or for omitted under category=sync." }),

  // ---- observe (13, one per include value) ----
  // A call may carry several includes; each is resolved independently and
  // a failed include is reported as a per-include error, not a call failure.
  e("observe", "metadata", "page.metadata", "read-only", false, "none", { idempotent: true }),
  e("observe", "outline", "page.outline", "read-only", false, "none", { idempotent: true }),
  e("observe", "text", "page.read", "read-only", false, "none", { idempotent: true }),
  e("observe", "links", "page.links", "read-only", false, "none", { idempotent: true }),
  e("observe", "tables", "page.tables", "read-only", false, "none", { idempotent: true }),
  e("observe", "forms", "forms.inspect", "read-only", false, "none", { idempotent: true }),
  e("observe", "find", "page.find", "read-only", false, "none", { idempotent: true, note: "Conditional: with a query it is page.find; with by/value/selector and no query it is dom.find (also read-only, no approval)." }),
  e("observe", "a11y", "page.accessibilityTree", "read-only", false, "none", { idempotent: true, note: "The handler also reads viewport metrics via a direct getViewport page op (no screenshot, no approval); it no longer calls screenshots.viewport, which now captures an image." }),
  e("observe", "ast", "devtools.dom", "read-only", false, "none", { idempotent: true, note: "The handler also reads viewport metrics via a direct getViewport page op (no screenshot, no approval); it no longer calls screenshots.viewport, which now captures an image." }),
  e("observe", "screenshot", "screenshots.visible", "sensitive-read", true, "none", { idempotent: true, note: "Also reached via the includeScreenshot flag (same granular tool). If approval is missing, the executor denies the nested call and observe reports it as a per-include error; no screenshot is ever returned without approval." }),
  e("observe", "selection", "page.selectedText", "read-only", false, "none", { idempotent: true }),
  e("observe", "shadow", "dom.shadow", "read-only", false, "none", { idempotent: true }),
  e("observe", "frames", "frames.list", "read-only", false, "none", { idempotent: true }),

  // ---- act (13, one per step `do` value) ----
  e("act", "click", "dom.click", "reversible", "granular", "browser-state", { idempotent: false, note: "Conditional: coordinate targets use dom.clickAt (also reversible). Unified pre-scan plus the granular activation check require approval when the target is consequential (submit, download, buy, ...); ordinary clicks need none." }),
  e("act", "hover", "dom.hover", "reversible", false, "browser-state", { idempotent: true, note: "Conditional: coordinate targets use dom.moveTo (also reversible)." }),
  e("act", "move", "dom.moveTo", "reversible", false, "browser-state", { idempotent: true, note: "Conditional: ref targets first resolve via dom.boundingBox (read-only) and then move to the centre." }),
  e("act", "drag", "dom.drag", "reversible", false, "browser-state", { idempotent: false, note: "Conditional: coordinate from/to use dom.dragAt (also reversible)." }),
  e("act", "focus", "dom.focus", "reversible", false, "browser-state", { idempotent: true }),
  e("act", "scroll", "dom.scroll", "reversible", false, "browser-state", { idempotent: false, note: "Conditional: direction/amount use dom.scroll; a ref-only scroll uses dom.scrollTo (also reversible); x/y coordinates use the page agent's scrollToXY page op, for which no granular tool exists (highest risk among the granular targets is still reversible)." }),
  e("act", "scroll_into_view", "dom.scrollTo", "reversible", false, "browser-state", { idempotent: true }),
  e("act", "press", "dom.press", "reversible", "granular", "browser-state", { idempotent: false, note: "Conditional approval: the unified pre-scan and the granular activation check require approval for Enter or Space on a consequential control; other keys need none." }),
  e("act", "type", "dom.type", "reversible", false, "browser-state", { idempotent: false, note: "The granular handler refuses credential fields outright (privacy guard); that is a refusal, not an approval gate." }),
  e("act", "fill", "dom.fill", "reversible", false, "browser-state", { idempotent: false, note: "Overwrites field content; granular risk is reversible with no approval. The granular handler refuses credential fields outright." }),
  e("act", "clear", "dom.clear", "reversible", false, "browser-state", { idempotent: false, note: "Discards field content; granular risk is reversible with no approval." }),
  e("act", "select", "dom.select", "reversible", false, "browser-state", { idempotent: false }),
  e("act", "check", "dom.setChecked", "reversible", false, "browser-state", { idempotent: true, note: "Sets the checkbox to an explicit checked value." }),

  // ---- wait (4, one per `for` value) ----
  e("wait", "element", "page.waitFor", "read-only", false, "none", { idempotent: true }),
  e("wait", "network_idle", "page.networkIdle", "read-only", false, "none", { idempotent: true }),
  e("wait", "navigation", "navigation.wait", "read-only", false, "none", { idempotent: true, note: "Default branch of the wait handler (any `for` other than element, network_idle or delay)." }),
  e("wait", "delay", "local:abortableDelay", "restricted", true, "none", { idempotent: true, note: "FLAGGED, no granular target: the handler implements a delay locally via abortableDelay. Marked restricted + approval true (fail closed) so a per-action manager denies it until a real granular target exists." }),

  // ---- form (6, phase / action aliases) ----
  e("form", "inspect", "forms.inspect", "read-only", false, "none", { idempotent: true }),
  e("form", "preview", "forms.preview", "read-only", false, "none", { idempotent: true }),
  e("form", "fill", "forms.fill", "reversible", false, "browser-state", { idempotent: false }),
  e("form", "upload", "forms.upload", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing. Inline file cap: 15,000,000 base64 characters." }),
  e("form", "submit", "forms.submit", "consequential", true, "external-visible", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing. Sends form data to the form's action destination." }),
  e("form", "set_file", "forms.setFile", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing. Inline file cap: 35,000,000 base64 characters." }),

  // ---- submit (3; the unified tool itself is consequential / approval true) ----
  e("submit", "submit", "forms.submit", "consequential", true, "external-visible", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing." }),
  e("submit", "upload", "forms.upload", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing. Inline file cap: 15,000,000 base64 characters." }),
  e("submit", "set_file", "forms.setFile", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular forms gate before executing. Inline file cap: 35,000,000 base64 characters." }),

  // ---- devtools (7) ----
  e("devtools", "console", "devtools.console", "sensitive-read", false, "none", { idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("devtools", "network", "devtools.network", "sensitive-read", false, "none", { idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("devtools", "errors", "devtools.pageErrors", "read-only", false, "none", { idempotent: true, note: "Granular tool name is devtools.pageErrors, not devtools.errors." }),
  e("devtools", "performance", "devtools.performance", "read-only", false, "none", { idempotent: true }),
  e("devtools", "observer", "browser.observer", "reversible", false, "browser-state", { idempotent: true, note: "Sets the observer enabled flag (defaults to true in the unified handler)." }),
  e("devtools", "dialogs", "page.dialogs", "sensitive-read", false, "none", { idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("devtools", "respond_dialog", "page.respondDialog", "consequential", true, "browser-state", { idempotent: false, note: "Unified handler dryRun-gates this through the granular page gate before executing." }),

  // ---- data (26, only pairs the handler dispatches) ----
  // clipboard domain
  e("data", "read", "clipboard.read", "sensitive-read", true, "none", { domain: "clipboard", idempotent: true, note: "Unified handler dryRun-gates this through the granular clipboard gate before executing." }),
  e("data", "write", "clipboard.write", "consequential", true, "external-visible", { domain: "clipboard", idempotent: false, note: "Unified handler dryRun-gates this through the granular clipboard gate before executing. Clipboard content is visible to other applications." }),
  // files domain
  e("data", "list", "files.list", "sensitive-read", false, "none", { domain: "files", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("data", "stat", "files.stat", "sensitive-read", false, "none", { domain: "files", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  // devtools domain (mirrors the devtools unified tool)
  e("data", "console", "devtools.console", "sensitive-read", false, "none", { domain: "devtools", idempotent: true }),
  e("data", "network", "devtools.network", "sensitive-read", false, "none", { domain: "devtools", idempotent: true }),
  e("data", "errors", "devtools.pageErrors", "read-only", false, "none", { domain: "devtools", idempotent: true, note: "Granular tool name is devtools.pageErrors, not devtools.errors." }),
  e("data", "performance", "devtools.performance", "read-only", false, "none", { domain: "devtools", idempotent: true }),
  e("data", "observer", "browser.observer", "reversible", false, "browser-state", { domain: "devtools", idempotent: true }),
  e("data", "dialogs", "page.dialogs", "sensitive-read", false, "none", { domain: "devtools", idempotent: true }),
  e("data", "respond_dialog", "page.respondDialog", "consequential", true, "browser-state", { domain: "devtools", idempotent: false, note: "Unified handler dryRun-gates this through the granular page gate before executing (data devtools branch)." }),
  // bookmarks domain
  e("data", "list", "bookmarks.list", "sensitive-read", false, "none", { domain: "bookmarks", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("data", "search", "bookmarks.search", "sensitive-read", false, "none", { domain: "bookmarks", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("data", "create", "bookmarks.create", "reversible", false, "browser-state", { domain: "bookmarks", idempotent: false }),
  e("data", "create_folder", "bookmarks.createFolder", "reversible", false, "browser-state", { domain: "bookmarks", idempotent: false, note: "Granular tool name is bookmarks.createFolder (camelCase)." }),
  e("data", "move", "bookmarks.move", "reversible", false, "browser-state", { domain: "bookmarks", idempotent: true }),
  e("data", "update", "bookmarks.update", "reversible", false, "browser-state", { domain: "bookmarks", idempotent: false, note: "Overwrites the bookmark's title/url." }),
  e("data", "delete", "bookmarks.delete", "consequential", true, "destructive", { domain: "bookmarks", idempotent: false, note: "Unified handler dryRun-gates this through the granular bookmarks gate before executing." }),
  // history domain
  e("data", "list", "history.search", "sensitive-read", false, "none", { domain: "history", idempotent: true, note: "Unified data history list, added after the 2026-10-28 retest (the handler had no list case). It is history.search with an empty query, not a separate granular tool." }),
  e("data", "search", "history.search", "sensitive-read", false, "none", { domain: "history", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("data", "add", "history.add", "reversible", false, "browser-state", { domain: "history", idempotent: false }),
  e("data", "delete", "history.delete", "consequential", true, "destructive", { domain: "history", idempotent: false, note: "Unified handler dryRun-gates this through the granular history gate before executing; deletes the given URLs from history." }),
  // downloads domain
  e("data", "list", "downloads.list", "sensitive-read", false, "none", { domain: "downloads", idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("data", "start", "downloads.start", "consequential", true, "external-visible", { domain: "downloads", idempotent: false, note: "Unified handler dryRun-gates this through the granular downloads gate before executing. Fetches an external file to disk." }),
  e("data", "control", "downloads.control", "reversible", false, "browser-state", { domain: "downloads", idempotent: false, note: "Unified handler dryRun-gates this, but under the default policy that gate is a no-op (granular predicate false and reversible policy gate false); it fires only on a policy override. Pause/resume/cancel, including cancel which ends the download." }),
  e("data", "erase", "downloads.erase", "consequential", true, "destructive", { domain: "downloads", idempotent: false, note: "Unified handler dryRun-gates this through the granular downloads gate before executing." }),

  // ---- clipboard (2) ----
  e("clipboard", "read", "clipboard.read", "sensitive-read", true, "none", { idempotent: true, note: "Unified handler dryRun-gates this through the granular clipboard gate before executing." }),
  e("clipboard", "write", "clipboard.write", "consequential", true, "external-visible", { idempotent: false, note: "Unified handler dryRun-gates this through the granular clipboard gate before executing." }),

  // ---- files (2) ----
  e("files", "list", "files.list", "sensitive-read", false, "none", { idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
  e("files", "stat", "files.stat", "sensitive-read", false, "none", { idempotent: true, note: "Granular predicate is false; the executor's sensitive-read policy gate still applies to the nested call (see header)." }),
];

/**
 * Resolve a unified dispatch key to its per-action risk entry.
 *
 * `domain` is the data domain for `data`, and the navigate category
 * variant for `navigate` (`tab`, `window`, `url`, or `sync:<for>`).
 * With no domain, the action-only entry is returned. Returns undefined
 * when the tool/action/domain combination is not a dispatched action
 * (the handler would throw INVALID_INPUT for it).
 */
export function resolveUnifiedAction(
  tool: string,
  action: string,
  domain?: string,
): ActionRiskEntry | undefined {
  return UNIFIED_ACTION_RISK.find(
    (entry) => entry.unifiedTool === tool && entry.action === action && entry.domain === domain,
  );
}
