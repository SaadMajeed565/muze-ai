import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  REGISTRY_VERSION,
  ToolErrorException,
  toToolDescriptor,
  toToolError,
  TOOL_SCHEMAS as FULL_TOOL_SCHEMAS,
  type ToolDescriptor,
} from "../libs/tool-contracts/index.js";
import { resolveUnifiedAction } from "../libs/tool-contracts/action-risk.js";
import {
  UNIFIED_ACTION_RISK,
  classifyClientType,
  discoverTools,
  generateToolSelectionInstructions,
  listToolsCapForClientType,
  taskPlanToolNames,
} from "../libs/tool-contracts/index.js";
import type { GatewayBridge } from "./bridge.js";
import type { ClientIdentity } from "../libs/tool-contracts/index.js";

export const SERVER_NAME = "muze-browser-gateway";
export const SERVER_VERSION = "0.5.0";

/** Curated MCP surface: The 5 Master Tools + Meta Tools. */
export const CORE_TOOL_NAMES = new Set<string>([
  "observe",
  "act",
  "navigate",
  "form",
  "data",
  "tools.batch",
  "tools.discover",
  // Phase 0 task tools are in the core set explicitly: a task client
  // needs tasks.create/get/list/pause/resume/cancel without first
  // discovering them, and the core-set filter would otherwise hide them
  // from the default ListTools response.
  "tasks.create",
  "tasks.get",
  "tasks.list",
  "tasks.pause",
  "tasks.resume",
  "tasks.cancel",
  "tasks.approvePlan",
]);

/** Stale names from older instructions; rewrite so cached clients still work. */
const TOOL_ALIASES: Record<string, string> = {
  "tabs.current": "tabs.active",
  "tabs.open": "tabs.create",
  "tabs.focus": "tabs.activate",
  "navigation.goto": "tabs.navigate",
  "page.getUrl": "page.metadata",
  "page.getTitle": "page.metadata",
  "dom.exists": "dom.waitFor",
  "forms.clear": "dom.clear",
  "workflows.extractLinks": "workflows.collectLinks",
  "system.status": "browser.info",
};

export const MCP_INSTRUCTIONS =
  "IMPORTANT: Every task you undertake must be created with tasks.create so it appears in the user's Tasks list — if the work is a task, call tasks.create for it rather than doing it only through direct tool calls.\n\n" +
  "You are an expert agentic browser operator controlling the user's Chrome browser via Muze AI.\n\n" +
  "## CORE AGENTIC LOOP: Observe → Reason → Act → Verify\n" +
  "1. Ground: Always observe before acting. Call `observe` to inspect the page text, accessibility tree, form fields, and interactive element refs.\n" +
  "2. Interact: Call `act` with step(s) using the stable element `ref` (e.g. 'r1a2b') obtained from `observe`.\n" +
  "3. Settle: If an action triggers navigation or async data loading, synchronize with `navigate({ category: 'sync', for: 'network_idle' })`.\n" +
  "4. Verify: Re-observe the page to confirm the expected change succeeded.\n\n" +
  "## EXECUTION DISCIPLINE\n" +
  "- Never stop mid-task on a first failure. A missing element, a timeout, or a tool error means re-observe and try the next grounding method, not abandoning the task. Report a task as partial only when you have actually stopped, and say exactly which steps are done and which are not.\n" +
  "- Never assume an identity. Identify a file by id + name + size, a tab by id + URL, and an element by ref + role + name + bounding box. If two candidates match, re-observe and disambiguate; do not pick the similar one.\n" +
  "- Never claim success from `clicked: true` alone. A click only means the click was dispatched. Success is a post-action observe showing the expected state, such as a dialog title, a button label, or a confirmation message.\n" +
  "- Fallback ladder, in order, per step: re-observe, then ref, then role + name, then text, then selector, then screenshot coordinates as a last resort. Do not jump to screenshot coordinates before the earlier methods, and do not ask the user until they have actually been tried.\n" +
  "- A stale ref is never re-resolved to a different element. Re-observe and mint a fresh ref for the same element.\n\n" +
  "## HOW TO BUILD YOUR OWN TASK BRIEF — HOW, NOT WHAT\n" +
  "This initialize text teaches how to work, never what a specific task's steps are. Do not copy a prewritten procedure for a site or a task: interfaces change, and a copied procedure is a guess about a page you have not observed. For each new task, build your own short brief from the goal and what you actually observe, before your first action.\n" +
  "- Restate the goal in your own words, and state what observable page state will prove it done. Define that success signal yourself from the page you observe, not from a label or message you were given in advance.\n" +
  "- Gather context first: the current tab and URL, what is open (dialog, form, menu), and what inputs or files the goal actually supplies, each identified by id + name + size or by id + URL, never by similarity alone.\n" +
  "- Decide direct vs plan: go direct only when the work is 1-3 steps, reversible or read-only, already grounded with no ambiguity, and has no consequential step. Otherwise build a plan: ordered steps, the capability each step needs, a verify observation after each consequential step, and the bounds that gate it.\n" +
  "- Choose tools by capability, not by name: discover tools for the capability the step needs, read the full schema of only the tools the plan actually uses, and ignore the rest.\n" +
  "- Work the fallback ladder per step, re-observe on any failure or unexpected state, and re-derive the brief when the page changes, a new dialog appears, or two candidates match.\n" +
  "- Stop and ask only after the ladder is exhausted, and report exactly what is done, what is not, and what you tried.\n\n" +
  "## IN-CHAT PERMISSIONS & APPROVALS\n" +
  "- Reading operations (reading personal profiles, inspecting DOM, querying history/bookmarks) execute immediately without asking for user permission.\n" +
  "- Consequential operations (submitting forms, deleting records, writing clipboard) may require confirmation.\n" +
  "- If an action requires confirmation, it is approved only through an elicitation dialog in your chat interface or a decision in the extension dashboard. A confirmation flag in tool input (\"confirmed\", \"userApproved\", \"approved\") is stripped by the gateway and never counts as approval — never send one expecting it to approve anything.\n" +
  "- Do not tell the user to open or look at the extension dashboard as a substitute for elicitation; approvals are decided in chat (elicitation) or on the dashboard, and the gateway records the decision as a real approval on the extension.\n";

/**
 * Gateway scope descriptors: the FULL registry, not just the unified
 * surface. Before this fix the list was unified tools + task tools only,
 * so descriptorForTool() returned undefined for every granular tool with
 * no adaptLegacyToolCall case (tabs.pin, dom.read, screenshots.viewport,
 * workflows.collectLinks, …) and assertScopeAllows() denied it with
 * PERMISSION_DENIED risk "unknown" before it ever reached the bridge —
 * even though the extension registers and executes those tools, and
 * their unified equivalents passed. Scope is still enforced strictly:
 * a granular tool is allowed only when its own registry risk is in the
 * verified OAuth scope (read:tools for read-only, call:tools otherwise);
 * unknown names still deny, and restricted tools still deny for all scopes.
 * ListTools is unaffected: filterToCoreTools() still reduces this list to
 * the core set unless MCP_SHOW_ALL_TOOLS is set.
 */
const ALL_TOOL_DESCRIPTORS: ToolDescriptor[] = FULL_TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool));

/** Every registered tool is advertised to clients; the extension authorizes each call. */
export function listExposedDescriptors(): ToolDescriptor[] {
  return ALL_TOOL_DESCRIPTORS;
}

function isCoreTool(name: string): boolean {
  return CORE_TOOL_NAMES.has(name);
}

/**
 * OAuth scope enforcement (0.3.0). This runs in CallTool handling BEFORE
 * anything is forwarded to the bridge, using the tool descriptor risk:
 *
 * - A token with only `read:tools` may call read-only tools only.
 * - `call:tools` is required for reversible, sensitive-read, and
 *   consequential tools.
 * - Phase 1 canonicalisation: a unified call is resolved to its granular
 *   tool first (resolveUnifiedToolForScope) and the scope check above
 *   runs against the granular risk, so one unified name can be partly
 *   allowed and partly denied by scope, per action.
 * - `restricted` tools are denied for every scope.
 * - A missing, empty, or unknown scope denies every call (fail closed).
 * - An unknown tool name is denied: its risk cannot be verified.
 *
 * Phase 0 task tools fall out of this same risk mapping, with no
 * special case: tasks.get/tasks.list are read-only, so read:tools and
 * call:tools may call them; tasks.create/pause/resume/cancel are
 * reversible, so only call:tools may call them and a read-only scope is
 * denied. The check runs before anything is forwarded to the bridge.
 *
 * The scope is the verified OAuth scope forwarded by the Worker (see
 * index.ts mcp()); it is never taken from client-supplied headers or input.
 * Servers constructed without a scope (e.g. some unit tests) therefore deny
 * all tool calls until a scope is supplied.
 */
export const KNOWN_SCOPES = ["read:tools", "call:tools"] as const;

export function parseOAuthScope(scope: string | undefined): Set<string> {
  if (!scope) return new Set();
  return new Set(scope.split(/\s+/).filter((item) => (KNOWN_SCOPES as readonly string[]).includes(item)));
}

export function scopeAllowsTool(scope: string | undefined, risk: ToolDescriptor["risk"] | undefined): boolean {
  if (!risk) return false;
  if (risk === "restricted") return false;
  const scopes = parseOAuthScope(scope);
  if (scopes.size === 0) return false;
  if (risk === "read-only") return scopes.has("read:tools") || scopes.has("call:tools");
  return scopes.has("call:tools");
}

