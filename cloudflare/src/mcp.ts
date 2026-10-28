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
  UNIFIED_TOOL_SCHEMAS as TOOL_SCHEMAS,
  type ToolDescriptor,
} from "../libs/tool-contracts/index.js";
// Task tools are imported directly from their schema file (not via the
// tool-contracts index) so the gateway needs no index change: the sync
// script copies the whole tool-contracts tree, including schemas/tasks.ts.
import { taskTools } from "../libs/tool-contracts/schemas/tasks.js";
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

const MCP_INSTRUCTIONS =
  "You are an expert agentic browser operator controlling the user's Chrome browser via Muze AI.\n\n" +
  "## CORE AGENTIC LOOP: Observe → Reason → Act → Verify\n" +
  "1. Ground: Always observe before acting. Call `observe` to inspect the page text, accessibility tree, form fields, and interactive element refs.\n" +
  "2. Interact: Call `act` with step(s) using the stable element `ref` (e.g. 'r1a2b') obtained from `observe`.\n" +
  "3. Settle: If an action triggers navigation or async data loading, synchronize with `navigate({ category: 'sync', for: 'network_idle' })`.\n" +
  "4. Verify: Re-observe the page to confirm the expected change succeeded.\n\n" +
  "## THE 5 MASTER TOOLS\n" +
  "1. `observe`: Page sensing & content extraction (text, a11y, forms, tables, links, outline, screenshot, selection).\n" +
  "   - Inspecting pages, personal profiles, articles, and taking screenshots run freely with zero permission prompts.\n" +
  "   - Find elements: `observe({ include: ['find'], by: 'role', value: 'button', name: 'Search' })` or by text/label/selector.\n" +
  "2. `act`: Browser interaction engine.\n" +
  "   - Batched `steps: [...]`:\n" +
  "     * Click: `{ do: 'click', target: { ref: '...' } }` (or `{ target: { selector: '...' } }` or coordinates).\n" +
  "     * Type/Fill: `{ do: 'type', target: { ref: '...' }, text: '...' }` or `{ do: 'fill', target: { ref: '...' }, value: '...' }`.\n" +
  "     * Press: `{ do: 'press', target: { ref: '...' }, key: 'Enter' }`.\n" +
  "     * Scroll/Hover/Check: `{ do: 'scroll', y: 300 }`, `{ do: 'hover', target: { ref } }`, `{ do: 'check', target: { ref }, checked: true }`.\n" +
  "3. `navigate`: Spatial window & tab management, page transitions, and synchronization.\n" +
  "   - URL navigation: `{ action: 'open', url: '...' }`, `back`, `forward`, `reload`, `search`.\n" +
  "   - Tab management (`category: 'tab'`): `{ category: 'tab', action: 'list' | 'active' | 'create' | 'close' | 'activate' | 'duplicate' | 'group' | 'organize' }`. DEPRECATED in 2.x: prefer `tabs` / `windows` for tab/window actions; navigate tab/window actions still work but will be removed in registry 3.0.\n" +
  "   - Window management (`category: 'window'`): `{ category: 'window', action: 'list' | 'create' | 'update' | 'close' }`. DEPRECATED in 2.x: prefer `windows`.\n" +
  "   - Synchronization (`category: 'sync'`): `{ category: 'sync', for: 'network_idle', quietMs: 300 }`, `{ for: 'element', selector: '...' }`, `{ for: 'delay', timeoutMs: 1000 }`.\n" +
  "4. `form`: Structured form lifecycle.\n" +
  "   - Inspect: `{ phase: 'inspect' }` to list all inputs and validations.\n" +
  "   - Fill: `{ phase: 'fill', fields: { refOrName: 'value' } }` or `{ fields: [{ ref, value }] }`.\n" +
  "   - Upload: `{ phase: 'upload', ref: '...', files: [...] }` to attach files.\n" +
  "   - Submit: `{ phase: 'submit', formRef: '...' }`.\n" +
  "5. `data`: System state and storage across domains.\n" +
  "   - History: `{ domain: 'history', action: 'search' | 'add' | 'delete' }`\n" +
  "   - Bookmarks: `{ domain: 'bookmarks', action: 'list' | 'search' | 'create' | 'delete' }`\n" +
  "   - Downloads: `{ domain: 'downloads', action: 'list' | 'start' | 'control' | 'erase' }`\n" +
  "   - Clipboard: `{ domain: 'clipboard', action: 'read' | 'write', text: '...' }`. DEPRECATED in 2.x: prefer `clipboard`.\n" +
  "   - DevTools: `{ domain: 'devtools', action: 'console' | 'network' | 'errors' | 'performance' }`. DEPRECATED in 2.x: prefer `devtools`.\n\n" +
  "## IN-CHAT PERMISSIONS & APPROVALS\n" +
  "- Reading operations (reading personal profiles, inspecting DOM, querying history/bookmarks) execute immediately without asking for user permission.\n" +
  "- Consequential operations (submitting forms, deleting records, writing clipboard) may require confirmation.\n" +
  "- If an action requires confirmation, it is approved only through an elicitation dialog in your chat interface or a decision in the extension dashboard. A confirmation flag in tool input (\"confirmed\", \"userApproved\", \"approved\") is stripped by the gateway and never counts as approval — never send one expecting it to approve anything.\n" +
  "- Do not tell the user to open or look at the extension dashboard as a substitute for elicitation; approvals are decided in chat (elicitation) or on the dashboard, and the gateway records the decision as a real approval on the extension.\n";

