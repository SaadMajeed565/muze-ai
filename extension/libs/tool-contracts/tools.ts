import { z } from "zod";
import { toolMetaFor } from "./tool-meta.js";

/**
 * Permission categories group tools so operators can allow/deny whole areas
 * (for example "history is off, everything else is on").
 */
export const PERMISSION_CATEGORIES = [
  "tabs",
  "windows",
  "page",
  "navigation",
  "dom",
  "forms",
  "screenshots",
  "downloads",
  "clipboard",
  "browser",
  "bookmarks",
  "history",
  "devtools",
  "workflows",
  "files",
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * Risk levels drive the default policy:
 * - read-only:      safe to run by default (list tabs, read a page).
 * - reversible:     mutates browser state but is undoable (open tab, scroll).
 * - sensitive-read: reads data the user may consider private (history, clipboard).
 * - consequential:  hard to undo or externally visible (submit form, purchase).
 * - restricted:     reserved for tools that should never be reachable (cookies, credentials).
 *
 * Every level is allowed by default; the policy's `approvalMode` and the
 * per-tool overrides decide what still needs a confirmation.
 */
export const RISK_LEVELS = ["read-only", "reversible", "sensitive-read", "consequential", "restricted"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * MCP tool annotations. Clients use them to decide whether a call needs a
 * confirmation prompt, so every hint is always present and always explicit.
 */
export interface ToolAnnotations {
  /** The call only reads state; it never changes the browser or a remote system. */
  readOnlyHint: boolean;
  /** The call can destroy or overwrite state that is hard to recover. */
  destructiveHint: boolean;
  /** The call reaches arbitrary public destinations rather than a bounded private set. */
  openWorldHint: boolean;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  category: PermissionCategory;
  risk: RiskLevel;
  requiresApproval: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Chrome optional host/origin permissions the tool may require. */
  hostPermissions?: string[];
  /** True when the tool only makes sense for a specific active tab. */
  targetsActiveTab?: boolean;
  tags?: string[];
  /** Registry tool names that should normally run first (Phase 2 metadata). */
  requires?: string[];
  /** Plain-English prerequisite note (e.g. preview before submit). */
  requiresNote?: string;
  /** Registry tool names often needed next. */
  related?: string[];
  /** One-line steering note; never a policy rule. */
  whenNotToUse?: string;
  /** Whole-tool deprecation flag (Phase 3 uses per-action deprecation instead). */
  deprecated?: boolean;
  /** Tool to use instead, when deprecated. */
  useInstead?: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  title: string;
  description: string;
  category: PermissionCategory;
  risk: RiskLevel;
  /**
   * Static approval requirement, or a predicate evaluated against the validated
   * input. Predicates let us require approval only for high-impact variants
   * (for example form.submit but not form.fill).
   */
  requiresApproval: boolean | ((input: Input) => boolean);
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  hostPermissions?: string[];
  targetsActiveTab?: boolean;
  tags?: string[];
  requires?: string[];
  requiresNote?: string;
  related?: string[];
  whenNotToUse?: string;
  deprecated?: boolean;
  useInstead?: string;
}

export interface ToolDescriptorOptions {
  /** Force the advertised requiresApproval flag (used when input cannot be static). */
  requiresApproval?: boolean;
}

/**
 * Writes that overwrite or discard state. The risk model calls some of them
 * "reversible" because the browser can undo the gesture, but the previous
 * content of the page, tab or field is gone.
 */
const OVERWRITING_TOOLS = new Set([
  "bookmarks.update",
  "dom.clear",
  "dom.click",
  "dom.clickAt",
  "dom.fill",
  "dom.press",
  "dom.select",
  "dom.setChecked",
  "dom.setRadio",
  "dom.type",
  "forms.fill",
  "tabs.close",
  "tabs.discard",
  "windows.close",
  "workflows.fillFormForReview",
]);

/** Consequential tools that only add state: they never overwrite or send anything. */
const ADDITIVE_CONSEQUENTIAL_TOOLS = new Set([
  "downloads.start",
  "workflows.openSequence",
  "workflows.organizeTabs",
  "workflows.saveSession",
]);

/** Categories whose tools read or act on web pages rather than on local browser state. */
const OPEN_WORLD_CATEGORIES = new Set<PermissionCategory>([
  "page",
  "navigation",
  "dom",
  "forms",
  "screenshots",
  "devtools",
  "workflows",
]);

/** Open-world categories with a tool that stays inside the user's own browser. */
const CLOSED_WORLD_TOOLS = new Set(["workflows.organizeTabs", "workflows.saveSession"]);

/** Local-state tools that still reach an arbitrary destination. */
const OPEN_WORLD_TOOLS = new Set(["browser.activeContext", "browser.captureTab", "browser.observer", "tabs.create", "tabs.navigate"]);

/**
 * Derive the MCP annotations from the risk model so every tool advertises the
 * same hints to every client, instead of hand-maintaining one set of flags
 * per tool (the count is derived from the registry, never hardcoded).
 */
export function toToolAnnotations(tool: {
  name: string;
  category: PermissionCategory;
  risk: RiskLevel;
}): ToolAnnotations {
  const readOnly = tool.risk === "read-only" || tool.risk === "sensitive-read";
  const destructive = !readOnly && (OVERWRITING_TOOLS.has(tool.name) || (tool.risk === "consequential" && !ADDITIVE_CONSEQUENTIAL_TOOLS.has(tool.name)));
  const openWorld =
    (OPEN_WORLD_CATEGORIES.has(tool.category) && !CLOSED_WORLD_TOOLS.has(tool.name)) || OPEN_WORLD_TOOLS.has(tool.name);
  return { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld };
}

export function toolRequiresApproval<I>(tool: ToolDefinition<I, unknown>, input: I): boolean {
  return typeof tool.requiresApproval === "function" ? tool.requiresApproval(input) : tool.requiresApproval;
}

export function toToolDescriptor<I, O>(tool: ToolDefinition<I, O>, options: ToolDescriptorOptions = {}): ToolDescriptor {
  const requiresApproval =
    options.requiresApproval ?? (typeof tool.requiresApproval === "boolean" ? tool.requiresApproval : false);
  // Phase 2 metadata lives in tool-meta.ts (one data table for the whole
  // registry) and is merged here, so every descriptor consumer — MCP,
  // dashboard, gateway discovery — sees the same tags/prerequisites/
  // related tools. A per-schema `tags` field, if ever set, wins.
  const meta = toolMetaFor(tool.name);
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    category: tool.category,
    risk: tool.risk,
    requiresApproval,
    inputSchema: z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(tool.output, { target: "draft-7", io: "output" }) as Record<string, unknown>,
    annotations: toToolAnnotations(tool),
    ...(tool.hostPermissions ? { hostPermissions: tool.hostPermissions } : {}),
    ...(tool.targetsActiveTab ? { targetsActiveTab: tool.targetsActiveTab } : {}),
    ...(tool.tags ?? meta?.tags ? { tags: tool.tags ?? meta!.tags } : {}),
    ...(tool.requires ?? meta?.requires ? { requires: tool.requires ?? meta!.requires } : {}),
    ...(tool.requiresNote ?? meta?.requiresNote ? { requiresNote: tool.requiresNote ?? meta!.requiresNote } : {}),
    ...(tool.related ?? meta?.related ? { related: tool.related ?? meta!.related } : {}),
    ...(tool.whenNotToUse ?? meta?.whenNotToUse ? { whenNotToUse: tool.whenNotToUse ?? meta!.whenNotToUse } : {}),
    ...(tool.deprecated ?? meta?.deprecated ? { deprecated: tool.deprecated ?? meta!.deprecated } : {}),
    ...(tool.useInstead ?? meta?.useInstead ? { useInstead: tool.useInstead ?? meta!.useInstead } : {}),
  };
}
