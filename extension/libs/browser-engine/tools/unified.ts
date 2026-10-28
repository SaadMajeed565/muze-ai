import {
  browserTool,
  tabsTool,
  windowsTool,
  navigateTool,
  observeTool,
  actTool,
  waitTool,
  formTool,
  submitTool,
  devtoolsTool,
  dataTool,
  clipboardTool,
  filesTool,
} from "../../tool-contracts/index.js";
import { ToolErrorException } from "../../tool-contracts/index.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import { resolveTabId, runPageOp, abortableDelay } from "./helpers.js";

type Exec = Parameters<RegisteredTool["handler"]>[1];

function buildAstTree(nodes: { depth: number; tag: string; id?: string; classes?: string[] }[]): {
  tag: string;
  depth: number;
  id?: string;
  classes?: string[];
  children: unknown[];
} {
  const root: { tag: string; depth: number; children: unknown[] } = { tag: "document", depth: -1, children: [] };
  const stack: Array<{ tag: string; depth: number; id?: string; classes?: string[]; children: unknown[] }> = [root];
  for (const node of nodes) {
    while (stack.length > 1 && stack[stack.length - 1].depth >= node.depth) stack.pop();
    const astNode = { tag: node.tag, depth: node.depth, id: node.id, classes: node.classes, children: [] as unknown[] };
    stack[stack.length - 1].children.push(astNode);
    stack.push(astNode);
  }
  return (root.children.length === 1 ? root.children[0] : root) as {
    tag: string;
    depth: number;
    id?: string;
    classes?: string[];
    children: unknown[];
  };
}


function targetToFind(target: any): { by: string; value: string; role?: string; name?: string } | null {
  if (!target || typeof target !== "object") return null;
  if (target.ref) return null;
  if (target.role) return { by: "role", value: target.role, role: target.role, name: target.name };
  if (target.label) return { by: "label", value: target.label };
  if (target.selector) return { by: "selector", value: target.selector };
  return null;
}

async function resolveTargetRef(exec: Exec, tabId: number, target: any, frameId?: number): Promise<string | undefined> {
  if (target?.ref) return target.ref;
  const findSpec = targetToFind(target);
  if (findSpec) {
    const found = await exec.invoke<{ elements?: { ref: string }[] }>("dom.find", {
      tabId,
      frameId,
      by: findSpec.by,
      value: findSpec.value,
      role: findSpec.role,
      name: findSpec.name,
      limit: 1,
    });
    const ref = found?.elements?.[0]?.ref;
    if (!ref) throw new ToolErrorException("NOT_FOUND", "Target element was not found");
    return ref;
  }
  return undefined;
}

function coordTarget(target: any): { x: number; y: number; space?: string } | null {
  if (target && typeof target.x === "number" && typeof target.y === "number") {
    return { x: target.x, y: target.y, space: target.space };
  }
  return null;
}

