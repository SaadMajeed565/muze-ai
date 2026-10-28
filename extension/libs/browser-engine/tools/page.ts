import {
  framesList,
  navigationBack,
  navigationForward,
  navigationOpen,
  navigationReload,
  navigationSearch,
  navigationWait,
  pageAccessibilityTree,
  pageDialogs,
  pageRespondDialog,
  pageExtract,
  pageFind,
  pageLinks,
  pageMetadata,
  pageNetworkIdle,
  pageOutline,
  pageRead,
  pageSelectedText,
  pageSnapshot,
  pageTables,
  pageWaitFor,
} from "../../tool-contracts/index.js";
import { ToolErrorException } from "../../tool-contracts/index.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import { isSensitiveElement, redactSecrets, redactUrl, REDACTED } from "../../security/privacy.js";
import { wrapUntrustedWebContent } from "../../security/index.js";
import { abortableDelay, raceWithAbort, requireScriptableTab, resolveTabId, runPageOp, throwIfAborted, toTabInfo, validateUrlInput } from "./helpers.js";

/**
 * The documented search endpoints. DuckDuckGo's HTML endpoint is the default
 * because it needs no scripts and no tracking cookies.
 */
const SEARCH_PROVIDERS: Record<string, (query: string) => string> = {
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`,
};

/**
 * Walk a tool result and mask anything that looks like a secret. The agent
 * already avoids collecting the obvious cases; this is the second line of
 * defence for text a page rendered on its own.
 */
function redactResult<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactResult(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "url" || key === "href" || key === "canonicalUrl") {
        out[key] = typeof item === "string" ? redactUrl(item) : item;
        continue;
      }
      out[key] = redactResult(item);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Apply the field level rules to an extraction result. A field whose element
 * descriptor looks like a credential never carries its value through.
 */
function redactExtraction(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const payload = result as { results?: Record<string, string>; elements?: Record<string, { tagName?: string; type?: string; name?: string; id?: string; autocomplete?: string; ariaLabel?: string; metaName?: string }> };
  const results = payload.results;
  const elements = payload.elements;
  if (!results) return result;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(results)) {
    const descriptor = elements?.[name];
    if (descriptor && isSensitiveElement(descriptor)) {
      out[name] = REDACTED;
      continue;
    }
    out[name] = redactSecrets(value);
  }
  return { ...payload, results: out };
}

/**
 * Self-contained frame probe injected into every frame. Runs in the page, so
 * it must not close over module scope (serialized via Function.toString()).
 */
function frameProbe(): { url: string; title: string; origin: string } {
  return { url: location.href, title: document.title ?? "", origin: location.origin };
}


export const pageToolHandlers: RegisteredTool[] = [
  defineTool(pageRead, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; offset: number; maxChars: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp<{ text?: string }>(exec.ctx, tab.id!, { op: "readPage", offset: data.offset, maxChars: data.maxChars }, data.frameId, exec.signal);
    const redacted = redactResult(result) as { text?: string };
    if (typeof redacted?.text === "string") {
      redacted.text = wrapUntrustedWebContent(redacted.text, tab.url);
    }
    return redacted;
  }),

  defineTool(pageMetadata, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "metadata" }, data.frameId, exec.signal);
    return redactResult(result);
  }),

  defineTool(pageOutline, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; maxDepth: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "outline", maxDepth: data.maxDepth }, data.frameId, exec.signal);
    return redactResult(result);
  }),

  defineTool(pageLinks, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; limit: number; sameOriginOnly: boolean };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "links", limit: data.limit, sameOriginOnly: data.sameOriginOnly }, data.frameId, exec.signal);
    return redactResult(result);
  }),

  defineTool(pageSelectedText, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "selected" }, data.frameId, exec.signal);
    return redactResult(result);
  }),

  defineTool(pageFind, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; query: string; caseSensitive: boolean; limit: number; contextChars: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "findText", query: data.query, caseSensitive: data.caseSensitive, limit: data.limit, contextChars: data.contextChars }, data.frameId, exec.signal);
    // Normalise to the declared output shape ({matches:[{index, text,
    // context?}], total}). The page agent now returns this shape directly;
    // the legacy shape ({matches:[{excerpt, index}], totalMatches}) is
    // still mapped here so a stale agent payload can never again reach
    // the executor's output validation as a schema failure. The schema
    // itself is NOT weakened: a wrong shape is fixed, not papered over.
    const raw = result as {
      matches?: { index: number; text?: string; excerpt?: string; context?: string }[];
      total?: number;
      totalMatches?: number;
    };
    const matches = (raw.matches ?? []).map((m) => ({
      index: m.index,
      text: m.text ?? m.excerpt ?? "",
      context: m.context ?? m.excerpt,
    }));
    return redactResult({ matches, total: raw.total ?? raw.totalMatches ?? matches.length });
  }),

  defineTool(pageTables, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; index?: number; maxRows: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "tables", index: data.index, maxRows: data.maxRows }, data.frameId, exec.signal);
    return redactResult(result);
  }),

  defineTool(pageExtract, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; fields: { name: string; selector: string; attribute?: string }[] };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(exec.ctx, tab.id!, { op: "extractFields", fields: data.fields }, data.frameId, exec.signal);
    return redactExtraction(result);
  }),

  defineTool(pageWaitFor, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      selector?: string;
      by: "selector" | "text" | "label" | "placeholder" | "role" | "name";
      value?: string;
      role?: string;
      name?: string;
      timeoutMs: number;
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    // A selector is the common case; anything else is expressed through the
    // strategy based wait.
    if (data.by === "selector" && data.selector) {
      return runPageOp(
        exec.ctx,
        tab.id!,
        { op: "waitForSelector", selector: data.selector, timeoutMs: data.timeoutMs },
        data.frameId,
        exec.signal,
      );
    }
    const value = data.value ?? data.selector;
    if (!value) throw new ToolErrorException("INVALID_INPUT", "page.waitFor needs a selector or a value for the chosen strategy");
    return runPageOp(
      exec.ctx,
      tab.id!,
      { op: "waitForElement", by: data.by, value, role: data.role, name: data.name, timeoutMs: data.timeoutMs, visible: true },
      data.frameId,
      exec.signal,
    );
  }),

  defineTool(pageNetworkIdle, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; quietMs: number; timeoutMs: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    // The observer knows about requests the page started before it was asked,
    // so it is preferred when it is attached.
    if (exec.ctx.observer) {
      const initial = await raceWithAbort(exec.ctx.observer.read(tab.id!), exec.signal);
      if (initial.attached) {
        // The observer read is a snapshot: pending requests finish
        // independently, so every poll iteration must re-read fresh state.
        // (The old loop re-assigned pending from the initial snapshot at
        // the top of each iteration, so it could report timed out even
        // after every request had finished.)
        const deadline = Date.now() + data.timeoutMs;
        let pending = initial.pendingRequests;
        let waitedMs = 0;
        while (Date.now() < deadline) {
          const fresh = await raceWithAbort(exec.ctx.observer.read(tab.id!), exec.signal);
          pending = fresh.pendingRequests;
          if (pending === 0) break;
          await abortableDelay(100, exec.signal);
          waitedMs += 100;
        }
        // One final fresh read, so a request finishing during the last
        // delay is not reported as still pending.
        if (pending !== 0) {
          const fresh = await raceWithAbort(exec.ctx.observer.read(tab.id!), exec.signal);
          pending = fresh.pendingRequests;
        }
        return {
          idle: pending === 0,
          pending,
          waitedMs: Math.min(waitedMs, data.timeoutMs),
          timedOut: pending !== 0,
        };
      }
    }
    return runPageOp(exec.ctx, tab.id!, { op: "networkIdle", quietMs: data.quietMs, timeoutMs: data.timeoutMs }, data.frameId, exec.signal);
  }),

  defineTool(pageAccessibilityTree, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; maxNodes: number; maxDepth: number; interactiveOnly: boolean };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const result = await runPageOp(
      exec.ctx,
      tab.id!,
      { op: "a11yTree", maxNodes: data.maxNodes, maxDepth: data.maxDepth, interactiveOnly: data.interactiveOnly },
      data.frameId,
      exec.signal,
    );
    return redactResult(result);
  }),

  defineTool(pageSnapshot, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      maxNodes: number;
      maxDepth: number;
      includeScreenshot: boolean;
      screenshotFormat: "jpeg" | "png";
      screenshotQuality: number;
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const snapshot = (await runPageOp(
      exec.ctx,
      tab.id!,
      { op: "snapshot", maxNodes: data.maxNodes, maxDepth: data.maxDepth, interactiveOnly: true },
      data.frameId,
      exec.signal,
    )) as {
      nodes: unknown[];
      viewport: { width: number; height: number; devicePixelRatio: number; scrollY: number };
    };
    const redacted = redactResult(snapshot);
    const screenshot = data.includeScreenshot
      ? await exec.ctx.captureVisibleTab(tab.id!, { format: data.screenshotFormat, quality: data.screenshotQuality })
      : undefined;
    return {
      ...redacted,
      ...(screenshot
        ? {
            screenshot: {
              dataUrl: screenshot.dataUrl,
              format: data.screenshotFormat,
              width: screenshot.width,
              height: screenshot.height,
            },
          }
        : {}),
      coordinateHint:
        "dom.clickAt uses CSS viewport pixels (same as node viewportX/Y). For screenshot pixels, set coordinateSpace=screenshot or divide by devicePixelRatio.",
    };
  }),

  defineTool(pageDialogs, async (input, exec) => {
    if (!exec.ctx.observer) throw new ToolErrorException("UNSUPPORTED", "The page observer is not available in this browser");
    const data = input as { tabId?: number; frameId?: number; limit: number };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const state = await raceWithAbort(exec.ctx.observer.read(tab.id!), exec.signal);
    return {
      dialogs: state.dialogs.slice(-data.limit).map((d) => ({
        id: d.id,
        type: d.type,
        message: redactSecrets(d.message),
        defaultValue: d.defaultValue,
        at: d.at,
        answered: d.answered,
      })),
      defaultAnswer: state.defaultAnswer,
      attached: state.attached,
    };
  }),

  defineTool(pageRespondDialog, async (input, exec) => {
    if (!exec.ctx.observer) throw new ToolErrorException("UNSUPPORTED", "The page observer is not available in this browser");
    const data = input as { tabId?: number; frameId?: number; response: "accept" | "dismiss"; text?: string };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    await raceWithAbort(exec.ctx.observer.respond({
      tabId: tab.id!,
      response: data.response,
      text: data.text,
    }), exec.signal);
    return { applied: true as const, response: data.response, text: data.text };
  }),

  // Navigation handlers below return navigationId: null: the browser APIs
  // used here expose no navigation id, and a fabricated id would mislead a
  // caller into believing a specific navigation was observed. The contracts
  // section must widen navigationId to string | null for these tools.
  defineTool(navigationOpen, async (input, { ctx, signal }) => {
    const data = input as { url: string; reuseActiveTab: boolean; active: boolean };
    const url = validateUrlInput(data.url);
    if (data.reuseActiveTab) {
      const active = await raceWithAbort(ctx.getActiveTab(), signal);
      if (active && typeof active.id === "number") {
        const tab = await raceWithAbort(ctx.updateTab(active.id, { url }), signal);
        return { tab: toTabInfo(tab), navigationId: null };
      }
    }
    const tab = await raceWithAbort(ctx.createTab({ url, active: data.active }), signal);
    return { tab: toTabInfo(tab), navigationId: null };
  }),

  defineTool(navigationBack, async (input, { ctx, signal }) => {
    const tabId = await resolveTabId(ctx, (input as { tabId?: number }).tabId, signal);
    await raceWithAbort(ctx.goBack(tabId), signal);
    const tab = await raceWithAbort(ctx.getTab(tabId), signal);
    return { tab: toTabInfo(tab), navigationId: null };
  }),

  defineTool(navigationForward, async (input, { ctx, signal }) => {
    const tabId = await resolveTabId(ctx, (input as { tabId?: number }).tabId, signal);
    await raceWithAbort(ctx.goForward(tabId), signal);
    const tab = await raceWithAbort(ctx.getTab(tabId), signal);
    return { tab: toTabInfo(tab), navigationId: null };
  }),

  defineTool(navigationReload, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; bypassCache: boolean };
    const tabId = await resolveTabId(ctx, data.tabId, signal);
    const tab = await raceWithAbort(ctx.reloadTab(tabId, data.bypassCache), signal);
    return { tab: toTabInfo(tab) };
  }),

  defineTool(navigationSearch, async (input, { ctx, signal }) => {
    const data = input as { query: string; provider: string; newTab: boolean; waitForLoad: boolean; timeoutMs: number };
    // An unknown provider is an explicit failure, never a silent fallback to
    // DuckDuckGo: the caller asked for a different search engine.
    const build = SEARCH_PROVIDERS[data.provider];
    if (!build) {
      throw new ToolErrorException(
        "INVALID_INPUT",
        `Unknown search provider "${data.provider}". Valid providers: ${Object.keys(SEARCH_PROVIDERS).join(", ")}`,
      );
    }
    const searchUrl = validateUrlInput(build(data.query));
    let tab = data.newTab
      ? await raceWithAbort(ctx.createTab({ url: searchUrl, active: true }), signal)
      : await raceWithAbort(ctx.updateTab(await resolveTabId(ctx, undefined, signal), { url: searchUrl }), signal);
    let loaded = tab.status === "complete";
    if (data.waitForLoad && typeof tab.id === "number") {
      const deadline = Date.now() + data.timeoutMs;
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        const current = await raceWithAbort(ctx.getTab(tab.id), signal);
        if (current.status === "complete") {
          tab = current;
          loaded = true;
          break;
        }
        await abortableDelay(250, signal);
      }
    }
    return { searchUrl, tab: toTabInfo(tab), loaded };
  }),

  defineTool(navigationWait, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; timeoutMs: number; waitForNetworkIdle: boolean; quietMs: number };
    const tabId = await resolveTabId(ctx, data.tabId, signal);
    const deadline = Date.now() + data.timeoutMs;
    let tab = await raceWithAbort(ctx.getTab(tabId), signal);
    let timedOut = false;
    while (tab.status === "loading" && Date.now() < deadline) {
      throwIfAborted(signal);
      await abortableDelay(250, signal);
      tab = await raceWithAbort(ctx.getTab(tabId), signal);
    }
    if (tab.status === "loading") timedOut = true;

    let idle: boolean | undefined;
    if (data.waitForNetworkIdle && !timedOut) {
      const remaining = Math.max(500, deadline - Date.now());
      const result = (await runPageOp(ctx, tabId, { op: "networkIdle", quietMs: data.quietMs, timeoutMs: remaining }, undefined, signal)) as {
        idle: boolean;
        timedOut: boolean;
      };
      idle = result.idle;
      if (result.timedOut) timedOut = true;
    }
    return {
      status: tab.status === "complete" ? ("complete" as const) : ("loading" as const),
      url: tab.url ?? "",
      timedOut,
      idle,
    };
  }),

  defineTool(framesList, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const results = await raceWithAbort(ctx.executeInFrames(tab.id!, frameProbe, undefined, "all"), signal);
    const top = results.find((r) => r.frameId === 0);
    const topOrigin = (() => {
      try {
        return new URL(top?.result?.url ?? "").origin;
      } catch {
        return "";
      }
    })();

    // The navigation API is the only source that knows how frames are nested
    // when some of them are cross-origin. Without it the frames are reported
    // as a flat list.
    const tree = ctx.listFrameTree ? await raceWithAbort(ctx.listFrameTree(tab.id!), signal) : [];
    const parents = new Map(tree.map((node) => [node.frameId, node.parentFrameId]));
    const depthOf = (frameId: number): number => {
      let depth = 0;
      let current = frameId;
      const seen = new Set<number>();
      while (parents.has(current) && !seen.has(current)) {
        seen.add(current);
        const parent = parents.get(current)!;
        if (parent < 0) break;
        current = parent;
        depth += 1;
      }
      return depth;
    };

    const frames = results
      .filter((r) => typeof r.result?.url === "string" && r.result.url.length > 0)
      .map((r) => {
        const probe = r.result!;
        let sameOrigin = false;
        try {
          sameOrigin = new URL(probe.url).origin === topOrigin;
        } catch {
          sameOrigin = false;
        }
        return {
          frameId: r.frameId,
          parentFrameId: parents.get(r.frameId) ?? -1,
          depth: depthOf(r.frameId),
          url: probe.url.slice(0, 2048),
          title: (probe.title ?? "").slice(0, 300),
          sameOrigin,
        };
      })
      .sort((a, b) => a.frameId - b.frameId);
    return { frames };
  }),

];
