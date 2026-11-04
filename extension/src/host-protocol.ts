import {
  PROTOCOL_VERSION,
  REGISTRY_VERSION,
  ToolErrorException,
  toToolError,
  type ApprovalRequestInfo,
  type BridgeClientMessage,
  type BridgeEvent,
  type BridgeHostMessage,
  type ClientIdentity,
  type ToolBatchItemResult,
  type ToolCallBatchMessage,
  type ToolDescriptor,
  UNIFIED_TOOL_NAMES,
} from "../libs/tool-contracts/index.js";
import type { ApprovalBroker, PolicyEngine } from "../libs/security/index.js";
import { describeOperation, type BrowserContext, type ToolExecutor, type ToolRegistry } from "../libs/browser-engine/index.js";
import {
  DryRunPreviewSchema,
  TaskViewSchema,
  taskTools,
  type DryRunPreview,
  type PlanBounds,
  type TaskView,
} from "../libs/tool-contracts/schemas/tasks.js";
// Runner types are imported from the real task engine (it landed in
// extension/libs/tasks/ while this section was being built); only the
// port interface itself is defined here, structurally, so the dispatch
// stays decoupled from the runner class and test fakes stay possible.
import type {
  ApprovePlanInput,
  CreateStepInput,
  CreateTaskInput,
  DryRunPreview as RunnerDryRunPreview,
  PolicySnapshot,
  TaskView as RunnerTaskView,
} from "../libs/tasks/index.js";
// Imported directly (not via the tool-contracts index, which does not
// re-export it yet): the per-action risk table is the single source of
// truth for unified action -> granular tool mapping.
import { resolveUnifiedAction, type ActionRiskEntry } from "../libs/tool-contracts/action-risk.js";

/**
 * Structural port for the Phase 0 task runner (extension/libs/tasks/).
 * It matches the runner's public methods exactly, including the
 * policy-snapshot parameters on create/resume: the snapshot is a
 * caller-supplied value the runner stores and re-checks on resume, so
 * dispatch must never invent one (an invented scope could silently
 * widen a resume). When no snapshot provider is wired, create/resume
 * fail closed with "task policy snapshot not wired".
 *
 * The runner owns step execution through the existing executor/policy/
 * approval path. This dispatch never calls the executor directly for a
 * step, never bypasses approval, and never returns a raw task record:
 * the runner's richer view is adapted to the frozen bridge contract
 * TaskView (schemas/tasks.ts) — totalSteps/doneSteps/undoneSteps are
 * computed from step states, and internal fields (idempotency keys,
 * policy snapshot, pinned tabs, raw inputs) are dropped — then
 * validated against TaskViewSchema, so only the contract view crosses
 * the bridge. The runner's own view deliberately has no
 * totalSteps/doneSteps/undoneSteps fields, so a direct pass-through
 * would fail contract validation; the adapter below is the bridge
 * between the two shapes.
 */
export interface TaskRunnerPort {
  createTask(input: CreateTaskInput, policySnapshot: PolicySnapshot): Promise<RunnerTaskView>;
  /** Append steps to an existing task's plan (tasks.appendSteps). */
  appendSteps(id: string, clientId: string, steps: CreateStepInput[]): Promise<RunnerTaskView>;
  getTask(id: string, clientId: string): Promise<RunnerTaskView>;
  listTasks(clientId: string, browserSessionId?: string): Promise<RunnerTaskView[]>;
  runTask(id: string, clientId: string, browserSessionId?: string): Promise<RunnerTaskView>;
  pauseTask(id: string, clientId: string, reason: string): Promise<RunnerTaskView>;
  resumeTask(id: string, clientId: string, policySnapshot: PolicySnapshot, browserSessionId?: string): Promise<RunnerTaskView>;
  cancelTask(id: string, clientId: string): Promise<RunnerTaskView>;
  /** Phase 1: separate granular plan-approval tool (see tasks.ts). */
  approvePlan(id: string, clientId: string, opts: ApprovePlanInput): Promise<RunnerTaskView>;
  /** Phase 1: dry-run preview; creates no task record. */
  previewTask(input: CreateTaskInput): Promise<RunnerDryRunPreview>;
}

/**
 * Adapt a runner view to the frozen bridge contract view. Throws
 * ToolErrorException(INTERNAL) when the adapted view fails contract
 * validation, so a malformed runner return never crosses the bridge.
 */
function toContractTaskView(view: RunnerTaskView): TaskView {
  const steps = view.steps.map((step) => ({
    index: step.index,
    tool: step.tool,
    inputSummary: step.inputSummary,
    state: step.state,
    attempts: step.attempts,
    outputSummary: step.outputSummary,
    ...(step.outsideBoundsReason !== null && step.outsideBoundsReason !== undefined ? { outsideBoundsReason: step.outsideBoundsReason } : {}),
    // Phase B: verify outcome/summary are bounded runner summaries, safe for the bridge view.
    ...(step.verifySummary ? { verifySummary: step.verifySummary } : {}),
    ...(step.verifyOutcome !== null && step.verifyOutcome !== undefined ? { verifyOutcome: step.verifyOutcome } : {}),
  }));
  const candidate = {
    id: view.id,
    goal: view.goal,
    clientId: view.clientId,
    browserSessionId: view.browserSessionId,
    // Phase B: pinned task mode, when present (pre-Phase-B tasks omit it).
    ...(view.mode !== undefined && view.mode !== null ? { mode: view.mode } : {}),
    status: view.status,
    steps,
    totalSteps: view.steps.length,
    doneSteps: view.steps.filter((step) => step.state === "done").map((step) => step.index),
    undoneSteps: view.steps.filter((step) => step.state !== "done").map((step) => step.index),
    totalBudgetMs: view.totalBudgetMs,
    correlationId: view.correlationId,
    resultSummary: view.resultSummary,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    completedAt: view.completedAt,
    ...(view.resumeAfterMs !== null ? { resumeAfterMs: view.resumeAfterMs } : {}),
    ...(view.pauseReason !== null ? { pauseReason: view.pauseReason } : {}),
    ...(view.finalReport !== null && view.finalReport !== undefined ? { finalReport: view.finalReport } : {}),
  };
  const checked = TaskViewSchema.safeParse(candidate);
  if (!checked.success) {
    throw new ToolErrorException("INTERNAL", "Task runner returned a view that fails the task contract");
  }
  return checked.data;
}

