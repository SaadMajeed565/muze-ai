import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { PageMetadata, TabInfo, WindowInfo, coordinateSchema, tabIdSchema, tabRef, urlSchema } from "./common.js";

/**
 * Unified (master) tool contracts.
 *
 * Approval rule, enforced by the schemas as well as by the executor: a
 * client-supplied confirmation flag is NEVER approval. The old
 * `confirmed` / `userApproved` / `approved` input fields have been removed
 * from every unified schema, so a strict schema now rejects them outright.
 * Only a broker approval token, a dashboard decision, or a verified
 * elicitation decision may approve a call. Policy-by-risk is a second gate
 * on top of that, never a replacement for it.
 *
 * Output rule: every unified tool returns one of several granular results
 * depending on its action, so each output schema lists the fields of all of
 * its variants as optional (non-strict, so unknown extra fields are stripped
 * rather than rejected). A unified output is therefore structured, never
 * `z.any()`, while still accepting every legitimate variant.
 *
 * Canonical parameters (handlers in the browser engine must match these
 * exactly; see the coordinator notes for the handler changes this implies):
 * - tabs.move: { tabIds, windowId?, index? } — never a bare tabId.
 * - tabs zoom action: { tabId, zoom } and it dispatches to granular
 *   `tabs.setZoom` (there is no granular `tabs.zoom` tool).
 * - browser.search: { query, limit?, includeHistory?, includeBookmarks?,
 *   includeTabs? } — never { text, maxResults }.
 * - organise strategy everywhere: "domain" | "titlePrefix" — never "prefix".
 */

/** tabRef and coordinateSchema are the shared definitions from common.ts
 * (coordinateSchema there carries the "Coordinate in CSS pixels, 0..100000"
 * description; the old unified-local copy had identical bounds but no
 * description, so JSON-schema output for unified coordinate fields now
 * gains that description and nothing else). */

const includeEnum = z.enum(["metadata", "outline", "text", "links", "tables", "forms", "find", "a11y", "ast", "screenshot", "selection", "shadow", "frames"]);

/** Inline base64 character caps, shared with granular forms.upload / forms.setFile. */
export const FORM_UPLOAD_MAX_BASE64_CHARS = 15_000_000;
export const FORM_SET_FILE_MAX_BASE64_CHARS = 35_000_000;

const inlineFileSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().max(128).default("application/octet-stream"),
  // The per-action cap is enforced by the superRefine below (upload: 15M,
  // set_file: 35M); this field cap is only the loosest bound.
  dataBase64: z.string().min(1).max(FORM_SET_FILE_MAX_BASE64_CHARS),
});

/** Enforce the action-specific inline file cap, stated in characters, not MB. */
function checkInlineFileCap(
  files: { dataBase64: string }[] | undefined,
  action: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!files) return;
  const cap = action === "set_file" ? FORM_SET_FILE_MAX_BASE64_CHARS : FORM_UPLOAD_MAX_BASE64_CHARS;
  for (const file of files) {
    if (file.dataBase64.length > cap) {
      ctx.addIssue({
        code: "too_big",
        maximum: cap,
        origin: "string",
        type: "string",
        inclusive: true,
        message: `Inline file data exceeds the ${cap.toLocaleString("en-US")} base64 character cap for ${action ?? "upload"}`,
      });
    }
  }
}

const screenshotOutput = z.object({ dataUrl: z.string(), format: z.string(), width: z.number(), height: z.number() });
const viewportOutput = z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number(), scrollY: z.number() });

export const browserTool: ToolDefinition = {
  name: "browser",
  title: "Browser",
  description: "browser: status() · capabilities() · permissions() · diagnostics() · search(query,limit?,includeHistory?,includeBookmarks?,includeTabs?). Search uses the canonical browser.search parameters, never {text,maxResults}.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    action: z.enum(["status", "capabilities", "permissions", "diagnostics", "search"]),
    query: z.string().min(1).max(512).optional().describe("Required when action=search"),
    limit: z.number().int().min(1).max(100).default(20),
    includeHistory: z.boolean().default(true),
    includeBookmarks: z.boolean().default(true),
    includeTabs: z.boolean().default(true),
  }).strict(),
  output: z.object({
    extensionVersion: z.string().optional(),
    protocolVersion: z.string().optional(),
    registryVersion: z.string().optional(),
    userAgent: z.string().optional(),
    platform: z.string().optional(),
    browserVersion: z.string().optional(),
    locale: z.string().optional(),
    timeZone: z.string().optional(),
    manifestVersion: z.number().int().optional(),
    toolCount: z.number().int().optional(),
    categories: z.array(z.string()).optional(),
    optionalGroups: z.record(z.string(), z.boolean()).optional(),
    readOnlyMode: z.boolean().optional(),
    killSwitch: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    mode: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    deniedTools: z.array(z.string()).optional(),
    bridgeStatus: z.enum(["connected", "disconnected"]).optional(),
    connectedClients: z.number().int().optional(),
    pendingApprovals: z.number().int().optional(),
    auditEvents: z.number().int().optional(),
    results: z.array(z.object({
      title: z.string(),
      url: z.string(),
      source: z.enum(["history", "bookmark", "tab"]),
      visitCount: z.number().int().optional(),
      lastVisitTime: z.string().optional(),
    })).optional(),
  }),
};

