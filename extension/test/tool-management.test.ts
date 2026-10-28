import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIFIED_ACTION_RISK } from "../libs/tool-contracts/action-risk.js";
import { discoverTools, taskPlanToolNames } from "../libs/tool-contracts/discovery.js";
import { aggregateToolHealth, filterHealth } from "../libs/tool-contracts/tool-health.js";
import { generateToolSelectionInstructions } from "../libs/tool-contracts/instructions.js";
import { TOOL_META, deprecatedUnifiedAction } from "../libs/tool-contracts/tool-meta.js";
import { TOOL_SCHEMAS, toToolDescriptor } from "../libs/tool-contracts/index.js";

const DESCRIPTORS = TOOL_SCHEMAS.map((t) => toToolDescriptor(t));
const byName = new Map(DESCRIPTORS.map((d) => [d.name, d]));

/** 20 discovery intent queries (plan 2.3 / Phase 2 exit test). */
const QUERIES: Array<{
  query: string;
  expectTop5: string[];
  /** Category prefixes that must NOT appear in the top 5. */
  forbiddenTop5: string[];
}> = [
  { query: "organise tabs", expectTop5: ["tabs", "workflows.organizeTabs"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "read clipboard", expectTop5: ["clipboard", "clipboard.read"], forbiddenTop5: ["downloads.", "tabs."] },
  { query: "fill a form", expectTop5: ["form", "forms.fill"], forbiddenTop5: ["downloads.", "bookmarks."] },
  { query: "collect links", expectTop5: ["workflows.collectLinks", "page.links"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "take a screenshot", expectTop5: ["screenshots.visible"], forbiddenTop5: ["bookmarks.", "downloads."] },
  { query: "list open tabs", expectTop5: ["tabs.list"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "close a tab", expectTop5: ["tabs.close"], forbiddenTop5: ["clipboard.", "bookmarks."] },
  { query: "search bookmarks", expectTop5: ["bookmarks.search"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "search history", expectTop5: ["history.search"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "download a file", expectTop5: ["downloads.start"], forbiddenTop5: ["clipboard.", "bookmarks."] },
  { query: "open a new tab", expectTop5: ["tabs.create"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "group tabs", expectTop5: ["tabs.group"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "save session", expectTop5: ["workflows.saveSession"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "read page text", expectTop5: ["page.read"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "extract table", expectTop5: ["workflows.extractTable", "page.tables"], forbiddenTop5: ["clipboard.", "downloads."] },
  { query: "click a button", expectTop5: ["dom.click", "act"], forbiddenTop5: ["bookmarks.", "downloads."] },
  { query: "type into a field", expectTop5: ["dom.type"], forbiddenTop5: ["bookmarks.", "downloads."] },
  { query: "submit a form", expectTop5: ["form", "forms.submit"], forbiddenTop5: ["bookmarks.", "downloads."] },
  { query: "preview a form", expectTop5: ["forms.preview", "form"], forbiddenTop5: ["bookmarks.", "downloads."] },
  { query: "wait for network idle", expectTop5: ["page.networkIdle", "wait"], forbiddenTop5: ["bookmarks.", "downloads."] },
];

describe("discovery v2 (Phase 2)", () => {
  it.each(QUERIES)("query %s returns the correct tool in the top 5, without an unrelated-category tool in the top 5", ({ query, expectTop5, forbiddenTop5 }) => {
    const { results } = discoverTools(DESCRIPTORS, query);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    const top5 = results.slice(0, 5).map((r) => r.name);
    for (const expected of expectTop5) expect(top5, `query "${query}" top5=${top5.join(",")}`).toContain(expected);
    for (const name of top5) {
      for (const forbidden of forbiddenTop5) expect(name.startsWith(forbidden), `query "${query}"`).toBe(false);
    }
  });

  it("returns full schemas for the top 5 only, and a pointer for the rest", () => {
    const { results } = discoverTools(DESCRIPTORS, "tabs");
    expect(results.length).toBeGreaterThan(5);
    for (let i = 0; i < 5; i++) expect(results[i]!.inputSchema).toBeDefined();
    expect(results[5]!.inputSchema).toBeUndefined();
    expect(results[5]!.inputSchemaPointer).toMatch(/ListTools/);
  });

  it("groups results by category", () => {
    const { grouped } = discoverTools(DESCRIPTORS, "tabs");
    expect(Object.keys(grouped).length).toBeGreaterThan(0);
    for (const [group, items] of Object.entries(grouped)) {
      for (const item of items) expect(item.category).toBe(group);
    }
  });

  it("filters by permission before scoring: a denied tool is never surfaced", () => {
    const { results } = discoverTools(DESCRIPTORS, "organise tabs", {
      allowed: (d) => d.name !== "tabs" && d.name !== "workflows.organizeTabs",
    });
    expect(results.map((r) => r.name)).not.toContain("tabs");
    expect(results.map((r) => r.name)).not.toContain("workflows.organizeTabs");
  });

  it("organise tabs: matched action carries consequential risk + approval, with related tools", () => {
    const { results } = discoverTools(DESCRIPTORS, "organise tabs");
    const tabs = results.find((r) => r.name === "tabs")!;
    expect(tabs.matchedAction).toBe("organize");
    expect(tabs.matchedActionRisk).toBe("consequential");
    expect(tabs.matchedActionApproval).toBe(true);
    expect(tabs.related.map((r) => r.name)).toContain("workflows.organizeTabs");
    expect(tabs.related.map((r) => r.name)).toContain("tabs.group");
  });

  it("read clipboard: matched action is sensitive-read + approval", () => {
    const { results } = discoverTools(DESCRIPTORS, "read clipboard");
    const clipboard = results.find((r) => r.name === "clipboard")!;
    expect(clipboard.matchedAction).toBe("read");
    expect(clipboard.matchedActionRisk).toBe("sensitive-read");
    expect(clipboard.matchedActionApproval).toBe(true);
  });

  it("form submit: prerequisites include preview, related include preview + fill", () => {
    const { results } = discoverTools(DESCRIPTORS, "submit a form");
    const form = results.find((r) => r.name === "form")!;
    expect(form.matchedAction).toBe("submit");
    expect(form.matchedActionRisk).toBe("consequential");
    expect(form.matchedActionApproval).toBe(true);
    expect(form.related.map((r) => r.name)).toContain("form.preview");
    expect(form.related.map((r) => r.name)).toContain("form.fill");
    expect(form.prerequisites.join(" ")).toMatch(/Preview is required before submit/);
  });

  it("telemetry suggestion states its reason and never restricts", () => {
    const { results } = discoverTools(DESCRIPTORS, "take a screenshot", {
      health: { "screenshots.visible": { timeoutRate: 0.5, errorRate: 0 } },
    });
    const shot = results.find((r) => r.name === "screenshots.visible")!;
    expect(shot.suggestion).toMatch(/splitting/);
    expect(shot.suggestionReason).toMatch(/50%/);
    // The tool is still returned; a suggestion is not a restriction.
    expect(results.map((r) => r.name)).toContain("screenshots.visible");
  });
});

describe("deprecation (Phase 3)", () => {
  it("navigate tab/window actions are deprecated with use-instead, URL/sync actions are not", () => {
    expect(deprecatedUnifiedAction("navigate", "list", "tab")?.useInstead).toBe("tabs.list");
    expect(deprecatedUnifiedAction("navigate", "close", "window")?.useInstead).toBe("tabs.close");
    expect(deprecatedUnifiedAction("navigate", "update", "window")?.useInstead).toBe("windows.update");
    expect(deprecatedUnifiedAction("navigate", "open", "url")).toBeNull();
    expect(deprecatedUnifiedAction("navigate", "wait", "sync:network_idle")).toBeNull();
    expect(deprecatedUnifiedAction("navigate", "open")).toBeNull();
  });

  it("data devtools/clipboard domains are deprecated, bookmarks/history/downloads/files are not", () => {
    expect(deprecatedUnifiedAction("data", "read", "clipboard")?.useInstead).toBe("clipboard.read");
    expect(deprecatedUnifiedAction("data", "console", "devtools")?.useInstead).toBe("devtools.console");
    expect(deprecatedUnifiedAction("data", "list", "bookmarks")).toBeNull();
    expect(deprecatedUnifiedAction("data", "search", "history")).toBeNull();
    expect(deprecatedUnifiedAction("data", "list", "downloads")).toBeNull();
    expect(deprecatedUnifiedAction("data", "list", "files")).toBeNull();
  });

  it("a matched deprecated action carries its warning in discovery", () => {
    const { results } = discoverTools(DESCRIPTORS, "navigate tab close");
    const nav = results.find((r) => r.name === "navigate");
    if (nav) {
      expect(nav.matchedAction).toBe("close");
      expect(nav.deprecatedWarning).toMatch(/tabs\.close/);
    }
    const dataResults = discoverTools(DESCRIPTORS, "data clipboard read").results;
    const data = dataResults.find((r) => r.name === "data");
    if (data) expect(data.deprecatedWarning).toMatch(/clipboard\.read/);
  });

  it("no whole tool is deprecated, so nothing in the core set is a deprecated tool", () => {
    expect(Object.values(TOOL_META).filter((m) => m.deprecated)).toEqual([]);
  });
});

describe("health aggregates (Phase 3)", () => {
  it("aggregates synthetic audit events correctly and leaks no inputs", () => {
    const events = [
      { kind: "tool.call", tool: "tabs.list", decision: "allowed" },
      { kind: "tool.result", tool: "tabs.list", decision: "executed", outcome: "success", durationMs: 100, outputSize: 500, truncated: false },
      { kind: "tool.result", tool: "tabs.list", decision: "executed", outcome: "success", durationMs: 300, outputSize: 1500, truncated: true },
      { kind: "tool.result", tool: "tabs.list", decision: "error", outcome: "timeout", durationMs: 5000 },
      { kind: "tool.call", tool: "tabs.close", decision: "denied" },
      { kind: "tool.call", tool: "tabs.close", decision: "approval-required" },
      { kind: "tool.result", tool: "tabs.close", decision: "executed", outcome: "success", durationMs: 50 },
    ];
    const aggregates = aggregateToolHealth(events);
    const list = aggregates.find((a) => a.tool === "tabs.list")!;
    expect(list.calls).toBe(3);
    expect(list.success).toBe(2);
    expect(list.timeout).toBe(1);
    expect(list.timeoutRate).toBeCloseTo(1 / 3);
    expect(list.avgLatencyMs).toBeCloseTo((100 + 300 + 5000) / 3);
    expect(list.avgOutputSize).toBe(1000);
    expect(list.truncatedRate).toBe(0.5);
    const close = aggregates.find((a) => a.tool === "tabs.close")!;
    expect(close.calls).toBe(3);
    expect(close.denied).toBe(1);
    expect(close.approvalRequired).toBe(1);
    expect(close.denialRate).toBeCloseTo(1 / 3);
    // No inputs, page content, or screenshots in aggregates.
    expect(JSON.stringify(aggregates)).not.toContain("secret");
    expect(filterHealth(aggregates, "high-timeout").map((a) => a.tool)).toContain("tabs.list");
    expect(filterHealth(aggregates, "high-denial").map((a) => a.tool)).toContain("tabs.close");
  });
});

describe("generated instructions + task plan tools (Phase 2)", () => {
  it("generated instructions name every unified tool and the deprecated actions", () => {
    const text = generateToolSelectionInstructions(DESCRIPTORS);
    for (const name of ["observe", "act", "navigate", "form", "data", "tabs", "clipboard"]) expect(text).toContain(`\`${name}\``);
    expect(text).toContain("read-only: active, get, list, search");
    expect(text).toContain("navigate tab/window");
    expect(text).toContain("data devtools/clipboard");
    expect(text).toContain("preview before submit");
  });

  it("task plan tool names are extracted once, deduplicated, in plan order", () => {
    expect(taskPlanToolNames([{ tool: "tabs.list", input: {} }, { tool: "page.read", input: {} }, { tool: "tabs.list", input: {} }])).toEqual([
      "tabs.list",
      "page.read",
    ]);
    expect(taskPlanToolNames(undefined)).toEqual([]);
  });

  it("Phase 1 per-action risk table is unchanged by this track (spot checks)", () => {
    const find = (tool: string, action: string, domain?: string) =>
      UNIFIED_ACTION_RISK.find((e) => e.unifiedTool === tool && e.action === action && e.domain === domain);
    expect(find("tabs", "list")?.risk).toBe("read-only");
    expect(find("tabs", "organize")?.risk).toBe("consequential");
    expect(find("data", "delete", "bookmarks")?.risk).toBe("consequential");
    expect(find("data", "delete", "bookmarks")?.granularTool).toBe("bookmarks.delete");
    expect(byName.get("tasks.create")).toBeDefined();
  });

  it("inventory report matches the registry exactly (generated file, not hand counts)", () => {
    const report = readFileSync(new URL("../../TOOL-INVENTORY.md", import.meta.url), "utf8");
    expect(report).toContain(`Total tools: **${TOOL_SCHEMAS.length}**`);
    // Only the Tools table (not the per-action table, whose first column
    // repeats unified tool names by design).
    const toolsSection = report.split("## Tools")[1]!.split("## Unified")[0]!;
    const counted = [...toolsSection.matchAll(/^\| ([a-zA-Z][a-zA-Z0-9.]*?) \|/gm)].map((m) => m[1]!);
    const toolRows = counted.filter((n) => byName.has(n));
    expect(new Set(toolRows).size).toBe(toolRows.length);
    expect(toolRows.sort()).toEqual(TOOL_SCHEMAS.map((t) => t.name).sort());
  });
});