/**
 * Validate a runner dry-run preview against the contract preview schema,
 * so a malformed preview never crosses the bridge (mirrors
 * toContractTaskView's fail-closed rule for task views).
 */
function toContractDryRunPreview(preview: RunnerDryRunPreview): DryRunPreview {
  const checked = DryRunPreviewSchema.safeParse(preview);
  if (!checked.success) {
    throw new ToolErrorException("INTERNAL", "Task runner returned a dry-run preview that fails the task contract");
  }
  return checked.data;
}

export interface BridgeTransport {
  post(message: BridgeHostMessage): void;
}

export interface HostProtocolDeps {
  registry: ToolRegistry;
  executor: ToolExecutor;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  transport: BridgeTransport;
  getContext: () => BrowserContext;
  server: { name: string; version: string };
  /** Fired when an approval request is created so the dashboard can react live. */
  onEvent?: (event: BridgeEvent) => void;
  /** Default identity used before a hello is received. */
  defaultClient?: ClientIdentity;
  /** When false, only the unified tool surface is exposed to remote clients. */
  legacyTools?: boolean;
  /**
   * Phase 0 task runner. Absent until the coordinator wires it; tasks.*
   * calls then fail with "task engine not wired" rather than succeeding.
   */
  tasks?: TaskRunnerPort;
  /**
   * The host's current browser session id, when the host knows one.
   * Falls back to the tasks.create / tasks.list input browserSessionId.
   */
  getBrowserSessionId?: () => string | undefined;
  /**
   * Policy snapshot for task create/resume (the runner stores it and
   * re-checks scope/version/mode on resume). The coordinator wires
   * this; dispatch never invents a snapshot.
   */
  getTaskPolicySnapshot?: () => PolicySnapshot;
}

const UNKNOWN_CLIENT: ClientIdentity = { id: "unknown", name: "Unknown client", transport: "remote" };

/**
 * Client-supplied confirmation flags that must NEVER count as approval.
 *
 * A bridge client may set `confirmed`, `userApproved` or `approved` on a
 * tool input (unified schemas no longer declare them in 0.3.0, and strict
 * schemas reject them; this strip is defence in depth). Those flags are
 * assertions by the caller, not a user
 * decision, so they are stripped at the bridge boundary before the input
 * reaches the executor or the approval fingerprint. The ONLY things that
 * approve a call are a broker approval token (approvalId, consumed once by
 * the approval broker), a dashboard decision, or a verified elicitation
 * decision relayed as an `approval.respond` message — never a flag on the
 * tool input itself.
 *
 * This strip is boundary defence in addition to the executor, which in
 * 0.3.0 also ignores (never approves on) those flags.
 */
const CLIENT_APPROVAL_FLAGS = ["confirmed", "userApproved", "approved"] as const;

export function stripClientApprovalFlags(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const copy = { ...(input as Record<string, unknown>) };
  for (const flag of CLIENT_APPROVAL_FLAGS) delete copy[flag];
  return copy;
}

/**
 * Phase 1 canonical resolution (Tool Management Plan section 2.2). The
 * granular tool for each unified action comes from the action-risk table
 * (extension/libs/tool-contracts/action-risk.ts, section A); this file
 * only builds the canonical granular INPUT from the unified handler's
 * own invoke arguments (extension/libs/browser-engine/tools/unified.ts),
 * with undefined fields stripped. The two paths that use this resolver —
 * approval-request and tool-call — must agree exactly, because the
 * approval fingerprint is built from its output on both.
 *
 * Returns null for granular tools, tasks tools (dispatched to the runner,
 * never resolved here), multi-target tools (observe fans out to many
 * granular reads; act fans out to many interaction steps), delay waits
 * (the table flags them `local:` — no granular tool exists, so they keep
 * pre-resolution behaviour rather than being audited under a sentinel
 * name), and anything unrecognised. A null result keeps the
 * pre-resolution behaviour for that call.
 *
 * Security rule: `calledAs` is debug-only. It is carried on the approval
 * info and in audit details so a reader can see which unified name was
 * used, but no approval, policy, rate-limit, or scope decision ever
 * reads it — every such decision uses `tool` (the granular name) and
 * `input` (the canonical input) only.
 */
export interface UnifiedResolution {
  /** Granular tool the call will actually execute. */
  tool: string;
  /** Canonical granular input (unified routing fields removed). */
  input: Record<string, unknown>;
  /** Unified tool name as called; debug-only, never a security input. */
  calledAs: string;
  /** Action/phase string that selected the granular tool. */
  action: string;
}

type Rec = Record<string, unknown>;