export const tabsTool: ToolDefinition = {
  name: "tabs",
  title: "Tabs",
  description: "tabs: list() · get(tabId) · active() · search(query) · create(url,pinned?,groupId?) · close(tabId) · activate(tabId) · duplicate(tabId) · discard(tabId) · move(tabIds,windowId?,index?) · pin(tabId,pinned?) · mute(tabId,muted?) · zoom(tabId,zoom) · group(tabIds,title?) · ungroup(tabIds) · reload(tabId,bypassCache?) · save_session(name) · restore_session(sessionId,active?) · organize(strategy,maxGroups?). Risk is reversible because most actions mutate tabs; save_session/restore_session/organize are consequential sub-actions that still require approval through the granular workflow gate. Policy-by-risk is a second gate, not a replacement for that approval.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    action: z.enum(["list", "get", "active", "search", "create", "close", "activate", "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup", "reload", "save_session", "restore_session", "organize"]),
    bypassCache: z.boolean().optional(),
    tabId: tabIdSchema.optional(),
    tabIds: z.array(tabIdSchema).min(1).max(50).optional().describe("Required for move/group/ungroup; canonical tabs.move input is {tabIds, windowId?, index?}"),
    windowId: z.number().int().optional(),
    url: urlSchema.optional(),
    query: z.string().min(1).max(256).optional(),
    pinned: z.boolean().optional(),
    groupId: z.number().int().optional(),
    index: z.number().int().min(-1).optional(),
    muted: z.boolean().optional(),
    zoom: z.number().min(0.25).max(5).optional().describe("Canonical zoom parameter; dispatches to granular tabs.setZoom"),
    title: z.string().max(120).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    active: z.boolean().optional(),
    strategy: z.enum(["domain", "titlePrefix"]).optional(),
    maxGroups: z.number().int().min(1).max(20).optional(),
  }).strict(),
  output: z.object({
    tabs: z.array(TabInfo).optional(),
    tab: TabInfo.optional(),
    closed: z.literal(true).optional(),
    tabId: tabIdSchema.optional(),
    tabIds: z.array(tabIdSchema).optional(),
    moved: z.array(tabIdSchema).optional(),
    muted: z.boolean().optional(),
    zoom: z.number().optional(),
    groupId: z.number().int().optional(),
    ungrouped: z.array(tabIdSchema).optional(),
    groups: z.array(z.object({ title: z.string(), tabIds: z.array(tabIdSchema) })).optional(),
    sessionId: z.string().optional(),
    name: z.string().optional(),
    tabCount: z.number().int().optional(),
    restored: z.number().int().optional(),
  }),
};

export const windowsTool: ToolDefinition = {
  name: "windows",
  title: "Windows",
  description: "windows: list() · create(url?,focused?,incognito?) · update(windowId,state?,focused?,width?,height?,left?,top?) · close(windowId). Risk is reversible because create/update/close mutate windows. Creating an incognito window requires a reversible-or-higher policy allowance; it is not granted silently.",
  category: "windows",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    action: z.enum(["list", "create", "update", "close"]),
    windowId: z.number().int().optional(),
    url: urlSchema.optional(),
    focused: z.boolean().optional(),
    incognito: z.boolean().optional().describe("Requires a reversible-or-higher policy allowance; never granted silently"),
    state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional(),
    width: z.number().int().min(200).max(10_000).optional(),
    height: z.number().int().min(200).max(10_000).optional(),
    left: z.number().int().min(-10_000).max(10_000).optional(),
    top: z.number().int().min(-10_000).max(10_000).optional(),
  }).strict(),
  output: z.object({
    windows: z.array(WindowInfo).optional(),
    window: WindowInfo.optional(),
    closed: z.literal(true).optional(),
    windowId: z.number().int().optional(),
  }),
};