const ALL_TOOL_DESCRIPTORS: ToolDescriptor[] = [
  ...TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool)),
  // Phase 0 task tools: additive descriptors so tasks.* are listed,
  // discoverable, and scope-checked like any other tool. The gateway
  // never executes a task step; it only forwards tasks.* to the bridge
  // exactly like other tools, and never synthesises a TaskView.
  ...taskTools.map((tool) => toToolDescriptor(tool)),
];

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

function entryToResolution(entry: { granularTool: string }, calledAs: string, action: string): UnifiedScopeResolution | null {
  if (entry.granularTool.startsWith("local:")) return null;
  return { granular: entry.granularTool, calledAs, action };
}

function resolveNavigate(d: Record<string, unknown>): UnifiedScopeResolution | null {
  const action = asString(d.action);
  const category = asString(d.category);
  const forValue = asString(d.for);
  // Handler order: tab, then window, then sync, then URL actions.
  if (action !== undefined && (category === "tab" || NAVIGATE_TAB_ACTIONS.has(action))) {
    const entry = resolveUnifiedAction("navigate", action, "tab") ?? resolveUnifiedAction("navigate", action);
    return entry ? entryToResolution(entry, "navigate", action) : null;
  }
  if (category === "window" || action === "update") {
    if (action === undefined) return null;
    const entry = resolveUnifiedAction("navigate", action, "window") ?? resolveUnifiedAction("navigate", action);
    return entry ? entryToResolution(entry, "navigate", action) : null;
  }
  if (category === "sync" || forValue !== undefined) {
    const domain = `sync:${forValue ?? "navigation"}`;
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

/** Full-registry descriptors for discovery: unified + granular + tasks (135). */
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
 * Discovery v2 (Phase 2): tag/category/verb/description scoring over the
 * FULL registry (not just the unified surface), permission/scope filtered
 * FIRST, grouped, up to 20 results, full schema for the top 5 only.
 * The caller adds returned names to the session's discovered set, so
 * session-aware ListTools can serve their full schemas later.
 */
export function searchTools(
  query: string,
  limit: number,
  options: { scope?: string; taskType?: string; health?: Record<string, { timeoutRate: number; errorRate: number }> } = {},
): Array<Record<string, unknown>> {
  const allowed = options.scope ? (descriptor: ToolDescriptor) => discoveryAllowed(descriptor, options.scope) : undefined;
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
      return { name: "act", input: { tabId: input.tabId, frameId: input.frameId, steps: [{ do: "select", target: { ref: String(input.ref ?? "") }, value: String(input.value ?? "") }] } };
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
      return { name: "navigate", input: { action: "open", url: input.url, tabId: input.tabId, reuseActiveTab: input.reuseActiveTab, active: input.active } };
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
    case "wait":
      return { name: "navigate", input: { category: "sync", ...input } };
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
      return { name: "form", input: { phase: "set_file", ref: input.ref, fileId: input.fileId, tabId: input.tabId, frameId: input.frameId } };
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
    case "browser.info":
      return { name: "data", input: { domain: "devtools", action: "status" } };
    case "browser.capabilities":
      return { name: "data", input: { domain: "devtools", action: "capabilities" } };
    case "browser.permissions":
      return { name: "data", input: { domain: "devtools", action: "permissions" } };
    case "browser.diagnostics":
      return { name: "data", input: { domain: "devtools", action: "diagnostics" } };
    case "browser.search":
      return { name: "navigate", input: { action: "search", query: input.text ?? input.query } };
    case "browser":
      return { name: "data", input: { domain: "devtools", action: input.action ?? "status" } };
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
export function createGatewayMcpServer(
  bridge: GatewayBridge,
  client?: ClientIdentity,
  env?: { MCP_SHOW_ALL_TOOLS?: string },
  oauthScope?: string,
  options?: { clientType?: string },
): Server {
  // Client type is recorded ONLY if declared (session-do passes the
  // initialize clientInfo name through; an undeclared client is "unknown").
  // The cap itself is a documented Muze conservative cap (see
  // tool-meta.ts LISTTOOLS_CAPS), not a claimed vendor limit.
  const clientType = classifyClientType(options?.clientType ?? client?.name);
  const listToolsCap = listToolsCapForClientType(clientType);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, elicitation: {} } as any,
      instructions: `${MCP_INSTRUCTIONS}\n\n${GENERATED_TOOL_SELECTION}`,
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
  const discoveredTools: string[] = [];
  const rememberDiscovered = (names: string[]): void => {
    for (const name of names) {
      if (!discoveredTools.includes(name)) discoveredTools.push(name);
    }
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
    const coreTools = filterToCoreTools(tools, showAllTools);
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
        if (descriptor && discoveryAllowed(descriptor, oauthScope)) {
          listed = [...listed, descriptor];
          coreNames.add(name);
        }
      }
    }
    if (!showAllTools) listed = listed.slice(0, listToolsCap);
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
      const goal = args.goal ?? "Explore the active page";
      const startUrl = args.startUrl;
      return {
        description: "Autonomous browser execution prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `# OBJECTIVE: ${goal}`,
                startUrl ? `Starting URL: ${startUrl}` : "",
                "",
                "## EXECUTION PROTOCOL (Observe → Reason → Act → Verify):",
                "1. Ground: Call `observe({ include: ['metadata', 'text', 'a11y'] })` to understand the page and obtain element refs (e.g. 'r1a2b'). Reading content or profiles runs freely without permission prompts.",
                "2. Reason: Formulate your plan explaining the exact next action.",
                "3. Act: Target the element using its ref from step 1 with `act({ steps: [{ do: '...', target: { ref: '...' } }] })`.",
                "4. Settle: If the action causes navigation or dynamic loading, call `navigate({ category: 'sync', for: 'network_idle' })`.",
                "5. Verify: Observe the page again to confirm the expected change took place.",
                "6. Approvals: If an action requires confirmation, ask the user in chat (elicitation) or via the dashboard; never re-run with a confirmation flag — such flags are stripped and never count as approval.",
                "7. Report: Conclude with a clear summary of what was accomplished.",
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
      // OAuth scope is enforced here, before anything reaches the bridge,
      // against the canonical granular tool when the call resolves to one.
      assertScopeAllows(oauthScope, name, input);
      if (name === "tools.discover") {
        const query = typeof input.query === "string" ? input.query : "";
        const limitRaw = typeof input.limit === "number" ? input.limit : Number(input.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 6;
        const taskType = typeof input.taskType === "string" ? input.taskType : undefined;
        const found = searchTools(query, limit, { scope: oauthScope, taskType });
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
