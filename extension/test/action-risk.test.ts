import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RISK_LEVELS,
  TOOL_SCHEMAS,
  UNIFIED_ACTION_RISK,
  UNIFIED_TOOL_NAMES,
  resolveUnifiedAction,
  unifiedTools,
} from "../libs/tool-contracts/index.js";

const SIDE_EFFECTS = ["none", "browser-state", "external-visible", "destructive"] as const;

/** Per-tool entry counts for the table as built (guards against dropped rows). */
const EXPECTED_COUNTS: Record<string, number> = {
  browser: 5,
  tabs: 18,
  windows: 4,
  navigate: 73,
  observe: 13,
  act: 13,
  wait: 4,
  form: 6,
  submit: 3,
  devtools: 7,
  data: 25,
  clipboard: 2,
  files: 2,
};

/** Every domain x action pair the data handler actually dispatches. */
const DATA_DISPATCHED: [string, string][] = [
  ["clipboard", "read"],
  ["clipboard", "write"],
  ["files", "list"],
  ["files", "stat"],
  ["devtools", "console"],
  ["devtools", "network"],
  ["devtools", "errors"],
  ["devtools", "performance"],
  ["devtools", "observer"],
  ["devtools", "dialogs"],
  ["devtools", "respond_dialog"],
  ["bookmarks", "list"],
  ["bookmarks", "search"],
  ["bookmarks", "create"],
  ["bookmarks", "create_folder"],
  ["bookmarks", "move"],
  ["bookmarks", "update"],
  ["bookmarks", "delete"],
  ["history", "search"],
  ["history", "add"],
  ["history", "delete"],
  ["downloads", "list"],
  ["downloads", "start"],
  ["downloads", "control"],
  ["downloads", "erase"],
];

/** Dispatch keys that have no `action` enum in their unified schema. */
const NON_ACTION_KEYS: Record<string, string[]> = {
  observe: ["metadata", "outline", "text", "links", "tables", "forms", "find", "a11y", "ast", "screenshot", "selection", "shadow", "frames"],
  act: ["click", "hover", "move", "drag", "focus", "scroll", "scroll_into_view", "press", "type", "fill", "clear", "select", "check"],
  wait: ["element", "network_idle", "navigation", "delay"],
  form: ["inspect", "preview", "fill", "upload", "submit", "set_file"],
};

function actionEnumOf(toolName: string): string[] | undefined {
  const tool = unifiedTools.find((t) => t.name === toolName);
  if (!tool) return undefined;
  const json = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as {
    properties?: Record<string, { enum?: string[] }>;
  };
  return json.properties?.action?.enum;
}