export const navigateTool: ToolDefinition = {
  name: "navigate",
  title: "Navigate",
  description: "navigate: spatial & window management. category: url | tab | window | sync (or direct action). Tab actions use the canonical parameters: move(tabIds,windowId?,index?), zoom(tabId,zoom via tabs.setZoom). Organise strategy is domain|titlePrefix. Creating an incognito window requires a reversible-or-higher policy allowance; it is not granted silently.",
  category: "page",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    category: z.enum(["url", "tab", "window", "sync"]).optional(),
    action: z.enum([
      "open", "back", "forward", "reload", "search", "wait",
      "list", "get", "active", "create", "close", "activate", "switch",
      "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup",
      "save_session", "restore_session", "organize", "update"
    ]).optional(),
    ...tabRef,
    url: urlSchema.optional(),
    reuseActiveTab: z.boolean().optional(),
    active: z.boolean().optional(),
    bypassCache: z.boolean().optional(),
    query: z.string().min(1).max(512).optional(),
    provider: z.enum(["duckduckgo", "bing", "google", "wikipedia"]).optional(),
    newTab: z.boolean().optional(),
    waitForLoad: z.boolean().optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
    waitForNetworkIdle: z.boolean().optional(),
    quietMs: z.number().int().min(100).max(30_000).optional(),
    windowId: z.number().int().optional(),
    groupId: z.number().int().optional(),
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
    openerTabId: tabIdSchema.optional(),
    index: z.number().int().min(-1).optional(),
    zoom: z.number().min(0.25).max(5).optional().describe("Canonical zoom parameter; dispatches to granular tabs.setZoom"),
    tabIds: z.array(tabIdSchema).min(1).max(50).optional().describe("Required for move/group/ungroup; canonical tabs.move input is {tabIds, windowId?, index?}"),
    title: z.string().max(512).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    strategy: z.enum(["domain", "titlePrefix"]).optional(),
    maxGroups: z.number().int().min(1).max(20).optional(),
    focused: z.boolean().optional(),
    incognito: z.boolean().optional().describe("Requires a reversible-or-higher policy allowance; never granted silently"),
    state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional(),
    width: z.number().int().min(200).max(10_000).optional(),
    height: z.number().int().min(200).max(10_000).optional(),
    left: z.number().int().min(-10_000).max(10_000).optional(),
    top: z.number().int().min(-10_000).max(10_000).optional(),
    for: z.enum(["element", "network_idle", "networkIdle", "navigation", "delay"]).optional(),
    by: z.enum(["selector", "text", "label", "placeholder", "role", "name"]).optional(),
    selector: z.string().min(1).max(512).optional(),
    value: z.string().max(512).optional(),
    role: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
  }).strict().superRefine((data, ctx) => {
    // Validation-time dispatch key: an actionless navigate call used to
    // pass Zod and only fail deep in the handler ("Unknown navigate
    // action"). The one legitimate actionless form is the sync dispatch,
    // which branches on category="sync" / `for` alone (gateway legacy
    // adaptation emits navigation.wait / page.waitFor / page.networkIdle
    // exactly this way), so it stays exempt; every other call needs an
    // action. No test or in-tree client relies on an actionless
    // non-sync navigate call.
    if (data.action === undefined && data.category !== "sync" && data.for === undefined) {
      ctx.addIssue({ code: "custom", message: "navigate requires an action, except for category \"sync\" (or a `for` value), which dispatches on category/`for` alone" });
    }
  }),
  output: z.object({
    tab: TabInfo.optional(),
    tabs: z.array(TabInfo).optional(),
    window: WindowInfo.optional(),
    windows: z.array(WindowInfo).optional(),
    // navigation.open/back/forward and tabs.navigate return
    // navigationId: null by design (the browser APIs expose no navigation
    // id); the unified output must accept null or every navigate URL
    // action fails output validation after dispatching successfully.
    navigationId: z.string().nullable().optional(),
    searchUrl: z.string().optional(),
    loaded: z.boolean().optional(),
    status: z.enum(["complete", "loading"]).optional(),
    url: z.string().optional(),
    timedOut: z.boolean().optional(),
    idle: z.boolean().optional(),
    found: z.boolean().optional(),
    ref: z.string().nullable().optional(),
    waited: z.boolean().optional(),
    delayMs: z.number().int().optional(),
    closed: z.literal(true).optional(),
    tabId: tabIdSchema.optional(),
    tabIds: z.array(tabIdSchema).optional(),
    windowId: z.number().int().optional(),
    moved: z.array(tabIdSchema).optional(),
    muted: z.boolean().optional(),
    zoom: z.number().optional(),
    groupId: z.number().int().optional(),
    ungrouped: z.array(tabIdSchema).optional(),
    groups: z.array(z.object({ title: z.string(), tabIds: z.array(tabIdSchema) })).optional(),
    sessionId: z.string().optional(),
    name: z.string().optional(),
    tabCount: z.number().int().optional(),
    restored: z.number().int().optional(),
  }),
};