function asRec(input: unknown): Rec {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Rec) : {};
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Drop undefined-valued keys so fingerprints are stable and readable. */
function clean(obj: Rec): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toId(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = parseInt(String(value), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(toId).filter((n) => !Number.isNaN(n));
}

/**
 * Table lookup that treats the table's `local:` sentinels (wait delay,
 * navigate sync delay — no granular tool exists) as unresolvable rather
 * than returning a sentinel as a tool name.
 */
function granularEntry(tool: string, action: string, domain?: string): ActionRiskEntry | undefined {
  const entry = resolveUnifiedAction(tool, action, domain);
  if (!entry || entry.granularTool.startsWith("local:")) return undefined;
  return entry;
}

const NAVIGATE_TAB_ACTIONS = new Set([
  "list", "get", "active", "create", "close", "activate", "switch",
  "duplicate", "discard", "move", "pin", "mute", "zoom", "group", "ungroup",
  "save_session", "restore_session", "organize",
]);

function tabsCanonical(action: string, d: Rec, windowIdForSession?: unknown): Rec | null {
  switch (action) {
    case "list": return {};
    case "get": return clean({ tabId: d.tabId });
    case "active": return {};
    case "search": return clean({ query: (d.query as string | undefined) ?? "" });
    case "create": return clean({ url: d.url, pinned: (d.pinned as boolean | undefined) ?? false, groupId: d.groupId, active: (d.active as boolean | undefined) ?? true });
    case "close": return clean({ tabId: d.tabId });
    case "activate": return clean({ tabId: d.tabId });
    case "switch": return clean({ tabId: d.tabId });
    case "duplicate": return clean({ tabId: d.tabId });
    case "discard": return clean({ tabId: d.tabId });
    case "move": {
      const tabIds: unknown = Array.isArray(d.tabIds) ? d.tabIds : (typeof d.tabId === "number" ? [d.tabId] : []);
      return clean({ tabIds, windowId: d.windowId, index: d.index });
    }
    case "pin": return clean({ tabId: d.tabId, pinned: (d.pinned as boolean | undefined) ?? true });
    case "mute": return clean({ tabId: d.tabId, muted: (d.muted as boolean | undefined) ?? true });
    case "zoom": return clean({ tabId: d.tabId, zoom: (d.zoom as number | undefined) ?? 1 });
    case "group": return clean({ tabIds: d.tabIds ?? [], title: d.title });
    case "ungroup": return clean({ tabIds: d.tabIds ?? [] });
    case "save_session": return clean({ name: (d.title as string | undefined) ?? "session", windowId: windowIdForSession });
    case "restore_session": return clean({ sessionId: d.sessionId, active: (d.active as boolean | undefined) ?? false });
    case "organize": {
      const strategy = d.strategy === "prefix" ? "titlePrefix" : ((d.strategy as string | undefined) ?? "domain");
      return clean({ strategy, windowId: windowIdForSession, maxGroups: (d.maxGroups as number | undefined) ?? 5 });
    }
    default: return null;
  }
}

function windowsCanonical(action: string, d: Rec): Rec | null {
  switch (action) {
    case "list": return {};
    case "create": return clean({ url: d.url, focused: (d.focused as boolean | undefined) ?? true, incognito: (d.incognito as boolean | undefined) ?? false });
    case "update": return clean({ windowId: d.windowId, state: d.state, focused: d.focused, width: d.width, height: d.height, left: d.left, top: d.top });
    case "close": return clean({ windowId: d.windowId });
    default: return null;
  }
}

function devtoolsCanonical(action: string, d: Rec): Rec | null {
  switch (action) {
    case "console": return clean({ tabId: d.tabId, frameId: d.frameId, limit: d.limit, level: d.level });
    case "network": return clean({ tabId: d.tabId, limit: d.limit, urlFilter: d.urlFilter, onlyFailed: d.onlyFailed });
    case "errors": return clean({ tabId: d.tabId, limit: d.limit });
    case "performance": return clean({ tabId: d.tabId, frameId: d.frameId });
    case "observer": return clean({ tabId: d.tabId, enabled: (d.enabled as boolean | undefined) ?? true });
    case "dialogs": return clean({ tabId: d.tabId, frameId: d.frameId, limit: d.limit });
    case "respond_dialog": return clean({ tabId: d.tabId, frameId: d.frameId, response: (d.response as string | undefined) ?? "accept", text: d.text });
    default: return null;
  }
}

function formFieldsCanonical(fields: unknown): unknown {
  if (Array.isArray(fields)) return fields;
  if (fields && typeof fields === "object") {
    return Object.entries(fields as Rec).map(([ref, value]) => ({ ref, value: String(value) }));
  }
  return fields;
}

function resolveNavigate(d: Rec): UnifiedResolution | null {
  const action = asStr(d.action);
  const category = asStr(d.category);
  const forValue = asStr(d.for);
  // Handler order: tab, then window, then sync, then URL actions. The
  // table carries the same precedence in its domain entries (a tab action
  // under category=window still maps to the tab granular tool), so the
  // domain derivation below mirrors the handler branch, not the category
  // alone. A combination the handler rejects (e.g. category=window with
  // a non-tab, non-update action) has no table entry and returns null.
  if (action !== undefined && (category === "tab" || NAVIGATE_TAB_ACTIONS.has(action))) {
    const entry =
      category === "tab" || category === "window"
        ? (granularEntry("navigate", action, category) ?? granularEntry("navigate", action))
        : granularEntry("navigate", action);
    const input = tabsCanonical(action, d, d.windowId);
    if (!entry || !input) return null;
    return { tool: entry.granularTool, input, calledAs: "navigate", action };
  }
  if (category === "window" || action === "update") {
    if (action !== "update") return null;
    const entry = granularEntry("navigate", "update", "window") ?? granularEntry("navigate", "update");
    const input = windowsCanonical(action, d);
    if (!entry || !input) return null;
    return { tool: entry.granularTool, input, calledAs: "navigate", action };
  }
  if (category === "sync" || forValue !== undefined) {
    // Sync dispatch ignores `action` and branches on `for`; the table's
    // sync entries are keyed action "wait" with domain `sync:<for>`.
    const entry = granularEntry("navigate", "wait", `sync:${forValue ?? "navigation"}`);
    if (!entry) return null;
    if (forValue === "element") {
      return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, by: (d.by as string | undefined) ?? "selector", selector: d.selector, value: d.value, role: d.role, name: d.name, timeoutMs: d.timeoutMs }), calledAs: "navigate", action: action ?? "sync" };
    }
    if (forValue === "network_idle") {
      return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, quietMs: d.quietMs, timeoutMs: d.timeoutMs }), calledAs: "navigate", action: action ?? "sync" };
    }
    return { tool: entry.granularTool, input: clean({ tabId: d.tabId, timeoutMs: d.timeoutMs, waitForNetworkIdle: (d.waitForNetworkIdle as boolean | undefined) ?? false, quietMs: d.quietMs }), calledAs: "navigate", action: action ?? "sync" };
  }
  if (action === undefined) return null;
  const entry = granularEntry("navigate", action);
  if (!entry) return null;
  switch (action) {
    case "open": return { tool: entry.granularTool, input: clean({ url: d.url, reuseActiveTab: (d.reuseActiveTab as boolean | undefined) ?? false, active: (d.active as boolean | undefined) ?? true, tabId: d.tabId }), calledAs: "navigate", action };
    case "back": return { tool: entry.granularTool, input: clean({ tabId: d.tabId }), calledAs: "navigate", action };
    case "forward": return { tool: entry.granularTool, input: clean({ tabId: d.tabId }), calledAs: "navigate", action };
    case "reload": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, bypassCache: (d.bypassCache as boolean | undefined) ?? false }), calledAs: "navigate", action };
    case "search": return { tool: entry.granularTool, input: clean({ query: (d.query as string | undefined) ?? "", provider: (d.provider as string | undefined) ?? "duckduckgo", newTab: (d.newTab as boolean | undefined) ?? true, waitForLoad: (d.waitForLoad as boolean | undefined) ?? true, timeoutMs: (d.timeoutMs as number | undefined) ?? 10000, tabId: d.tabId }), calledAs: "navigate", action };
    case "wait": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, timeoutMs: (d.timeoutMs as number | undefined) ?? 10000, waitForNetworkIdle: (d.waitForNetworkIdle as boolean | undefined) ?? false, quietMs: (d.quietMs as number | undefined) ?? 300 }), calledAs: "navigate", action };
    default: return null;
  }
}