async function runStep(exec: Exec, tabId: number, frameId: number | undefined, step: any): Promise<{ index: number; ok: boolean; error?: string; result?: unknown }> {
  const index = step.index ?? 0;
  try {
    const op = step.do;
    const target = step.target ?? {};
    const ref = await resolveTargetRef(exec, tabId, target, frameId);
    const coords = coordTarget(target);
    const toCoords = step.to ? coordTarget(step.to) : null;
    const toRef = step.to ? await resolveTargetRef(exec, tabId, step.to, frameId) : undefined;

    let result: unknown;
    switch (op) {
      case "click":
        if (coords && !ref) result = await exec.invoke("dom.clickAt", { tabId, frameId, x: coords.x, y: coords.y, coordinateSpace: coords.space === "screenshot" ? "screenshot" : "css" });
        else result = await exec.invoke("dom.click", { tabId, frameId, ref, button: "left" });
        break;
      case "hover":
        if (coords && !ref) result = await exec.invoke("dom.moveTo", { tabId, frameId, x: coords.x, y: coords.y });
        else result = await exec.invoke("dom.hover", { tabId, frameId, ref });
        break;
      case "move":
        if (coords && !ref) result = await exec.invoke("dom.moveTo", { tabId, frameId, x: coords.x, y: coords.y });
        else if (ref) {
          const box = await exec.invoke<{ viewportX: number; viewportY: number; width: number; height: number }>("dom.boundingBox", { tabId, frameId, ref });
          result = await exec.invoke("dom.moveTo", { tabId, frameId, x: box.viewportX + box.width / 2, y: box.viewportY + box.height / 2 });
        }
        break;
      case "drag":
        if (ref && toRef) result = await exec.invoke("dom.drag", { tabId, frameId, fromRef: ref, toRef });
        else if (coords && toCoords) result = await exec.invoke("dom.dragAt", { tabId, frameId, x1: coords.x, y1: coords.y, x2: toCoords.x, y2: toCoords.y, coordinateSpace: coords.space === "screenshot" || toCoords.space === "screenshot" ? "screenshot" : "css" });
        else throw new ToolErrorException("INVALID_INPUT", "drag needs from/to refs or coordinates");
        break;
      case "focus":
        result = await exec.invoke("dom.focus", { tabId, frameId, ref });
        break;
      // Scroll mapping (documented; the old code called dom.scroll with
      // {ref, x, y}, which dom.scroll's strict input rejects, and called
      // dom.scroll for scroll-into-view, which it cannot do):
      //  - direction (+optional amount) -> dom.scroll {direction, amount}
      //  - x/y coordinates -> coordinate scroll via the page agent's
      //    scrollToXY op (absolute page position; no granular tool exists
      //    for this, so it runs as a page op, not as dom.scroll)
      //  - scroll_into_view (or a scroll step with only a ref) ->
      //    dom.scrollTo {ref}, which scrolls that element into view.
      case "scroll": {
        const stepCoords = typeof step.x === "number" && typeof step.y === "number"
          ? { x: step.x, y: step.y }
          : coords;
        if (typeof step.direction === "string") {
          result = await exec.invoke("dom.scroll", { tabId, frameId, direction: step.direction, amount: step.amount ?? 600 });
        } else if (stepCoords) {
          result = await runPageOp(exec.ctx, tabId, { op: "scrollToXY", x: stepCoords.x, y: stepCoords.y }, frameId, exec.signal);
        } else if (ref) {
          result = await exec.invoke("dom.scrollTo", { tabId, frameId, ref });
        } else {
          throw new ToolErrorException("INVALID_INPUT", "scroll step needs direction/amount, x/y coordinates, or a target ref");
        }
        break;
      }
      case "scroll_into_view":
        if (!ref) throw new ToolErrorException("INVALID_INPUT", "scroll_into_view needs a target ref");
        result = await exec.invoke("dom.scrollTo", { tabId, frameId, ref });
        break;
      case "press":
        result = await exec.invoke("dom.press", { tabId, frameId, ref, key: step.key, modifiers: step.modifiers ?? [] });
        break;
      case "type":
        result = await exec.invoke("dom.type", { tabId, frameId, ref, text: step.text ?? step.value ?? "" });
        break;
      case "fill":
        result = await exec.invoke("dom.fill", { tabId, frameId, ref, value: step.value ?? step.text ?? "" });
        break;
      case "clear":
        result = await exec.invoke("dom.clear", { tabId, frameId, ref });
        break;
      case "select":
        result = await exec.invoke("dom.select", { tabId, frameId, ref, value: step.value ?? "" });
        break;
      case "check":
        if (step.checked === false) result = await exec.invoke("dom.setChecked", { tabId, frameId, ref, checked: false });
        else result = await exec.invoke("dom.setChecked", { tabId, frameId, ref, checked: true });
        break;
      default:
        throw new ToolErrorException("INVALID_INPUT", `Unknown act step: ${op}`);
    }
    return { index, ok: true, result };
  } catch (error) {
    return { index, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}


/**
 * Inline-file caps for unified form/submit, matching the granular handlers
 * and stated in base64 characters: forms.upload 15,000,000 (per file and in
 * total), forms.setFile 35,000,000 per file. The granular nested invoke
 * would also enforce them, but checking here gives the unified caller the
 * same explicit character-cap error instead of a nested validation failure.
 */
function assertUnifiedFileCaps(files: unknown, tool: string): void {
  if (!Array.isArray(files)) return;
  const limit = tool === "forms.upload" ? 15_000_000 : 35_000_000;
  let total = 0;
  for (const file of files as { dataBase64?: unknown }[]) {
    const len = typeof file.dataBase64 === "string" ? file.dataBase64.length : 0;
    total += len;
    if (len > limit) {
      throw new ToolErrorException("INVALID_INPUT", `A file for ${tool} exceeds the ${limit.toLocaleString("en-US")} base64 character limit`);
    }
  }
  if (tool === "forms.upload" && total > 15_000_000) {
    throw new ToolErrorException("INVALID_INPUT", "The files for forms.upload exceed the 15,000,000 base64 character limit");
  }
}

async function requireLegacyApproval(exec: Exec, tool: string, input: unknown, label: string): Promise<void> {
  if (exec.approvalValidated) return;
  const dry = await exec.invoke<{ requiresApproval?: boolean }>(tool, input, { dryRun: true });
  if (dry?.requiresApproval) {
    throw new ToolErrorException("APPROVAL_REQUIRED", `${label} requires user approval`, {
      details: { tool },
    });
  }
}

export const unifiedToolHandlers: RegisteredTool[] = [
  defineTool(browserTool, async (input, exec) => {
    const data = input as { action: string; query?: string };
    switch (data.action) {
      case "status": return exec.invoke("browser.info", {});
      case "capabilities": return exec.invoke("browser.capabilities", {});
      case "permissions": return exec.invoke("browser.permissions", {});
      case "diagnostics": return exec.invoke("browser.diagnostics", {});
      // Canonical granular params are {query, limit, includeHistory,
      // includeBookmarks, includeTabs}. The old call used {text, maxResults},
      // which the granular schema rejects. When no include flag is given at
      // all, all three default to true; otherwise each given flag is used
      // and an omitted flag falls back to the granular default (true).
      case "search": {
        const d = data as Record<string, any>;
        const anyIncludeGiven = d.includeHistory !== undefined || d.includeBookmarks !== undefined || d.includeTabs !== undefined;
        return exec.invoke("browser.search", {
          query: d.query ?? "",
          limit: d.limit ?? d.maxResults ?? 20,
          includeHistory: anyIncludeGiven ? (d.includeHistory ?? true) : true,
          includeBookmarks: anyIncludeGiven ? (d.includeBookmarks ?? true) : true,
          includeTabs: anyIncludeGiven ? (d.includeTabs ?? true) : true,
        });
      }
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown browser action "${data.action}". Valid: status, capabilities, permissions, diagnostics, search`);
    }
  }),

  defineTool(tabsTool, async (input, exec) => {
    const data = input as Record<string, any>;
    const action = data.action;
    switch (action) {
      case "list": return exec.invoke("tabs.list", {});
      case "get": return exec.invoke("tabs.get", { tabId: data.tabId });
      case "active": return exec.invoke("tabs.active", {});
      case "search": return exec.invoke("tabs.search", { query: data.query ?? "" });
      case "create": return exec.invoke("tabs.create", { url: data.url, pinned: data.pinned ?? false, groupId: data.groupId, active: data.active ?? true });
      case "close": return exec.invoke("tabs.close", { tabId: data.tabId });
      case "activate": return exec.invoke("tabs.activate", { tabId: data.tabId });
      case "duplicate": return exec.invoke("tabs.duplicate", { tabId: data.tabId });
      case "discard": return exec.invoke("tabs.discard", { tabId: data.tabId });
      case "move": {
        // Canonical granular params are {tabIds, windowId, index}. A single
        // tabId is wrapped into tabIds; when windowId is omitted it is read
        // from that tab's current window, and a move with neither is an
        // explicit error rather than a silent no-op.
        const tabIds: number[] = Array.isArray(data.tabIds) ? data.tabIds : (typeof data.tabId === "number" ? [data.tabId] : []);
        let windowId = data.windowId;
        if (windowId === undefined && tabIds.length === 1) {
          const current = await exec.invoke<{ tab?: { windowId?: number } }>("tabs.get", { tabId: tabIds[0] });
          windowId = current?.tab?.windowId;
        }
        if (tabIds.length === 0 || windowId === undefined) {
          throw new ToolErrorException("INVALID_INPUT", "tabs.move needs tabIds (or tabId) and a windowId");
        }
        return exec.invoke("tabs.move", { tabIds, windowId, index: data.index });
      }
      case "pin": return exec.invoke("tabs.pin", { tabId: data.tabId, pinned: data.pinned ?? true });
      case "mute": return exec.invoke("tabs.mute", { tabId: data.tabId, muted: data.muted ?? true });
      // Canonical granular tool is tabs.setZoom with param zoom; level is accepted as an alias
      // for the old unified spelling, with zoom taking precedence.
      case "zoom": return exec.invoke("tabs.setZoom", { tabId: data.tabId, zoom: data.zoom ?? data.level ?? 1 });
      case "group": return exec.invoke("tabs.group", { tabIds: data.tabIds ?? [], title: data.title });
      case "ungroup": return exec.invoke("tabs.ungroup", { tabIds: data.tabIds ?? [] });
      case "save_session": {
        if (!exec.approvalValidated) {
          const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.saveSession", { name: data.title ?? "session", windowId: undefined }, { dryRun: true });
          if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "tabs.save_session requires user approval");
        }
        return exec.invoke("workflows.saveSession", { name: data.title ?? "session", windowId: undefined });
      }
      case "restore_session": {
        if (!exec.approvalValidated) {
          const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.restoreSession", { sessionId: data.sessionId, active: data.active ?? false }, { dryRun: true });
          if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "tabs.restore_session requires user approval");
        }
        return exec.invoke("workflows.restoreSession", { sessionId: data.sessionId, active: data.active ?? false });
      }
      case "organize": {
        if (!exec.approvalValidated) {
          const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.organizeTabs", { strategy: data.strategy === "prefix" ? "titlePrefix" : (data.strategy ?? "domain"), windowId: undefined, maxGroups: data.maxGroups ?? 5 }, { dryRun: true });
          if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "tabs.organize requires user approval");
        }
        return exec.invoke("workflows.organizeTabs", { strategy: data.strategy === "prefix" ? "titlePrefix" : (data.strategy ?? "domain"), windowId: undefined, maxGroups: data.maxGroups ?? 5 });
      }
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown tabs action "${action}". Valid: list, get, active, search, create, close, activate, duplicate, discard, move, pin, mute, zoom, group, ungroup, save_session, restore_session, organize`);
    }
  }),

  defineTool(windowsTool, async (input, exec) => {
    const data = input as Record<string, any>;
    switch (data.action) {
      case "list": return exec.invoke("windows.list", {});
      case "create": return exec.invoke("windows.create", { url: data.url, focused: data.focused ?? true, incognito: data.incognito ?? false });
      case "update": return exec.invoke("windows.update", { windowId: data.windowId, state: data.state, focused: data.focused, width: data.width, height: data.height, left: data.left, top: data.top });
      case "close": return exec.invoke("windows.close", { windowId: data.windowId });
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown windows action "${data.action}". Valid: list, create, update, close`);
    }
  }),

  defineTool(navigateTool, async (input, exec) => {
    const data = input as Record<string, any>;
    // Client-supplied confirmed/userApproved flags are ignored (see executor.ts):
    // only a broker token, dashboard decision, or verified elicitation decision counts.
    const tabId = data.tabId;
    const category = data.category;
    const action = data.action;

    const isTab =
      category === "tab" ||
      [
        "list", "get", "active", "create", "close", "activate", "switch",
        "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup",
        "save_session", "restore_session", "organize",
      ].includes(action);

    const isWindow = category === "window" || action === "update";
    const isSync = category === "sync" || Boolean(data.for);

    if (isTab) {
      const tabAction = action === "switch" ? "activate" : action;
      switch (tabAction) {
        case "list": return exec.invoke("tabs.list", {});
        case "get": return exec.invoke("tabs.get", { tabId: data.tabId });
        case "active": return exec.invoke("tabs.active", {});
        case "search": return exec.invoke("tabs.search", { query: data.query ?? "" });
        case "create": return exec.invoke("tabs.create", { url: data.url, pinned: data.pinned ?? false, groupId: data.groupId, active: data.active ?? true });
        case "close": return exec.invoke("tabs.close", { tabId: data.tabId });
        case "activate": return exec.invoke("tabs.activate", { tabId: data.tabId });
        case "duplicate": return exec.invoke("tabs.duplicate", { tabId: data.tabId });
        case "discard": return exec.invoke("tabs.discard", { tabId: data.tabId });
        case "move": {
          // Canonical granular params are {tabIds, windowId, index}. A single
          // tabId is wrapped into tabIds; when windowId is omitted it is read
          // from that tab's current window, and a move with neither is an
          // explicit error rather than a silent no-op.
          const tabIds: number[] = Array.isArray(data.tabIds) ? data.tabIds : (typeof data.tabId === "number" ? [data.tabId] : []);
          let windowId = data.windowId;
          if (windowId === undefined && tabIds.length === 1) {
            const current = await exec.invoke<{ tab?: { windowId?: number } }>("tabs.get", { tabId: tabIds[0] });
            windowId = current?.tab?.windowId;
          }
          if (tabIds.length === 0 || windowId === undefined) {
            throw new ToolErrorException("INVALID_INPUT", "tabs.move needs tabIds (or tabId) and a windowId");
          }
          return exec.invoke("tabs.move", { tabIds, windowId, index: data.index });
        }
        case "pin": return exec.invoke("tabs.pin", { tabId: data.tabId, pinned: data.pinned ?? true });
        case "mute": return exec.invoke("tabs.mute", { tabId: data.tabId, muted: data.muted ?? true });
        // Canonical granular tool is tabs.setZoom with param zoom; level is accepted as an alias
        // for the old unified spelling, with zoom taking precedence.
        case "zoom": return exec.invoke("tabs.setZoom", { tabId: data.tabId, zoom: data.zoom ?? data.level ?? 1 });
        case "group": return exec.invoke("tabs.group", { tabIds: data.tabIds ?? [], title: data.title });
        case "ungroup": return exec.invoke("tabs.ungroup", { tabIds: data.tabIds ?? [] });
        case "save_session": {
          if (!exec.approvalValidated) {
            const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.saveSession", { name: data.title ?? "session", windowId: data.windowId }, { dryRun: true });
            if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "navigate.save_session requires user approval");
          }
          return exec.invoke("workflows.saveSession", { name: data.title ?? "session", windowId: data.windowId });
        }
        case "restore_session": {
          if (!exec.approvalValidated) {
            const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.restoreSession", { sessionId: data.sessionId, active: data.active ?? false }, { dryRun: true });
            if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "navigate.restore_session requires user approval");
          }
          return exec.invoke("workflows.restoreSession", { sessionId: data.sessionId, active: data.active ?? false });
        }
        case "organize": {
          if (!exec.approvalValidated) {
            const dry = await exec.invoke<{ requiresApproval?: boolean }>("workflows.organizeTabs", { strategy: data.strategy === "prefix" ? "titlePrefix" : (data.strategy ?? "domain"), windowId: data.windowId, maxGroups: data.maxGroups ?? 5 }, { dryRun: true });
            if (dry?.requiresApproval) throw new ToolErrorException("APPROVAL_REQUIRED", "navigate.organize requires user approval");
          }
          return exec.invoke("workflows.organizeTabs", { strategy: data.strategy === "prefix" ? "titlePrefix" : (data.strategy ?? "domain"), windowId: data.windowId, maxGroups: data.maxGroups ?? 5 });
        }
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown tab navigate action "${action}". Valid: list, get, active, search, create, close, activate, duplicate, discard, move, pin, mute, zoom, group, ungroup, save_session, restore_session, organize`);
      }
    }

    if (isWindow) {
      switch (action) {
        case "list": return exec.invoke("windows.list", {});
        case "create": return exec.invoke("windows.create", { url: data.url, focused: data.focused ?? true, incognito: data.incognito ?? false });
        case "update": return exec.invoke("windows.update", { windowId: data.windowId, state: data.state, focused: data.focused, width: data.width, height: data.height, left: data.left, top: data.top });
        case "close": return exec.invoke("windows.close", { windowId: data.windowId });
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown window navigate action "${action}". Valid: list, create, update, close`);
      }
    }

    if (isSync) {
      if (data.for === "element") {
        return exec.invoke("page.waitFor", {
          tabId,
          frameId: data.frameId,
          by: data.by ?? "selector",
          selector: data.selector,
          value: data.value,
          role: data.role,
          name: data.name,
          timeoutMs: data.timeoutMs,
        });
      }
      if (data.for === "network_idle") {
        return exec.invoke("page.networkIdle", { tabId, frameId: data.frameId, quietMs: data.quietMs, timeoutMs: data.timeoutMs });
      }
      if (data.for === "delay") {
        const ms = Math.min(Math.max(1, Number(data.timeoutMs ?? 1000)), 30000);
        await abortableDelay(ms, exec.signal);
        return { waited: true, delayMs: ms };
      }
      return exec.invoke("navigation.wait", { tabId, timeoutMs: data.timeoutMs, waitForNetworkIdle: data.waitForNetworkIdle ?? false, quietMs: data.quietMs });
    }

    switch (data.action) {
      case "open": return exec.invoke("navigation.open", { url: data.url, reuseActiveTab: data.reuseActiveTab ?? false, active: data.active ?? true, tabId });
      case "back": return exec.invoke("navigation.back", { tabId });
      case "forward": return exec.invoke("navigation.forward", { tabId });
      case "reload": return exec.invoke("navigation.reload", { tabId, bypassCache: data.bypassCache ?? false });
      case "search": return exec.invoke("navigation.search", { query: data.query ?? "", provider: data.provider ?? "duckduckgo", newTab: data.newTab ?? true, waitForLoad: data.waitForLoad ?? true, timeoutMs: data.timeoutMs ?? 10000, tabId });
      case "wait": return exec.invoke("navigation.wait", { tabId, timeoutMs: data.timeoutMs ?? 10000, waitForNetworkIdle: data.waitForNetworkIdle ?? false, quietMs: data.quietMs ?? 300 });
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown navigate action "${data.action}". Valid: open, back, forward, reload, search, wait (or category tab/window/sync)`);
    }
  }),

  defineTool(observeTool, async (input, exec) => {
    const data = input as Record<string, any>;
    // Observe does NOT self-approve: nested tools still go through the
    // executor, so a nested tool that needs approval (e.g. screenshots)
    // reports an approval error for its include instead of running.
    const include = new Set(Array.isArray(data.include) ? data.include : ["metadata", "text", "a11y"]);
    const tabId = data.tabId;
    const frameId = data.frameId;
    const out: Record<string, unknown> = {};
    const errors: { include: string; error: string }[] = [];

    async function run(tool: string, payload: unknown): Promise<any> {
      return exec.invoke(tool, payload);
    }

    // One failed include must not fail the whole call: each include runs
    // through this wrapper, which records its error and lets the rest run.
    function taskFor(includeName: string, tool: string, payload: unknown, apply: (r: any) => void): Promise<void> {
      return run(tool, payload).then(apply).catch((error: unknown) => {
        errors.push({ include: includeName, error: error instanceof Error ? error.message : String(error) });
      });
    }

    const tasks: Promise<void>[] = [];

    if (include.has("metadata")) {
      tasks.push(taskFor("metadata", "page.metadata", { tabId, frameId }, (r) => { out.metadata = r; }));
    }
    if (include.has("outline")) {
      tasks.push(taskFor("outline", "page.outline", { tabId, frameId, maxDepth: data.maxDepth }, (r) => {
        out.outline = r?.outline ?? r;
      }));
    }
    if (include.has("text")) {
      tasks.push(taskFor("text", "page.read", { tabId, frameId, offset: 0, maxChars: data.maxChars }, (r) => {
        out.text = r?.text;
        out.truncated = r?.truncated;
      }));
    }
    if (include.has("links")) {
      tasks.push(taskFor("links", "page.links", { tabId, frameId, limit: data.limit, sameOriginOnly: data.sameOriginOnly }, (r) => {
        out.links = r?.links;
      }));
    }
    if (include.has("tables")) {
      tasks.push(taskFor("tables", "page.tables", { tabId, frameId, maxRows: data.maxRows }, (r) => {
        out.tables = r?.tables;
      }));
    }
    if (include.has("forms")) {
      tasks.push(taskFor("forms", "forms.inspect", { tabId, frameId }, (r) => {
        out.forms = r?.forms;
      }));
    }
    if (include.has("find") && (data.query || data.value || data.selector)) {
      if (data.query) {
        tasks.push(taskFor("find", "page.find", { tabId, frameId, query: data.query, caseSensitive: false, limit: data.limit, contextChars: 120 }, (r) => {
          out.find = r?.matches ?? r;
        }));
      } else {
        tasks.push(taskFor("find", "dom.find", { tabId, frameId, by: data.by ?? "text", value: data.value ?? data.selector ?? "", role: data.role, name: data.name, limit: data.limit }, (r) => {
          out.find = r?.elements ?? r;
        }));
      }
    }
    if (include.has("a11y")) {
      tasks.push(taskFor("a11y", "page.accessibilityTree", { tabId, frameId, maxNodes: data.maxNodes, maxDepth: data.maxDepth, interactiveOnly: data.interactiveOnly }, (r) => {
        out.nodes = r?.nodes;
      }));
    }
    if (include.has("ast")) {
      tasks.push(taskFor("ast", "devtools.dom", { tabId, frameId, maxNodes: data.maxNodes, maxDepth: data.maxDepth }, (r) => {
        out.ast = buildAstTree(Array.isArray(r?.nodes) ? r.nodes : Array.isArray(r) ? r : []);
      }));
    }
    if (include.has("shadow")) {
      tasks.push(taskFor("shadow", "dom.shadow", { tabId, frameId, maxDepth: data.maxDepth }, (r) => {
        out.shadow = r;
      }));
    }
    if (include.has("frames")) {
      tasks.push(taskFor("frames", "frames.list", { tabId }, (r) => {
        out.frames = r?.frames ?? r;
      }));
    }
    if (include.has("selection")) {
      tasks.push(taskFor("selection", "page.selectedText", { tabId, frameId }, (r) => {
        out.selection = r?.text ?? r;
      }));
    }

    // Run independent page reads in parallel; taskFor already turned
    // each failure into a per-include error, so Promise.all cannot reject.
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    if (include.has("screenshot") || data.includeScreenshot) {
      await taskFor("screenshot", "screenshots.visible", { tabId, format: data.screenshotFormat, quality: data.screenshotQuality }, (shot) => {
        out.screenshot = shot;
      });
    }
    if (include.has("a11y") || include.has("ast") || include.has("screenshot") || data.includeScreenshot) {
      await taskFor("viewport", "screenshots.viewport", { tabId }, (vp) => {
        out.viewport = vp;
      });
    }
    out.coordinateHint = "dom.clickAt uses CSS viewport pixels. For screenshot pixels, set coordinateSpace=screenshot or divide by devicePixelRatio.";
    if (errors.length > 0) out.errors = errors;
    return out;
  }),

  defineTool(actTool, async (input, exec) => {
    const data = input as Record<string, any>;
    // Client-supplied confirmed/userApproved flags are ignored (see executor.ts):
    // only a broker token, dashboard decision, or verified elicitation decision counts.
    const tabIdResolved = data.tabId ?? (await resolveTabId(exec.ctx, data.tabId, exec.signal));
    const frameIdResolved = data.frameId;
    const stopOnError = data.stopOnError !== false;

    // Pre-scan: any consequential step requires approval BEFORE any action runs.
    if (!exec.approvalValidated) {
      for (const step of data.steps) {
        const op = step.do;
        const target = step.target ?? {};
        if (op === "click") {
          const coords = coordTarget(target);
          const ref = coords && !target?.ref ? undefined : await resolveTargetRef(exec, tabIdResolved, target, frameIdResolved).catch(() => undefined);
          const activation = await runPageOp<{ consequential: boolean; reason: string; text?: string }>(
            exec.ctx,
            tabIdResolved,
            coords && !ref ? { op: "activationCheck", x: coords.x, y: coords.y } : { op: "activationCheck", ref },
            frameIdResolved,
            exec.signal,
          );
          const sensitive = activation.consequential || /\b(delete|remove|buy|purchase|confirm|pay|checkout|submit|download)\b/i.test(activation.text ?? "");
          if (sensitive) {
            throw new ToolErrorException("APPROVAL_REQUIRED", "act step requires user approval", {
              details: { reason: activation.reason || "sensitive-control", text: activation.text, step: { tool: "dom.clickAt", input: { tabId: tabIdResolved, frameId: frameIdResolved, x: coords?.x, y: coords?.y, coordinateSpace: coords?.space } } },
            });
          }
        }
        // Mirror the granular dom.press gate, which activation-checks both
        // Enter and Space: without the Space case, a consequential Space
        // press was only caught mid-batch by the nested dom.press handler,
        // after earlier steps in the batch had already run.
        if (op === "press" && (step.key === "Enter" || step.key === " ")) {
          const ref = await resolveTargetRef(exec, tabIdResolved, target, frameIdResolved).catch(() => undefined);
          if (ref) {
            const activation = await runPageOp<{ consequential: boolean; reason: string; text?: string }>(
              exec.ctx,
              tabIdResolved,
              { op: "activationCheck", ref, key: step.key },
              frameIdResolved,
              exec.signal,
            );
            if (activation.consequential || /\b(delete|remove|buy|purchase|confirm|pay|checkout|submit|download)\b/i.test(activation.text ?? "")) {
              throw new ToolErrorException("APPROVAL_REQUIRED", "act step requires user approval", {
                details: { reason: activation.reason || "form-submit", text: activation.text, step: { tool: "dom.press", input: { tabId: tabIdResolved, frameId: frameIdResolved, ref, key: step.key } } },
              });
            }
          }
        }
      }
    }

    const results: any[] = [];
    for (let i = 0; i < data.steps.length; i += 1) {
      const step = { ...data.steps[i], index: i };
      const item = await runStep(exec, tabIdResolved, frameIdResolved, step);
      results.push(item);
      if (stopOnError && !item.ok) break;
    }
    return { results };
  }),

  defineTool(waitTool, async (input, exec) => {
    const data = input as Record<string, any>;
    const tabId = data.tabId;
    if (data.for === "element") {
      return exec.invoke("page.waitFor", {
        tabId,
        frameId: data.frameId,
        by: data.by ?? "selector",
        selector: data.selector,
        value: data.value,
        role: data.role,
        name: data.name,
        timeoutMs: data.timeoutMs,
      });
    }
    if (data.for === "network_idle") {
      return exec.invoke("page.networkIdle", { tabId, frameId: data.frameId, quietMs: data.quietMs, timeoutMs: data.timeoutMs });
    }
    if (data.for === "delay") {
      const ms = Math.min(Math.max(1, Number(data.timeoutMs ?? 1000)), 30000);
      await abortableDelay(ms, exec.signal);
      return { waited: true, delayMs: ms };
    }
    return exec.invoke("navigation.wait", { tabId, timeoutMs: data.timeoutMs, waitForNetworkIdle: data.waitForNetworkIdle ?? false, quietMs: data.quietMs });
  }),

  defineTool(formTool, async (input, exec) => {
    const data = input as Record<string, any>;
    // Client-supplied confirmed/userApproved flags are ignored (see executor.ts):
    // only a broker token, dashboard decision, or verified elicitation decision counts.
    const tabId = data.tabId;
    const phase = data.phase ?? data.action;

    let fields = data.fields;
    if (fields && !Array.isArray(fields) && typeof fields === "object") {
      fields = Object.entries(fields).map(([ref, value]) => ({ ref, value: String(value) }));
    }

    switch (phase) {
      case "inspect": return exec.invoke("forms.inspect", { tabId, frameId: data.frameId });
      case "preview": return exec.invoke("forms.preview", { tabId, frameId: data.frameId, ref: data.ref ?? data.formRef });
      case "fill": return exec.invoke("forms.fill", { tabId, frameId: data.frameId, fields: fields ?? [] });
      case "upload": {
        assertUnifiedFileCaps(data.files, "forms.upload");
        await requireLegacyApproval(exec, "forms.upload", { tabId, frameId: data.frameId, ref: data.ref, files: data.files ?? [] }, "form.upload");
        return exec.invoke("forms.upload", { tabId, frameId: data.frameId, ref: data.ref, files: data.files ?? [] });
      }
      case "set_file": {
        assertUnifiedFileCaps(data.files, "forms.setFile");
        await requireLegacyApproval(exec, "forms.setFile", { tabId, frameId: data.frameId, ref: data.ref, fileId: data.fileId }, "form.set_file");
        return exec.invoke("forms.setFile", { tabId, frameId: data.frameId, ref: data.ref, fileId: data.fileId });
      }
      case "submit": {
        await requireLegacyApproval(exec, "forms.submit", { tabId, frameId: data.frameId, formRef: data.formRef ?? data.ref, expectedAction: data.expectedAction }, "form.submit");
        return exec.invoke("forms.submit", { tabId, frameId: data.frameId, formRef: data.formRef ?? data.ref, expectedAction: data.expectedAction });
      }
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown form phase "${phase}". Valid: inspect, preview, fill, upload, submit, set_file`);
    }
  }),

  defineTool(submitTool, async (input, exec) => {
    const data = input as Record<string, any>;
    const tabId = data.tabId;
    if (data.action === "submit") await requireLegacyApproval(exec, "forms.submit", { tabId, frameId: data.frameId, formRef: data.formRef, expectedAction: data.expectedAction }, "submit.submit");
    if (data.action === "upload") {
      assertUnifiedFileCaps(data.files, "forms.upload");
      await requireLegacyApproval(exec, "forms.upload", { tabId, frameId: data.frameId, ref: data.ref, files: data.files ?? [] }, "submit.upload");
    }
    if (data.action === "set_file") {
      assertUnifiedFileCaps(data.files, "forms.setFile");
      await requireLegacyApproval(exec, "forms.setFile", { tabId, frameId: data.frameId, ref: data.ref, fileId: data.fileId }, "submit.set_file");
    }
    switch (data.action) {
      case "submit": return exec.invoke("forms.submit", { tabId, frameId: data.frameId, formRef: data.formRef, expectedAction: data.expectedAction });
      case "upload": return exec.invoke("forms.upload", { tabId, frameId: data.frameId, ref: data.ref, files: data.files ?? [] });
      case "set_file": return exec.invoke("forms.setFile", { tabId, frameId: data.frameId, ref: data.ref, fileId: data.fileId });
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown submit action "${data.action}". Valid: submit, upload, set_file`);
    }
  }),

  defineTool(devtoolsTool, async (input, exec) => {
    const data = input as Record<string, any>;
    const tabId = data.tabId;
    switch (data.action) {
      case "console": return exec.invoke("devtools.console", { tabId, frameId: data.frameId, limit: data.limit, level: data.level });
      case "network": return exec.invoke("devtools.network", { tabId, limit: data.limit, urlFilter: data.urlFilter, onlyFailed: data.onlyFailed });
      case "errors": return exec.invoke("devtools.pageErrors", { tabId, limit: data.limit });
      case "performance": return exec.invoke("devtools.performance", { tabId, frameId: data.frameId });
      case "observer": return exec.invoke("browser.observer", { tabId, enabled: data.enabled ?? true });
      case "dialogs": return exec.invoke("page.dialogs", { tabId, frameId: data.frameId, limit: data.limit });
      case "respond_dialog": {
        await requireLegacyApproval(exec, "page.respondDialog", { tabId, frameId: data.frameId, response: data.response ?? "accept", text: data.text }, "devtools.respond_dialog");
        return exec.invoke("page.respondDialog", { tabId, frameId: data.frameId, response: data.response ?? "accept", text: data.text });
      }
      default: throw new ToolErrorException("INVALID_INPUT", `Unknown devtools action "${data.action}". Valid: console, network, errors, performance, observer, dialogs, respond_dialog`);
    }
  }),

  defineTool(dataTool, async (input, exec) => {
    const data = input as Record<string, any>;
    // Client-supplied confirmed/userApproved flags are ignored (see executor.ts):
    // only a broker token, dashboard decision, or verified elicitation decision counts.
    const domain = data.domain ?? data.store;
    const action = data.action;

    if (domain === "clipboard") {
      if (action === "read") {
        await requireLegacyApproval(exec, "clipboard.read", {}, "clipboard.read");
        return exec.invoke("clipboard.read", {});
      }
      if (action === "write") {
        await requireLegacyApproval(exec, "clipboard.write", { text: data.text ?? "" }, "clipboard.write");
        return exec.invoke("clipboard.write", { text: data.text ?? "" });
      }
      throw new ToolErrorException("INVALID_INPUT", `Unknown clipboard action "${action}". Valid: read, write`);
    }

    if (domain === "files") {
      if (action === "list") return exec.invoke("files.list", { limit: data.limit ?? 100 });
      if (action === "stat") return exec.invoke("files.stat", { id: data.id });
      throw new ToolErrorException("INVALID_INPUT", `Unknown files action "${action}". Valid: list, stat`);
    }

    if (domain === "devtools") {
      const tabId = data.tabId;
      switch (action) {
        case "console": return exec.invoke("devtools.console", { tabId, frameId: data.frameId, limit: data.limit, level: data.level });
        case "network": return exec.invoke("devtools.network", { tabId, limit: data.limit, urlFilter: data.urlFilter, onlyFailed: data.onlyFailed });
        case "errors": return exec.invoke("devtools.pageErrors", { tabId, limit: data.limit });
        case "performance": return exec.invoke("devtools.performance", { tabId, frameId: data.frameId });
        case "observer": return exec.invoke("browser.observer", { tabId, enabled: data.enabled ?? true });
        case "dialogs": return exec.invoke("page.dialogs", { tabId, frameId: data.frameId, limit: data.limit });
        case "respond_dialog": {
          await requireLegacyApproval(exec, "page.respondDialog", { tabId, frameId: data.frameId, response: data.response ?? "accept", text: data.text }, "devtools.respond_dialog");
          return exec.invoke("page.respondDialog", { tabId, frameId: data.frameId, response: data.response ?? "accept", text: data.text });
        }
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown devtools action "${action}". Valid: console, network, errors, performance, observer, dialogs, respond_dialog`);
      }
    }

    const downloadId = typeof data.id === "number" ? data.id : parseInt(String(data.id), 10) || 0;
    const downloadIds = Array.isArray(data.ids)
      ? data.ids.map((x: any) => (typeof x === "number" ? x : parseInt(String(x), 10))).filter((n: number) => !isNaN(n))
      : [];

    if (domain === "bookmarks") {
      switch (action) {
        case "list": return exec.invoke("bookmarks.list", { folderId: data.folderId, limit: data.limit ?? 100 });
        case "search": return exec.invoke("bookmarks.search", { query: data.query ?? "", limit: data.limit ?? 50 });
        case "create": return exec.invoke("bookmarks.create", { title: data.title ?? "", url: data.url, parentId: data.parentId });
        case "create_folder": return exec.invoke("bookmarks.createFolder", { title: data.title ?? "", parentId: data.parentId, index: data.index });
        case "move": return exec.invoke("bookmarks.move", { id: String(data.id), parentId: data.parentId, index: data.index });
        case "update": return exec.invoke("bookmarks.update", { id: String(data.id), title: data.title, url: data.url });
        case "delete": {
          await requireLegacyApproval(exec, "bookmarks.delete", { id: String(data.id) }, "data.bookmarks.delete");
          return exec.invoke("bookmarks.delete", { id: String(data.id) });
        }
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown bookmarks action "${action}".`);
      }
    }
    if (domain === "history") {
      switch (action) {
        case "search": return exec.invoke("history.search", { text: data.text ?? data.query ?? "", startTime: data.startTime, endTime: data.endTime, maxResults: data.maxResults ?? data.limit ?? 50 });
        case "add": return exec.invoke("history.add", { url: data.url, title: data.title, transition: data.transition ?? "link" });
        case "delete": {
          await requireLegacyApproval(exec, "history.delete", { urls: data.urls ?? [] }, "data.history.delete");
          return exec.invoke("history.delete", { urls: data.urls ?? [] });
        }
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown history action "${action}".`);
      }
    }
    if (domain === "downloads") {
      switch (action) {
        case "list": return exec.invoke("downloads.list", { limit: data.limit ?? 50, query: data.query });
        case "start": {
          await requireLegacyApproval(exec, "downloads.start", { url: data.url, filename: data.filename, saveAs: data.saveAs ?? false, conflictAction: data.conflictAction }, "data.downloads.start");
          return exec.invoke("downloads.start", { url: data.url, filename: data.filename, saveAs: data.saveAs ?? false, conflictAction: data.conflictAction });
        }
        case "control": {
          await requireLegacyApproval(exec, "downloads.control", { id: downloadId, action: data.controlAction ?? "pause" }, "data.downloads.control");
          return exec.invoke("downloads.control", { id: downloadId, action: data.controlAction ?? "pause" });
        }
        case "erase": {
          await requireLegacyApproval(exec, "downloads.erase", { ids: downloadIds }, "data.downloads.erase");
          return exec.invoke("downloads.erase", { ids: downloadIds });
        }
        default: throw new ToolErrorException("INVALID_INPUT", `Unknown downloads action "${action}".`);
      }
    }
    throw new ToolErrorException("INVALID_INPUT", `Unknown data domain "${domain}". Valid: bookmarks, history, downloads, clipboard, files, devtools`);
  }),

  defineTool(clipboardTool, async (input, exec) => {
    const data = input as Record<string, any>;
    if (data.action === "read") {
      await requireLegacyApproval(exec, "clipboard.read", {}, "clipboard.read");
      return exec.invoke("clipboard.read", {});
    }
    if (data.action === "write") {
      await requireLegacyApproval(exec, "clipboard.write", { text: data.text ?? "" }, "clipboard.write");
      return exec.invoke("clipboard.write", { text: data.text ?? "" });
    }
    throw new ToolErrorException("INVALID_INPUT", `Unknown clipboard action "${data.action}". Valid: read, write`);
  }),

  defineTool(filesTool, async (input, exec) => {
    const data = input as Record<string, any>;
    if (data.action === "list") return exec.invoke("files.list", { limit: data.limit ?? 100 });
    if (data.action === "stat") return exec.invoke("files.stat", { id: data.id });
    throw new ToolErrorException("INVALID_INPUT", `Unknown files action "${data.action}". Valid: list, stat`);
  }),
];