/** Descriptor for a (possibly adapted) tool name, or undefined if unknown. */
function descriptorForTool(name: string): ToolDescriptor | undefined {
  if (name === "tools.discover") return getDiscoverToolDescriptor();
  if (name === "tools.batch") return getBatchToolDescriptor();
  return ALL_TOOL_DESCRIPTORS.find((tool) => tool.name === name);
}

/** Granular risk by tool name, from the full registry (not the unified surface). */
const GRANULAR_RISK = new Map(FULL_TOOL_SCHEMAS.map((tool) => [tool.name, tool.risk]));

/**
 * Per-action scope resolution, from the shared action-risk table
 * (extension/libs/tool-contracts/action-risk.ts, Tool Management Phase 1
 * section A), synced into cloudflare/libs by scripts/sync-tool-contracts.mjs.
 * It carries NO risk of its own: risk always comes from the granular
 * registry entry (GRANULAR_RISK above), never from the table.
 *
 * Returns null for granular tools, tasks tools, multi-target tools
 * (observe, act — they fan out to several granular tools, so no single
 * granular risk applies), delay waits (handled locally, no granular
 * tool — they keep pre-resolution behaviour, see gap note in the
 * Phase 1 report), and anything unrecognised. A null result falls back
 * to the unified descriptor's own risk, which is the pre-resolution
 * behaviour and can only deny, never widen, a call.
 * Local: sentinels in the table are also treated as unresolvable here,
 * for the same reason: denying a previously working delay wait via scope
 * would be a policy change, not a canonicalisation fix.
 */
export interface UnifiedScopeResolution {
  /** Granular tool the call will actually execute. */
  granular: string;
  /** Unified tool name as called, kept for error messages only. */
  calledAs: string;
  /** Action/phase string that selected the granular tool. */
  action: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Tab actions in navigate's handler (checked before window/sync). */
const NAVIGATE_TAB_ACTIONS = new Set([
  "list", "get", "active", "create", "close", "activate", "switch",
  "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup",
  "save_session", "restore_session", "organize",
]);

/** Actions the navigate handler's window branch owns. Under an explicit
 * category=window these beat the tab branch (mirrors the handler's guard
 * in extension/libs/browser-engine/tools/unified.ts); without it, window
 * list/create/close would resolve to tabs.* for scope, matching the old
 * handler bug that returned tabs instead of WindowInfo shapes. */
const NAVIGATE_WINDOW_ACTIONS = new Set(["list", "create", "update", "close"]);

function entryToResolution(entry: { granularTool: string }, calledAs: string, action: string): UnifiedScopeResolution | null {
  if (entry.granularTool.startsWith("local:")) return null;
  return { granular: entry.granularTool, calledAs, action };
}

function resolveNavigate(d: Record<string, unknown>): UnifiedScopeResolution | null {
  const action = asString(d.action);
  const category = asString(d.category);
  const forValue = asString(d.for);
  // Handler order: tab, then window, then sync, then URL actions — except
  // that window-branch actions under category=window go to the window
  // branch (see NAVIGATE_WINDOW_ACTIONS above).
  if (action !== undefined && (category === "tab" || NAVIGATE_TAB_ACTIONS.has(action)) && !(category === "window" && NAVIGATE_WINDOW_ACTIONS.has(action))) {
    const entry = resolveUnifiedAction("navigate", action, "tab") ?? resolveUnifiedAction("navigate", action);
    return entry ? entryToResolution(entry, "navigate", action) : null;
  }
  if (category === "window" || action === "update") {
    if (action === undefined) return null;
    const entry = resolveUnifiedAction("navigate", action, "window") ?? resolveUnifiedAction("navigate", action);
    return entry ? entryToResolution(entry, "navigate", action) : null;
  }
  if (category === "sync" || forValue !== undefined) {
    // networkIdle is accepted by the navigate/wait schemas as an alias for
    // network_idle; scope resolution must use the canonical spelling or
    // it falls back to the unified (reversible) risk and wrongly denies
    // a read-only sync wait to read:tools clients.
    const canonicalFor = forValue === "networkIdle" ? "network_idle" : forValue;
    const domain = `sync:${canonicalFor ?? "navigation"}`;
    const entry = resolveUnifiedAction("navigate", "wait", domain);
    return entry ? entryToResolution(entry, "navigate", "wait") : null;
  }
  if (action === undefined) return null;
  const entry = resolveUnifiedAction("navigate", action, category === "url" ? "url" : undefined)
    ?? resolveUnifiedAction("navigate", action);
  return entry ? entryToResolution(entry, "navigate", action) : null;
}

export function resolveUnifiedToolForScope(name: string, input: unknown): UnifiedScopeResolution | null {
  const d = asRecord(input);
  switch (name) {
    case "browser":
    case "tabs":
    case "windows":
    case "devtools":
    case "clipboard":
    case "files":
    case "submit": {
      const action = asString(d.action);
      if (action === undefined) return null;
      const entry = resolveUnifiedAction(name, action);
      return entry ? entryToResolution(entry, name, action) : null;
    }
    case "navigate":
      return resolveNavigate(d);
    case "form": {
      const phase = asString(d.phase) ?? asString(d.action);
      if (phase === undefined) return null;
      const entry = resolveUnifiedAction("form", phase);
      return entry ? entryToResolution(entry, name, phase) : null;
    }
    case "data": {
      const domain = asString(d.domain) ?? asString(d.store);
      const action = asString(d.action);
      if (domain === undefined || action === undefined) return null;
      const entry = resolveUnifiedAction("data", action, domain);
      return entry ? entryToResolution(entry, name, action) : null;
    }
    case "wait": {
      const forValue = asString(d.for);
      if (forValue === undefined) return null;
      const entry = resolveUnifiedAction("wait", forValue);
      return entry ? entryToResolution(entry, name, forValue) : null;
    }
    default:
      // Granular tools, tasks tools, observe, and act have no single
      // granular target: scope is checked against their own descriptor.
      return null;
  }
}

function assertScopeAllows(scope: string | undefined, name: string, input?: Record<string, unknown>): void {
  // Phase 1 canonicalisation: when a unified call resolves to one granular
  // tool, scope is checked against the GRANULAR risk, not the unified
  // risk. A read:tools client may therefore call tabs.list via the unified
  // tool (read-only action) and is denied tabs.close via the same tool
  // (reversible action). The denial names the granular tool and the
  // action, so the client learns the precise name for next time.
  if (input !== undefined) {
    const resolved = resolveUnifiedToolForScope(name, input);
    if (resolved) {
      const risk = GRANULAR_RISK.get(resolved.granular);
      if (!risk || !scopeAllowsTool(scope, risk)) {
        throw new ToolErrorException(
          "PERMISSION_DENIED",
          `OAuth scope does not permit ${resolved.granular} via ${resolved.calledAs} action ${resolved.action}`,
          { details: { tool: resolved.granular, calledAs: resolved.calledAs, action: resolved.action, risk: risk ?? "unknown" } },
        );
      }
      return;
    }
  }
  const descriptor = descriptorForTool(name);
  if (!descriptor || !scopeAllowsTool(scope, descriptor.risk)) {
    throw new ToolErrorException(
      "PERMISSION_DENIED",
      `OAuth scope does not permit calling "${name}"`,
      { details: { tool: name, risk: descriptor?.risk ?? "unknown" } },
    );
  }
}

/**
 * Confirmation flags in tool input are never approval. Strip them before
 * forwarding so neither the gateway nor the extension can mistake a
 * client-asserted flag for a user decision (see runWithApproval).
 */
export function stripConfirmationFlags(input: Record<string, unknown>): Record<string, unknown> {
  const { confirmed: _confirmed, userApproved: _userApproved, approved: _approved, ...rest } = input;
  return rest;
}

function shouldShowAllTools(env?: { MCP_SHOW_ALL_TOOLS?: string }): boolean {
  const flag = env?.MCP_SHOW_ALL_TOOLS;
  if (!flag) return false;
  const normalized = flag.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Full-registry descriptors for discovery: unified + granular + tasks (136). */
export const SEARCH_DESCRIPTORS: ToolDescriptor[] = FULL_TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool));

/**
 * Discovery-time scope filter (shared by tools.discover and by the
 * session-aware ListTools append). A unified tool is discoverable when
 * ANY dispatched action is in scope (e.g. a read:tools client may
 * discover tabs for list, even though tabs as a whole is reversible).
 * Call-time per-action scope still gates the actual call.
 */
export function discoveryAllowed(descriptor: ToolDescriptor, scope: string | undefined): boolean {
  if (!scope) return true;
  if (scopeAllowsTool(scope, descriptor.risk)) return true;
  return UNIFIED_ACTION_RISK.some(
    (entry) => entry.unifiedTool === descriptor.name && scopeAllowsTool(scope, entry.risk),
  );
}

/** Registry-generated tool-selection text, appended to the hand-written instructions. */
export const GENERATED_TOOL_SELECTION = generateToolSelectionInstructions(SEARCH_DESCRIPTORS);

/**
 * Phase A agent modes (OpenCode-style, adapted to Muze's control points).
 * A mode is a tool-visibility set + a prompt layer, recorded per MCP
 * session. Visibility is NOT security: scope and dashboard policy still
 * gate every call, and modeAllowsCall() below refuses hidden tools at
 * CallTool time with PERMISSION_DENIED as well. Default is "act", which
 * is exactly the pre-Phase-A behaviour, so existing clients do not break
 * by merely upgrading. Modes are how-only: no mode prompt contains a
 * procedure for any site or task.
 */
