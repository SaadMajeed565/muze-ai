import {
  PROTOCOL_VERSION,
  REGISTRY_VERSION,
  ToolErrorException,
  browserActiveContext,
  browserCapabilities,
  browserCaptureTab,
  browserDiagnostics,
  browserInfo,
  browserObserver,
  browserPermissions,
  browserSearch,
  clipboardRead,
  clipboardWrite,
  devtoolsConsole,
  devtoolsDom,
  devtoolsNetwork,
  devtoolsPageErrors,
  devtoolsPerformance,
  downloadsControl,
  downloadsErase,
  downloadsList,
  downloadsStart,
} from "../../tool-contracts/index.js";
import { isRestrictedUrl, redactUrl } from "../../security/index.js";
import { diagnosticsHook, readDiagnosticsLog, type DiagnosticsLog } from "../page/diagnostics.js";
import type { BrowserContext } from "../context.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import { raceWithAbort, requireScriptableTab, resolveTabId, runPageOp, throwIfAborted, toTabInfo, validateDownloadPath, validateUrlInput } from "./helpers.js";

/**
 * Read the page's diagnostics log, never crashing on a null read (retest3:
 * devtools.console / devtools.pageErrors failed with "Cannot read
 * properties of null (reading 'console'/'errors')"). Why only these two:
 * devtools.network / performance / dom go through the persistent page
 * agent (ISOLATED world, always returns a value), while console/errors go
 * through a MAIN-world scripting injection of diagnosticsHook +
 * readDiagnosticsLog — a data source that only exists after the hook is
 * installed, and whose read-back can come back null if the page navigated
 * or MAIN-world injection did not stick. So: install, read, and if the
 * read-back is null or malformed, lazily re-install and re-read once.
 * If it is still unavailable, throw a clear error naming the cause instead
 * of a TypeError — and return nothing, rather than pretending the log is
 * empty (an empty array is only returned for a genuinely installed, empty
 * log, which is the documented "messages since attach" semantics).
 */
async function readDiagnosticsLogSafe(ctx: BrowserContext, tabId: number, signal: AbortSignal | undefined, label: string): Promise<DiagnosticsLog> {
  const isLog = (value: unknown): value is DiagnosticsLog =>
    !!value && typeof value === "object" && Array.isArray((value as DiagnosticsLog).console) && Array.isArray((value as DiagnosticsLog).errors);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await raceWithAbort(ctx.executeInPage(tabId, diagnosticsHook, undefined, { world: "MAIN" }), signal);
    const log = await raceWithAbort(ctx.executeInPage(tabId, readDiagnosticsLog, undefined, { world: "MAIN" }), signal);
    if (isLog(log)) return log;
  }
  throw new ToolErrorException(
    "INTERNAL",
    `Devtools ${label} are unavailable for this tab: the page returned no diagnostics log even after the diagnostics hook was installed (the page may have navigated, or MAIN-world script injection was blocked). No ${label} data was returned; retry on a stable, scriptable page.`,
  );
}