function resolveData(d: Rec): UnifiedResolution | null {
  const domain = asStr(d.domain) ?? asStr(d.store);
  const action = asStr(d.action);
  if (domain === undefined || action === undefined) return null;
  const entry = granularEntry("data", action, domain);
  if (!entry) return null;
  const granular = entry.granularTool;
  if (domain === "clipboard") {
    if (action === "read") return { tool: granular, input: {}, calledAs: "data", action };
    if (action === "write") return { tool: granular, input: clean({ text: (d.text as string | undefined) ?? "" }), calledAs: "data", action };
    return null;
  }
  if (domain === "files") {
    if (action === "list") return { tool: granular, input: clean({ limit: (d.limit as number | undefined) ?? 100 }), calledAs: "data", action };
    if (action === "stat") return { tool: granular, input: clean({ id: d.id }), calledAs: "data", action };
    return null;
  }
  if (domain === "devtools") {
    const input = devtoolsCanonical(action, d);
    if (!input) return null;
    return { tool: granular, input, calledAs: "data", action };
  }
  if (domain === "bookmarks") {
    switch (action) {
      case "list": return { tool: granular, input: clean({ folderId: d.folderId, limit: (d.limit as number | undefined) ?? 100 }), calledAs: "data", action };
      case "search": return { tool: granular, input: clean({ query: (d.query as string | undefined) ?? "", limit: (d.limit as number | undefined) ?? 50 }), calledAs: "data", action };
      case "create": return { tool: granular, input: clean({ title: (d.title as string | undefined) ?? "", url: d.url, parentId: d.parentId }), calledAs: "data", action };
      case "create_folder": return { tool: granular, input: clean({ title: (d.title as string | undefined) ?? "", parentId: d.parentId, index: d.index }), calledAs: "data", action };
      case "move": return { tool: granular, input: clean({ id: d.id === undefined ? undefined : String(d.id), parentId: d.parentId, index: d.index }), calledAs: "data", action };
      case "update": return { tool: granular, input: clean({ id: d.id === undefined ? undefined : String(d.id), title: d.title, url: d.url }), calledAs: "data", action };
      case "delete": return { tool: granular, input: clean({ id: d.id === undefined ? undefined : String(d.id) }), calledAs: "data", action };
      default: return null;
    }
  }
  if (domain === "history") {
    switch (action) {
      case "search": return { tool: granular, input: clean({ text: (d.text as string | undefined) ?? (d.query as string | undefined) ?? "", startTime: d.startTime, endTime: d.endTime, maxResults: (d.maxResults as number | undefined) ?? (d.limit as number | undefined) ?? 50 }), calledAs: "data", action };
      case "add": return { tool: granular, input: clean({ url: d.url, title: d.title, transition: (d.transition as string | undefined) ?? "link" }), calledAs: "data", action };
      case "delete": return { tool: granular, input: clean({ urls: d.urls ?? [] }), calledAs: "data", action };
      default: return null;
    }
  }
  if (domain === "downloads") {
    switch (action) {
      case "list": return { tool: granular, input: clean({ limit: (d.limit as number | undefined) ?? 50, query: d.query }), calledAs: "data", action };
      case "start": return { tool: granular, input: clean({ url: d.url, filename: d.filename, saveAs: (d.saveAs as boolean | undefined) ?? false, conflictAction: d.conflictAction }), calledAs: "data", action };
      case "control": return { tool: granular, input: clean({ id: toId(d.id), action: (d.controlAction as string | undefined) ?? "pause" }), calledAs: "data", action };
      case "erase": return { tool: granular, input: clean({ ids: toIds(d.ids) }), calledAs: "data", action };
      default: return null;
    }
  }
  return null;
}