export type AgentMode = "read" | "act" | "plan" | "explore" | "summary" | "compaction";
export const AGENT_MODES: AgentMode[] = ["read", "act", "plan", "explore", "summary", "compaction"];

export function parseAgentMode(value: unknown): AgentMode | undefined {
  return typeof value === "string" && (AGENT_MODES as string[]).includes(value) ? (value as AgentMode) : undefined;
}

export const MODE_PROMPTS: Record<AgentMode, string> = {
  read: "Read mode: ground first, batch independent reads, and never act. You see read-only tools only. A tool you cannot see is not available in this mode — it is not merely discouraged.",
  act: "Act mode: verify after every consequential step, work the fallback ladder, never re-resolve a stale ref, and be aware that a step may need a compensation if a later step fails.",
  plan: "Plan mode: explore, ground, and propose ordered steps with bounds and verify conditions — never execute. Approving a plan does not execute it; execution requires resuming in act mode.",
  explore: "Explore mode (read-only child): make bounded reads and return only the requested summary shape. You see read-only tools only and you cannot create child tasks.",
  summary: "Internal summary mode: you have no browser tools. Condense only the task record you were given — what was done, what is in progress, what is next, and the key constraints and decisions.",
  compaction: "Internal compaction mode: you have no browser tools. Operate only on stored task records, protect the newest tail and instruction-bearing records, and act only above the reclaim threshold.",
};

/** Tool-level visibility for a mode, over registry descriptors. */
export function isModeVisibleTool(mode: AgentMode, descriptor: ToolDescriptor): boolean {
  if (mode === "summary" || mode === "compaction") return false;
  if (mode === "act") return true;
  if (mode === "plan") {
    if (descriptor.name === "tasks.create" || descriptor.name === "tasks.approvePlan") return true;
  }
  // read / explore / plan (base): read-only descriptors, plus the two
  // meta tools that are themselves read-only (discovery, batching reads).
  // Unified tools with mixed actions (navigate, form, data, act) carry a
  // non-read-only descriptor risk, so they are excluded as whole tools
  // here; their read-only actions remain reachable as granular tools
  // (e.g. tabs.list) via discovery, where each action is risk-checked.
  return descriptor.risk === "read-only" || descriptor.name === "tools.discover" || descriptor.name === "tools.batch";
}

export function filterDescriptorsByMode(descriptors: ToolDescriptor[], mode: AgentMode): ToolDescriptor[] {
  return descriptors.filter((d) => isModeVisibleTool(mode, d));
}

/**
 * Call-time mode backstop (visibility is not security, and scope/policy
 * still run after this). Returns false when the call is not allowed in
 * the mode. tools.batch is checked per item: every item tool must itself
 * be mode-visible, otherwise the whole batch is refused.
 */
export function modeAllowsCall(mode: AgentMode, name: string, input?: Record<string, unknown>): boolean {
  if (mode === "act") return true;
  if (mode === "summary" || mode === "compaction") return false;
  if (name === "tools.batch") {
    const calls = input && Array.isArray((input as Record<string, unknown>).calls)
      ? ((input as Record<string, unknown>).calls as Array<Record<string, unknown>>)
      : null;
    if (!calls) return true; // malformed input is rejected later as INVALID_INPUT
    return calls.every((item) => {
      const toolName = typeof item?.tool === "string" ? item.tool : "";
      if (!toolName) return false;
      const descriptor = descriptorForTool(toolName);
      if (!descriptor) return false;
      return isModeVisibleTool(mode, descriptor);
    });
  }
  if (mode === "plan" && name === "tasks.create") {
    // Plan mode may only preview a plan; execution is an act-mode call.
    return (input as Record<string, unknown> | undefined)?.dryRun === true;
  }
  const descriptor = descriptorForTool(name);
  if (!descriptor) return false;
  return isModeVisibleTool(mode, descriptor);
}

export interface LayeredEnvironment {
  browserConnected: boolean;
  clientType: string;
  scopePresent: boolean;
  discoveredCount: number;
}

/**
 * Phase A layered instruction assembler, in OpenCode's order adapted to
 * Muze: Layer 1 base (how, not what) + Layer 2 mode + Layer 3 tool
 * guidance for the mode's visible tools only + Layer 4 environment
 * snapshot + Layer 5 session entries (discovered tools).
 *
 * Layer 4 honesty note: the gateway has no bridge query for the active
 * tab, its URL/domain, the dashboard policy mode, or task counts in
 * Phase A (adding one would be extension work, which Phase A excludes),
 * so those fields are explicitly NOT claimed here. Tab state is always
 * obtained via observe, never assumed from initialize text.
 */
export function buildLayeredInstructions(input: {
  mode: AgentMode;
  visibleDescriptors: ToolDescriptor[];
  environment: LayeredEnvironment;
  discovered: string[];
}): string {
  const layers = [
    MCP_INSTRUCTIONS,
    `## MODE: ${input.mode}\n${MODE_PROMPTS[input.mode]}`,
    generateToolSelectionInstructions(input.visibleDescriptors),
    [
      "## ENVIRONMENT SNAPSHOT (gateway, at initialize; re-observe before acting)",
      `- Mode: ${input.mode}`,
      `- Browser connected: ${input.environment.browserConnected ? "yes" : "no"}`,
      `- Client type: ${input.environment.clientType}`,
      `- OAuth scope: ${input.environment.scopePresent ? "present" : "absent"} (value never shown)`,
      `- Discovered tools this session: ${input.environment.discoveredCount}`,
      "- Active tab, URL, domain, dashboard policy mode, and task counts are NOT in this snapshot: the gateway has no bridge query for them in Phase A, so obtain tab state via observe and never assume it.",
    ].join("\n"),
    [
      "## SESSION ENTRIES",
      input.discovered.length
        ? `- Discovered tools this session: ${input.discovered.join(", ")}`
        : "- Discovered tools this session: (none yet)",
    ].join("\n"),
  ];
  return layers.join("\n\n");
}


/**
 * Phase D surface discipline: deterministic per-mode initialize-payload
 * measurement. Every mode is assembled through the same Phase A layered
 * assembler with a fixed environment (no browser, unknown client, scope
 * present, no discovered tools), so the numbers are reproducible without
 * a live gateway call and depend only on the mode's prompt layer and its
 * visible-tool guidance. `old` is the pre-Phase-A two-string assembly
 * (base instructions + full-registry tool selection) for comparison.
 * Sizes are in characters of the assembled initialize text.
 */
export type InitializePayloadSizes = Record<AgentMode | "old", number>;
export function measureInitializePayloads(): InitializePayloadSizes {
  const environment: LayeredEnvironment = {
    browserConnected: false,
    clientType: "unknown",
    scopePresent: true,
    discoveredCount: 0,
  };
  const sizes = {} as InitializePayloadSizes;
  for (const mode of AGENT_MODES) {
    sizes[mode] = buildLayeredInstructions({
      mode,
      visibleDescriptors: filterDescriptorsByMode(SEARCH_DESCRIPTORS, mode),
      environment,
      discovered: [],
    }).length;
  }
  sizes.old = `${MCP_INSTRUCTIONS}\n\n${GENERATED_TOOL_SELECTION}`.length;
  return sizes;
}

/**
 * Discovery v2 (Phase 2): tag/category/verb/description scoring over the
 * FULL registry (not just the unified surface), permission/scope filtered
 * FIRST, grouped, up to 20 results, full schema for the top 5 only.
 * The caller adds returned names to the session's discovered set, so
 * session-aware ListTools can serve their full schemas later.
 */
export function searchTools(
  query: string,
  limit: number,
  options: { scope?: string; taskType?: string; health?: Record<string, { timeoutRate: number; errorRate: number }>; mode?: AgentMode } = {},
): Array<Record<string, unknown>> {
  // Phase A: mode filter first, then scope — a mode-hidden tool is never
  // scored or returned, whatever the OAuth scope would allow.
  const allowed = (descriptor: ToolDescriptor): boolean => {
    if (options.mode && !isModeVisibleTool(options.mode, descriptor)) return false;
    if (options.scope) return discoveryAllowed(descriptor, options.scope);
    return true;
  };
  const { results, grouped, totalAvailable } = discoverTools(SEARCH_DESCRIPTORS, query, {
    limit,
    allowed,
    taskType: options.taskType,
    health: options.health,
  });
  void totalAvailable;
  void grouped;
  return results.map((result) => {
    const descriptor = SEARCH_DESCRIPTORS.find((d) => d.name === result.name);
    return {
      name: result.name,
      title: result.title,
      description: result.description,
      category: result.category,
      risk: result.risk,
      requiresApproval: result.requiresApproval,
      tags: result.tags,
      ...(result.matchedAction ? { matchedAction: result.matchedAction } : {}),
      ...(result.matchedActionRisk ? { matchedActionRisk: result.matchedActionRisk } : {}),
      ...(result.matchedActionApproval !== undefined ? { matchedActionApproval: result.matchedActionApproval } : {}),
      ...(result.inputSchema !== undefined ? { inputSchema: result.inputSchema } : {}),
      ...(result.inputSchemaPointer ? { inputSchemaPointer: result.inputSchemaPointer } : {}),
      group: result.group,
      related: result.related,
      prerequisites: result.prerequisites,
      ...(result.deprecatedWarning ? { deprecatedWarning: result.deprecatedWarning, useInstead: result.useInstead } : {}),
      ...(result.suggestion ? { suggestion: result.suggestion, suggestionReason: result.suggestionReason } : {}),
      annotations: descriptor?.annotations,
    };
  });
}