describe("unified per-action risk table", () => {
  it("covers exactly the 13 unified tools, with the expected entry counts", () => {
    expect([...UNIFIED_TOOL_NAMES].sort()).toEqual(
      ["act", "browser", "clipboard", "data", "devtools", "files", "form", "navigate", "observe", "submit", "tabs", "wait", "windows"].sort(),
    );
    const counts: Record<string, number> = {};
    for (const entry of UNIFIED_ACTION_RISK) counts[entry.unifiedTool] = (counts[entry.unifiedTool] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(UNIFIED_ACTION_RISK.length).toBe(175);
  });

  it("has valid risk, sideEffect and requiresApproval on every entry", () => {
    const registryByName = new Map(TOOL_SCHEMAS.map((t) => [t.name, t]));
    for (const entry of UNIFIED_ACTION_RISK) {
      expect(RISK_LEVELS, entry.unifiedTool + "." + entry.action).toContain(entry.risk);
      expect(SIDE_EFFECTS, entry.unifiedTool + "." + entry.action).toContain(entry.sideEffect);
      expect(
        typeof entry.requiresApproval === "boolean" || entry.requiresApproval === "granular",
        `${entry.unifiedTool}.${entry.action} requiresApproval`,
      ).toBe(true);
      if (entry.idempotent !== undefined) expect(typeof entry.idempotent).toBe("boolean");
      // Every entry maps to a real registry tool, except the two flagged
      // local (unmappable) actions, which must be restricted + approval true.
      if (entry.granularTool.startsWith("local:")) {
        expect(entry.risk).toBe("restricted");
        expect(entry.requiresApproval).toBe(true);
      } else {
        const granular = registryByName.get(entry.granularTool);
        expect(granular, `${entry.unifiedTool}.${entry.action} -> ${entry.granularTool}`).toBeDefined();
        // No entry maps to a restricted tool (none exists in the registry).
        expect(granular!.risk).not.toBe("restricted");
        // The table's risk mirrors the granular tool's risk, except for the
        // flagged local entries handled above.
        expect(entry.risk, `${entry.unifiedTool}.${entry.action} risk`).toBe(granular!.risk);
      }
    }
  });

  it("has no duplicate (tool, action, domain) keys", () => {
    const seen = new Set<string>();
    for (const entry of UNIFIED_ACTION_RISK) {
      const key = [entry.unifiedTool, entry.action, entry.domain ?? ""].join("\0");
      expect(seen.has(key), `duplicate key ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("covers every action in each unified schema's action enum", () => {
    for (const tool of unifiedTools) {
      const actions = actionEnumOf(tool.name);
      if (!actions) continue; // observe / act / wait use other dispatch keys (below)
      for (const action of actions) {
        const covered = UNIFIED_ACTION_RISK.some((e) => e.unifiedTool === tool.name && e.action === action);
        expect(covered, `${tool.name}.${action} has no table entry`).toBe(true);
      }
    }
  });

  it("covers every non-action dispatch key (observe includes, act steps, wait fors, form phases)", () => {
    for (const [tool, keys] of Object.entries(NON_ACTION_KEYS)) {
      for (const key of keys) {
        const covered = UNIFIED_ACTION_RISK.some((e) => e.unifiedTool === tool && e.action === key);
        expect(covered, `${tool}.${key} has no table entry`).toBe(true);
      }
    }
  });

  it("covers every domain x action pair the data handler dispatches, and no other data domains", () => {
    for (const [domain, action] of DATA_DISPATCHED) {
      const entry = resolveUnifiedAction("data", action, domain);
      expect(entry, `data.${domain}.${action}`).toBeDefined();
    }
    const dataDomains = new Set(UNIFIED_ACTION_RISK.filter((e) => e.unifiedTool === "data").map((e) => e.domain));
    expect([...dataDomains].sort()).toEqual(["bookmarks", "clipboard", "devtools", "downloads", "files", "history"].sort());
  });

  it("covers navigate category variants as they actually dispatch", () => {
    // Action-only search goes to navigation.search; category=tab search
    // reaches the tab branch and goes to tabs.search.
    expect(resolveUnifiedAction("navigate", "search")?.granularTool).toBe("navigation.search");
    expect(resolveUnifiedAction("navigate", "search", "tab")?.granularTool).toBe("tabs.search");
    // The tab branch is checked before the window branch, so window+create
    // and window+close land on tabs, not windows; only update reaches windows.
    expect(resolveUnifiedAction("navigate", "create", "window")?.granularTool).toBe("tabs.create");
    expect(resolveUnifiedAction("navigate", "close", "window")?.granularTool).toBe("tabs.close");
    expect(resolveUnifiedAction("navigate", "update", "window")?.granularTool).toBe("windows.update");
    expect(resolveUnifiedAction("navigate", "update")?.granularTool).toBe("windows.update");
    // Sync dispatch is by `for`, carried in the domain column.
    expect(resolveUnifiedAction("navigate", "wait", "sync:element")?.granularTool).toBe("page.waitFor");
    expect(resolveUnifiedAction("navigate", "wait", "sync:network_idle")?.granularTool).toBe("page.networkIdle");
    expect(resolveUnifiedAction("navigate", "wait", "sync:navigation")?.granularTool).toBe("navigation.wait");
    // URL-branch actions under category=url.
    expect(resolveUnifiedAction("navigate", "open", "url")?.granularTool).toBe("navigation.open");
    // The tab-branch workflow actions are approval-gated in every variant.
    for (const domain of [undefined, "tab", "window"]) {
      for (const action of ["save_session", "restore_session", "organize"]) {
        const entry = resolveUnifiedAction("navigate", action, domain);
        expect(entry?.risk).toBe("consequential");
        expect(entry?.requiresApproval).toBe(true);
      }
    }
    // Unknown combinations resolve to undefined (the handler throws).
    expect(resolveUnifiedAction("navigate", "search", "window")).toBeUndefined();
    expect(resolveUnifiedAction("navigate", "open", "tab")).toBeUndefined();
  });

  it("flags the unmappable local delay actions as restricted with approval", () => {
    // wait delay is keyed by its `for` value; navigate sync delay is keyed
    // by the canonical sync action ("wait") plus the sync:delay variant.
    const entries = [
      resolveUnifiedAction("wait", "delay"),
      resolveUnifiedAction("navigate", "wait", "sync:delay"),
    ];
    for (const entry of entries) {
      expect(entry).toBeDefined();
      expect(entry!.risk).toBe("restricted");
      expect(entry!.requiresApproval).toBe(true);
      expect(entry!.granularTool.startsWith("local:")).toBe(true);
    }
  });

  it("resolves representative cases", () => {
    const list = resolveUnifiedAction("tabs", "list");
    expect(list?.granularTool).toBe("tabs.list");
    expect(list?.risk).toBe("read-only");
    expect(list?.requiresApproval).toBe(false);

    const close = resolveUnifiedAction("tabs", "close");
    expect(close?.granularTool).toBe("tabs.close");
    expect(close?.risk).toBe("reversible");

    const bookmarkDelete = resolveUnifiedAction("data", "delete", "bookmarks");
    expect(bookmarkDelete?.granularTool).toBe("bookmarks.delete");
    expect(bookmarkDelete?.risk).toBe("consequential");
    expect(bookmarkDelete?.requiresApproval).toBe(true);
    expect(bookmarkDelete?.sideEffect).toBe("destructive");

    const clipboardRead = resolveUnifiedAction("clipboard", "read");
    expect(clipboardRead?.granularTool).toBe("clipboard.read");
    expect(clipboardRead?.risk).toBe("sensitive-read");
    expect(clipboardRead?.requiresApproval).toBe(true);

    expect(resolveUnifiedAction("tabs", "nope")).toBeUndefined();
    expect(resolveUnifiedAction("data", "delete", "files")).toBeUndefined();
    expect(resolveUnifiedAction("data", "delete")).toBeUndefined();
  });
});