export function resolveUnifiedToolCall(tool: string, input: unknown): UnifiedResolution | null {
  const d = asRec(input);
  switch (tool) {
    case "browser": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("browser", action);
      if (!entry) return null;
      if (action === "search") {
        const anyIncludeGiven = d.includeHistory !== undefined || d.includeBookmarks !== undefined || d.includeTabs !== undefined;
        return {
          tool: entry.granularTool,
          input: clean({
            query: (d.query as string | undefined) ?? "",
            limit: (d.limit as number | undefined) ?? 20,
            includeHistory: anyIncludeGiven ? ((d.includeHistory as boolean | undefined) ?? true) : true,
            includeBookmarks: anyIncludeGiven ? ((d.includeBookmarks as boolean | undefined) ?? true) : true,
            includeTabs: anyIncludeGiven ? ((d.includeTabs as boolean | undefined) ?? true) : true,
          }),
          calledAs: tool,
          action,
        };
      }
      return { tool: entry.granularTool, input: {}, calledAs: tool, action };
    }
    case "tabs": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("tabs", action);
      const canonical = tabsCanonical(action, d);
      if (!entry || !canonical) return null;
      return { tool: entry.granularTool, input: canonical, calledAs: tool, action };
    }
    case "windows": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("windows", action);
      const canonical = windowsCanonical(action, d);
      if (!entry || !canonical) return null;
      return { tool: entry.granularTool, input: canonical, calledAs: tool, action };
    }
    case "navigate":
      return resolveNavigate(d);
    case "form": {
      const phase = asStr(d.phase) ?? asStr(d.action);
      if (phase === undefined) return null;
      const entry = granularEntry("form", phase);
      if (!entry) return null;
      switch (phase) {
        case "inspect": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId }), calledAs: tool, action: phase };
        case "preview": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, ref: d.ref ?? d.formRef }), calledAs: tool, action: phase };
        case "fill": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, fields: formFieldsCanonical(d.fields) ?? [] }), calledAs: tool, action: phase };
        case "upload": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, ref: d.ref, files: d.files ?? [] }), calledAs: tool, action: phase };
        case "set_file": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, selector: d.selector, ref: d.ref, fileId: d.fileId, files: d.files }), calledAs: tool, action: phase };
        case "submit": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, formRef: d.formRef ?? d.ref, expectedAction: d.expectedAction }), calledAs: tool, action: phase };
        default: return null;
      }
    }
    case "submit": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("submit", action);
      if (!entry) return null;
      switch (action) {
        case "submit": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, formRef: d.formRef, expectedAction: d.expectedAction }), calledAs: tool, action };
        case "upload": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, ref: d.ref, files: d.files ?? [] }), calledAs: tool, action };
        case "set_file": return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, selector: d.selector, ref: d.ref, fileId: d.fileId, files: d.files }), calledAs: tool, action };
        default: return null;
      }
    }
    case "devtools": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("devtools", action);
      const canonical = devtoolsCanonical(action, d);
      if (!entry || !canonical) return null;
      return { tool: entry.granularTool, input: canonical, calledAs: tool, action };
    }
    case "data":
      return resolveData(d);
    case "clipboard": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("clipboard", action);
      if (!entry) return null;
      if (action === "read") return { tool: entry.granularTool, input: {}, calledAs: tool, action };
      if (action === "write") return { tool: entry.granularTool, input: clean({ text: (d.text as string | undefined) ?? "" }), calledAs: tool, action };
      return null;
    }
    case "files": {
      const action = asStr(d.action);
      if (action === undefined) return null;
      const entry = granularEntry("files", action);
      if (!entry) return null;
      if (action === "list") return { tool: entry.granularTool, input: clean({ limit: (d.limit as number | undefined) ?? 100 }), calledAs: tool, action };
      if (action === "stat") return { tool: entry.granularTool, input: clean({ id: d.id }), calledAs: tool, action };
      return null;
    }
    case "wait": {
      const forValue = asStr(d.for);
      if (forValue === undefined) return null;
      const entry = granularEntry("wait", forValue);
      if (!entry) return null;
      if (forValue === "element") return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, by: (d.by as string | undefined) ?? "selector", selector: d.selector, value: d.value, role: d.role, name: d.name, timeoutMs: d.timeoutMs }), calledAs: tool, action: forValue };
      if (forValue === "network_idle") return { tool: entry.granularTool, input: clean({ tabId: d.tabId, frameId: d.frameId, quietMs: d.quietMs, timeoutMs: d.timeoutMs }), calledAs: tool, action: forValue };
      if (forValue === "navigation") return { tool: entry.granularTool, input: clean({ tabId: d.tabId, timeoutMs: d.timeoutMs, waitForNetworkIdle: (d.waitForNetworkIdle as boolean | undefined) ?? false, quietMs: d.quietMs }), calledAs: tool, action: forValue };
      return null;
    }
    default:
      // Granular tools, tasks tools, observe, and act: no single target.
      return null;
  }
}

/**
 * Implements the bridge *host* role: it consumes client protocol messages,
 * runs every tool call through the shared executor (policy + approvals + audit),
 * and emits host protocol messages back over the supplied transport. The gateway
 * is always the protocol client, so the permission model is identical for every
 * connected AI client.
 */