/**
 * Gateway-native browser-routing tools. These are NOT registry tools and
 * NOT extension tools: they never reach the bridge, they act only on the
 * caller's own account (via DirectoryDO), and they are therefore not
 * gated by the extension's permission level — only by OAuth scope and
 * agent mode. No registry bump and no version bump: the same precedent
 * as the gateway-native handling of tools.discover/tools.batch.
 *
 * Honest limit, stated in the select result: selection rebinds the
 * client's tokens, so it moves FUTURE MCP transports to the new browser.
 * The live transport that called select still talks to the old browser
 * until the client re-initializes there.
 */
export interface BrowsersHandler {
  list: () => Promise<{
    browsers: Array<Record<string, unknown>>;
    defaultSessionId: string;
    currentSessionId: string;
  }>;
  select: (sessionId: string) => Promise<{ sessionId: string; name: string }>;
}

export const BROWSER_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "browsers.list",
    title: "List browsers",
    description:
      "List the browsers attached to your account (name, browser/OS/version, created and last-seen dates, default marker). No device tokens are ever returned. Use browsers.select to move this client's future calls to another browser; the live transport keeps talking to its current browser until it re-initializes.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List browsers", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    category: "system",
    risk: "read-only",
    requiresApproval: false,
    outputSchema: {},
  } as unknown as ToolDescriptor,
  {
    name: "browsers.select",
    title: "Select browser",
    description:
      "Move this OAuth client's future MCP calls to another browser of the same account, persisted across reconnects (the client's tokens are rebound to the target browser). The target must belong to the same account. The live transport that calls this still talks to the previous browser until the client re-initializes; dashboard default selection is respected for clients that never select.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser session id from browsers.list (never a device token)." },
      },
      required: ["sessionId"],
    },
    annotations: { title: "Select browser", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    category: "system",
    risk: "reversible",
    requiresApproval: false,
    outputSchema: {},
  } as unknown as ToolDescriptor,
];

/** Mode visibility for the gateway-native browsers tools. */
export function isBrowsersToolVisible(mode: AgentMode, name: string): boolean {
  if (mode === "summary" || mode === "compaction") return false;
  if (name === "browsers.list") return true;
  if (name === "browsers.select") return mode === "act" || mode === "plan" || mode === "explore";
  return false;
}

function getDiscoverToolDescriptor(): ToolDescriptor {
  const descriptor = ALL_TOOL_DESCRIPTORS.find((tool) => tool.name === "tools.discover");
  if (descriptor) return descriptor;

  const fallback = {
    name: "tools.discover",
    title: "Discover tools",
    description:
      "Find tools by intent: scored by exact name, then tag, category, action verb, then description; filtered by your OAuth scope so you never see a tool you cannot call. Returns up to 20 grouped results with full schemas for the top 5 only; discovered tools persist in this session's ListTools. Deprecated actions (navigate tab/window, data devtools/clipboard) are returned only on exact name match, with a use-instead warning.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need to do, e.g. 'organise tabs', 'read clipboard', 'fill a form', 'collect links', 'take a screenshot'.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of results to return (default 6, max 20).",
        },
        taskType: {
          type: "string",
          enum: ["research", "form", "organise"],
          description: "Optional task type for suggestions only (never a restriction): research, form, or organise.",
        },
      },
      required: ["query"],
    },
    annotations: {
      title: "Discover tools",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    category: "workflows",
    risk: "read-only",
    requiresApproval: false,
    outputSchema: {},
  };
  return fallback as unknown as ToolDescriptor;
}

function getBatchToolDescriptor(): ToolDescriptor {
  const fallback = {
    name: "tools.batch",
    title: "Batch read-only calls",
    description:
      "Run up to 8 independent read-only tools in one bridge round trip. Use it for tab/page ground reads (for example tabs.active plus page.snapshot) instead of chaining calls. Non-read-only calls are refused by the extension.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Exact read-only tool name" },
              input: { type: "object", description: "Arguments for that tool" },
            },
            required: ["tool", "input"],
          },
        },
      },
      required: ["calls"],
    },
    annotations: {
      title: "Batch read-only calls",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    category: "workflows",
    risk: "read-only",
    requiresApproval: false,
    outputSchema: {},
  };
  return fallback as unknown as ToolDescriptor;
}

/**
 * Tasks-first ordering for the ListTools response: the tasks.* family
 * comes first with tasks.create first, everything else keeps its current
 * relative order, and the set is unchanged. Pure reorder — it never adds,
 * removes, or renames a tool. Applied AFTER the ListTools cap slice so the
 * capped set is identical and only the order changes.
 */
export function orderToolsTasksFirst<T extends { name: string }>(tools: T[]): T[] {
  const head: T[] = [];
  const tail: T[] = [];
  for (const tool of tools) {
    if (tool.name === "tasks.create") head.unshift(tool);
    else if (tool.name.startsWith("tasks.")) head.push(tool);
    else tail.push(tool);
  }
  return [...head, ...tail];
}