export const observeTool: ToolDefinition = {
  name: "observe",
  title: "Observe",
  description: "observe: one read call driven by include (metadata, outline, text, links, tables, forms, find, a11y, ast, screenshot, selection, shadow, frames) with find/scope/screenshot/limits. Including a screenshot is a sensitive-read sub-action: it must still pass the screenshots approval gate (screenshots.visible/element/fullPage all require approval). This contract does not grant screenshot approval, and policy-by-risk is a second gate, not a replacement.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    include: z.array(includeEnum).max(12).default(["metadata", "text", "a11y"]),
    ref: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(512).optional(),
    query: z.string().min(1).max(500).optional(),
    by: z.enum(["selector", "text", "label", "placeholder", "role", "name"]).optional(),
    value: z.string().max(512).optional(),
    role: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
    maxChars: z.number().int().min(1).max(200000).default(8000),
    maxNodes: z.number().int().min(1).max(2000).default(200),
    // Deliberately NO default for maxDepth/limit (retest3 observe-defaults
    // fix): observe used to default to maxDepth=8 / limit=100 and forward
    // those to every granular tool, but page.outline caps maxDepth at 6 and
    // page.find / dom.find cap limit at 50, so a no-argument observe find /
    // outline failed granular validation ("Invalid input for page.find" /
    // "Invalid input for page.outline"). Forwarding an omitted value as
    // undefined lets each granular tool apply its OWN default instead
    // (outline 3, a11y 10, shadow 4, devtools.dom 8; find 20, dom.find 10,
    // links 200). Explicit values are passed through unchanged and never
    // silently truncated: an explicit value above a granular maximum still
    // fails loudly at that tool's strict validation, which is the honest
    // signal to retry with a smaller value. The granular maxima themselves
    // are unchanged, so direct granular callers keep their output bounds.
    maxDepth: z.number().int().min(1).max(20).optional(),
    maxRows: z.number().int().min(1).max(1000).default(50),
    limit: z.number().int().min(1).max(1000).optional(),
    interactiveOnly: z.boolean().default(true),
    sameOriginOnly: z.boolean().default(false),
    attributes: z.array(z.string().max(128)).max(20).default([]),
    includeScreenshot: z.boolean().default(false),
    screenshot: z.object({ mode: z.enum(["visible", "fullPage", "element"]).default("visible"), ref: z.string().min(1).max(128).optional() }).optional(),
    screenshotFormat: z.enum(["jpeg", "png"]).default("jpeg"),
    screenshotQuality: z.number().int().min(1).max(100).default(60),
  }).strict(),
  output: z.object({
    metadata: PageMetadata.optional(),
    outline: z.array(z.object({ level: z.number().int(), text: z.string() })).optional(),
    text: z.string().optional(),
    truncated: z.boolean().optional(),
    links: z.array(z.object({ text: z.string(), href: z.string(), rel: z.string().optional(), target: z.string().optional(), download: z.string().optional(), internal: z.boolean() })).optional(),
    tables: z.array(z.object({ index: z.number().int(), headers: z.array(z.string()), rows: z.array(z.array(z.string())), truncated: z.boolean() })).optional(),
    forms: z.array(z.object({ ref: z.string(), action: z.string().optional(), method: z.string().optional(), fields: z.array(z.object({ ref: z.string(), label: z.string(), type: z.string(), required: z.boolean(), options: z.array(z.string()).optional() })) })).optional(),
    find: z.unknown().optional(),
    nodes: z.array(z.object({ ref: z.string(), role: z.string(), name: z.string() })).optional(),
    ast: z.unknown().optional(),
    shadow: z.unknown().optional(),
    frames: z.array(z.object({ frameId: z.number().int(), url: z.string() })).optional(),
    selection: z.string().optional(),
    screenshot: screenshotOutput.optional(),
    viewport: viewportOutput.optional(),
    coordinateHint: z.string().optional(),
    errors: z.array(z.object({ include: z.string(), error: z.string() })).optional(),
  }),
};

