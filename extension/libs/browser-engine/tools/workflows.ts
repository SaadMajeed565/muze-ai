import {
  ToolErrorException,
  workflowsCollectLinks,
  workflowsCompareTabs,
  workflowsExtractTable,
  workflowsFillFormForReview,
  workflowsOpenSequence,
  workflowsOrganizeTabs,
  workflowsResearchReport,
  workflowsRestoreSession,
  workflowsSaveSession,
  workflowsSummarizePage,
} from "../../tool-contracts/index.js";
import type { PageMetadata } from "../../tool-contracts/index.js";
import { registrableDomain } from "../../security/index.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import {
  abortableDelay,
  requireScriptableTab,
  throwIfAborted,
  toTabInfo,
  validateUrlInput,
} from "./helpers.js";

interface BoundedTextResult {
  text: string;
  truncated: boolean;
}

export interface PoolResult<T, R> {
  index: number;
  item: T;
  ok: boolean;
  value?: R;
  error?: string;
}

/**
 * Partial-failure pool: one item's failure is recorded as a per-item error
 * instead of rejecting the whole pool. Callers return the successes plus the
 * per-item errors, so a single dead tab cannot erase the other tabs' data.
 * Cancellation still aborts the pool (it is not a per-item failure).
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<PoolResult<T, R>[]> {
  const results: PoolResult<T, R>[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { index, item: items[index], ok: true, value: await fn(items[index]) };
      } catch (error) {
        if (signal.aborted) throw error;
        results[index] = { index, item: items[index], ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}


async function waitForTabLoad(invoke: <T = unknown>(tool: string, input: unknown) => Promise<T>, tabId: number): Promise<void> {
  await invoke("navigation.wait", { tabId, timeoutMs: 5_000, waitForNetworkIdle: false });
}

export const workflowToolHandlers: RegisteredTool[] = [
  defineTool(workflowsSummarizePage, async (input, { invoke, ctx, signal }) => {
    throwIfAborted(signal);
    const data = input as { tabId?: number; maxChars: number };
    const tab = await requireScriptableTab(ctx, data.tabId);
    const tabId = tab.id!;
    const metadata = await invoke<PageMetadata>("page.metadata", { tabId });
    const text = await invoke<BoundedTextResult>("page.read", { tabId, offset: 0, maxChars: data.maxChars });
    return {
      metadata,
      text: text.text,
      truncated: text.truncated,
      note: "Summarization is performed by the connected AI client; the browser does not call a model.",
    };
  }),

  defineTool(workflowsCompareTabs, async (input, { invoke, ctx, signal }) => {
    const data = input as { tabIds: number[]; maxCharsPerTab: number };
    const settled = await mapPool(data.tabIds, 4, signal, async (tabId) => {
      throwIfAborted(signal);
      const tab = await ctx.getTab(tabId);
      throwIfAborted(signal);
      const read = await invoke<BoundedTextResult>("page.read", { tabId, offset: 0, maxChars: data.maxCharsPerTab });
      return { tabId, title: tab.title ?? "", url: tab.url ?? "", excerpt: read.text };
    });
    const pages = settled.filter((r) => r.ok).map((r) => r.value!);
    const errors = settled.filter((r) => !r.ok).map((r) => ({ tabId: r.item, error: r.error ?? "unknown error" }));
    return { pages, ...(errors.length > 0 ? { errors } : {}) };
  }),

  defineTool(workflowsExtractTable, async (input, { invoke, signal }) => {
    throwIfAborted(signal);
    // tableIndex is the new name; index is accepted as an alias for it.
    const data = input as { tabId?: number; index?: number; tableIndex?: number; maxRows: number };
    const tableIndex = data.tableIndex ?? data.index ?? 0;
    // page.tables is called without an index so the full table list comes
    // back and totalTables can be reported; the selection happens here.
    const result = await invoke<{ tables: { index: number; headers: string[]; rows: string[][]; truncated: boolean }[] }>("page.tables", {
      tabId: data.tabId,
      maxRows: data.maxRows,
    });
    const totalTables = result.tables.length;
    const table = result.tables[tableIndex] ?? { index: tableIndex, headers: [], rows: [], truncated: false };
    // totalTables is a new output field (schema change needed); without it
    // a caller cannot tell "table 3 of 1" from "table 3 of 20".
    return { headers: table.headers, rows: table.rows, truncated: table.truncated, totalTables };
  }),

  defineTool(workflowsCollectLinks, async (input, { invoke, signal }) => {
    const data = input as { tabIds: number[]; limitPerTab: number };
    const settled = await mapPool(data.tabIds, 4, signal, async (tabId) => {
      throwIfAborted(signal);
      const result = await invoke<{ links: { href: string; text: string }[] }>("page.links", { tabId, limit: data.limitPerTab, sameOriginOnly: false });
      return result.links.map((link) => ({ tabId, href: link.href, text: link.text }));
    });
    const seen = new Set<string>();
    const links: { tabId: number; href: string; text: string }[] = [];
    for (const group of settled.filter((r) => r.ok).map((r) => r.value!)) {
      for (const link of group) {
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        links.push(link);
      }
    }
    const errors = settled.filter((r) => !r.ok).map((r) => ({ tabId: r.item, error: r.error ?? "unknown error" }));
    return { links, ...(errors.length > 0 ? { errors } : {}) };
  }),

  defineTool(workflowsOpenSequence, async (input, { invoke, signal }) => {
    const data = input as { urls: string[]; delayMs: number; active: boolean };
    const opened: { url: string; tabId: number }[] = [];
    try {
      for (const url of data.urls) {
        throwIfAborted(signal);
        const result = await invoke<{ tab: { id: number } }>("tabs.create", { url, active: false });
        const tabId = result.tab.id;
        opened.push({ url, tabId });
        await waitForTabLoad(invoke, tabId);
        if (data.delayMs > 0) await abortableDelay(data.delayMs, signal);
      }
      if (data.active && opened.length > 0) {
        throwIfAborted(signal);
        await invoke("tabs.activate", { tabId: opened[opened.length - 1].tabId });
      }
      return { opened };
    } catch (error) {
      if (signal.aborted) {
        throw new ToolErrorException("CANCELLED", "Workflow cancelled", { details: { opened } });
      }
      // Partial failure: the tabs that did open are returned, with a
      // partial flag and the error, instead of losing them to a throw.
      // (Schema change needed: openSequence output must allow optional
      // partial and error fields.)
      return { opened, partial: true, error: error instanceof Error ? error.message : String(error) };
    }
  }),

  defineTool(workflowsFillFormForReview, async (input, { invoke, ctx, signal }) => {
    throwIfAborted(signal);
    const data = input as { tabId?: number; formRef: string; fields: { ref: string; value: string }[] };
    const tab = await requireScriptableTab(ctx, data.tabId);
    const preview = await invoke<{ fields: { ref: string }[] }>("forms.preview", { tabId: tab.id!, ref: data.formRef });
    const allowed = new Set(preview.fields.map((field) => field.ref));
    const seen = new Set<string>();
    const invalid = data.fields
      .map((field) => field.ref)
      .filter((ref) => {
        if (!allowed.has(ref) || seen.has(ref)) return true;
        seen.add(ref);
        return false;
      });
    if (invalid.length > 0) {
      throw new ToolErrorException("INVALID_INPUT", "One or more fields do not belong to the reviewed form", {
        details: { invalidRefs: invalid },
      });
    }
    const report = await invoke<{ filled: unknown[]; skipped: unknown[] }>("forms.fill", {
      tabId: tab.id!,
      fields: data.fields,
    });
    return {
      formRef: data.formRef,
      filled: report.filled.length,
      skipped: report.skipped.length,
      awaitingReview: true as const,
    };
  }),

  defineTool(workflowsOrganizeTabs, async (input, { ctx, signal }) => {
    throwIfAborted(signal);
    // "prefix" is the old unified spelling; the canonical enum is
    // "domain" | "titlePrefix" everywhere, so it is normalised here.
    const rawStrategy = (input as { strategy?: string }).strategy;
    const strategy = rawStrategy === "prefix" ? "titlePrefix" : (rawStrategy ?? "domain");
    const data = input as { windowId?: number; maxGroups: number };
    const active = data.windowId === undefined ? await ctx.getActiveTab() : null;
    const windowId = data.windowId ?? active?.windowId;
    if (typeof windowId !== "number") throw new ToolErrorException("NOT_FOUND", "No active window is available");
    const tabs = await ctx.listTabs({ windowId });
    const buckets = new Map<string, number[]>();
    let skipped = 0;
    for (const tab of tabs) {
      if (typeof tab.id !== "number" || !tab.url) {
        // Tabs with no id or no URL cannot be grouped; count them instead
        // of silently dropping them.
        skipped += 1;
        continue;
      }
      let key: string;
      if (strategy === "domain") {
        try {
          key = registrableDomain(new URL(tab.url).hostname) || "other";
        } catch {
          key = "other";
        }
      } else {
        key = (tab.title ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "other";
      }
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(tab.id);
    }
    // Only buckets with at least 2 tabs are worth grouping; single-tab
    // buckets are reported as ungrouped ("small-bucket") tabs, and buckets
    // beyond maxGroups are ungrouped too — neither is silently dropped.
    const groupable = [...buckets.entries()].filter(([, tabIds]) => tabIds.length >= 2);
    const selected = groupable.sort((a, b) => b[1].length - a[1].length).slice(0, data.maxGroups);
    const selectedTitles = new Set(selected.map(([title]) => title));
    const ungrouped: number[] = [];
    for (const [title, tabIds] of buckets.entries()) {
      if (!selectedTitles.has(title)) ungrouped.push(...tabIds);
    }
    const groups: { title: string; tabIds: number[] }[] = [];
    for (const [title, tabIds] of selected) {
      throwIfAborted(signal);
      if (tabIds.length === 0) continue;
      await ctx.groupTabs(tabIds, { title });
      groups.push({ title, tabIds });
    }
    // ungrouped/skipped are included only when non-empty, so a fully
    // grouped window keeps its previous shape. (Schema change needed:
    // organizeTabs output must allow optional ungrouped/skipped fields.)
    return { groups, ...(ungrouped.length > 0 ? { ungrouped } : {}), ...(skipped > 0 ? { skipped } : {}) };
  }),

  defineTool(workflowsSaveSession, async (input, { ctx, signal }) => {
    throwIfAborted(signal);
    if (!ctx.sessions) throw new ToolErrorException("UNSUPPORTED", "Session storage is not available");
    const data = input as { name: string; windowId?: number };
    const tabs = await ctx.listTabs({ windowId: data.windowId });
    const seen = new Set<string>();
    const payload: { url: string; title: string }[] = [];
    let skipped = 0;
    for (const tab of tabs) {
      if (typeof tab.url !== "string" || tab.url.length === 0) {
        skipped += 1;
        continue;
      }
      let url: string;
      try {
        url = validateUrlInput(tab.url);
      } catch {
        skipped += 1;
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      payload.push({ url, title: tab.title ?? "" });
    }
    const session = await ctx.sessions.save(data.name, payload);
    // skipped is included only when non-zero (schema change needed for the
    // optional field); it counts tabs dropped for a missing/invalid URL.
    return { sessionId: session.id, name: session.name, tabCount: session.tabs.length, ...(skipped > 0 ? { skipped } : {}) };
  }),

  defineTool(workflowsRestoreSession, async (input, { ctx, invoke, signal }) => {
    throwIfAborted(signal);
    if (!ctx.sessions) throw new ToolErrorException("UNSUPPORTED", "Session storage is not available");
    const data = input as { sessionId: string; active: boolean };
    const session = await ctx.sessions.get(data.sessionId);
    if (!session) throw new ToolErrorException("NOT_FOUND", `Session ${data.sessionId} not found`);
    const tabIds: number[] = [];
    const skipped: string[] = [];
    try {
      for (const tab of session.tabs) {
        throwIfAborted(signal);
        let url: string;
        try {
          url = validateUrlInput(tab.url);
        } catch {
          skipped.push(tab.url);
          continue;
        }
        const created = await invoke<{ tab: { id: number } }>("tabs.create", { url, active: false });
        tabIds.push(created.tab.id);
        await waitForTabLoad(invoke, created.tab.id);
      }
      if (data.active && tabIds.length > 0) {
        throwIfAborted(signal);
        await invoke("tabs.activate", { tabId: tabIds[tabIds.length - 1] });
      }
      // skipped is included only when non-empty (schema change needed for
      // the optional field); it lists session URLs that failed validation.
      return { restored: tabIds.length, tabIds, ...(skipped.length > 0 ? { skipped } : {}) };
    } catch (error) {
      if (signal.aborted) {
        throw new ToolErrorException("CANCELLED", "Workflow cancelled", { details: { tabIds } });
      }
      // Partial failure: tabs already restored are returned with a partial
      // flag and the error, instead of losing them to a throw. (Schema
      // change needed: restoreSession output must allow optional partial,
      // error and skipped fields.)
      return {
        restored: tabIds.length,
        tabIds,
        partial: true,
        error: error instanceof Error ? error.message : String(error),
        ...(skipped.length > 0 ? { skipped } : {}),
      };
    }
  }),

  defineTool(workflowsResearchReport, async (input, { invoke, ctx, signal }) => {
    const data = input as { tabIds: number[]; maxCharsPerTab: number };
    const settled = await mapPool(data.tabIds, 4, signal, async (tabId) => {
      throwIfAborted(signal);
      const tab = await ctx.getTab(tabId);
      throwIfAborted(signal);
      const metadata = await invoke<PageMetadata>("page.metadata", { tabId });
      const read = await invoke<BoundedTextResult>("page.read", { tabId, offset: 0, maxChars: data.maxCharsPerTab });
      return {
        tabId,
        title: metadata.title || toTabInfo(tab).title,
        url: metadata.url,
        headings: metadata.headings.map((h) => h.text),
        text: read.text,
      };
    });
    const sections = settled.filter((r) => r.ok).map((r) => r.value!);
    const errors = settled.filter((r) => !r.ok).map((r) => ({ tabId: r.item, error: r.error ?? "unknown error" }));
    return { sections, ...(errors.length > 0 ? { errors } : {}) };
  }),
];