function filterToCoreTools(tools: ToolDescriptor[], showAll: boolean): ToolDescriptor[] {
  const withBatch = (list: ToolDescriptor[]): ToolDescriptor[] =>
    list.some((tool) => tool.name === "tools.batch") ? list : list.concat([getBatchToolDescriptor()]);
  if (showAll) return withBatch(tools);
  if (tools.length === 0) return tools;
  const filtered = tools.filter((tool) => isCoreTool(tool.name));
  const withDiscover = filtered.some((tool) => tool.name === "tools.discover")
    ? filtered
    : filtered.concat([getDiscoverToolDescriptor()]);
  return withBatch(withDiscover);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recoveryHint(code: string): string | undefined {
  switch (code) {
    case "STALE_ELEMENT":
      return "Call observe({ include: ['a11y', 'text'] }) to obtain fresh element refs, then retry.";
    case "TIMEOUT":
      return "Wait for page network idle with navigate({ category: 'sync', for: 'network_idle' }), or increase timeoutMs.";
    case "NOT_FOUND":
      return "Call observe or navigate({ category: 'tab', action: 'active' }) to re-ground page state, then retry.";
    case "RATE_LIMITED":
      return "Retry after retryAfterMs.";
    case "CONFLICT":
      return "Open Muze AI, sign in, and reconnect the gateway.";
    case "APPROVAL_REQUIRED":
      return "This action requires user approval. Ask the user in chat (elicitation) or wait for a dashboard decision, then re-call this tool with no confirmation flag; the gateway will re-request approval. A 'confirmed' flag in input is stripped and never counts as approval.";
    case "APPROVAL_DENIED":
      return "The user declined this operation.";
    default:
      return undefined;
  }
}

/** Translate legacy fine-grained tool names into the unified toolset so older AI callers continue working. */
function adaptLegacyToolCall(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const norm = TOOL_ALIASES[name] ?? name;
  switch (norm) {
    case "page.snapshot":
      return {
        name: "observe",
        input: {
          include: ["metadata", "text", "a11y"],
          tabId: input.tabId,
          frameId: input.frameId,
          includeScreenshot: Boolean(input.includeScreenshot),
          ...(typeof input.maxNodes === "number" ? { maxNodes: input.maxNodes } : {}),
          ...(typeof input.maxDepth === "number" ? { maxDepth: input.maxDepth } : {}),
        },
      };
    case "page.read":
      return {
        name: "observe",
        input: {
          include: ["text"],
          tabId: input.tabId,
          frameId: input.frameId,
          ...(typeof input.maxChars === "number" ? { maxChars: input.maxChars } : {}),
        },
      };
    case "page.extract":
      return {
        name: "observe",
        input: {
          include: ["text"],
          tabId: input.tabId,
          frameId: input.frameId,
        },
      };
    case "page.metadata":
      return { name: "observe", input: { include: ["metadata"], tabId: input.tabId, frameId: input.frameId } };
    case "page.outline":
      return { name: "observe", input: { include: ["outline"], maxDepth: input.maxDepth, tabId: input.tabId, frameId: input.frameId } };
    case "page.links":
      return { name: "observe", input: { include: ["links"], limit: input.limit, sameOriginOnly: input.sameOriginOnly, tabId: input.tabId, frameId: input.frameId } };
    case "page.tables":
      return { name: "observe", input: { include: ["tables"], maxRows: input.maxRows, tabId: input.tabId, frameId: input.frameId } };
    case "page.accessibilityTree":
      return { name: "observe", input: { include: ["a11y"], maxNodes: input.maxNodes, maxDepth: input.maxDepth, interactiveOnly: input.interactiveOnly, tabId: input.tabId, frameId: input.frameId } };
    case "dom.find":
      return {
        name: "observe",
        input: {
          include: ["find"],
          by: input.by ?? "text",
          value: input.value ?? input.selector ?? "",
          role: input.role,
          name: input.name,
          limit: input.limit,
          tabId: input.tabId,
          frameId: input.frameId,
        },
      };
    case "page.find":
      return { name: "observe", input: { include: ["find"], query: input.query, limit: input.limit, tabId: input.tabId, frameId: input.frameId } };
    case "dom.click":
      return {
        name: "act",
        input: {
          tabId: input.tabId,
          frameId: input.frameId,
          steps: [{ do: "click", target: { ref: String(input.ref ?? "") } }],
        },
      };
    case "dom.clickAt":
      return {
        name: "act",
        input: {
          tabId: input.tabId,
          frameId: input.frameId,
          steps: [{ do: "click", target: { x: Number(input.x), y: Number(input.y), space: input.coordinateSpace === "screenshot" ? "screenshot" : "viewport" } }],
        },
      };
    case "dom.hover":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "hover", target: { ref: String(input.ref ?? "") } }] } };
    case "dom.focus":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "focus", target: { ref: String(input.ref ?? "") } }] } };
    case "dom.scroll":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "scroll", target: input.ref ? { ref: String(input.ref) } : { x: 0, y: 0 }, x: Number(input.x ?? 0), y: Number(input.y ?? 0) }] } };
    case "dom.type":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "type", target: { ref: String(input.ref ?? "") }, text: String(input.text ?? "") }] } };
    case "dom.fill":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "fill", target: { ref: String(input.ref ?? "") }, value: String(input.value ?? "") }] } };
    case "dom.clear":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "clear", target: { ref: String(input.ref ?? "") } }] } };
    case "dom.select":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "select", target: { ref: String(input.ref ?? "") }, value: String(input.value ?? ""), ...(typeof input.label === "string" && input.label !== "" ? { label: input.label } : {}) }] } };
    case "dom.setChecked":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "check", target: { ref: String(input.ref ?? "") }, checked: Boolean(input.checked) }] } };
    case "dom.press":
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "press", target: { ref: String(input.ref ?? "") }, key: String(input.key ?? ""), modifiers: input.modifiers as any }] } };
    case "tabs.active":
      return { name: "navigate", input: { category: "tab", action: "active" } };
    case "tabs.list":
      return { name: "navigate", input: { category: "tab", action: "list" } };
    case "tabs.get":
      return { name: "navigate", input: { category: "tab", action: "get", tabId: input.tabId } };
    case "tabs.create":
      return { name: "navigate", input: { category: "tab", action: "create", url: input.url, pinned: input.pinned, groupId: input.groupId, active: input.active } };
    case "tabs.close":
      return { name: "navigate", input: { category: "tab", action: "close", tabId: input.tabId } };
    case "tabs.activate":
      return { name: "navigate", input: { category: "tab", action: "activate", tabId: input.tabId } };
    case "tabs":
      return { name: "navigate", input: { category: "tab", ...input } };
    case "tabs.navigate":
    case "navigation.open":
      // Omit tabId when the caller gave none: the extension's navigate
      // handler used to forward the always-present (possibly undefined)
      // key into navigation.open's strict schema, which rejects it with
      // "Unrecognized key: tabId". A real tabId is kept — the handler
      // routes an open with a tabId to tabs.navigate.
      return { name: "navigate", input: { action: "open", url: input.url, ...(typeof input.tabId === "number" ? { tabId: input.tabId } : {}), reuseActiveTab: input.reuseActiveTab, active: input.active } };
    case "navigation.back":
      return { name: "navigate", input: { action: "back", tabId: input.tabId } };
    case "navigation.forward":
      return { name: "navigate", input: { action: "forward", tabId: input.tabId } };
    case "navigation.reload":
      return { name: "navigate", input: { action: "reload", tabId: input.tabId, bypassCache: input.bypassCache } };
    case "navigation.search":
      return { name: "navigate", input: { action: "search", query: input.query, provider: input.provider, newTab: input.newTab } };
    case "navigation.wait":
      return { name: "navigate", input: { category: "sync", for: "navigation", timeoutMs: input.timeoutMs, waitForNetworkIdle: input.waitForNetworkIdle, quietMs: input.quietMs, tabId: input.tabId } };
    case "page.waitFor":
      return { name: "navigate", input: { category: "sync", for: "element", by: input.by, selector: input.selector, value: input.value, role: input.role, name: input.name, timeoutMs: input.timeoutMs, tabId: input.tabId, frameId: input.frameId } };
    case "page.networkIdle":
      return { name: "navigate", input: { category: "sync", for: "network_idle", quietMs: input.quietMs, timeoutMs: input.timeoutMs, tabId: input.tabId, frameId: input.frameId } };
    case "wait": {
      // Canonical spelling is network_idle; accept the camelCase alias
      // clients actually send (the retest's for="networkIdle" was rejected
      // by both the wait and navigate schemas). Normalised here so the
      // extension schemas only need the canonical value.
      const out = { ...input };
      if (out.for === "networkIdle") out.for = "network_idle";
      return { name: "navigate", input: { category: "sync", ...out } };
    }
    case "form": {
      // Legacy field aliases for the unified form tool: values -> fields,
      // formId -> formRef, and field entries {name, value} -> {ref, value}.
      // Anything else is left untouched so the extension's strict schema
      // still rejects genuinely unknown keys with a clear error.
      const out: Record<string, unknown> = { ...input };
      if (out.values !== undefined && out.fields === undefined) out.fields = out.values;
      if (out.formId !== undefined && out.formRef === undefined) out.formRef = out.formId;
      if (Array.isArray(out.fields)) {
        out.fields = out.fields.map((field) => {
          if (field && typeof field === "object" && !Array.isArray(field)) {
            const f = field as Record<string, unknown>;
            if (typeof f.ref !== "string" && typeof f.name === "string") return { ...f, ref: f.name };
          }
          return field;
        });
      }
      return { name: "form", input: out };
    }
    case "forms.inspect":
      return { name: "form", input: { phase: "inspect", tabId: input.tabId, frameId: input.frameId } };
    case "forms.preview":
      return { name: "form", input: { phase: "preview", ref: input.ref, tabId: input.tabId, frameId: input.frameId } };
    case "forms.fill":
      return { name: "form", input: { phase: "fill", fields: input.fields, tabId: input.tabId, frameId: input.frameId } };
    case "forms.submit":
    case "dom.submit":
      return { name: "form", input: { phase: "submit", formRef: input.formRef ?? input.ref, expectedAction: input.expectedAction, tabId: input.tabId, frameId: input.frameId } };
    case "forms.upload":
      return { name: "form", input: { phase: "upload", ref: input.ref, files: input.files, tabId: input.tabId, frameId: input.frameId } };
    case "forms.setFile":
      // Do NOT fold ref into selector: a ref is an opaque registry id,
      // not a CSS selector, and the granular handler resolves refs
      // through the page agent while selectors go to querySelector.
      // Folding made ref-only calls fail STALE_ELEMENT downstream.
      return { name: "form", input: { phase: "set_file", ref: input.ref, selector: typeof input.selector === "string" ? input.selector : undefined, fileId: input.fileId, files: input.files, tabId: input.tabId, frameId: input.frameId } };
    case "submit":
      return { name: "form", input: { phase: (input.action as any) ?? "submit", ...input } };
    case "history.search":
      return { name: "data", input: { domain: "history", action: "search", query: input.text ?? input.query, limit: input.maxResults } };
    case "history.delete":
      return { name: "data", input: { domain: "history", action: "delete", urls: input.urls } };
    case "bookmarks.search":
      return { name: "data", input: { domain: "bookmarks", action: "search", query: input.query, limit: input.limit } };
    case "bookmarks.list":
      return { name: "data", input: { domain: "bookmarks", action: "list", folderId: input.folderId, limit: input.limit } };
    case "bookmarks.delete":
      return { name: "data", input: { domain: "bookmarks", action: "delete", id: input.id } };
    case "downloads.list":
      return { name: "data", input: { domain: "downloads", action: "list", limit: input.limit, query: input.query } };
    case "downloads.erase":
      return { name: "data", input: { domain: "downloads", action: "erase", ids: input.ids } };
    case "windows.list":
      return { name: "navigate", input: { category: "window", action: "list" } };
    case "windows.create":
      return { name: "navigate", input: { category: "window", action: "create", url: input.url, incognito: input.incognito } };
    case "windows.close":
      return { name: "navigate", input: { category: "window", action: "close", windowId: input.windowId } };
    case "windows":
      return { name: "navigate", input: { category: "window", ...input } };
    // browser.* and the unified "browser" tool are forwarded under their
    // own names (the old mapping sent them to data/navigation.search,
    // whose schemas reject browser action fields, so every browser call
    // failed validation). The extension registers both the granular
    // browser.* tools and the unified browser handler, which dispatches
    // status/capabilities/permissions/diagnostics/search to those
    // granular tools. Only legacy field aliases are normalised here;
    // scope is still checked against each tool's own registry descriptor
    // (see ALL_TOOL_DESCRIPTORS), so this routing change widens nothing.
    case "browser.search":
      return {
        name: "browser.search",
        input: {
          ...input,
          query: typeof input.query === "string" ? input.query : (typeof input.text === "string" ? input.text : ""),
          ...(typeof input.maxResults === "number" && typeof input.limit !== "number" ? { limit: input.maxResults } : {}),
        },
      };
    case "browser": {
      const out = { ...input };
      if (out.action === "search" && typeof out.query !== "string" && typeof out.text === "string") out.query = out.text;
      return { name: "browser", input: out };
    }
    case "devtools":
      return { name: "data", input: { domain: "devtools", ...input } };
    case "screenshots.visible":
      return { name: "observe", input: { include: ["screenshot"], includeScreenshot: true, screenshotFormat: input.format ?? "jpeg", screenshotQuality: input.quality ?? 60, tabId: input.tabId } };
    case "clipboard.read":
      return { name: "data", input: { domain: "clipboard", action: "read" } };
    case "clipboard.write":
      return { name: "data", input: { domain: "clipboard", action: "write", text: input.text } };
    case "clipboard":
      return { name: "data", input: { domain: "clipboard", ...input } };
    case "files.list":
      return { name: "data", input: { domain: "files", action: "list", limit: input.limit } };
    case "files.stat":
      return { name: "data", input: { domain: "files", action: "stat", id: input.id } };
    case "files":
      return { name: "data", input: { domain: "files", ...input } };
    case "workflows.summarizePage":
      return { name: "observe", input: { include: ["metadata", "text"], maxChars: input.maxChars, tabId: input.tabId } };
    default:
      return { name: norm, input };
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1] || "image/png", data: match[2] };
}