/**
 * Act scroll semantics, kept distinct so the handler cannot confuse them:
 * - a `scroll` step carries EITHER direction+amount (page scroll, the
 *   dom.scroll path) OR x+y coordinates (a coordinate scroll path), never
 *   both; `scroll_into_view` scrolls a target element into view (the
 *   dom.scrollTo path for elements). The unified mapping itself is owned by
 *   the browser-engine section; this schema only guarantees the two paths
 *   arrive unambiguously.
 */
const stepSchema = z.object({
  do: z.enum(["click", "hover", "move", "drag", "focus", "scroll", "scroll_into_view", "press", "type", "fill", "clear", "select", "check"]),
  target: z.union([
    z.object({ ref: z.string().min(1).max(128) }),
    z.object({ role: z.string().max(64), name: z.string().max(256).optional() }),
    z.object({ label: z.string().max(512) }),
    z.object({ selector: z.string().min(1).max(512) }),
    z.object({ x: coordinateSchema, y: coordinateSchema, space: z.enum(["viewport", "screenshot"]).optional() }),
  ]),
  to: z.union([
    z.object({ ref: z.string().min(1).max(128) }),
    z.object({ role: z.string().max(64), name: z.string().max(256).optional() }),
    z.object({ label: z.string().max(512) }),
    z.object({ selector: z.string().min(1).max(512) }),
    z.object({ x: coordinateSchema, y: coordinateSchema, space: z.enum(["viewport", "screenshot"]).optional() }),
  ]).optional(),
  value: z.string().max(10_000).optional(),
  label: z.string().max(512).optional().describe("select step only: visible option text to select (matched by the dom.select label path); value takes precedence when both are given"),
  key: z.string().min(1).max(32).optional(),
  modifiers: z.array(z.enum(["Control", "Shift", "Alt", "Meta"])).max(4).optional(),
  text: z.string().max(10_000).optional(),
  checked: z.boolean().optional(),
  direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("scroll step only: page-scroll direction (dom.scroll path)"),
  amount: z.number().int().min(0).max(20_000).optional().describe("scroll step only: page-scroll amount (dom.scroll path)"),
  x: coordinateSchema.optional().describe("scroll step only: coordinate scroll target; never combined with direction"),
  y: coordinateSchema.optional().describe("scroll step only: coordinate scroll target; never combined with direction"),
  waitMs: z.number().int().min(0).max(10_000).optional(),
  waitForNetworkIdle: z.boolean().optional(),
}).superRefine((step, ctx) => {
  if (step.do === "scroll") {
    const hasDirection = step.direction !== undefined;
    const hasCoords = step.x !== undefined || step.y !== undefined;
    if (hasDirection && hasCoords) {
      ctx.addIssue({ code: "custom", message: "scroll step must use either direction/amount or x/y coordinates, not both" });
    }
    if (hasCoords && (step.x === undefined || step.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "coordinate scroll step requires both x and y" });
    }
  }
});

export const actTool: ToolDefinition = {
  name: "act",
  title: "Act",
  description: "act: batched interaction via steps[] (click, hover, move, drag, focus, scroll, scroll_into_view, press, type, fill, clear, select, check); target is {ref}|{role,name}|{label}|{selector}|{x,y,space}; scroll steps use direction/amount OR x/y, never both; stopOnError",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    steps: z.array(stepSchema).min(1).max(20),
    stopOnError: z.boolean().default(true),
  }).strict(),
  output: z.object({
    results: z.array(z.object({ index: z.number().int(), ok: z.boolean(), error: z.string().optional(), result: z.unknown().optional() })),
  }),
};