export class HostProtocolHandler {
  private client: ClientIdentity;
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: HostProtocolDeps) {
    this.client = deps.defaultClient ?? UNKNOWN_CLIENT;
  }

  getClient(): ClientIdentity {
    return this.client;
  }

  /**
   * Tools advertised to this client.
   *
   * The list is filtered through the policy engine, so a model never sees a
   * tool the current permission level refuses. The dashboard deliberately uses
   * the full registry instead, because it has to show what exists as well as
   * what is currently permitted.
   */
  visibleDescriptors(): ToolDescriptor[] {
    const unified = new Set(UNIFIED_TOOL_NAMES);
    return this.deps.registry.descriptors().filter((descriptor) => {
      const definition = this.deps.registry.get(descriptor.name);
      if (!definition) return false;
      if (this.deps.legacyTools !== true && !unified.has(descriptor.name)) return false;
      return this.deps.policy.allows(definition, this.client);
    });
  }

  async handle(message: BridgeClientMessage): Promise<void> {
    switch (message.type) {
      case "hello":
        this.onHello(message.id, message.protocolVersion, message.client);
        return;
      case "registry.list":
        this.deps.transport.post({ type: "registry.result", id: message.id, tools: this.visibleDescriptors() });
        return;
      case "ping":
        this.deps.transport.post({ type: "pong", id: message.id });
        return;
      case "approval.request":
        this.onApprovalRequest(message.id, message.tool, message.input, message.client);
        return;
      case "approval.respond":
        this.onApprovalRespond(message.id, message.approvalId, message.approved, message.reason);
        return;
      case "approval.wait":
        // Do not block the message loop: the dashboard decision can arrive at
        // any time, and other calls must keep flowing while we wait.
        void this.onApprovalWait(message.id, message.approvalId, message.timeoutMs);
        return;
      case "tool.call":
        await this.onToolCall(message);
        return;
      case "tool.call.batch":
        await this.onToolCallBatch(message);
        return;
      case "cancel": {
        this.inflight.get(message.targetId)?.abort(new ToolErrorException("CANCELLED", "Cancelled by client"));
        this.deps.transport.post({ type: "cancelled", id: message.id, targetId: message.targetId });
        return;
      }
      default:
        return;
    }
  }

  /** Release any in-flight work (used when the transport drops). */
  dispose(): void {
    for (const controller of this.inflight.values()) controller.abort(new ToolErrorException("CANCELLED", "Bridge closed"));
    this.inflight.clear();
  }

  private onHello(id: string, protocolVersion: string, client: ClientIdentity): void {
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.deps.transport.post({
        type: "hello.error",
        id,
        error: {
          code: "CONFLICT",
          message: `Protocol version mismatch: host=${PROTOCOL_VERSION} client=${protocolVersion}`,
          retryable: false,
        },
      });
      return;
    }
    this.client = client;
    this.deps.transport.post({
      type: "hello.ok",
      id,
      protocolVersion: PROTOCOL_VERSION,
      registryVersion: REGISTRY_VERSION,
      server: this.deps.server,
    });
  }

  private onApprovalRequest(id: string, tool: string, input: unknown, overrideClient?: ClientIdentity): void {
    let definition;
    try {
      definition = this.deps.registry.require(tool);
    } catch (error) {
      this.deps.transport.post({ type: "tool.error", id, error: toToolError(error) });
      return;
    }
    // Parse (and apply schema defaults) so the approval is fingerprinted against
    // the exact, canonical operation the executor will later consume. Otherwise
    // tools with defaulted fields would never match at approval-consume time.
    // Client approval flags are stripped first, so a fingerprint can never be
    // built over a self-asserted approval.
    // Phase 1 canonicalisation: a unified call is resolved BEFORE approval
    // handling, so the approval is created for the GRANULAR tool and
    // canonical input. An approval granted for tabs.list therefore cannot
    // authorise tabs.close: the broker fingerprint binds granular tool +
    // canonical input + client, and the executor consumes against exactly
    // those values. The unified name is kept only as a debug `calledAs`
    // field on the approval info, never used for any security decision.
    const sanitized = stripClientApprovalFlags(input) ?? {};
    const parsed = definition.input.safeParse(sanitized);
    const unifiedInput = parsed.success ? parsed.data : sanitized;
    const resolved = resolveUnifiedToolCall(tool, unifiedInput);
    const effTool = resolved?.tool ?? tool;
    const effInput = resolved?.input ?? unifiedInput;
    let effDefinition = definition;
    try {
      effDefinition = this.deps.registry.require(effTool);
    } catch {
      // Resolved granular tool missing from the registry: keep the unified
      // definition for title/risk rather than failing the approval request;
      // the executor will still refuse the unknown tool at call time.
    }
    const client = overrideClient ?? this.client;
    const risk = effTool === "act" || effTool === "submit" ? "consequential" : effDefinition.risk;
    const record = this.deps.approvals.create({
      tool: effTool,
      risk,
      summary: describeOperation(effTool, effInput),
      client,
      input: effInput,
    });
    const approval = toApprovalInfo(record, effDefinition.title, describeOperation(effTool, effInput));
    if (resolved) {
      (approval as ApprovalRequestInfo & { calledAs?: string }).calledAs = tool;
    }
    this.deps.transport.post({ type: "approval.requested", id, approval });
    this.emitEvent({ kind: "approval.pending", approval });
  }

  private onApprovalRespond(id: string, approvalId: string, approved: boolean, reason?: string): void {
    // The posted approval.resolved is a notification, never the source
    // of truth: the approval.wait poller reads the broker record
    // itself and posts its own resolved message from that. But when
    // the broker rejects this response (already decided/expired), the
    // old code still posted the REQUESTED value, telling the consumer
    // an approval was granted that the broker never recorded. On a
    // broker error, post the record's actual status when it is known;
    // when the record is gone, fall back to denied (the same outcome
    // the wait poller reports for a missing record) rather than
    // claiming the requested value.
    let resolved = approved;
    try {
      if (approved) this.deps.approvals.approve(approvalId, this.client.name);
      else this.deps.approvals.deny(approvalId, reason);
    } catch {
      const record = this.deps.approvals.get(approvalId);
      resolved = record?.status === "approved";
    }
    this.deps.transport.post({ type: "approval.resolved", id, approvalId, approved: resolved });
  }

  private async onApprovalWait(id: string, approvalId: string, timeoutMs?: number): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(id, controller);
    const deadline = Date.now() + Math.min(timeoutMs ?? 120_000, 120_000);
    let approved = false;
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        const record = this.deps.approvals.get(approvalId);
        if (!record) break;
        if (record.status === "approved") {
          approved = true;
          break;
        }
        if (record.status !== "pending") break;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          };
          timer = setTimeout(done, 250);
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      this.inflight.delete(id);
    }
    this.deps.transport.post({ type: "approval.resolved", id, approvalId, approved });
  }

  private async onToolCall(message: Extract<BridgeClientMessage, { type: "tool.call" }>): Promise<void> {
    // Phase 0 task tools are dispatched to the task runner, not the
    // executor: the runner owns the task lifecycle and runs each step
    // through the executor/policy/approval path itself. This intercept
    // keeps tasks.* out of the executor entirely, so dispatch can never
    // become an approval bypass or a direct step-execution path.
    if (message.tool.startsWith("tasks.")) {
      await this.onTaskCall(message);
      return;
    }
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    try {
      // Resolve BEFORE execution, with the same resolver the approval
      // path uses, so approval consumption, rate limiting, and audit all
      // see the granular tool + canonical input. The unified handler
      // still executes (tool stays the unified name); only the
      // security/audit identity is canonical.
      const stripped = stripClientApprovalFlags(message.input);
      const unifiedDef = this.deps.registry.get(message.tool);
      const unifiedParsed = unifiedDef?.input.safeParse(stripped ?? {});
      const resolved = resolveUnifiedToolCall(message.tool, unifiedParsed?.success ? unifiedParsed.data : stripped);
      const result = await this.deps.executor.execute({
        tool: message.tool,
        input: stripped,
        canonical: resolved ? { tool: resolved.tool, input: resolved.input, calledAs: message.tool } : undefined,
        client: message.client ?? this.client,
        ctx: this.deps.getContext(),
        approvalId: message.approvalId,
        dryRun: message.dryRun,
        signal: controller.signal,
        // Gateway-internal housekeeping arrives with no client: the
        // socket message only carries client when the gateway call had
        // one, and every real MCP call passes a client. A client-less
        // call is therefore never an AI client call — e.g. the
        // gateway's own tab-count probe behind the dashboard browsers
        // list — so its recording is suppressed with silentActivity:
        // it still executes and returns its result under the full
        // policy/approval/audit/rate-limit path, but emits no activity
        // row. Without this, every dashboard browsers refresh plants a
        // phantom "Checked tabs" row in the feed and history. NOTE: not
        // `internal` — internal would also bypass the TASK_REQUIRED
        // gate, and a client-less bridge call is not
        // extension-initiated, so a client-less action must still be
        // gated like any direct call.
        ...(message.client === undefined ? { silentActivity: true } : {}),
      });
      this.deps.transport.post({
        type: "tool.result",
        id: message.id,
        result: result.result,
        dryRun: result.dryRun,
        durationMs: result.durationMs,
      });
    } catch (error) {
      this.deps.transport.post({ type: "tool.error", id: message.id, error: toToolError(error) });
    } finally {
      this.inflight.delete(message.id);
    }
  }

  /**
   * Phase 0 task dispatch, mirroring tool.call's reply shape
   * (tool.result / tool.error) but routing to the task runner.
   *
   * - The tool name is matched against the registered tasks.* contracts;
   *   anything else under tasks.* is an unknown tool, not a runner call.
   * - Input is validated against the task contract (strict, so a
   *   client-supplied confirmation flag is rejected, never honoured).
   * - Client identity comes from the bridge client (message.client, else
   *   the hello identity); clientId is the client name, matching the
   *   runner port's ownership check.
   * - The runner's view is adapted to the bridge contract view (see
   *   toContractTaskView) and validated. A raw task record (step
   *   inputs, tokens, raw outputs, idempotency keys, policy snapshot)
   *   can never cross the bridge.
   * - With no runner wired, this fails with "task engine not wired"
   *   (UNSUPPORTED), never a silent success. With a runner but no
   *   policy-snapshot provider, create/resume fail closed with
   *   "task policy snapshot not wired" rather than inventing a scope.
   */
  private async onTaskCall(message: Extract<BridgeClientMessage, { type: "tool.call" }>): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    const startedAt = Date.now();
    try {
      const definition = taskTools.find((tool) => tool.name === message.tool);
      if (!definition) {
        throw new ToolErrorException("TOOL_NOT_FOUND", `Unknown tool ${message.tool}`);
      }
      const sanitized = stripClientApprovalFlags(message.input) ?? {};
      const parsed = definition.input.safeParse(sanitized);
      if (!parsed.success) {
        throw new ToolErrorException("INVALID_INPUT", `Invalid input for ${message.tool}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ")}`);
      }
      const runner = this.deps.tasks;
      if (!runner) {
        throw new ToolErrorException("UNSUPPORTED", "task engine not wired");
      }
      const client = message.client ?? this.client;
      // Task ownership is by bridge client id (the verified OAuth client
      // id when routed through the gateway), falling back to the client
      // name for direct bridge clients. Using the name alone would
      // collide when two OAuth clients share a name (e.g. two "Claude"
      // registrations), so the id is authoritative when present.
      const clientId = client.id && client.id !== "unknown" ? client.id : client.name;
      const input = parsed.data as Record<string, unknown>;
      const policySnapshot = (): PolicySnapshot => {
        const snapshot = this.deps.getTaskPolicySnapshot?.();
        if (!snapshot) {
          throw new ToolErrorException("UNSUPPORTED", "task policy snapshot not wired");
        }
        // The snapshot provider cannot know the current bridge client,
        // so dispatch stamps the actual client id here. Scope is left
        // as provided: the service-worker provider returns
        // "gateway-enforced" because the gateway does not forward OAuth
        // scope over the bridge, and the gateway's CallTool scope check
        // is the real scope gate for tasks.* (read:tools may only
        // get/list; create/pause/resume/cancel require call:tools).
        return { ...snapshot, clientId };
      };
      let view: TaskView;
      switch (message.tool) {
        case "tasks.create": {
          const browserSessionId = this.deps.getBrowserSessionId?.() ?? (typeof input.browserSessionId === "string" ? input.browserSessionId : undefined);
          // The runner requires a non-empty browser session: a task is
          // bound to one browser and never moves on its own.
          if (!browserSessionId) {
            throw new ToolErrorException("INVALID_INPUT", "tasks.create requires a browserSessionId (host session or input browserSessionId)");
          }
          const createInput: CreateTaskInput = {
            goal: String(input.goal),
            clientId,
            browserSessionId,
            steps: (input.steps as CreateTaskInput["steps"]) ?? [],
            ...(typeof input.totalBudgetMs === "number" ? { totalBudgetMs: input.totalBudgetMs } : {}),
            ...(typeof input.start === "boolean" ? { start: input.start } : {}),
            ...(input.bounds !== undefined ? { planBounds: input.bounds as PlanBounds } : {}),
            // Phase B: task mode pinned at creation (validated by the
            // tasks.create schema; the runner rejects unknown values).
            // This never changes the caller's session mode.
            ...(typeof input.mode === "string" ? { mode: input.mode as CreateTaskInput["mode"] } : {}),
          };
          // Phase 1 dry-run: validate the whole plan and return the
          // preview only — no task record is created, nothing executes.
          if (input.dryRun === true) {
            const preview = await runner.previewTask(createInput);
            this.deps.transport.post({
              type: "tool.result",
              id: message.id,
              result: toContractDryRunPreview(preview),
              dryRun: true,
              durationMs: Date.now() - startedAt,
            });
            return;
          }
          const created = await runner.createTask(createInput, policySnapshot());
          view = toContractTaskView(created);
          break;
        }
        case "tasks.appendSteps": {
          // Follow-up steps for an existing task: the runner validates
          // the steps, rejects terminal tasks, and queues the rest
          // behind unexecuted steps — no new task record is created.
          // No policy snapshot is needed: nothing executes here; the
          // appended steps face the per-step gates when the loop runs
          // them, exactly like created steps.
          const appended = await runner.appendSteps(
            String(input.taskId),
            clientId,
            (input.steps as CreateStepInput[]) ?? [],
          );
          view = toContractTaskView(appended);
          break;
        }
        case "tasks.approvePlan": {
          // Phase 1: the approval source is derived from transport, never
          // from client input. An MCP caller must carry a broker approval
          // token as the message's approvalId; without one this fails
          // closed. Dashboard decisions do not come through this path.
          const approvalId = message.approvalId;
          if (typeof approvalId !== "string" || approvalId === "") {
            throw new ToolErrorException(
              "APPROVAL_DENIED",
              "tasks.approvePlan requires a broker approval token (approvalId); client-supplied approval flags are never accepted",
            );
          }
          const approved = await runner.approvePlan(String(input.taskId), clientId, {
            source: "broker-token",
            approvalTokenId: approvalId,
            ...(input.bounds !== undefined ? { bounds: input.bounds as PlanBounds } : {}),
          });
          view = toContractTaskView(approved);
          break;
        }
        case "tasks.get":
          view = toContractTaskView(await runner.getTask(String(input.taskId), clientId));
          break;
        case "tasks.list": {
          const browserSessionId = this.deps.getBrowserSessionId?.() ?? (typeof input.browserSessionId === "string" ? input.browserSessionId : undefined);
          const views = await runner.listTasks(clientId, browserSessionId);
          this.deps.transport.post({ type: "tool.result", id: message.id, result: { tasks: views.map(toContractTaskView) }, dryRun: false, durationMs: Date.now() - startedAt });
          return;
        }
        case "tasks.pause":
          view = toContractTaskView(await runner.pauseTask(String(input.taskId), clientId, typeof input.reason === "string" ? input.reason : "paused"));
          break;
        case "tasks.resume":
          // Phase 3 binding: when the host knows its browser session,
          // the runner refuses to run a task bound to another session.
          view = toContractTaskView(await runner.resumeTask(String(input.taskId), clientId, policySnapshot(), this.deps.getBrowserSessionId?.()));
          break;
        case "tasks.cancel":
          view = toContractTaskView(await runner.cancelTask(String(input.taskId), clientId));
          break;
        default:
          throw new ToolErrorException("TOOL_NOT_FOUND", `Unknown tool ${message.tool}`);
      }
      this.deps.transport.post({
        type: "tool.result",
        id: message.id,
        result: view,
        dryRun: false,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.deps.transport.post({ type: "tool.error", id: message.id, error: toToolError(error) });
    } finally {
      this.inflight.delete(message.id);
    }
  }

  /**
   * A batch is one bridge round trip for several independent reads. The host is
   * still the authority: every item goes through the executor, and anything
   * above read-only risk is refused even if the gateway asks.
   */
  private async onToolCallBatch(message: ToolCallBatchMessage): Promise<void> {
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    const results: ToolBatchItemResult[] = [];
    try {
      for (const call of message.calls) {
        if (controller.signal.aborted) {
          results.push({
            tool: call.tool,
            ok: false,
            error: toToolError(new ToolErrorException("CANCELLED", "Operation cancelled")),
          });
          continue;
        }
        const definition = this.deps.registry.get(call.tool);
        if (!definition) {
          results.push({
            tool: call.tool,
            ok: false,
            error: toToolError(new ToolErrorException("NOT_FOUND", `Unknown tool ${call.tool}`)),
          });
          continue;
        }
        // Resolve each batch item canonically, exactly as a single call
        // is resolved: the read-only-only rule is judged on the GRANULAR
        // risk, so a unified tabs.list item is allowed while a unified
        // tabs.close item is refused, as before for granular tools.
        const batchStripped = stripClientApprovalFlags(call.input);
        const batchParsed = definition.input.safeParse(batchStripped ?? {});
        const batchResolved = resolveUnifiedToolCall(call.tool, batchParsed.success ? batchParsed.data : batchStripped);
        const effDefinition = batchResolved ? this.deps.registry.get(batchResolved.tool) : definition;
        const effRisk = effDefinition?.risk;
        if (!effDefinition || effRisk !== "read-only") {
          results.push({
            tool: call.tool,
            ok: false,
            error: toToolError(
              new ToolErrorException("PERMISSION_DENIED", "Batch calls are limited to read-only tools", {
                details: batchResolved
                  ? { risk: effRisk ?? "unknown", tool: batchResolved.tool, calledAs: call.tool, action: batchResolved.action }
                  : { risk: definition.risk },
              }),
            ),
          });
          continue;
        }
        try {
          const result = await this.deps.executor.execute({
            tool: call.tool,
            input: batchStripped,
            canonical: batchResolved ? { tool: batchResolved.tool, input: batchResolved.input, calledAs: call.tool } : undefined,
            client: message.client ?? this.client,
            ctx: this.deps.getContext(),
            approvalId: call.approvalId,
            dryRun: call.dryRun,
            signal: controller.signal,
            // Same gateway-internal rule as a single call: a client-less
            // batch is housekeeping, not an AI client call, so its items
            // execute and return but emit no activity rows. silentActivity
            // (not internal) so the TASK_REQUIRED gate still applies.
            ...(message.client === undefined ? { silentActivity: true } : {}),
          });
          results.push({
            tool: call.tool,
            ok: true,
            result: result.result,
            dryRun: result.dryRun,
            durationMs: result.durationMs,
          });
        } catch (error) {
          results.push({ tool: call.tool, ok: false, error: toToolError(error) });
        }
      }
      this.deps.transport.post({ type: "tool.batch.result", id: message.id, results });
    } finally {
      this.inflight.delete(message.id);
    }
  }

  private emitEvent(event: BridgeEvent): void {
    this.deps.onEvent?.(event);
    this.deps.transport.post({ type: "event", event });
  }
}

function toApprovalInfo(
  record: { id: string; tool: string; risk: ApprovalRequestInfo["risk"]; client: ClientIdentity; createdAt: number; expiresAt: number; target?: ApprovalRequestInfo["target"] },
  title: string,
  summary: string,
): ApprovalRequestInfo {
  return {
    id: record.id,
    tool: record.tool,
    title,
    summary,
    risk: record.risk,
    target: record.target,
    client: record.client,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}
