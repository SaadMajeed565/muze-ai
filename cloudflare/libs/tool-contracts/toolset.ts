import type { PermissionCategory, ToolDefinition } from "./tools.js";
import { tabsTools } from "./schemas/tabs.js";
import { pageTools } from "./schemas/page.js";
import { interactTools } from "./schemas/interact.js";
import { systemTools } from "./schemas/system.js";
import { dataTools } from "./schemas/data.js";
import { workflowTools } from "./schemas/workflows.js";
import { unifiedTools } from "./schemas/unified.js";
import { taskTools } from "./schemas/tasks.js";

/**
 * Per-action risk table for the 13 unified tools (Tool Management Plan
 * Phase 1, section A). The table itself and its resolver live in
 * action-risk.ts; they are re-exported here so the registry entry point
 * exposes them, and they flow on to tool-contracts/index.ts through this
 * module's existing `export *` (index.ts itself is left untouched).
 */
export { UNIFIED_ACTION_RISK, resolveUnifiedAction } from "./action-risk.js";
export type { ActionRiskEntry, ActionSideEffect } from "./action-risk.js";
export * from "./tool-meta.js";
export * from "./discovery.js";
export * from "./tool-health.js";
export * from "./instructions.js";

/**
 * The complete, ordered tool registry schema. Handlers are attached by the
 * browser engine; this array is the single source of truth for validation,
 * MCP discovery and the dashboard.
 */
export const TOOL_SCHEMAS: ToolDefinition[] = [
  ...tabsTools,
  ...pageTools,
  ...interactTools,
  ...systemTools,
  ...dataTools,
  ...workflowTools,
  ...unifiedTools,
  ...taskTools,
];

/**
 * Task tools (Phase 0's six plus Phase 1's tasks.approvePlan), as a convenience
 * alias for the task subset of TOOL_SCHEMAS. They are merged into
 * TOOL_SCHEMAS in 0.4.0 so registry consumers (including the gateway
 * core-list check) see them, but they are still runner-owned: host
 * dispatch intercepts tasks.* before the executor, and the registry
 * factory registers a stub handler for them that throws UNSUPPORTED
 * (see registry-factory.ts), so a direct executor call to tasks.*
 * can never silently execute a step or bypass approval — it must go
 * through host dispatch to the task runner.
 */
export const TASK_TOOL_SCHEMAS: ToolDefinition[] = [...taskTools];

export const TOOL_NAMES: string[] = TOOL_SCHEMAS.map((t) => t.name);

/**
 * Optional permission groups. Each group maps to the Chrome permission list the
 * user must grant before the group's tools can run. Groups are disabled by
 * default and enabled explicitly from the dashboard.
 */
export const OPTIONAL_PERMISSION_GROUPS = {
  bookmarks: ["bookmarks"],
  history: ["history"],
  downloads: ["downloads"],
  // Clipboard read/write uses an offscreen document rather than a host permission.
  clipboard: ["offscreen"],
} as const satisfies Record<string, readonly string[]>;

export type OptionalPermissionGroup = keyof typeof OPTIONAL_PERMISSION_GROUPS;

/**
 * Tools that need an optional permission group, keyed by tool name. A tool can
 * need a group without belonging to that group's category, which is why this
 * is an explicit map rather than a switch on the category.
 *
 * `browser.search` is deliberately absent: it only combines history, bookmarks
 * and open tabs, and each of those sources is gated by its own group at the
 * point of use.
 */
const TOOL_OPTIONAL_GROUP: Record<string, OptionalPermissionGroup> = {
  "bookmarks.search": "bookmarks",
  "bookmarks.list": "bookmarks",
  "bookmarks.create": "bookmarks",
  "bookmarks.update": "bookmarks",
  "bookmarks.delete": "bookmarks",
  "bookmarks.move": "bookmarks",
  "bookmarks.createFolder": "bookmarks",
  "history.search": "history",
  "history.add": "history",
  "history.delete": "history",
  "downloads.list": "downloads",
  "downloads.control": "downloads",
  "downloads.start": "downloads",
  "downloads.erase": "downloads",
  "clipboard.read": "clipboard",
  "clipboard.write": "clipboard",
};

/** Which optional group a tool requires, if any. */
export function optionalGroupForTool(name: string): OptionalPermissionGroup | null {
  return TOOL_OPTIONAL_GROUP[name] ?? null;
}

export function toolsByCategory(): Record<string, string[]> {
  const result: Partial<Record<PermissionCategory, string[]>> = {};
  for (const tool of TOOL_SCHEMAS) {
    (result[tool.category] ??= []).push(tool.name);
  }
  return result as Record<string, string[]>;
}

export const UNIFIED_TOOL_SCHEMAS: ToolDefinition[] = [...unifiedTools];

export const UNIFIED_TOOL_NAMES: string[] = unifiedTools.map((tool) => tool.name);