function extractImages(value: unknown, images: Array<{ mimeType: string; data: string }>): unknown {
  if (Array.isArray(value)) return value.map((item) => extractImages(item, images));
  if (!value || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  if (typeof rec.dataUrl === "string" && rec.dataUrl.startsWith("data:")) {
    const parsed = parseDataUrl(rec.dataUrl);
    if (parsed) {
      images.push(parsed);
      const { dataUrl: _dataUrl, ...rest } = rec;
      return { ...rest, screenshotIncluded: true, mimeType: parsed.mimeType };
    }
  }
  if (typeof rec.dataBase64 === "string" && typeof rec.mimeType === "string" && rec.mimeType.startsWith("image/")) {
    images.push({ mimeType: rec.mimeType, data: rec.dataBase64 });
    const { dataBase64: _dataBase64, ...rest } = rec;
    return { ...rest, screenshotIncluded: true };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) out[key] = extractImages(item, images);
  return out;
}

export function toMcpContent(result: unknown): Array<Record<string, unknown>> {
  const images: Array<{ mimeType: string; data: string }> = [];
  const stripped = extractImages(result, images);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: stringify(stripped) }];
  for (const image of images) {
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  return content;
}

/** Build the low-level MCP server backed by a browser bridge. */
/**
 * @param oauthScope Verified OAuth scope for this MCP client (forwarded by
 * the Worker from the access token). Missing scope denies every tool call;
 * see scopeAllowsTool. This is the 0.3.0 scope-enforcement plumbing.
 */
export interface GatewaySessionState {
  mode: AgentMode;
  discovered: string[];
}

