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
import { abortableDelay, raceWithAbort, requireScriptableTab, resolveTabId, runPageOp, throwIfAborted, toTabInfo, validateDownloadPath, validateUrlInput } from "./helpers.js";

/**
 * Clipboard self-focus (2026-10-28, user requirement: "it should focus
 * itself instead of me keeping focus for clipboard").
 *
 * The offscreen document is never focused, so its navigator.clipboard
 * calls always fail with a focus error, and the page-context fallback
 * only works while the browser window holding the active tab is
 * focused. Previously the tool told the user to click a window and
 * retry. Now the tool focuses that window itself before falling back:
 * it takes the active tab (chrome.tabs.query active + lastFocusedWindow,
 * i.e. the window the user was last in), activates that tab if it is
 * not already active, and calls chrome.windows.update with
 * focused:true on that tab's window, then waits a short settle so the
 * focus change can land before the page read/write is attempted.
 *
 * Settle: 200ms. Chrome focus changes are asynchronous and a page
 * read attempted in the same tick as the focus call still sees an
 * unfocused document; 200ms is long enough for the focus event to
 * propagate in practice and short enough not to dominate the call
 * (the tool's own 15s/30s bounds are untouched).
 *
 * Boundaries, deliberately:
 * - Self-focus NEVER switches the user's active tab to a different
 *   tab. It only focuses the window of the tab that is already
 *   active, and activates that same tab if needed. If the active tab
 *   is a restricted page (chrome://, Extensions, dashboard), self-focus
 *   is skipped entirely — focusing that window would not help, since
 *   no page-context read can run there — and the caller returns the
 *   restricted-page error naming that case.
 * - A failed self-focus attempt is swallowed (returns false), never
 *   thrown: focus is best-effort, and the page attempt that follows
 *   is the thing that decides success or the honest focus error.
 * - OS focus-stealing prevention is the honest limit: on some systems
 *   a background service worker's focus request only flashes the
 *   window in the taskbar instead of bringing it to the front. In
 *   that case the retry still fails and the error says the self-focus
 *   attempt did not make the window focused — it does not tell the
 *   user to keep focus manually as the primary instruction, and it
 *   never fabricates clipboard content.
 */
const CLIPBOARD_SELF_FOCUS_SETTLE_MS = 200;

async function selfFocusActiveWindow(ctx: BrowserContext, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    const tab = await raceWithAbort(ctx.getActiveTab(), signal);
    if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") return false;
    // Restricted active tab: no page-context clipboard op can run there,
    // so focusing its window cannot help and must not be attempted as a
    // way of moving the user elsewhere. The caller returns the
    // restricted-page error for this case.
    if (isRestrictedUrl(tab.url)) return false;
    if (!tab.active) await raceWithAbort(ctx.updateTab(tab.id, { active: true }), signal);
    await raceWithAbort(ctx.updateWindow(tab.windowId, { focused: true }), signal);
    await abortableDelay(CLIPBOARD_SELF_FOCUS_SETTLE_MS, signal);
    return true;
  } catch {
    return false;
  }
}

async function readClipboardFromPage(ctx: BrowserContext, signal: AbortSignal | undefined): Promise<{ text: string; truncated: boolean }> {
  const tab = await requireScriptableTab(ctx, undefined, signal);
  const pageResult = await runPageOp<{ text?: string; truncated?: boolean }>(ctx, tab.id!, { op: "readClipboard" }, undefined, signal);
  if (typeof pageResult?.text !== "string") {
    throw new ToolErrorException("INTERNAL", "Clipboard read failed: the page-context clipboard read returned no text.");
  }
  const pageText = pageResult.text;
  const truncated = pageResult.truncated ?? pageText.length > 100_000;
  return { text: truncated ? pageText.slice(0, 100_000) : pageText, truncated };
}

async function writeClipboardToPage(ctx: BrowserContext, text: string, signal: AbortSignal | undefined): Promise<void> {
  const tab = await requireScriptableTab(ctx, undefined, signal);
  await runPageOp(ctx, tab.id!, { op: "writeClipboard", text }, undefined, signal);
}

function isFocusError(error: unknown): boolean {
  return /not focused/i.test(error instanceof Error ? error.message : String(error));
}

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
      // focused. Only focus errors take this path — any other failure
      // (e.g. a permission denial) is rethrown unchanged, so a real
      // denial is never masked as a focus problem. Nothing is written
      // to the clipboard on any path, and a failed read returns no
      // content, real or fabricated.
      //
      // Self-focus (2026-10-28): instead of telling the user to click
      // a window and retry, the tool focuses the active tab's window
      // itself before the fallback read, and focuses it again and
      // retries the read once if the first fallback read still
      // reports not-focused (focus changes are asynchronous, so one
      // settle may not be enough). The output shape is unchanged:
      // { text, truncated }.
      if (isFocusError(error)) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await selfFocusActiveWindow(ctx, signal);
          try {
            return await readClipboardFromPage(ctx, signal);
          } catch (fallbackError) {
            // Restricted active tab: no scriptable tab is active at all,
            // so no focus attempt can help — name that case, do not
            // switch the user to another tab, and do not fall through
            // to the generic focus error.
            if (ToolErrorException.is(fallbackError) && fallbackError.code === "RESTRICTED_PAGE") {
              throw new ToolErrorException(
                "INTERNAL",
                "Clipboard read failed: the active tab is a restricted page (for example chrome://, Extensions, or the Cloudflare dashboard) and cannot run a page-context clipboard read. Make a normal, non-restricted browser tab the active tab, then retry. No clipboard content was read.",
              );
            }
            if (isFocusError(fallbackError) && attempt === 0) continue;
            break;
          }
        }
        throw new ToolErrorException(
          "INTERNAL",
          "Clipboard read failed: Chrome requires a focused document for navigator.clipboard.readText. The offscreen document is never focused, and the tool's own attempt to focus the browser window did not make the active tab's document focused (on some systems a background focus request only flashes the window instead of bringing it to the front) — retrying will only help once the browser window is actually in the foreground. No clipboard content was read.",
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
      // Same self-focus as read, plus a page-context write fallback
      // mirroring readClipboard: the offscreen write can never succeed
      // unfocused, but a focused page document can writeText with the
      // extension's clipboardWrite permission. Previously write had no
      // page fallback at all and always failed unfocused. Only focus
      // errors take this path; other failures are rethrown unchanged.
      // Output shape is unchanged: { written, chars }.
      if (isFocusError(error)) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await selfFocusActiveWindow(ctx, signal);
          try {
            await writeClipboardToPage(ctx, text, signal);
            return { written: true as const, chars: text.length };
          } catch (fallbackError) {
            if (ToolErrorException.is(fallbackError) && fallbackError.code === "RESTRICTED_PAGE") {
              throw new ToolErrorException(
                "INTERNAL",
                "Clipboard write failed: the active tab is a restricted page (for example chrome://, Extensions, or the Cloudflare dashboard) and cannot run a page-context clipboard write. Make a normal, non-restricted browser tab the active tab, then retry. No clipboard content was written.",
              );
            }
            if (isFocusError(fallbackError) && attempt === 0) continue;
            break;
          }
        }
        throw new ToolErrorException(
          "INTERNAL",
          "Clipboard write failed: Chrome requires a focused document for navigator.clipboard.writeText. The offscreen document is never focused, and the tool's own attempt to focus the browser window did not make the active tab's document focused (on some systems a background focus request only flashes the window instead of bringing it to the front). No clipboard content was written.",
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