export const waitTool: ToolDefinition = {
  name: "wait",
  title: "Wait",
  description: "wait: for=element|network_idle|navigation|delay with selector/text/label/placeholder/role/name, timeoutMs, quietMs",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    for: z.enum(["element", "network_idle", "networkIdle", "navigation", "delay"]),
    by: z.enum(["selector", "text", "label", "placeholder", "role", "name"]).optional(),
    selector: z.string().min(1).max(512).optional(),
    value: z.string().max(512).optional(),
    role: z.string().max(64).optional(),
    name: z.string().max(256).optional(),
    timeoutMs: z.number().int().min(1).max(120000).default(10000),
    quietMs: z.number().int().min(0).max(10000).default(300),
    waitForNetworkIdle: z.boolean().default(false),
  }).strict(),
  output: z.object({
    found: z.boolean().optional(),
    ref: z.string().nullable().optional(),
    timedOut: z.boolean().optional(),
    idle: z.boolean().optional(),
    pending: z.number().int().optional(),
    waitedMs: z.number().int().optional(),
    status: z.enum(["complete", "loading"]).optional(),
    url: z.string().optional(),
    waited: z.boolean().optional(),
    delayMs: z.number().int().optional(),
  }),
};

const formFieldsSchema = z.union([
  z.array(z.object({ ref: z.string().min(1).max(128), value: z.string().max(10_000) })).min(1).max(100),
  z.record(z.string().max(128), z.string().max(10_000)),
]);

export const formTool: ToolDefinition = {
  name: "form",
  title: "Form",
  description: "form: structured form lifecycle. phase: inspect | preview | fill | upload | submit | set_file. Inline file caps are stated in base64 characters: upload 15,000,000, set_file 35,000,000. Submit and upload sub-actions still require approval through the granular forms gate; policy-by-risk is a second gate, not a replacement.",
  category: "forms",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    phase: z.enum(["inspect", "preview", "fill", "upload", "submit", "set_file"]).optional(),
    action: z.enum(["inspect", "preview", "fill", "upload", "submit", "set_file"]).optional(),
    ref: z.string().min(1).max(128).optional(),
    formRef: z.string().min(1).max(128).optional(),
    fields: formFieldsSchema.optional(),
    expectedAction: z.string().max(512).optional(),
    files: z.array(inlineFileSchema).min(1).max(5).optional(),
    fileId: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(512).optional(),
  }).strict().superRefine((data, ctx) => {
    checkInlineFileCap(data.files, data.phase ?? data.action, ctx);
  }),
  output: z.object({
    forms: z.array(z.object({ ref: z.string(), action: z.string().optional(), method: z.string().optional(), fields: z.array(z.object({ ref: z.string(), label: z.string(), type: z.string(), required: z.boolean(), options: z.array(z.string()).optional() })) })).optional(),
    fields: z.array(z.object({ ref: z.string(), label: z.string(), type: z.string(), required: z.boolean(), options: z.array(z.string()).optional() })).optional(),
    filled: z.array(z.object({ ref: z.string(), field: z.string(), value: z.string() })).optional(),
    skipped: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
    uploaded: z.number().int().optional(),
    names: z.array(z.string()).optional(),
    submitted: z.literal(true).optional(),
    formRef: z.string().optional(),
    evidence: z.string().optional(),
    set: z.literal(true).optional(),
    files: z.array(z.object({ name: z.string(), mimeType: z.string(), size: z.number().int() })).optional(),
  }),
};

export const submitTool: ToolDefinition = {
  name: "submit",
  title: "Submit",
  description: "submit: actions submit(formRef,expectedAction?) · upload(ref,files[]) · set_file(ref,fileId). Inline file caps are stated in base64 characters: upload 15,000,000, set_file 35,000,000 — the same caps as granular forms.upload / forms.setFile.",
  category: "forms",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    action: z.enum(["submit", "upload", "set_file"]),
    formRef: z.string().min(1).max(128).optional(),
    ref: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(512).optional(),
    expectedAction: z.string().max(512).optional(),
    files: z.array(inlineFileSchema).min(1).max(5).optional(),
    fileId: z.string().min(1).max(128).optional(),
  }).strict().superRefine((data, ctx) => {
    checkInlineFileCap(data.files, data.action, ctx);
  }),
  output: z.object({
    submitted: z.literal(true).optional(),
    formRef: z.string().optional(),
    evidence: z.string().optional(),
    uploaded: z.number().int().optional(),
    names: z.array(z.string()).optional(),
    set: z.literal(true).optional(),
    files: z.array(z.object({ name: z.string(), mimeType: z.string(), size: z.number().int() })).optional(),
  }),
};