export function createGatewayMcpServer(
  bridge: GatewayBridge,
  client?: ClientIdentity,
  env?: { MCP_SHOW_ALL_TOOLS?: string },
  oauthScope?: string,
  options?: {
    clientType?: string;
    initialMode?: AgentMode;
    initialDiscovered?: string[];
    /** Called whenever the mode or discovered set changes, so the caller
     * (SessionDO) can persist them. Best-effort: a failing callback must
     * never break a tool call. */
    onSessionStateChange?: (state: GatewaySessionState) => void;
    /** Gateway-native browsers.list/select handler (SessionDO supplies it
     * via DirectoryDO). Absent in unit-test servers without a directory. */
    browsers?: BrowsersHandler;
  },
): Server {
  // Client type is recorded ONLY if declared (session-do passes the
  // initialize clientInfo name through; an undeclared client is "unknown").
  // The cap itself is a documented Muze conservative cap (see
  // tool-meta.ts LISTTOOLS_CAPS), not a claimed vendor limit.
  const clientType = classifyClientType(options?.clientType ?? client?.name);
  const listToolsCap = listToolsCapForClientType(clientType);
  // Phase A session state. Default "act" is exactly the pre-Phase-A
  // behaviour. Mode changes (via the agent prompt, see GetPrompt below)
  // apply to this server instance immediately and to ListTools, discovery,
  // and CallTool from that point on.
  let sessionMode: AgentMode = options?.initialMode ?? "act";
  const visibleDescriptorsForInstructions = (): ToolDescriptor[] =>
    filterDescriptorsByMode(SEARCH_DESCRIPTORS, sessionMode);
  const layeredEnvironment = (): LayeredEnvironment => ({
    browserConnected: bridge.isConnected(),
    clientType,
    scopePresent: !!oauthScope,
    discoveredCount: discoveredTools.length,
  });
  // Discovered tools are declared here (before the Server is built) so
  // the construction-time instructions can already count them.
  const discoveredTools: string[] = [...(options?.initialDiscovered ?? [])];
  const emitSessionState = (): void => {
    try {
      options?.onSessionStateChange?.({ mode: sessionMode, discovered: [...discoveredTools] });
    } catch {
      // ignore: persistence is best-effort, never call-breaking
    }
  };
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, elicitation: {} } as any,
      // Phase A: layered assembly at construction time. The mode and
      // environment layers here are a construction-time snapshot; a mode
      // change after initialize is reflected in ListTools, discovery, and
      // CallTool immediately, and in the agent-prompt response, while the
      // SDK's initialize instructions text itself is static per server.
      instructions: buildLayeredInstructions({
        mode: sessionMode,
        visibleDescriptors: visibleDescriptorsForInstructions(),
        environment: {
          browserConnected: bridge.isConnected(),
          clientType,
          scopePresent: !!oauthScope,
          discoveredCount: discoveredTools.length,
        },
        discovered: [...discoveredTools],
      }),
      // The SDK defaults to Ajv, which compiles schemas with `new Function` and
      // is therefore rejected by the Workers runtime. The gateway sends its
      // elicitation through the protocol layer today, but the Workers-safe
      // validator keeps that true if the typed SDK helper is ever used.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  const showAllTools = shouldShowAllTools(env);

  // Short-lived cache of live extension tool descriptors, per MCP server
  // instance. If a live fetch fails, a fresh (<=5s) cached list is returned
  // instead of immediately advertising nothing on every ListTools call; on
  // cache miss + live failure, no tools are returned (fail closed).
  const LIVE_TOOL_CACHE_TTL_MS = 5_000;
  let liveToolsCache: { tools: ToolDescriptor[]; at: number } | null = null;

  // Session-aware discovery (Phase 2): tools this session discovered, and
  // tools a task plan needed, persist in THIS server instance's ListTools
  // until the session closes. This is a session cache only — it is cleared
  // when the session closes, it never changes permissions, and a tool only
  // appears if the current (extension-authoritative or static) list still
  // contains it. Bounded by the ListTools cap, core tools first.
  // Phase A: the set is also reported to onSessionStateChange so the
  // caller (SessionDO) can persist it across isolate restarts.
  const rememberDiscovered = (names: string[]): void => {
    let changed = false;
    for (const name of names) {
      if (!discoveredTools.includes(name)) {
        discoveredTools.push(name);
        changed = true;
      }
    }
    if (changed) emitSessionState();
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // The extension is the authority on what may run right now: its reply is
    // already filtered by the user's permission level. When no browser is
    // connected the static list is used so a client can still discover the
    // registry.
    let tools = listExposedDescriptors();
    if (bridge.isConnected()) {
      try {
        // The live list is authoritative even when it is empty: an empty list
        // means the user's current permission level allows nothing, and the
        // static registry must not leak past that.
        tools = await bridge.listTools();
        liveToolsCache = { tools, at: Date.now() };
      } catch {
        if (liveToolsCache && Date.now() - liveToolsCache.at <= LIVE_TOOL_CACHE_TTL_MS) {
          tools = liveToolsCache.tools;
        } else {
          // The browser went away between the check and the request: expose
          // nothing rather than the unfiltered static registry.
          tools = [];
        }
      }
    }
    // Phase A: mode filter applies to BOTH the live list and the static
    // fallback list, and to the core set below — a mode-denied tool is
    // excluded from ListTools, not just refused at execution. (The
    // extension's own list is already permission-filtered; the gateway
    // adds the mode layer on top of it.)
    const modeFilteredTools = filterDescriptorsByMode(tools, sessionMode);
    const coreTools = filterToCoreTools(modeFilteredTools, showAllTools);
    // Session-aware: append discovered / task-plan tools that are still in
    // the current list (extension authority preserved), then apply the
    // documented conservative ListTools cap (core first) unless show-all
    // was explicitly requested.
    let listed = coreTools;
    if (!showAllTools && discoveredTools.length > 0 && tools.length > 0) {
      // Fail closed: when the live list is empty (permission level allows
      // nothing), discovered tools must not leak past it — the tools.length
      // guard above is that gate. Otherwise a discovered granular tool is
      // served from the full registry descriptor; call-time policy and
      // scope in the extension still gate the actual call, so ListTools
      // here is an offer, not a permission.
      const byName = new Map(SEARCH_DESCRIPTORS.map((t) => [t.name, t]));
      const coreNames = new Set(coreTools.map((t) => t.name));
      for (const name of discoveredTools) {
        if (coreNames.has(name)) continue;
        const descriptor = byName.get(name);
        if (descriptor && isModeVisibleTool(sessionMode, descriptor) && discoveryAllowed(descriptor, oauthScope)) {
          listed = [...listed, descriptor];
          coreNames.add(name);
        }
      }
    }
    // Gateway-native browsers tools: appended after the extension list
    // (they never come from the bridge), gated by mode + scope only.
    // They are NOT subject to the extension permission level, because
    // they reveal no browser state and act on no browser — they only
    // route the caller's own future calls.
    for (const native of BROWSER_TOOL_DESCRIPTORS) {
      if (listed.some((tool) => tool.name === native.name)) continue;
      if (!isBrowsersToolVisible(sessionMode, native.name)) continue;
      if (!scopeAllowsTool(oauthScope, native.risk)) continue;
      listed = [...listed, native];
    }
    if (!showAllTools) listed = listed.slice(0, listToolsCap);
    // Tasks first: the tasks.* family leads the response with
    // tasks.create first; the capped set is unchanged, only the order.
    listed = orderToolsTasksFirst(listed);
    return {
      tools: listed.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description:
          tool.name === "navigate"
            ? `${tool.description} [Deprecated actions: navigate tab/window actions — use tabs.* / windows.* instead; still working in 2.x, removed in registry 3.0.]`
            : tool.name === "data"
              ? `${tool.description} [Deprecated domains: data devtools/clipboard — use devtools.* / clipboard.* instead; still working in 2.x, removed in registry 3.0.]`
              : tool.description,
        inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
        annotations: {
          title: tool.title,
          readOnlyHint: tool.annotations?.readOnlyHint ?? false,
          destructiveHint: tool.annotations?.destructiveHint ?? false,
          openWorldHint: tool.annotations?.openWorldHint ?? false,
        },
      })),
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "autonomous_browser_agent",
          description: "Autonomous browser execution prompt using the Observe-Reason-Act loop",
          arguments: [
            { name: "goal", description: "The specific objective to achieve in the browser", required: true },
            { name: "startUrl", description: "Starting URL to navigate to (optional)", required: false },
            { name: "mode", description: "Phase A agent mode for this MCP session: read, act, plan, explore, summary, or compaction. Selecting a mode filters ListTools, discovery, and calls for this session from that point on. Defaults to act (previous behaviour) when omitted.", required: false },
          ],
        },
        {
          name: "extract_structured_data",
          description: "Navigate, observe, and extract clean structured data from web pages",
          arguments: [
            { name: "url", description: "Target website URL", required: true },
            { name: "dataDescription", description: "Description of items/attributes to extract", required: true },
          ],
        },
        {
          name: "fill_and_submit_form",
          description: "Safely inspect, populate, and submit multi-field web forms",
          arguments: [
            { name: "formPurpose", description: "Purpose of the form submission", required: true },
            { name: "fields", description: "Key-value pairs or description of fields to populate", required: false },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === "autonomous_browser_agent") {
      // Phase A mode selection: fetching the generic agent prompt with a
      // mode argument records that mode for this MCP session. It does not
      // change any running task's mode, and it does not weaken scope or
      // policy. An invalid mode is rejected, never guessed.
      if (args.mode !== undefined) {
        const requested = parseAgentMode(args.mode);
        if (!requested) {
          throw new ToolErrorException("INVALID_INPUT", `Unknown agent mode "${String(args.mode)}". Valid modes: ${AGENT_MODES.join(", ")}.`);
        }
        if (requested !== sessionMode) {
          sessionMode = requested;
          emitSessionState();
          // Tell clients that re-list to pick up the new visibility set.
          // Best-effort: not all SDK versions expose this, and a client
          // that re-calls ListTools sees the new set regardless.
          try {
            const maybe = server as unknown as { sendToolListChanged?: () => Promise<void> };
            if (typeof maybe.sendToolListChanged === "function") void maybe.sendToolListChanged().catch(() => undefined);
          } catch {
            // ignore
          }
        }
      }
      const goal = args.goal ?? "Explore the active page";
      const startUrl = args.startUrl;
      return {
        description: "Generic agentic browser automation prompt: how to build and run your own task brief",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `# OBJECTIVE: ${goal}`,
                startUrl ? `Starting URL: ${startUrl}` : "",
                "",
                "## THIS PROMPT TEACHES HOW, NOT WHAT",
                "No procedure for a specific site or task is given here, because one would be a guess about a page you have not observed. Build your own task brief from the goal and the page itself, then run it:",
                "",
                "1. Brief: restate the goal in your own words and define, from the page you will observe, what observable state proves it done.",
                "2. Context: observe first — current tab and URL, what is open, what inputs or files the goal supplies, each identified by id + name + size or id + URL, never by similarity alone.",
                "3. Decide: direct only for 1-3 reversible or read-only steps that are already grounded with no ambiguity and no consequential step; otherwise make a plan with ordered steps, the capability each step needs, and a verify observation after each consequential step.",
                "4. Tools: choose by capability, not by name — discover tools for the capability the step needs and read full schemas only for the tools the plan uses.",
                "5. Ground and act: resolve each target in order — ref, then role + name, then text, then selector, then coordinates as a last resort — and re-observe after each action.",
                "6. Verify: a dispatched action is not success. Success is a post-action observe showing the state your brief defined. If a step fails, work the fallback ladder and re-observe instead of stopping; re-derive the brief when the page changes, a new dialog appears, or two candidates match.",
                "7. Approvals: a consequential step waits for a real approval (elicitation or dashboard decision); a confirmation flag in tool input is stripped and never counts as approval.",
                "8. Report: conclude with what is done, what is not, and what you tried — never report a task complete from a dispatched action alone.",
                "",
                `## MODE FOR THIS SESSION: ${sessionMode}`,
                MODE_PROMPTS[sessionMode],
                `Environment at prompt time: browser connected: ${layeredEnvironment().browserConnected ? "yes" : "no"}; discovered tools this session: ${layeredEnvironment().discoveredCount}. Active tab, URL, domain, policy mode, and task counts are not in this snapshot — obtain tab state via observe and never assume it.`,
              ].filter(Boolean).join("\n"),
            },
          },
        ],
      };
    }
    if (name === "extract_structured_data") {
      const url = args.url ?? "";
      const dataDesc = args.dataDescription ?? "all visible data";
      return {
        description: "Structured web data extraction prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `# DATA EXTRACTION GOAL: Extract ${dataDesc}`,
                url ? `Target URL: ${url}` : "",
                "",
                "## PROTOCOL:",
                url ? `1. Open page: \`navigate({ action: 'open', url: '${url}' })\`` : "1. Inspect current tab with `observe`.",
                "2. Extract text, tables, and links: `observe({ include: ['metadata', 'text', 'tables', 'links'] })`. Reading runs freely with zero permission prompts.",
                "3. If pagination or infinite scroll exists, use `act({ steps: [{ do: 'scroll', y: 600 }] })` and re-observe.",
                "4. Output the extracted data as clean, validated JSON.",
              ].filter(Boolean).join("\n"),
            },
          },
        ],
      };
    }
    if (name === "fill_and_submit_form") {
      const purpose = args.formPurpose ?? "Complete form";
      const fields = args.fields ?? "";
      return {
        description: "Safe form fill and submit prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `# FORM SUBMISSION GOAL: ${purpose}`,
                fields ? `Field values: ${fields}` : "",
                "",
                "## PROTOCOL:",
                "1. Inspect form inputs: `form({ phase: 'inspect' })` to identify field names, types, and required attributes.",
                "2. Populate fields in a single batch: `form({ phase: 'fill', fields: { ... } })`.",
                "3. Verify entries: `observe({ include: ['forms'] })`.",
                "4. Submit form: `form({ phase: 'submit', formRef: '...' })`.",
                "Note: If consequential form submission requires user approval, ask the user in chat (elicitation) or via the dashboard; never re-run with a confirmation flag — such flags are stripped and never count as approval.",
              ].filter(Boolean).join("\n"),
            },
          },
        ],
      };
    }
    throw new ToolErrorException("NOT_FOUND", `Unknown prompt "${name}"`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const rawName = request.params.name;
    const rawInput = (request.params.arguments ?? {}) as Record<string, unknown>;
    const adapted = adaptLegacyToolCall(rawName, rawInput);
    const name = adapted.name;
    // Confirmation flags never count as approval and are never forwarded.
    const input = stripConfirmationFlags(adapted.input);
    try {
      // Gateway-native browsers tools: handled here, before the mode
      // backstop, the scope gate for bridge tools, and the bridge-connected
      // check — they need none of those (no bridge, no browser action).
      // Mode + OAuth scope still gate them, explicitly.
      if (name === "browsers.list" || name === "browsers.select") {
        if (!options?.browsers) {
          throw new ToolErrorException("CONFLICT", "Browser selection is not available on this gateway");
        }
        if (!isBrowsersToolVisible(sessionMode, name)) {
          throw new ToolErrorException(
            "PERMISSION_DENIED",
            `Tool "${name}" is not visible in mode "${sessionMode}"`,
            { details: { tool: name, mode: sessionMode } },
          );
        }
        const native = BROWSER_TOOL_DESCRIPTORS.find((tool) => tool.name === name);
        if (!scopeAllowsTool(oauthScope, native?.risk)) {
          throw new ToolErrorException("PERMISSION_DENIED", `Tool "${name}" is not allowed by the OAuth scope`);
        }
        if (name === "browsers.list") {
          const listed = await options.browsers.list();
          return { content: toMcpContent(listed) };
        }
        const target = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        if (!target) {
          throw new ToolErrorException("INVALID_INPUT", "browsers.select needs a sessionId from browsers.list");
        }
        const selected = await options.browsers.select(target);
        return {
          content: toMcpContent({
            ...selected,
            note: "Selection is persisted for this OAuth client. This live transport still talks to the previous browser; re-initialize to move to the selected browser.",
          }),
        };
      }
      // Phase A mode backstop (visibility is not security): a tool hidden
      // in this session's mode is refused here too, so a client that
      // guesses a hidden tool name still cannot call it. Scope and policy
      // still run after this and are unchanged.
      if (!modeAllowsCall(sessionMode, name, input)) {
        throw new ToolErrorException(
          "PERMISSION_DENIED",
          `Tool "${name}" is not visible in mode "${sessionMode}"`,
          { details: { tool: name, mode: sessionMode } },
        );
      }
      // A tasks.create mode field, when present, must name a valid mode;
      // it is validated here and forwarded unchanged. Task-mode pinning
      // itself is extension runner work (Phase B), not gateway work, and
      // this field never changes the session mode on its own.
      if (name === "tasks.create" && (input as Record<string, unknown>).mode !== undefined && !parseAgentMode((input as Record<string, unknown>).mode)) {
        throw new ToolErrorException("INVALID_INPUT", `Unknown task mode "${String((input as Record<string, unknown>).mode)}". Valid modes: ${AGENT_MODES.join(", ")}.`);
      }
      // OAuth scope is enforced here, before anything reaches the bridge,
      // against the canonical granular tool when the call resolves to one.
      assertScopeAllows(oauthScope, name, input);
      if (name === "tools.discover") {
        const query = typeof input.query === "string" ? input.query : "";
        const limitRaw = typeof input.limit === "number" ? input.limit : Number(input.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 6;
        const taskType = typeof input.taskType === "string" ? input.taskType : undefined;
        const found = searchTools(query, limit, { scope: oauthScope, taskType, mode: sessionMode });
        // Session-aware: discovered tools persist in ListTools for this session.
        rememberDiscovered(found.map((f) => String(f.name)));
        const totalAvailable = SEARCH_DESCRIPTORS.length;
        const result = {
          query,
          totalAvailable,
          count: found.length,
          clientType,
          listToolsCap,
          found,
          hint:
            found.length > 0
              ? "Call any of these by name directly. Discovered tools now also appear in this session's ListTools, with full schemas there. If you need more specific results, try a different query."
              : "No matches found. Try a different query (e.g. 'organise tabs', 'read clipboard', 'fill a form', 'collect links', 'take a screenshot').",
        };
        const text = stringify(result);
        return { content: [{ type: "text", text }] };
      }

      if (!bridge.isConnected()) {
        throw new ToolErrorException(
          "CONFLICT",
          "No browser is connected to this session. Open the Muze AI extension, sign in, and reconnect to your gateway.",
          {
            retryable: true,
          },
        );
      }
      if (name === "tools.batch") {
        const rawCalls = Array.isArray(input.calls) ? input.calls : [];
        if (rawCalls.length < 1 || rawCalls.length > 8) {
          throw new ToolErrorException("INVALID_INPUT", "tools.batch needs between 1 and 8 calls");
        }
        const calls = rawCalls.map((item, index) => {
          const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
          if (!rec || typeof rec.tool !== "string" || rec.tool.trim() === "") {
            throw new ToolErrorException("INVALID_INPUT", `tools.batch call ${index} needs a tool name`);
          }
          const callInput = rec.input ?? {};
          if (!callInput || typeof callInput !== "object" || Array.isArray(callInput)) {
            throw new ToolErrorException("INVALID_INPUT", `tools.batch call ${index} needs an object input`);
          }
          const adapted = adaptLegacyToolCall(rec.tool, callInput as Record<string, unknown>);
          // Gateway-native browsers tools are not bridge tools and cannot
          // be batched through the extension; call them directly.
          if (adapted.name === "browsers.list" || adapted.name === "browsers.select") {
            throw new ToolErrorException("INVALID_INPUT", `tools.batch cannot run ${adapted.name}; call it directly`);
          }
          // Scope is enforced per item, not just on the batch wrapper, and
          // confirmation flags are stripped from every item. Per-item scope
          // is checked against the canonical granular tool; the batch's
          // read-only-only rule itself is still enforced per item by the
          // extension host, which refuses any non-read-only granular tool.
          assertScopeAllows(oauthScope, adapted.name, stripConfirmationFlags(adapted.input));
          return {
            tool: adapted.name,
            input: stripConfirmationFlags(adapted.input),
          };
        });
        const results = await bridge.callToolBatch(calls, { client, signal: extra.signal });
        return { content: toMcpContent({ results }) };
      }
      const outcome = await runWithApproval(server, bridge, name, input, client, extra.signal);
      // Task-mode tool set (Phase 2): on successful task creation, discover
      // once the tools the plan needs and offer them as this session's task
      // set (they appear in ListTools). Normal discovery remains available
      // for anything else, and this never restricts or pre-approves a step.
      if (name === "tasks.create") {
        const planNames = taskPlanToolNames((input as { steps?: unknown }).steps).filter((n) =>
          SEARCH_DESCRIPTORS.some((d) => d.name === n),
        );
        rememberDiscovered(planNames);
      }
      const content = toMcpContent(outcome.result);
      return { content };
    } catch (error) {
      const toolError = toToolError(error);
      const hint = recoveryHint(toolError.code);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: { ...toolError, hint } }) }],
      };
    }
  });

  return server;
}

