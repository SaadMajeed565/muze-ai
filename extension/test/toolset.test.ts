import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  REGISTRY_VERSION,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  TabInfo,
  actTool,
  browserCaptureTab,
  browserSearch,
  browserTool,
  clipboardRead,
  clipboardTool,
  clipboardWrite,
  dataTool,
  domClickAt,
  formTool,
  navigateTool,
  optionalGroupForTool,
  screenshotsElement,
  screenshotsFullPage,
  screenshotsVisible,
  submitTool,
  tabsMove,
  tabsTool,
  toToolDescriptor,
} from "../libs/tool-contracts/index.js";

describe("tool registry schema", () => {
  it("exposes a versioned registry", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REGISTRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is at the 0.6.0 versions (protocol unchanged, registry bumped for discovery)", () => {
    expect(PROTOCOL_VERSION).toBe("2.0.0");
    expect(REGISTRY_VERSION).toBe("2.3.0");
  });

  it("derives the tool count from the registry, never a hardcoded number", () => {
    // The old onboarding copy said a fixed count; the registry is the only
    // source of truth, so this test fails if the count drifts from it.
    expect(TOOL_NAMES.length).toBe(TOOL_SCHEMAS.length);
    expect(TOOL_NAMES.length).toBeGreaterThan(0);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("gives every tool a structured output schema, never z.any()", () => {
    for (const tool of TOOL_SCHEMAS) {
      const schema = z.toJSONSchema(tool.output, { target: "draft-7", io: "output" }) as Record<string, unknown>;
      // z.any() serializes to an empty schema; every real output has a type.
      expect(Object.keys(schema).length, tool.name).toBeGreaterThan(0);
      expect(schema.type, tool.name).toBeDefined();
    }
  });

  it("uses the canonical unified parameters", () => {
    // tabs.move: {tabIds, windowId?, index?}; zoom: {tabId, zoom}.
    expect(() => tabsTool.input.parse({ action: "move", tabIds: [1, 2], windowId: 3, index: 0 })).not.toThrow();
    expect(() => tabsTool.input.parse({ action: "move", tabIds: [1], index: 0 })).not.toThrow();
    expect(() => tabsTool.input.parse({ action: "zoom", tabId: 1, zoom: 1.5 })).not.toThrow();
    expect(() => tabsTool.input.parse({ action: "zoom", tabId: 1, level: 1.5 })).toThrow();
    // browser.search: {query, limit?, includeHistory?, includeBookmarks?, includeTabs?}.
    expect(() => browserTool.input.parse({ action: "search", query: "docs", limit: 10, includeHistory: false, includeBookmarks: true, includeTabs: true })).not.toThrow();
    expect(() => browserSearch.input.parse({ query: "docs", limit: 10, includeHistory: false, includeBookmarks: true, includeTabs: true })).not.toThrow();
    expect(() => browserSearch.input.parse({ text: "docs", maxResults: 10 } as never)).toThrow();
    // Granular tabs.move no longer requires windowId.
    expect(() => tabsMove.input.parse({ tabIds: [1] })).not.toThrow();
    // Organise strategy is domain|titlePrefix everywhere, never "prefix".
    expect(() => navigateTool.input.parse({ action: "organize", strategy: "titlePrefix" })).not.toThrow();
    expect(() => navigateTool.input.parse({ action: "organize", strategy: "prefix" })).toThrow();
    expect(() => tabsTool.input.parse({ action: "organize", strategy: "titlePrefix" })).not.toThrow();
  });

  it("requires a dispatch key on navigate/data at validation time, except navigate sync", () => {
    // An empty call used to pass Zod and fail deep in the handler.
    expect(() => navigateTool.input.parse({})).toThrow(/requires an action/);
    expect(() => navigateTool.input.parse({ category: "tab" })).toThrow(/requires an action/);
    expect(() => navigateTool.input.parse({ category: "window" })).toThrow(/requires an action/);
    // The sync dispatch branches on category/`for` alone, so it stays
    // exempt (the gateway legacy adaptation emits exactly this form).
    expect(() => navigateTool.input.parse({ category: "sync" })).not.toThrow();
    expect(() => navigateTool.input.parse({ category: "sync", for: "delay" })).not.toThrow();
    expect(() => navigateTool.input.parse({ for: "network_idle" })).not.toThrow();
    expect(() => navigateTool.input.parse({ action: "open", url: "https://example.com/" })).not.toThrow();
    const emptyData = dataTool.input.safeParse({});
    expect(emptyData.success).toBe(false);
    if (!emptyData.success) {
      const messages = emptyData.error.issues.map((i) => i.message).join(" ");
      expect(messages).toMatch(/requires a domain/);
      expect(messages).toMatch(/requires an action/);
    }
    expect(() => dataTool.input.parse({ domain: "bookmarks" })).toThrow(/requires an action/);
    expect(() => dataTool.input.parse({ action: "list" })).toThrow(/requires a domain/);
    expect(() => dataTool.input.parse({ domain: "bookmarks", action: "list" })).not.toThrow();
    expect(() => dataTool.input.parse({ store: "history", action: "search", query: "x" })).not.toThrow();
  });

  it("rejects client-supplied approval flags in unified inputs", () => {
    // A confirmation flag must never count as approval, so the schemas do
    // not even accept the fields; strict parsing rejects them outright.
    expect(() => navigateTool.input.parse({ action: "open", confirmed: true } as never)).toThrow();
    expect(() => navigateTool.input.parse({ action: "open", userApproved: true } as never)).toThrow();
    expect(() => actTool.input.parse({ steps: [{ do: "click", target: { ref: "r1" } }], confirmed: true } as never)).toThrow();
    expect(() => formTool.input.parse({ phase: "fill", confirmed: true } as never)).toThrow();
  });

  it("aligns clipboard and screenshot approval across granular and unified tools", () => {
    expect(clipboardTool.requiresApproval).toBe(true);
    expect(clipboardRead.requiresApproval).toBe(true);
    expect(clipboardWrite.requiresApproval).toBe(true);
    // Consistent capture rule: every pixel-returning capture requires approval.
    expect(screenshotsVisible.requiresApproval).toBe(true);
    expect(screenshotsElement.requiresApproval).toBe(true);
    expect(screenshotsFullPage.requiresApproval).toBe(true);
    expect(browserCaptureTab.requiresApproval).toBe(true);
  });

  it("keeps TabInfo.url optional so restricted URLs can be omitted, not leaked", () => {
    expect(() => TabInfo.parse({ id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: false, title: "t", status: "complete", groupId: -1, discarded: false, incognito: false })).not.toThrow();
    const withUrl = TabInfo.parse({ id: 1, index: 0, windowId: 1, active: true, pinned: false, highlighted: false, title: "t", url: "https://example.com/", status: "complete", groupId: -1, discarded: false, incognito: false });
    expect(withUrl.url).toBe("https://example.com/");
  });

  it("bounds coordinates and keeps act scroll paths distinct", () => {
    expect(() => domClickAt.input.parse({ x: -1, y: 10 })).toThrow();
    expect(() => domClickAt.input.parse({ x: 100_001, y: 10 })).toThrow();
    expect(() => domClickAt.input.parse({ x: Number.NaN, y: 10 })).toThrow();
    expect(() => domClickAt.input.parse({ x: 100_000, y: 0 })).not.toThrow();
    const scrollDirection = { do: "scroll", target: { ref: "r1" }, direction: "down", amount: 600 };
    const scrollCoords = { do: "scroll", target: { ref: "r1" }, x: 10, y: 20 };
    const scrollBoth = { do: "scroll", target: { ref: "r1" }, direction: "down", x: 10, y: 20 };
    expect(() => actTool.input.parse({ steps: [scrollDirection] })).not.toThrow();
    expect(() => actTool.input.parse({ steps: [scrollCoords] })).not.toThrow();
    expect(() => actTool.input.parse({ steps: [scrollBoth] })).toThrow();
  });

  it("enforces the same inline file caps in unified form/submit as granular tools", () => {
    const uploadOk = { ref: "r1", files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "a".repeat(15_000_000) }] };
    const uploadOver = { ref: "r1", files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "a".repeat(15_000_001) }] };
    expect(() => formTool.input.parse({ phase: "upload", ...uploadOk })).not.toThrow();
    expect(() => formTool.input.parse({ phase: "upload", ...uploadOver })).toThrow(/15,000,000/);
    expect(() => submitTool.input.parse({ action: "upload", ...uploadOver })).toThrow(/15,000,000/);
    const setFileOk = { ref: "r1", files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "a".repeat(35_000_000) }] };
    const setFileOver = { ref: "r1", files: [{ name: "a.txt", mimeType: "text/plain", dataBase64: "a".repeat(35_000_001) }] };
    expect(() => submitTool.input.parse({ action: "set_file", ...setFileOk })).not.toThrow();
    expect(() => submitTool.input.parse({ action: "set_file", ...setFileOver })).toThrow(/35,000,000/);
  });

  it("uses unique, namespaced tool names", () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(?:\.[a-zA-Z]+)?$/);
  });

  it("gives every tool an action-oriented description and schemas", () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.description.length).toBeGreaterThanOrEqual(13);
      expect(tool.title.length).toBeGreaterThan(1);
      expect(tool.input).toBeDefined();
      expect(tool.output).toBeDefined();
    }
  });

  it("produces JSON-schema descriptors for MCP discovery", () => {
    const descriptor = toToolDescriptor(TOOL_SCHEMAS.find((t) => t.name === "tabs")!);
    expect(descriptor.name).toBe("tabs");
    expect(descriptor.inputSchema).toHaveProperty("type", "object");
    expect(descriptor.category).toBe("tabs");
    expect(descriptor.risk).toBe("reversible"); // unified tabs dispatches create/close/duplicate, not read-only
  });

  it("maps optional permission groups for sensitive categories", () => {
    expect(optionalGroupForTool("bookmarks.search")).toBe("bookmarks");
    expect(optionalGroupForTool("history.search")).toBe("history");
    expect(optionalGroupForTool("clipboard.read")).toBe("clipboard");
    expect(optionalGroupForTool("tabs.list")).toBeNull();
  });

  it("defaults every optional-tab tool to active-tab policy targeting", () => {
    for (const tool of TOOL_SCHEMAS) {
      const input = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      if (input.properties?.tabId && !input.required?.includes("tabId")) {
        expect(tool.targetsActiveTab, tool.name).toBe(true);
      }
    }
  });

  it("keeps TOOL_NAMES in sync with schemas", () => {
    expect(TOOL_NAMES).toEqual(TOOL_SCHEMAS.map((t) => t.name));
  });
});