export const devtoolsTool: ToolDefinition = {
  name: "devtools",
  title: "Devtools",
  description: "devtools: actions console(limit,level) · network(limit,urlFilter?,onlyFailed?) · errors(limit) · performance() · observer(enabled?) · dialogs(limit) · respond_dialog(response,text?). respond_dialog still requires approval through the granular page.respondDialog gate; policy-by-risk is a second gate, not a replacement.",
  category: "devtools",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    ...tabRef,
    action: z.enum(["console", "network", "errors", "performance", "observer", "dialogs", "respond_dialog"]),
    limit: z.number().int().min(1).max(1000).default(50),
    level: z.enum(["all", "error", "warn", "info", "log"]).default("all"),
    urlFilter: z.string().max(512).optional(),
    onlyFailed: z.boolean().default(false),
    enabled: z.boolean().optional(),
    response: z.enum(["accept", "dismiss"]).optional(),
    text: z.string().max(2000).optional(),
  }).strict(),
  output: z.object({
    messages: z.array(z.object({ level: z.string(), text: z.string(), at: z.string() })).optional(),
    requests: z.array(z.object({ id: z.string(), method: z.string(), url: z.string(), status: z.number().int().optional(), type: z.string().optional(), startedAt: z.string(), durationMs: z.number().int().optional(), failed: z.boolean().optional() })).optional(),
    attached: z.boolean().optional(),
    errors: z.array(z.object({ message: z.string(), source: z.string().optional(), at: z.string() })).optional(),
    navigation: z.record(z.string(), z.number()).optional(),
    paint: z.record(z.string(), z.number()).optional(),
    resources: z.number().int().optional(),
    dialogs: z.array(z.object({ id: z.string(), type: z.enum(["alert", "confirm", "prompt"]), message: z.string(), defaultValue: z.string().optional(), at: z.string(), answered: z.enum(["accept", "dismiss"]) })).optional(),
    defaultAnswer: z.enum(["accept", "dismiss"]).optional(),
    enabled: z.boolean().optional(),
    tabs: z.number().int().optional(),
    applied: z.literal(true).optional(),
    response: z.enum(["accept", "dismiss"]).optional(),
    text: z.string().optional(),
  }),
};