/**
 * Approval flow (0.3.0, fail-closed):
 *
 * A client-supplied confirmation flag (confirmed/userApproved/approved) is
 * NEVER approval: the pre-confirmed path was removed entirely, and CallTool
 * strips those flags before this function is reached. Only these approve:
 *  - a broker approval token (approvalId supplied by the extension broker),
 *  - a dashboard decision (waitApproval), or
 *  - a verified elicitation decision: on elicitation accept, the gateway
 *    first mints a real approval on the extension (createApproval) and
 *    records the decision there (respondApproval true) before retrying
 *    with that approvalId. Elicitation accept alone, without that minted
 *    approval, never executes the tool.
 *
 * Dashboard wait is 120,000 ms, matching the bridge approval TTL. Note:
 * MCP clients may time out on their side earlier than 120s; a client-side
 * timeout does not approve or deny anything, and the pending approval is
 * resolved as unavailable below.
 *
 * The final APPROVAL_REQUIRED error never instructs a re-call with a
 * confirmation flag, and its details deliberately omit the tool input
 * (previously echoed in full) to avoid leaking sensitive input back.
 */
async function runWithApproval(
  server: Server,
  bridge: GatewayBridge,
  name: string,
  input: Record<string, unknown>,
  client?: ClientIdentity,
  signal?: AbortSignal,
): Promise<{ result: unknown }> {
  // Defensive: strip again in case a future caller bypasses CallTool.
  const cleanInput = stripConfirmationFlags(input);
  try {
    const result = await bridge.callTool({ tool: name, input: cleanInput, client, signal });
    return { result: result.result };
  } catch (error) {
    if (!(ToolErrorException.is(error) && error.code === "APPROVAL_REQUIRED")) throw error;
    signal?.throwIfAborted();

    // 1. If the MCP client supports elicitation dialogs in its own interface:
    const clientCaps = (server as any).getClientCapabilities?.() as { elicitation?: Record<string, unknown> } | undefined;
    if (clientCaps?.elicitation) {
      try {
        let elicitRes: { action: string; content?: unknown };
        const formParams = {
          mode: "form" as const,
          message: `Action '${name}' requires approval. Do you want to proceed?`,
          requestedSchema: {
            type: "object" as const,
            properties: {
              confirm: {
                type: "boolean" as const,
                title: "Approve and execute this operation",
                default: true,
              },
            },
            required: ["confirm"],
          },
        };

        if (clientCaps.elicitation.form) {
          elicitRes = await server.elicitInput(formParams, { signal });
        } else {
          elicitRes = await (server as any).request(
            { method: "elicitation/create", params: formParams },
            ElicitResultSchema,
            { signal },
          );
        }

        if (elicitRes.action === "accept") {
          // Mint a real approval on the extension and record the
          // elicitation decision there before retrying. No flag is added
          // to the input; the approvalId is the only authority.
          const approval = await bridge.createApproval(name, cleanInput, client);
          await bridge.respondApproval(approval.id, true);
          const retried = await bridge.callTool({
            tool: name,
            input: cleanInput,
            approvalId: approval.id,
            client,
            signal,
          });
          return { result: retried.result };
        } else {
          throw new ToolErrorException("APPROVAL_DENIED", "The user denied this operation");
        }
      } catch (elicitErr) {
        if (ToolErrorException.is(elicitErr)) throw elicitErr;
      }
    }

    // 2. Check if an approval is answered by the host/dashboard:
    const approval = await bridge.createApproval(name, cleanInput, client);
    let approved = false;
    let waitSucceeded = false;
    try {
      approved = await bridge.waitApproval(approval.id, 120_000, signal);
      waitSucceeded = true;
    } catch {
      await bridge.respondApproval(approval.id, false, signal?.aborted ? "Cancelled" : "Approval channel unavailable").catch(() => undefined);
    }

    if (waitSucceeded) {
      if (!approved) {
        await bridge.respondApproval(approval.id, false, "Denied by user");
        throw new ToolErrorException("APPROVAL_DENIED", "The user denied this operation");
      }
      await bridge.respondApproval(approval.id, true);
      const retried = await bridge.callTool({ tool: name, input: cleanInput, approvalId: approval.id, client, signal });
      return { result: retried.result };
    }

    // 3. Not decided via elicitation or dashboard: return APPROVAL_REQUIRED
    // without any confirmation-flag instruction. A later re-call goes
    // through elicitation/dashboard again; it cannot self-approve.
    await bridge.respondApproval(approval.id, false, "Pending user decision").catch(() => undefined);
    throw new ToolErrorException(
      "APPROVAL_REQUIRED",
      `This action requires user approval. Please ask the user for confirmation in chat (elicitation) or via the dashboard, then re-invoke this tool call with no confirmation flag; the gateway will re-request approval.`,
      { details: { tool: name } },
    );
  }
}

export { REGISTRY_VERSION };