export const systemToolHandlers: RegisteredTool[] = [
  defineTool(downloadsList, async (input, { ctx, signal }) => {
    if (!ctx.downloads) throw new ToolErrorException("UNSUPPORTED", "Downloads capability is not enabled");
    const data = input as { limit: number; query?: string };
    const items = await raceWithAbort(ctx.downloads.list({ limit: data.limit, query: data.query }), signal);
    return {
      downloads: items.map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.url,
        state: d.state,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        paused: d.paused,
        startTime: d.startTime,
        error: d.error,
      })),
    };
  }),

  defineTool(downloadsControl, async (input, { ctx, signal }) => {
    if (!ctx.downloads) throw new ToolErrorException("UNSUPPORTED", "Downloads capability is not enabled");
    const data = input as { id: number; action: "pause" | "resume" | "cancel" };
    await raceWithAbort(ctx.downloads.control(data.id, data.action), signal);
    return { id: data.id, action: data.action, ok: true as const };
  }),

  defineTool(downloadsStart, async (input, { ctx, signal }) => {
    if (!ctx.downloads) throw new ToolErrorException("UNSUPPORTED", "Downloads capability is not enabled");
    const data = input as {
      url: string;
      filename?: string;
      directory?: string;
      saveAs: boolean;
      conflictAction?: "uniquify" | "overwrite" | "prompt";
    };
    const url = validateUrlInput(data.url, false);
    const filename = validateDownloadPath(data.filename, data.directory);
    const result = await raceWithAbort(ctx.downloads.start({
      url,
      filename,
      saveAs: data.saveAs,
      conflictAction: data.conflictAction,
    }), signal);
    return { id: result.id, filename: result.filename };
  }),

  defineTool(downloadsErase, async (input, { ctx, signal }) => {
    if (!ctx.downloads) throw new ToolErrorException("UNSUPPORTED", "Downloads capability is not enabled");
    const data = input as { ids: number[] };
    const erased = await raceWithAbort(ctx.downloads.erase(data.ids), signal);
    return { erased };
  }),

  defineTool(clipboardRead, async (_input, { ctx, signal }) => {
    if (!ctx.clipboard) throw new ToolErrorException("UNSUPPORTED", "Clipboard capability is not enabled");
    let text: string;
    try {
      text = await raceWithAbort(ctx.clipboard.read(), signal);
    } catch (error) {
      // navigator.clipboard in the offscreen document requires a focused
      // document, and an offscreen document is NEVER focused — so the
      // offscreen path cannot ever succeed for readText, whatever the
      // browser window state. That is the retest3 failure, not a transient
      // focus lapse. The legitimate fallback is the active tab's page
      // context: the extension holds the clipboardRead permission, and a
      // content-context readText succeeds whenever that tab's document is
      // focused (i.e. the user is in a browser window). Only focus errors
      // take this path — any other failure (e.g. a permission denial) is
      // rethrown unchanged, so a real denial is never masked as a focus
      // problem. Nothing is written to the clipboard on any path, and a
      // failed read returns no content, real or fabricated.
      if (/not focused/i.test(error instanceof Error ? error.message : String(error))) {
        try {
          const tab = await requireScriptableTab(ctx, undefined, signal);
          const pageResult = await runPageOp<{ text?: string; truncated?: boolean }>(
            ctx,
            tab.id!,
            { op: "readClipboard" },
            undefined,
            signal,
          );
          if (typeof pageResult?.text === "string") {
            const pageText = pageResult.text;
            const truncated = pageResult.truncated ?? pageText.length > 100_000;
            return { text: truncated ? pageText.slice(0, 100_000) : pageText, truncated };
          }
        } catch (fallbackError) {
          // Retest4 note, code change (not a new read path): the old
          // catch swallowed every fallback failure into the generic
          // both-paths focus error, including the common case where
          // the ACTIVE tab itself is a restricted page (chrome://,
          // Extensions, dashboard) after a reload. That case is not
          // "the window is unfocused" — it is "no scriptable tab is
          // active at all" — and it needs its own instruction, or
          // the user keeps focusing the same restricted window and
          // retrying to no effect. A genuinely unfocused window
          // still falls through to the focus error below.
          if (ToolErrorException.is(fallbackError) && fallbackError.code === "RESTRICTED_PAGE") {
            throw new ToolErrorException(
              "INTERNAL",
              "Clipboard read failed: the active tab is a restricted page (for example chrome://, Extensions, or the Cloudflare dashboard) and cannot run a page-context clipboard read. Click a normal, non-restricted browser tab so it becomes the active tab, then retry. No clipboard content was read.",
            );
          }
          // Fall through to the honest focus-required error below.
        }
        throw new ToolErrorException(
          "INTERNAL",
          "Clipboard read failed: Chrome requires a focused document for navigator.clipboard.readText. The offscreen document is never focused, and the active tab's page context could not read it either — click a browser window so a normal (non-restricted) tab is focused, then retry. No clipboard content was read.",
        );
      }
      throw error;
    }
    const truncated = text.length > 100_000;
    return { text: truncated ? text.slice(0, 100_000) : text, truncated };
  }),

  defineTool(clipboardWrite, async (input, { ctx, signal }) => {
    if (!ctx.clipboard) throw new ToolErrorException("UNSUPPORTED", "Clipboard capability is not enabled");
    const { text } = input as { text: string };
    try {
      await raceWithAbort(ctx.clipboard.write(text), signal);
    } catch (error) {
      if (/not focused/i.test(error instanceof Error ? error.message : String(error))) {
        throw new ToolErrorException(
          "INTERNAL",
          "Clipboard write failed: Chrome requires a focused document for navigator.clipboard.writeText, and the offscreen document is not focused. Click a browser window to focus it and retry. No clipboard content was written.",
        );
      }
      throw error;
    }
    return { written: true as const, chars: text.length };
  }),

  defineTool(browserInfo, async (_input, { ctx, signal }) => {
    const info = await raceWithAbort(ctx.getBrowserInfo(), signal);
    return {
      extensionVersion: info.extensionVersion,
      protocolVersion: PROTOCOL_VERSION,
      registryVersion: REGISTRY_VERSION,
      userAgent: info.userAgent,
      platform: info.platform,
      ...(info.browserVersion ? { browserVersion: info.browserVersion } : {}),
      ...(info.locale ? { locale: info.locale } : {}),
      ...(info.timeZone ? { timeZone: info.timeZone } : {}),
      ...(info.manifestVersion !== undefined ? { manifestVersion: info.manifestVersion } : {}),
    };
  }),

  defineTool(browserCapabilities, async (_input, { runtime, ctx }) => ({
    toolCount: runtime.toolCount,
    categories: runtime.categories,
    optionalGroups: runtime.enabledGroups,
    readOnlyMode: runtime.readOnlyMode,
    killSwitch: runtime.killSwitch,
    // The browser features this context can actually use, so a client can
    // tell the difference between "not available" and "not allowed".
    capabilities: [
      "tabs",
      "windows",
      "scripting",
      ctx.downloads ? "downloads" : null,
      ctx.bookmarks ? "bookmarks" : null,
      ctx.history ? "history" : null,
      ctx.clipboard ? "clipboard" : null,
      ctx.observer ? "observer" : null,
      ctx.sessions ? "sessions" : null,
      ctx.listFrameTree ? "frameTree" : null,
    ].filter((capability): capability is string => capability !== null),
  })),

  defineTool(browserPermissions, async (_input, { runtime }) => ({
    allowedTools: runtime.allowedTools,
    deniedTools: runtime.deniedTools,
    readOnlyMode: runtime.readOnlyMode,
  })),

  defineTool(browserActiveContext, async (_input, { ctx, signal }) => {
    const tab = await raceWithAbort(ctx.getActiveTab(), signal);
    return {
      tab: tab && typeof tab.id === "number" ? toTabInfo(tab) : null,
      restricted: isRestrictedUrl(tab?.url),
    };
  }),

  defineTool(browserDiagnostics, async (_input, { runtime }) => ({
    bridgeStatus: runtime.bridgeStatus,
    connectedClients: runtime.connectedClients,
    pendingApprovals: runtime.pendingApprovals,
    killSwitch: runtime.killSwitch,
    auditEvents: runtime.auditEvents,
  })),

  defineTool(browserObserver, async (input, { ctx, signal }) => {
    if (!ctx.observer) throw new ToolErrorException("UNSUPPORTED", "The page observer is not available in this browser");
    const data = input as { enabled: boolean; tabId?: number };
    const tabId = await resolveTabId(ctx, data.tabId, signal);
    return raceWithAbort(ctx.observer.setEnabled(data.enabled, tabId), signal);
  }),

  defineTool(browserSearch, async (input, { ctx, invoke, signal }) => {
    const data = input as {
      query: string;
      limit: number;
      includeHistory: boolean;
      includeBookmarks: boolean;
      includeTabs: boolean;
    };
    const results: {
      title: string;
      url: string;
      source: "history" | "bookmark" | "tab";
      visitCount?: number;
      lastVisitTime?: string;
    }[] = [];
    // A failed source is reported, never silently swallowed: the caller gets
    // the results that did arrive plus one error entry per failed source,
    // so a missing history/bookmark/tab source cannot masquerade as "no
    // matches". A source whose capability is absent is reported the same
    // way, not skipped quietly.
    const errors: { source: "history" | "bookmark" | "tab"; error: string }[] = [];
    const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

    throwIfAborted(signal);
    if (data.includeHistory) {
      throwIfAborted(signal);
      if (!ctx.history) {
        errors.push({ source: "history", error: "history capability is not available" });
      } else {
        try {
          const response = await invoke<{ entries: { title?: string; url: string; visitCount?: number; lastVisitTime?: string }[] }>(
            "history.search",
            { text: data.query, maxResults: data.limit },
          );
          for (const entry of response.entries) {
            results.push({
              title: entry.title || entry.url,
              url: entry.url,
              source: "history",
              visitCount: entry.visitCount,
              lastVisitTime: entry.lastVisitTime,
            });
          }
        } catch (error) {
          errors.push({ source: "history", error: errorMessage(error) });
        }
      }
    }
    if (data.includeBookmarks) {
      throwIfAborted(signal);
      if (!ctx.bookmarks) {
        errors.push({ source: "bookmark", error: "bookmarks capability is not available" });
      } else {
        try {
          const response = await invoke<{ bookmarks: { title?: string; url?: string }[] }>("bookmarks.search", {
            query: data.query,
            limit: data.limit,
          });
          for (const node of response.bookmarks) {
            if (!node.url) continue;
            results.push({ title: node.title || node.url, url: node.url, source: "bookmark" });
          }
        } catch (error) {
          errors.push({ source: "bookmark", error: errorMessage(error) });
        }
      }
    }
    if (data.includeTabs) {
      try {
        const needle = data.query.toLowerCase();
        const tabs = await raceWithAbort(ctx.listTabs({}), signal);
        for (const tab of tabs) {
          const title = tab.title ?? "";
          const url = tab.url ?? "";
          if (!title.toLowerCase().includes(needle) && !url.toLowerCase().includes(needle)) continue;
          results.push({ title: title || url, url, source: "tab" });
        }
      } catch (error) {
        errors.push({ source: "tab", error: errorMessage(error) });
      }
    }
    // errors is included only when a source actually failed, so a fully
    // successful search keeps its previous shape. (Schema change needed:
    // browser.search output must allow an optional errors array.)
    return { results: results.slice(0, data.limit), ...(errors.length > 0 ? { errors } : {}) };
  }),

  defineTool(browserCaptureTab, async (input, { ctx, signal }) => {
    const data = input as { windowId?: number; format: "png" | "jpeg"; quality: number };
    const tab = await raceWithAbort(ctx.getActiveTab(), signal);
    if (!tab || typeof tab.id !== "number") {
      throw new ToolErrorException("INVALID_INPUT", "There is no active tab to capture");
    }
    const capture = await raceWithAbort(ctx.captureVisibleTab(tab.id, { format: data.format, quality: data.quality }), signal);
    return { dataUrl: capture.dataUrl, format: data.format, width: capture.width, height: capture.height };
  }),

  defineTool(devtoolsDom, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; maxNodes: number; maxDepth: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "domStructure", maxNodes: data.maxNodes, maxDepth: data.maxDepth }, data.frameId, signal);
  }),

  defineTool(devtoolsPerformance, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "performance" }, data.frameId, signal);
  }),

  defineTool(devtoolsPageErrors, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; limit: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const log = await readDiagnosticsLogSafe(ctx, tab.id!, signal, "page errors");
    return { errors: log.errors.slice(-data.limit) };
  }),

  defineTool(devtoolsConsole, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; limit: number; level: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const log = await readDiagnosticsLogSafe(ctx, tab.id!, signal, "console messages");
    const messages = data.level === "all" ? log.console : log.console.filter((m) => m.level === data.level);
    return { messages: messages.slice(-data.limit) };
  }),

  defineTool(devtoolsNetwork, async (input, { ctx, signal }) => {
    if (!ctx.observer) throw new ToolErrorException("UNSUPPORTED", "The page observer is not available in this browser");
    const data = input as { tabId?: number; limit: number; urlFilter?: string; onlyFailed: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const resolved = tab.id!;
    const state = await raceWithAbort(ctx.observer.read(resolved), signal);
    const needle = data.urlFilter?.toLowerCase();
    const requests = state.requests
      .filter((r) => (needle ? r.url.toLowerCase().includes(needle) : true))
      .filter((r) => (data.onlyFailed ? r.failed === true : true))
      .slice(-data.limit)
      .map((r) => ({
        id: r.id,
        method: r.method,
        url: redactUrl(r.url),
        status: r.status,
        type: r.type,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        failed: r.failed,
      }));
    return { requests, attached: state.attached };
  }),
];

export type { DiagnosticsLog };