export const dataTool: ToolDefinition = {
  name: "data",
  title: "Data",
  description: "data: browser state & system. domain: history | bookmarks | downloads | clipboard | files | devtools. Consequential sub-actions (clipboard read/write, bookmark/history delete, download start/erase, dialog response) still require approval through their granular gates; policy-by-risk is a second gate, not a replacement. Download filenames/directories are length-capped here only; path containment is enforced downstream by the downloads handler, not by this schema.",
  category: "browser",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    domain: z.enum(["history", "bookmarks", "downloads", "clipboard", "files", "devtools"]).optional(),
    store: z.enum(["bookmarks", "history", "downloads", "clipboard", "files", "devtools"]).optional(),
    action: z.enum([
      "list", "search", "create", "create_folder", "move", "update", "delete", "add", "start", "control", "erase",
      "read", "write", "stat",
      "console", "network", "errors", "performance", "observer", "dialogs", "respond_dialog"
    ]).optional(),
    query: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    folderId: z.string().max(128).optional(),
    title: z.string().min(1).max(512).optional(),
    url: urlSchema.optional(),
    parentId: z.string().max(128).optional(),
    index: z.number().int().min(0).optional(),
    id: z.union([z.string().min(1).max(128), z.number().int()]).optional(),
    ids: z.array(z.union([z.string().min(1).max(128), z.number().int()])).max(100).optional(),
    urls: z.array(z.string().max(2048)).max(100).optional(),
    text: z.string().max(100_000).optional(),
    startTime: z.number().finite().optional(),
    endTime: z.number().finite().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
    transition: z.enum(["link", "typed", "reload", "auto_bookmark"]).optional(),
    saveAs: z.boolean().optional(),
    filename: z.string().max(255).optional(),
    directory: z.string().max(255).optional(),
    conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).optional(),
    controlAction: z.enum(["pause", "resume", "cancel"]).optional(),
    ...tabRef,
    level: z.enum(["all", "error", "warn", "info", "log"]).optional(),
    urlFilter: z.string().max(512).optional(),
    onlyFailed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    response: z.enum(["accept", "dismiss"]).optional(),
  }).strict().superRefine((data, ctx) => {
    // Validation-time dispatch key: an empty data call used to pass Zod
    // and only fail deep in the handler ("Unknown data domain"). No test
    // or in-tree client relies on omitting domain/store or action, so
    // both are required here (domain and its legacy alias store are
    // interchangeable; at least one must be present).
    if (data.domain === undefined && data.store === undefined) {
      ctx.addIssue({ code: "custom", message: "data requires a domain (or its alias store)" });
    }
    if (data.action === undefined) {
      ctx.addIssue({ code: "custom", message: "data requires an action" });
    }
  }),
  output: z.object({
    bookmarks: z.array(z.object({ id: z.string(), parentId: z.string().optional(), title: z.string(), url: z.string().optional(), dateAdded: z.string().optional(), folder: z.string() })).optional(),
    bookmark: z.object({ id: z.string(), parentId: z.string().optional(), title: z.string(), url: z.string().optional(), dateAdded: z.string().optional(), folder: z.string() }).optional(),
    folders: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    folder: z.object({ id: z.string(), title: z.string(), parentId: z.string().optional() }).optional(),
    deleted: z.union([z.literal(true), z.number().int()]).optional(),
    added: z.literal(true).optional(),
    entries: z.array(z.object({ id: z.string(), url: z.string(), title: z.string(), lastVisitTime: z.string(), visitCount: z.number().int() })).optional(),
    downloads: z.array(z.object({ id: z.number().int(), filename: z.string(), url: z.string(), state: z.enum(["in_progress", "interrupted", "complete", "unknown"]), bytesReceived: z.number(), totalBytes: z.number().optional(), paused: z.boolean(), startTime: z.string(), error: z.string().optional() })).optional(),
    id: z.union([z.string(), z.number().int()]).optional(),
    filename: z.string().optional(),
    erased: z.number().int().optional(),
    action: z.string().optional(),
    ok: z.literal(true).optional(),
    text: z.string().optional(),
    truncated: z.boolean().optional(),
    written: z.literal(true).optional(),
    chars: z.number().int().optional(),
    files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int(), createdAt: z.number().int() })).optional(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().optional(),
    createdAt: z.number().int().optional(),
    messages: z.array(z.object({ level: z.string(), text: z.string(), at: z.string() })).optional(),
    requests: z.array(z.object({ id: z.string(), method: z.string(), url: z.string() })).optional(),
    attached: z.boolean().optional(),
    errors: z.array(z.object({ message: z.string(), source: z.string().optional(), at: z.string() })).optional(),
    navigation: z.record(z.string(), z.number()).optional(),
    paint: z.record(z.string(), z.number()).optional(),
    resources: z.number().int().optional(),
    dialogs: z.array(z.object({ id: z.string(), type: z.enum(["alert", "confirm", "prompt"]), message: z.string(), defaultValue: z.string().optional(), at: z.string(), answered: z.enum(["accept", "dismiss"]) })).optional(),
    defaultAnswer: z.enum(["accept", "dismiss"]).optional(),
    enabled: z.boolean().optional(),
    tabs: z.number().int().optional(),
    applied: z.literal(true).optional(),
    response: z.enum(["accept", "dismiss"]).optional(),
  }),
};

export const clipboardTool: ToolDefinition = {
  name: "clipboard",
  title: "Clipboard",
  description: "clipboard: actions read() · write(text). Aligned with granular clipboard.read and clipboard.write, which both require approval (approval:true). Policy-by-risk (sensitive-read for read, consequential for write) is a second gate, not a replacement for that approval.",
  category: "browser",
  risk: "sensitive-read",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({
    action: z.enum(["read", "write"]),
    text: z.string().max(100_000).optional(),
  }).strict(),
  output: z.object({
    text: z.string().optional(),
    truncated: z.boolean().optional(),
    written: z.literal(true).optional(),
    chars: z.number().int().optional(),
  }),
};

export const filesTool: ToolDefinition = {
  name: "files",
  title: "Files",
  description: "files: actions list(limit?) · stat(id)",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({
    action: z.enum(["list", "stat"]),
    limit: z.number().int().min(1).max(200).optional(),
    id: z.string().min(1).max(128).optional(),
  }).strict(),
  output: z.object({
    files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), size: z.number().int(), createdAt: z.number().int() })).optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().optional(),
    createdAt: z.number().int().optional(),
  }),
};

export const unifiedTools = [
  browserTool, tabsTool, windowsTool, navigateTool, observeTool, actTool, waitTool,
  formTool, submitTool, devtoolsTool, dataTool, clipboardTool, filesTool,
];
