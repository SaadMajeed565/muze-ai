import { REGISTRY_VERSION, UNIFIED_TOOL_NAMES, type BridgeEvent, type ToolDescriptor } from "../libs/tool-contracts/index.js";
import { AuditLog, ApprovalBroker, PolicyEngine, RateLimiter } from "../libs/security/index.js";
import { ChromeWorkingTabGroup, ToolExecutor, createToolRegistry } from "../libs/browser-engine/index.js";
import { BridgeManager } from "./bridge-manager.js";
import {
  applyDeltaToCache,
  isLastRefreshFailed,
  readBrowsersCache,
  refreshBrowsersCache,
  setLastRefreshFailed,
  writeBrowsersCache,
} from "./browsers-cache.js";
import { ChromeBrowserContext } from "./chrome-context.js";
import { ChromeOffscreenMessenger } from "./offscreen-messenger.js";
import {
  browserInfoFromUserAgent,
  fetchGatewayStatus,
  gatewayMcpUrl,
  isGatewayAuthError,
  normalizeGatewayUrl,
  rotateDeviceToken,
  reuseBrowserSession,
  signInWithEmailPassword,
  signUpWithEmailPassword,
  type BrowserInfo,
  type GatewayAccount,
} from "./gateway-client.js";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient, DashboardRequest, DashboardResponse, DashboardSnapshot, DashboardState, GatewayInfo } from "./messages.js";
import { LEGACY_OFFSCREEN_TARGET, OFFSCREEN_TARGET } from "./messages.js";
import { prefetchFaviconForTab } from "./favicon-cache.js";
import {
  DEFAULT_BRIDGE_SETTINGS,
  GATEWAY_URL,
  loadBridgeSettings,
  loadOnboarding,
  loadPolicy,
  saveBridgeSettings,
  saveOnboarding,
  savePolicy,
  type BridgeSettings,
  type OnboardingState,
} from "./storage.js";
import { putFile, getFile, listFiles, removeFile } from "../libs/files/index.js";
import {
  TaskRunner,
  createChromeTaskStore,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskStep,
  type TaskView as RunnerTaskView,
} from "../libs/tasks/index.js";
import {
  handleTaskDashboardRequest,
  type TaskDashboardPort,
  type TaskView as DashboardTaskView,
} from "./task-dashboard.js";

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const SERVER_INFO = { name: "muze-extension", version: "0.5.0" };

/**
 * Mask a secret for display: bullet mask + last 4 characters only. Same
 * algorithm as the dashboard's `maskToken` (dashboard/logic.ts); kept here so
 * the service worker never has to hand the dashboard a full token to mask.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${"•".repeat(8)}${trimmed.slice(-4)}`;
}

/**
 * Normalise a dashboard request type to its canonical "muze/*" form.
 * Returns null for anything that is not a dashboard request. The legacy
 * "uabb/*" spelling is accepted inbound and treated identically; the
 * dashboard only ever emits "muze/*".
 */
export function normalizeDashboardRequestType(type: unknown): string | null {
  if (typeof type !== "string") return null;
  if (type.startsWith("muze/") || type.startsWith("uabb/")) return `muze/${type.slice(5)}`;
  return null;
}

/**
 * Dashboard routes that change state the user cares about, and therefore
 * require a positively identified extension sender (see
 * `isTrustedDashboardSender`). This is every route in `handleRequest`
 * except the read-only set below: policy/kill-switch changes, approval
 * decisions, bridge/gateway session changes, onboarding changes, file
 * adds/removes, browser default/rename/disconnect/remove, MCP-client
 * revocation, and task pause/resume/cancel/plan-approval. The legacy
 * "uabb/*" spelling is normalised to "muze/*" before this check, so it
 * is guarded identically.
 */
export const CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "muze/policy/update",
  "muze/policy/mode",
  "muze/policy/tool",
  "muze/policy/reset",
  "muze/policy/group",
  "muze/policy/readonly",
  "muze/killswitch",
  "muze/approval/respond",
  "muze/approvals/cancel-for-client",
  "muze/bridge/settings",
  "muze/bridge/reconnect",
  "muze/gateway/sign-in",
  "muze/gateway/sign-in-email",
  "muze/gateway/sign-up-email",
  "muze/gateway/delete-account",
  "muze/gateway/sign-out",
  "muze/gateway/rotate",
  "muze/onboarding/set",
  "muze/files/attach",
  "muze/files/remove",
  "muze/browsers/set-default",
  "muze/browsers/rename",
  "muze/browsers/disconnect",
  "muze/browsers/remove",
  "muze/mcp-sessions/revoke",
  "muze/tasks.pause",
  "muze/tasks.resume",
  "muze/tasks.cancel",
  "muze/tasks.approvePlan",
]);

/**
 * Dashboard routes that do not change user state and keep the previous
 * behaviour (any sender, including an undefined sender.id, may read):
 * state/audit snapshots, file and browser listings and file reads, the
 * browsers-cache refresh (a re-read that only rewrites the derived
 * cache), and task listings/reads. `muze/browsers/refresh` is deliberately
 * here, not in the consequential set: it fetches the same account data
 * `muze/browsers/list` serves and changes no account, policy or session
 * state. `muze/bridge/reconnect`, by contrast, is consequential: it
 * re-dials the gateway, so it is guarded even though it stores nothing.
 */
export const READ_ONLY_DASHBOARD_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "muze/state",
  "muze/audit",
  "muze/files/list",
  "muze/files/get",
  "muze/browsers/list",
  "muze/browsers/refresh",
  "muze/tasks.list",
  "muze/tasks.get",
]);

export function isConsequentialDashboardRequestType(type: string): boolean {
  return CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES.has(type);
}

/**
 * A sender is positively identified as this extension only when its id
 * is defined AND equals the runtime id. This is deliberately fail-closed:
 * an undefined sender.id, an undefined runtime id, and a foreign id all
 * fail. In a real Chrome install `chrome.runtime.id` is always defined
 * for extension contexts, so the dashboard (side panel and options page,
 * both served from `dashboard/index.html` via `sendRequest`) always
 * passes; only callers that cannot prove they are this extension fail.
 */
export function isTrustedDashboardSender(senderId: string | undefined, runtimeId: string | undefined): boolean {
  return senderId !== undefined && runtimeId !== undefined && senderId === runtimeId;
}

/** Read-only routes keep current behaviour; consequential routes require a trusted sender. */
export function isDashboardSenderAllowedForRequest(
  type: string,
  senderId: string | undefined,
  runtimeId: string | undefined,
): boolean {
  return !isConsequentialDashboardRequestType(type) || isTrustedDashboardSender(senderId, runtimeId);
}

/**
 * MV3 service workers are suspended when idle, which tears down the gateway
 * WebSocket. These alarms wake the worker before that happens (30s matches the
 * worker idle timeout) so it can reconnect, keeping the bridge alive across
 * suspensions.
 */
const GATEWAY_KEEPALIVE_ALARM = "muze-gateway-keepalive";
/** Legacy alarm name, cleared once so a renamed alarm cannot linger. */
const LEGACY_GATEWAY_KEEPALIVE_ALARM = "uabb-gateway-keepalive";
const GATEWAY_KEEPALIVE_PERIOD_MINUTES = 0.5;

const registry = createToolRegistry();
const policy = new PolicyEngine();
const approvals = new ApprovalBroker({ ttlMs: 120_000 });
const audit = new AuditLog({ maxEvents: 1000, onRecord: () => notifyDashboard({ kind: "audit" }) });
const rateLimiter = new RateLimiter({ capacity: 120, refillPerSecond: 20 });
const context = new ChromeBrowserContext(new ChromeOffscreenMessenger());

let manager: BridgeManager | null = null;
let activeSettings: BridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS };
let onboarding: OnboardingState = { completed: false, step: 1 };
/** Set when the gateway rejects the stored token; cleared by a new sign-in. */
let gatewayAuthRequired = false;
let gatewayAuthToken = "";

const executor = new ToolExecutor({
  registry,
  policy,
  approvals,
  audit,
  rateLimiter,
  runtime: () => ({
    bridgeStatus: manager?.isConnected() ? "connected" : "disconnected",
    connectedClients: manager?.clientCount() ?? 0,
  }),
});

/**
 * Surface the number of waiting approvals on the toolbar icon. Approvals are
 * the one thing a user has to answer for, and they expire after 120s, so they
 * have to be visible even while the panel is closed.
 */
/**
 * Phase 0 task engine wiring (0.4.0). The task runner is the only task
 * owner: it lives in the service worker, its state lives in
 * chrome.storage.local under "muze.tasks", and every step it runs goes
 * through the same ToolExecutor (policy + approval + audit) as a single
 * tool call. The gateway never executes a step; it only forwards
 * tasks.* calls to host dispatch, which calls this runner.
 *
 * Two honest limits are documented here because they shape the code:
 * - OAuth scope is NOT forwarded over the bridge (the gateway checks
 *   scope at CallTool time and does not put it in the bridge client
 *   identity), so the task policy snapshot's scope is the constant
 *   "gateway-enforced". The extension enforces client identity
 *   (bridge client id, stamped by host dispatch), policy version, and
 *   permission mode on every step; the gateway enforces OAuth scope
 *   before any tasks.* call reaches this runner.
 * - Re-observation for an unknown consequential step is conservative:
 *   a navigation step is confirmed only if the tab's current URL
 *   matches the step's target URL, a read-only step may safely
 *   re-execute, and any other consequential step whose effect cannot
 *   be confirmed throws, so the runner pauses with
 *   "reobserve-failed" instead of blindly re-executing a click or
 *   submit that may already have happened.
 */
let taskRunner: TaskRunner | null = null;

function toDashboardTaskView(view: RunnerTaskView): DashboardTaskView {
  return {
    id: view.id,
    goal: view.goal,
    clientId: view.clientId,
    browserSessionId: view.browserSessionId,
    status: view.status,
    steps: view.steps.map((step) => ({
      index: step.index,
      tool: step.tool,
      inputSummary: step.inputSummary,
      state: step.state === "unknown" ? "pending" : step.state,
      attempts: step.attempts,
      outputSummary: step.outputSummary,
      ...(step.outsideBoundsReason !== null && step.outsideBoundsReason !== undefined
        ? { outsideBoundsReason: step.outsideBoundsReason }
        : {}),
    })),
    totalSteps: view.steps.length,
    doneSteps: view.steps.filter((step) => step.state === "done").map((step) => step.index),
    undoneSteps: view.steps.filter((step) => step.state !== "done").map((step) => step.index),
    totalBudgetMs: view.totalBudgetMs,
    correlationId: view.correlationId,
    resultSummary: view.resultSummary,
    // Mode and child status pass through: the dashboard types accept
    // both (mode?, isChild?), and dropping them made deriveLoopStatus
    // always see mode "act" and child:false. The parent id itself is
    // never exposed — only the boolean, matching the dashboard type's
    // documented rule.
    ...(view.mode ? { mode: view.mode } : {}),
    ...(view.parentId ? { isChild: true } : {}),
    ...(view.finalReport ? { finalReport: view.finalReport } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    completedAt: view.completedAt ?? 0,
    ...(view.resumeAfterMs !== null ? { resumeAfterMs: view.resumeAfterMs } : {}),
    ...(view.pauseReason !== null ? { pauseReason: view.pauseReason } : {}),
  };
}

function getTaskRunner(): TaskRunner {
  if (taskRunner) return taskRunner;
  let store;
  try {
    store = createChromeTaskStore();
  } catch {
    // Non-extension hosts (tests, tooling) have no chrome.storage.local;
    // fall back to an in-memory store so the runner still works, with
    // the durability caveat that a restart then loses task state.
    store = createMemoryTaskStore();
  }
  taskRunner = new TaskRunner({
    store,
    // Automatic working tabs: a task's tabs join the "Muze AI" group
    // while it runs, and are ungrouped (left open) when it ends.
    workingGroup: new ChromeWorkingTabGroup(context),
    executeStep: async (tool, input, ctx) => {
      const result = await executor.execute({
        tool,
        input,
        client: { id: ctx.clientId, name: ctx.clientId, transport: "remote" },
        ctx: context,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        // Plan approval is internal only: runner verified an active,
        // in-bounds plan approval (broker/dashboard/elicitation) before
        // setting this. It is never derived from MCP tool input, and
        // policy checks still run per tool in the executor.
        ...(ctx.planApproved ? { planApproved: true } : {}),
      });
      const raw = result.result;
      const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
      return { outputSummary: text };
    },
    audit: (entry) => {
      // Runner audit kinds are task-specific; AuditLog kinds are a
      // closed union, so map onto tool.call with the task identity in
      // details (redacted by AuditLog; never inputs, never outputs).
      audit.record({
        kind: "tool.call",
        tool: entry.tool || undefined,
        decision: entry.decision === "failed" ? "error" : entry.decision === "approval-required" ? "approval-required" : "allowed",
        outcome: entry.outcome === "success" ? "success" : entry.outcome === "failure" ? "failure" : undefined,
        details: { taskId: entry.taskId, stepIndex: entry.stepIndex, decision: entry.decision, outcome: entry.outcome },
      });
    },
    progress: (view) => {
      const done = view.steps.filter((step) => step.state === "done").length;
      notifyDashboard({
        kind: "task.progress",
        taskId: view.id,
        status: view.status,
        stepIndex: done,
        totalSteps: view.steps.length,
      });
    },
    policySnapshot: () => getTaskPolicySnapshot(),
    toolRisk: (tool) => registry.get(tool)?.risk,
    toolExists: (tool) => registry.has(tool),
    validateStepInput: (tool, input) => {
      const definition = registry.get(tool);
      if (!definition) return [`unknown tool ${tool}`];
      const parsed = definition.input.safeParse(input);
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    },
    verifyApprovalToken: (tokenId, clientId) => {
      // Single-use, bound to tasks.approvePlan: the record must be an
      // approved broker approval for tasks.approvePlan, for the same
      // client when the caller supplies one, and is then burned so it
      // cannot approve a second plan.
      const record = approvals.get(tokenId);
      if (!record || record.status !== "approved" || record.tool !== "tasks.approvePlan") return false;
      if (clientId !== undefined && record.client.id !== clientId) return false;
      return approvals.markUsed(tokenId);
    },
    // Phase B per-iteration tool resolution: existence + live policy
    // (the runner already applied its mode gate). Approval is NOT
    // decided here — the executor still enforces approval per step.
    resolveTool: (tool, context) => {
      const definition = registry.get(tool);
      if (!definition) return { allowed: false, reason: `tool "${tool}" does not exist` };
      if ((context.mode === "read" || context.mode === "explore") && definition.risk !== "read-only") {
        return { allowed: false, reason: `tool "${tool}" is not read-only and not allowed in mode "${context.mode}"` };
      }
      const stepInput = context.step.input as Record<string, unknown>;
      const targetUrl = typeof stepInput.url === "string" ? stepInput.url : undefined;
      const decision = policy.decide(definition, { id: context.clientId, name: context.clientId, transport: "remote" }, targetUrl ? { url: targetUrl } : {});
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason || `tool "${tool}" is denied by policy` };
    },
    // Phase B snapshot checkpoint: bounded observe (no screenshot),
    // counts + URL only — never node text or page content.
    captureSnapshot: async (step, signal) => {
      const input = step.input as Record<string, unknown>;
      const tabId = typeof input.tabId === "number" ? input.tabId : undefined;
      const observed = await executor.execute({
        tool: "observe",
        input: { ...(tabId !== undefined ? { tabId } : {}), include: ["metadata", "a11y", "forms"], maxNodes: 200 },
        client: { id: "task-runner", name: "task-runner", transport: "native" },
        ctx: context,
        ...(signal ? { signal } : {}),
      });
      const out = observed.result as Record<string, unknown>;
      const metadata = out.metadata as { title?: string; url?: string } | undefined;
      const nodes = Array.isArray(out.nodes) ? out.nodes : [];
      const forms = Array.isArray(out.forms) ? (out.forms as { fields?: unknown[] }[]) : [];
      const fieldCount = forms.reduce((total, form) => total + (Array.isArray(form.fields) ? form.fields.length : 0), 0);
      return {
        url: metadata?.url ?? null,
        a11ySummary: `${nodes.length} accessibility nodes observed`,
        formSummary: `${forms.length} forms, ${fieldCount} fields observed`,
      };
    },
    // Phase B post-step verify observation: same observe machinery as
    // preStepObserve, run after the step. The runner evaluates the
    // step's generic verify condition against url/targetPresent.
    postStepObserve: async (step, signal) => {
      const input = step.input as Record<string, unknown>;
      const tabId = typeof input.tabId === "number" ? input.tabId : undefined;
      const observed = await executor.execute({
        tool: "observe",
        input: { ...(tabId !== undefined ? { tabId } : {}), include: ["metadata", "a11y"], maxNodes: 200 },
        client: { id: "task-runner", name: "task-runner", transport: "native" },
        ctx: context,
        ...(signal ? { signal } : {}),
      });
      const out = observed.result as Record<string, unknown>;
      const metadata = out.metadata as { title?: string; url?: string } | undefined;
      const summary = metadata?.title ? `${metadata.title} (${metadata.url ?? ""})` : "Tab observed after step.";
      let targetPresent: boolean | null = null;
      if (step.verify?.kind === "element-present") {
        const ref = typeof step.verify.value === "string" ? step.verify.value : typeof input.ref === "string" ? input.ref : undefined;
        if (ref !== undefined) {
          const nodes = Array.isArray(out.nodes) ? (out.nodes as { ref?: string }[]) : [];
          const forms = Array.isArray(out.forms) ? (out.forms as { fields?: { ref?: string }[] }[]) : [];
          targetPresent =
            nodes.some((node) => node.ref === ref) ||
            forms.some((form) => (form.fields ?? []).some((field) => field.ref === ref));
        }
        // No ref anywhere to check: null = unconfirmed, and the runner
        // fails the verify fail-closed instead of guessing.
      }
      return { url: metadata?.url ?? null, targetPresent, summary };
    },
    preStepObserve: async (step, signal) => {
      // Real re-observation via the executor (read-only observe, no
      // screenshot): if the step carries a dom ref, that ref must still
      // appear in the accessibility tree or forms; selector-only and
      // ref-less steps rely on the tab gate above and pass.
      const input = step.input as Record<string, unknown>;
      const tabId = typeof input.tabId === "number" ? input.tabId : undefined;
      const ref = typeof input.ref === "string" ? input.ref : undefined;
      try {
        const observed = await executor.execute({
          tool: "observe",
          input: { ...(tabId !== undefined ? { tabId } : {}), include: ["metadata", "a11y"], maxNodes: 200 },
          client: { id: "task-runner", name: "task-runner", transport: "native" },
          ctx: context,
          ...(signal ? { signal } : {}),
        });
        const out = observed.result as Record<string, unknown>;
        const metadata = out.metadata as { title?: string; url?: string } | undefined;
        const summary = metadata?.title ? `${metadata.title} (${metadata.url ?? ""})` : "Tab observed before step.";
        if (!ref) return { refValid: true, summary };
        const nodes = Array.isArray(out.nodes) ? (out.nodes as { ref?: string }[]) : [];
        const forms = Array.isArray(out.forms) ? (out.forms as { fields?: { ref?: string }[] }[]) : [];
        const found =
          nodes.some((node) => node.ref === ref) ||
          forms.some((form) => (form.fields ?? []).some((field) => field.ref === ref));
        return found
          ? { refValid: true, summary: `Ref ${ref} still present. ${summary}` }
          : { refValid: false, summary: `Ref ${ref} no longer present. ${summary}` };
      } catch (error) {
        throw new Error(`pre-step observe failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    tabChecker: async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        return { exists: true, url: tab.url ?? null };
      } catch {
        return { exists: false, url: null };
      }
    },
    reobserve: async (step: TaskStep) => {
      const input = step.input as Record<string, unknown>;
      const tabId = typeof input.tabId === "number" ? input.tabId : null;
      if (tabId !== null) {
        try {
          const tab = await chrome.tabs.get(tabId);
          const targetUrl = typeof input.url === "string" ? input.url : null;
          if (targetUrl && tab.url === targetUrl) {
            return { effectObserved: true, summary: `Tab ${tabId} is at the step target URL.` };
          }
        } catch {
          return { effectObserved: false, summary: `Tab ${tabId} no longer exists.` };
        }
      }
      // Read-only steps are safe to re-execute; consequential steps
      // whose effect cannot be confirmed must not be blindly retried.
      const definition = registry.get(step.tool);
      if (definition && definition.risk === "read-only") {
        return { effectObserved: false, summary: "Read-only step; safe to re-execute." };
      }
      throw new Error(`cannot confirm effect of consequential step ${step.index} (${step.tool}); manual check required`);
    },
    isConsequential: (tool) => {
      const definition = registry.get(tool);
      if (!definition) return false;
      return definition.risk === "consequential" || tool === "act" || tool === "submit";
    },
  });
  return taskRunner;
}

function getTaskPolicySnapshot(): PolicySnapshot {
  return {
    policyVersion: policy.getVersion(),
    mode: policy.getMode(),
    // Stamped with the real bridge client id by host dispatch; the
    // empty value here is never stored, because dispatch overwrites it.
    clientId: "",
    // See the header note above: scope is enforced at the gateway,
    // not forwarded over the bridge.
    scope: "gateway-enforced",
  };
}

async function taskDashboardPort(): Promise<TaskDashboardPort> {
  const runner = getTaskRunner();
  const withClient = async (id: string): Promise<{ clientId: string }> => {
    const all = await runner.listAllTasks();
    const found = all.find((task) => task.id === id);
    if (!found) throw new Error(`task not found: ${id}`);
    return { clientId: found.clientId };
  };
  return {
    listTasks: async () => (await runner.listAllTasks()).map(toDashboardTaskView),
    getTask: async (id) => toDashboardTaskView(await runner.getTask(id, (await withClient(id)).clientId)),
    pauseTask: async (id, reason) =>
      toDashboardTaskView(await runner.pauseTask(id, (await withClient(id)).clientId, reason ?? "paused")),
    resumeTask: async (id) => {
      const { clientId } = await withClient(id);
      // Stamp the owning client id, as host dispatch does for MCP calls.
      return toDashboardTaskView(await runner.resumeTask(id, clientId, { ...getTaskPolicySnapshot(), clientId }));
    },
    cancelTask: async (id) => toDashboardTaskView(await runner.cancelTask(id, (await withClient(id)).clientId)),
    approvePlan: async (id, bounds) =>
      toDashboardTaskView(
        await runner.approvePlan(id, (await withClient(id)).clientId, {
          source: "dashboard",
          ...(bounds !== undefined ? { bounds } : {}),
        }),
      ),
  };
}

function syncActionBadge(): void {
  const pending = approvals.pendingCount();
  const text = pending <= 0 ? "" : pending > 9 ? "9+" : String(pending);
  void chrome.action?.setBadgeText?.({ text });
  if (pending > 0) void chrome.action?.setBadgeBackgroundColor?.({ color: "#b42318" });
}

function notifyDashboard(event: BridgeEvent): void {
  syncActionBadge();
  chrome.runtime.sendMessage({ type: "muze/event", event }).catch(() => undefined);
}

function broadcastEvent(event: BridgeEvent): void {
  manager?.broadcast({ type: "event", event });
  notifyDashboard(event);
}

function buildManager(): BridgeManager {
  return new BridgeManager({
    registry,
    policy,
    approvals,
    executor,
    getContext: () => context,
    server: SERVER_INFO,
    legacyTools: false,
    onEvent: notifyDashboard,
    onConnectionsChanged: () => {
      // Socket (re)connected: refresh the browsers cache in the
      // background. The guard matters because this callback also fires
      // on register (before the socket is up) and on disconnect.
      if (!activeSettings.gatewayToken) return;
      if (!manager?.isConnected()) return;
      void refreshBrowsersCache(loadBrowsersDashboard, () => notifyDashboard({ kind: "browsers.changed" })).catch(() => undefined);
    },
    onBrowsersDelta: (delta) => {
      void applyDeltaToCache(delta).then(() => notifyDashboard({ kind: "browsers.changed" }));
    },
    onAuthFailure: (reason) => markGatewayAuthRequired(activeSettings.gatewayToken, reason),
    tasks: getTaskRunner(),
    getBrowserSessionId: () => (activeSettings.gatewaySessionId ? activeSettings.gatewaySessionId : undefined),
    getTaskPolicySnapshot: () => getTaskPolicySnapshot(),
  });
}

const OFFSCREEN_HTML = "offscreen.html";

async function ensureKeepAliveDocument(wanted: boolean): Promise<void> {
  if (!chrome.offscreen?.createDocument) return;
  try {
    const has = (await chrome.offscreen.hasDocument?.()) ?? false;
    if (wanted && !has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_HTML,
        reasons: [chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.BLOBS],
        justification: "Keep service worker alive and provide canvas/clipboard DOM access.",
      });
    } else if (!wanted && has) {
      // Previously there was no close path: signing out (which calls
      // syncKeepAlive with gatewayEnabled=false) left the offscreen
      // document — and its 20s keepalive pings — alive indefinitely.
      // closeDocument may be absent from older chrome typings, so it is
      // called through a guarded cast, never assumed present.
      const offscreen = chrome.offscreen as typeof chrome.offscreen & {
        closeDocument?: () => Promise<void>;
      };
      await offscreen.closeDocument?.();
    }
  } catch {
    // Ignore if already created/closed or offscreen is unsupported in current environment
  }
}

/**
 * Keep the worker (and thus the gateway socket) alive only while a gateway is
 * configured. Called from every path that changes the bridge settings.
 *
 * Uses a persistent offscreen document that sends 20s keepalive pings (immune
 * to MV3 30s idle termination), plus alarm fallback for environments without
 * offscreen support.
 */
function syncKeepAlive(settings: BridgeSettings): void {
  const wanted = settings.gatewayEnabled && Boolean(settings.gatewayToken);
  void ensureKeepAliveDocument(wanted);
  try {
    // Clear the legacy alarm name once: renaming without this would leave
    // the old 30s alarm firing (and waking the worker) forever.
    chrome.alarms.clear(LEGACY_GATEWAY_KEEPALIVE_ALARM).catch(() => undefined);
    if (wanted) {
      chrome.alarms.create(GATEWAY_KEEPALIVE_ALARM, { periodInMinutes: GATEWAY_KEEPALIVE_PERIOD_MINUTES });
    } else {
      chrome.alarms.clear(GATEWAY_KEEPALIVE_ALARM);
    }
  } catch {
    // Alarms unavailable (older runtime): fall back to reconnect-on-startup.
  }
}

function markGatewayAuthRequired(token: string, reason: string): void {
  gatewayAuthRequired = true;
  // Held in service-worker memory only, for the "same token already failed"
  // latch in connectGateway. It is never written to an audit event, to
  // dashboard state, or to any log (the audit redactor would strip a field
  // named "token" anyway, but no such field is ever recorded here).
  gatewayAuthToken = token;
  audit.record({
    kind: "client.connect",
    decision: "denied",
    details: { gateway: GATEWAY_URL, authRequired: true, error: reason },
  });
}

/**
 * Map a gateway auth failure to one plain sentence for the dashboard.
 * Gateway messages are already plain ("Invalid email or password."),
 * but the browser-limit wording is technical, so it is rewritten here
 * rather than shown raw.
 */
function plainAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid email or password/i.test(message)) return "Wrong email or password.";
  if (/already exists/i.test(message)) return "That email already has an account.";
  if (/browser limit/i.test(message)) return "You already have 10 browsers attached. Remove one, then try again.";
  if (/timed out/i.test(message)) return "The gateway did not respond. Check the connection and try again.";
  if (/valid email/i.test(message)) return "Enter a valid email address.";
  if (/at least 8 characters/i.test(message)) return "Use a password with at least 8 characters.";
  return message || "Sign-in failed. Try again.";
}

/**
 * Dial the gateway. The token is checked over HTTPS *before* opening the
 * socket: a revoked token then produces a clear sign-in prompt instead of a
 * reconnect loop. Network/preflight outages still attempt the socket, which
 * owns its own backoff. Once auth has failed for a token, repeated keepalive
 * alarms are ignored until the user signs in again.
 */
let connectGatewayInFlight: Promise<void> | null = null;
/**
 * The single pending offline-resume listener, if one is registered.
 * Previously every offline connectGateway call registered a new `online`
 * listener before the single-flight check, stacking listeners that all
 * fired (and all dialled) when the network returned.
 */
let offlineResumeHandler: (() => void) | null = null;
async function connectGateway(settings: BridgeSettings): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // Offline: do nothing now. Resume automatically when the network
    // comes back, instead of hammering a dead endpoint. Exactly one
    // resume listener is ever registered: repeat offline calls while one
    // is pending return without stacking another.
    if (!offlineResumeHandler) {
      const handler = (): void => {
        offlineResumeHandler = null;
        globalThis.removeEventListener("online", handler);
        void connectGateway(settings);
      };
      offlineResumeHandler = handler;
      globalThis.addEventListener("online", handler, { once: true });
    }
    return;
  }
  // Online again (or the online event never fired but onLine flipped):
  // a stale resume listener would re-dial with captured old settings,
  // so drop it — this call is connecting now anyway.
  if (offlineResumeHandler) {
    globalThis.removeEventListener("online", offlineResumeHandler);
    offlineResumeHandler = null;
  }
  if (connectGatewayInFlight) return connectGatewayInFlight;
  connectGatewayInFlight = (async () => {
    syncKeepAlive(settings);
  const hasGateway = settings.gatewayEnabled && Boolean(settings.gatewayToken) && Boolean(GATEWAY_URL);
  if (!hasGateway) {
    gatewayAuthRequired = false;
    gatewayAuthToken = "";
    manager?.disposeAll();
    manager = buildManager();
    return;
  }
  if (gatewayAuthRequired && gatewayAuthToken === settings.gatewayToken) return;

  manager?.disposeAll();
  manager = buildManager();
  const url = normalizeGatewayUrl(GATEWAY_URL);
  if (!url) return;

  try {
    await fetchGatewayStatus(url, settings.gatewayToken);
  } catch (error) {
    if (isGatewayAuthError(error)) {
      markGatewayAuthRequired(settings.gatewayToken, error.message);
      return;
    }
    // The status endpoint is unreachable; the socket may still come up, and it
    // retries on its own. Do not clear a valid token because the network is down.
    // This is NOT recorded as "allowed": no connection was established, so
    // recording an allow would misstate the audit trail. It uses the
    // dedicated "preflight-unavailable" decision (0.3.0).
    audit.record({
      kind: "client.connect",
      decision: "preflight-unavailable",
      outcome: "failure",
      details: { gateway: GATEWAY_URL, error: error instanceof Error ? error.message : String(error) },
    });
  }

  gatewayAuthRequired = false;
  gatewayAuthToken = "";
  // Bridge routing (0.5.1 fix): the gateway routes /bridge to the SessionDO
  // named by the `session` query parameter and returns 400 without it, so a
  // bare gateway URL can never connect, even with a valid token. The session
  // id is a routing identifier, not a credential; the device token is still
  // sent as the first WebSocket message. Without a session id, do not dial
  // a URL that is guaranteed to fail with a handshake 400.
  if (!settings.gatewaySessionId) {
    markGatewayAuthRequired(settings.gatewayToken, "Sign in again to link this browser session");
    return;
  }
  const bridgeUrl = `${url}?session=${encodeURIComponent(settings.gatewaySessionId)}`;
  manager.connectGateway(bridgeUrl, settings.gatewayToken);
  })().finally(() => { connectGatewayInFlight = null; });
  return connectGatewayInFlight;
}

function gatewayInfo(settings: BridgeSettings): GatewayInfo {
  return {
    enabled: settings.gatewayEnabled,
    url: normalizeGatewayUrl(GATEWAY_URL),
    mcpUrl: gatewayMcpUrl(GATEWAY_URL),
    signedIn: Boolean(settings.gatewayToken),
    email: settings.gatewayAccountEmail,
    // No token value leaves the service worker to the dashboard, masked
    // or otherwise. The session id is shown masked only; it is a routing
    // identifier, not a credential on its own.
    sessionIdMasked: maskSecret(settings.gatewaySessionId),
    connected: settings.gatewayEnabled && (manager?.isConnected() ?? false),
    authRequired: gatewayAuthRequired,
  };
}

function unifiedTools(): ToolDescriptor[] {
  const unified = new Set(UNIFIED_TOOL_NAMES);
  return registry.descriptors().filter((tool) => unified.has(tool.name));
}

function snapshot(): DashboardSnapshot {
  const tools = registry.list().filter((tool) => UNIFIED_TOOL_NAMES.includes(tool.name));
  const synthetic = { id: "dashboard", name: "Dashboard", transport: "remote" as const };
  const allowedTools: string[] = [];
  const deniedTools: string[] = [];
  for (const tool of tools) {
    (policy.decide(tool, synthetic).allowed ? allowedTools : deniedTools).push(tool.name);
  }
  const config = policy.getConfig();
  return {
    toolCount: tools.length,
    categories: [...new Set(tools.map((t) => t.category))],
    mode: config.mode,
    enabledGroups: config.enabledGroups,
    readOnlyMode: config.readOnlyMode,
    killSwitch: config.killSwitch,
    bridgeConnected: manager?.isConnected() ?? false,
    bridgeStatus: manager?.isConnected() ? "connected" : "disconnected",
    connectedClients: manager?.clientCount() ?? 0,
    pendingApprovals: approvals.pendingCount(),
    auditEvents: audit.size(),
    allowedTools,
    deniedTools,
  };
}

function dashboardState(): DashboardState {
  return {
    snapshot: snapshot(),
    policy: policy.getConfig(),
    approvals: approvals
      .list("pending")
      .map((record) => ({
        id: record.id,
        tool: record.tool,
        title: registry.get(record.tool)?.title ?? record.tool,
        summary: record.summary,
        risk: record.risk,
        target: record.target,
        client: record.client,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      })),
    clients: manager?.clients() ?? [],
    // The dashboard never receives the full token or session id, even
    // inside "settings": only the enable flag and account email cross.
    settings: {
      gatewayEnabled: activeSettings.gatewayEnabled,
      gatewayAccountEmail: activeSettings.gatewayAccountEmail,
    },
    // The dashboard exposes the unified tool surface only. Permission state is
    // still enforced by the nested legacy handlers behind each unified action.
    tools: unifiedTools(),
    gateway: gatewayInfo(activeSettings),
    onboarding,
  };
}

async function persistPolicy(): Promise<void> {
  await savePolicy(policy.getConfig());
}

/**
 * Multi-browser dashboard data, via the gateway account routes. The
 * service worker is the only caller: it holds the device token, the
 * dashboard never sees it. A failed fetch is reported as
 * "gateway-unreachable" so the dashboard can show its error state
 * instead of an empty list. The local browser's tab count (exact, from
 * chrome.tabs) overlays the gateway's count for the local row only;
 * remote browsers keep the gateway's count (null when unknown).
 */
function localBrowserInfo(): BrowserInfo {
  try {
    return browserInfoFromUserAgent(typeof navigator !== "undefined" ? navigator.userAgent : "");
  } catch {
    return {};
  }
}

async function gatewayAccountFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const token = activeSettings.gatewayToken;
  if (!token) throw new Error("Not signed in");
  const url = normalizeGatewayUrl(GATEWAY_URL);
  if (!url) throw new Error("Gateway URL is required");
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error("gateway-unreachable");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `gateway request failed (${response.status})`);
  return body;
}

async function loadBrowsersDashboard(): Promise<BrowsersDashboard> {
  const body = await gatewayAccountFetch("/account/browsers");
  const rawBrowsers = Array.isArray(body.browsers) ? (body.browsers as Array<Record<string, unknown>>) : [];
  const rawClients = Array.isArray(body.mcpClients) ? (body.mcpClients as Array<Record<string, unknown>>) : [];
  let localTabCount: number | null = null;
  try {
    const tabs = await chrome.tabs.query({});
    localTabCount = tabs.length;
  } catch {
    localTabCount = null;
  }
  const localSessionId = activeSettings.gatewaySessionId;
  const browsers: DashboardBrowser[] = rawBrowsers.map((entry) => {
    const sessionId = String(entry.sessionId ?? "");
    const isLocal = Boolean(localSessionId) && sessionId === localSessionId;
    return {
      sessionId,
      name: String(entry.name ?? "Browser"),
      browser: String(entry.browser ?? ""),
      os: String(entry.os ?? ""),
      version: String(entry.version ?? ""),
      createdAt: typeof entry.createdAt === "number" ? entry.createdAt : null,
      lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : null,
      isDefault: Boolean(entry.isDefault),
      connected: Boolean(entry.connected),
      tabCount: isLocal && localTabCount !== null ? localTabCount : typeof entry.tabCount === "number" ? entry.tabCount : null,
      isLocal,
    };
  });
  const mcpClients: DashboardMcpClient[] = rawClients.map((entry) => ({
    clientId: String(entry.clientId ?? ""),
    clientName: String(entry.clientName ?? entry.clientId ?? ""),
    scope: String(entry.scope ?? ""),
    sessionId: String(entry.sessionId ?? ""),
    live: Boolean(entry.live),
    connectedSince: typeof entry.connectedSince === "number" ? entry.connectedSince : null,
    lastActivityAt: typeof entry.lastActivityAt === "number" ? entry.lastActivityAt : null,
    authorizedSince: typeof entry.authorizedSince === "number" ? entry.authorizedSince : null,
    lastRefreshedAt: typeof entry.lastRefreshedAt === "number" ? entry.lastRefreshedAt : null,
    expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : null,
  }));
  return {
    browsers,
    defaultSessionId: String(body.defaultSessionId ?? ""),
    ...(typeof body.currentSessionId === "string" ? { currentSessionId: body.currentSessionId } : {}),
    mcpClients,
  };
}

/**
 * Browsers data flow (extension side). `muze/browsers/list` is
 * CACHE-ONLY and never fetches; `muze/browsers/refresh` is the only
 * dashboard route that fetches, and only as follows:
 * - cache present: return it instantly and refresh in the background
 *   (deduped by `refreshBrowsersCache`); success broadcasts
 *   `browsers.changed`, failure only sets the stale flag.
 * - no cache (first load): await the fetch, store it, return it; on
 *   failure return the existing error shape.
 * `browsersStale` is the last-refresh-failed flag at serve time, so
 * cached data served after a failed refresh is honestly flagged.
 */
async function browsersRefreshResponse(): Promise<DashboardResponse> {
  const cached = await readBrowsersCache();
  if (cached) {
    void refreshBrowsersCache(loadBrowsersDashboard, () => notifyDashboard({ kind: "browsers.changed" })).catch(() => undefined);
    return {
      ok: true,
      browsers: cached.dashboard,
      browsersStale: isLastRefreshFailed(),
      browsersCachedAt: cached.fetchedAt,
    };
  }
  try {
    const dashboard = await refreshBrowsersCache(loadBrowsersDashboard, () => notifyDashboard({ kind: "browsers.changed" }));
    const stored = await readBrowsersCache();
    return { ok: true, browsers: dashboard, browsersStale: false, browsersCachedAt: stored?.fetchedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Post-mutation re-fetch: the mutation handlers keep their current
 * behaviour (gateway POST, then a fresh full fetch), and additionally
 * write that fresh dashboard to the cache, clear the stale flag (this
 * was a full successful fetch, same as a refresh), and broadcast
 * `browsers.changed`. A fresh fetch here is deliberately NOT deduped
 * through `refreshBrowsersCache`: a refresh started before the mutation
 * could otherwise return (and cache) the pre-mutation snapshot.
 */
async function reloadBrowsersAfterMutation(): Promise<{ dashboard: BrowsersDashboard; cachedAt: number }> {
  const dashboard = await loadBrowsersDashboard();
  const entry = await writeBrowsersCache(dashboard);
  setLastRefreshFailed(false);
  notifyDashboard({ kind: "browsers.changed" });
  return { dashboard, cachedAt: entry.fetchedAt };
}

async function handleRequest(request: DashboardRequest): Promise<DashboardResponse> {
  switch (request.type) {
    case "muze/state":
      return { ok: true, state: dashboardState() };
    case "muze/audit":
      return { ok: true, audit: audit.list(request.limit ?? 100) };
    case "muze/policy/update":
      policy.setConfig(request.patch);
      await persistPolicy();
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    case "muze/policy/mode": {
      const before = policy.getMode();
      policy.setMode(request.mode);
      await persistPolicy();
      audit.record({
        kind: "policy.change",
        decision: "allowed",
        details: { from: before, to: request.mode },
      });
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    }
    case "muze/policy/tool": {
      policy.setToolAllowed(request.tool, request.allowed);
      await persistPolicy();
      audit.record({
        kind: "policy.change",
        decision: "allowed",
        details: { tool: request.tool, allowed: request.allowed },
      });
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    }
    case "muze/policy/reset": {
      policy.resetOverrides();
      await persistPolicy();
      audit.record({ kind: "policy.change", decision: "allowed", details: { reset: true } });
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    }
    case "muze/policy/group":
      policy.setGroupEnabled(request.group, request.enabled);
      await persistPolicy();
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    case "muze/policy/readonly":
      policy.setReadOnlyMode(request.enabled);
      await persistPolicy();
      broadcastEvent({ kind: "policy.changed" });
      return { ok: true, state: dashboardState() };
    case "muze/killswitch":
      if (request.engaged) policy.engageKillSwitch();
      else policy.releaseKillSwitch();
      await persistPolicy();
      audit.record({ kind: "kill-switch", decision: request.engaged ? "denied" : "allowed", details: { engaged: request.engaged } });
      broadcastEvent({ kind: "kill-switch", engaged: request.engaged });
      return { ok: true, state: dashboardState() };
    case "muze/approval/respond": {
      try {
        if (request.approved) approvals.approve(request.approvalId, "dashboard");
        else approvals.deny(request.approvalId, request.reason);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      manager?.broadcast({
        type: "approval.resolved",
        id: `host_${Date.now().toString(36)}`,
        approvalId: request.approvalId,
        approved: request.approved,
      });
      audit.record({ kind: "approval", decision: "allowed", details: { approvalId: request.approvalId, approved: request.approved } });
      syncActionBadge();
      return { ok: true, state: dashboardState() };
    }
    case "muze/approvals/cancel-for-client":
      approvals.cancelForClient(request.clientId);
      syncActionBadge();
      return { ok: true, state: dashboardState() };
    case "muze/bridge/settings":
      activeSettings = await saveBridgeSettings(request.patch);
      await connectGateway(activeSettings);
      return { ok: true, state: dashboardState() };
    case "muze/bridge/reconnect":
      await connectGateway(activeSettings);
      return { ok: true, state: dashboardState() };
    case "muze/gateway/sign-in": {
      // Legacy dashboard spelling: reuse a stored token's browser, or
      // report that email sign-in is required. The dashboard no longer
      // opens the website sign-in flow; use muze/gateway/sign-in-email.
      try {
        if (!activeSettings.gatewayToken) {
          return { ok: false, error: "Sign in with your email and password." };
        }
        const info = localBrowserInfo();
        const reused = await reuseBrowserSession(GATEWAY_URL, activeSettings.gatewayToken, info);
        const account: GatewayAccount = {
          token: activeSettings.gatewayToken,
          email: activeSettings.gatewayAccountEmail,
          sessionId: reused.sessionId,
        };
        gatewayAuthRequired = false;
        gatewayAuthToken = "";
        activeSettings = await saveBridgeSettings({
          gatewayAccountEmail: account.email,
          gatewayToken: account.token,
          gatewaySessionId: account.sessionId,
          gatewayEnabled: true,
        });
        await connectGateway(activeSettings);
        return { ok: true, state: dashboardState() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/gateway/sign-in-email":
    case "muze/gateway/sign-up-email": {
      // In-extension sign-in / sign-up: email + password go only to the
      // gateway over HTTPS and are never stored in the extension. A
      // stored token still reuses its own browser first, exactly as the
      // legacy sign-in did; a fresh sign-in creates a new browser.
      try {
        const email = String(request.email ?? "").trim();
        const password = String(request.password ?? "");
        if (!email || !password) return { ok: false, error: "Enter your email and password." };
        const info = localBrowserInfo();
        let account: GatewayAccount;
        if (activeSettings.gatewayToken) {
          try {
            const reused = await reuseBrowserSession(GATEWAY_URL, activeSettings.gatewayToken, info);
            account = {
              token: activeSettings.gatewayToken,
              email: activeSettings.gatewayAccountEmail,
              sessionId: reused.sessionId,
            };
          } catch {
            account =
              request.type === "muze/gateway/sign-up-email"
                ? await signUpWithEmailPassword(GATEWAY_URL, email, password, info)
                : await signInWithEmailPassword(GATEWAY_URL, email, password, info);
          }
        } else {
          account =
            request.type === "muze/gateway/sign-up-email"
              ? await signUpWithEmailPassword(GATEWAY_URL, email, password, info)
              : await signInWithEmailPassword(GATEWAY_URL, email, password, info);
        }
        gatewayAuthRequired = false;
        gatewayAuthToken = "";
        activeSettings = await saveBridgeSettings({
          gatewayAccountEmail: account.email,
          gatewayToken: account.token,
          gatewaySessionId: account.sessionId,
          gatewayEnabled: true,
        });
        await connectGateway(activeSettings);
        return { ok: true, state: dashboardState() };
      } catch (error) {
        return { ok: false, error: plainAuthError(error) };
      }
    }
    case "muze/gateway/delete-account": {
      if (!activeSettings.gatewayToken) return { ok: false, error: "Not signed in" };
      try {
        const response = await fetch(`${normalizeGatewayUrl(GATEWAY_URL)}/extension/account/delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${activeSettings.gatewayToken}` },
        });
        if (!response.ok) {
          let message = "Could not delete the account.";
          try {
            const body = (await response.json()) as { error?: string };
            if (body.error) message = body.error;
          } catch {
            // Keep the plain fallback.
          }
          return { ok: false, error: message };
        }
        gatewayAuthRequired = false;
        gatewayAuthToken = "";
        activeSettings = await saveBridgeSettings({
          gatewayAccountEmail: "",
          gatewayToken: "",
          gatewaySessionId: "",
          gatewayEnabled: false,
        });
        await connectGateway(activeSettings);
        return { ok: true, state: dashboardState() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/gateway/sign-out": {
      gatewayAuthRequired = false;
      gatewayAuthToken = "";
      activeSettings = await saveBridgeSettings({
        gatewayAccountEmail: "",
        gatewayToken: "",
        gatewaySessionId: "",
        gatewayEnabled: false,
      });
      await connectGateway(activeSettings);
      return { ok: true, state: dashboardState() };
    }
    case "muze/gateway/rotate": {
      if (!activeSettings.gatewayToken) return { ok: false, error: "Not signed in" };
      try {
        const rotated = await rotateDeviceToken(GATEWAY_URL, activeSettings.gatewayToken);
        gatewayAuthRequired = false;
        gatewayAuthToken = "";
        activeSettings = await saveBridgeSettings({
          gatewayToken: rotated.deviceToken,
          gatewaySessionId: rotated.sessionId,
          gatewayEnabled: true,
        });
        audit.record({
          kind: "token.rotate",
          decision: "allowed",
          details: { gateway: GATEWAY_URL },
        });
        await connectGateway(activeSettings);
        return { ok: true, state: dashboardState() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/onboarding/set":
      onboarding = await saveOnboarding(request.patch);
      return { ok: true, state: dashboardState() };
    case "muze/files/attach": {
      try {
        const fileReq = request as Extract<DashboardRequest, { type: "muze/files/attach" }>;
        const { name, mimeType, dataBase64 } = fileReq.file;
        const binary = atob(dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const buffer = bytes.buffer;
        const id = generateId();
        await putFile({ id, name, mimeType, size: buffer.byteLength, data: buffer, createdAt: Date.now() });
        return { ok: true, data: { id, name, mimeType, size: buffer.byteLength } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/files/list": {
      try {
        const files = await listFiles();
        return { ok: true, data: files };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/files/get": {
      try {
        const fileReq = request as Extract<DashboardRequest, { type: "muze/files/get" }>;
        const file = await getFile(fileReq.id);
        if (!file) return { ok: false, error: "File not found" };
        const bytes = new Uint8Array(file.data);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const dataBase64 = btoa(binary);
        return { ok: true, data: { id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, dataBase64 } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/files/remove": {
      try {
        const fileReq = request as Extract<DashboardRequest, { type: "muze/files/remove" }>;
        await removeFile(fileReq.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/browsers/list": {
      // CACHE-ONLY: this must never fetch. Pages call this after a
      // `browsers.changed` event (or as a cheap re-read); the refresh
      // route below is the only dashboard route that fetches.
      const cached = await readBrowsersCache();
      if (!cached) return { ok: false, error: "no cached browsers" };
      return {
        ok: true,
        browsers: cached.dashboard,
        browsersStale: isLastRefreshFailed(),
        browsersCachedAt: cached.fetchedAt,
      };
    }
    case "muze/browsers/refresh":
      return browsersRefreshResponse();
    case "muze/browsers/set-default":
    case "muze/browsers/rename":
    case "muze/browsers/disconnect":
    case "muze/browsers/remove": {
      try {
        const path =
          request.type === "muze/browsers/set-default"
            ? "/account/browsers/default"
            : request.type === "muze/browsers/rename"
              ? "/account/browsers/rename"
              : request.type === "muze/browsers/disconnect"
                ? "/account/browsers/disconnect"
                : "/account/browsers/remove";
        const payload =
          request.type === "muze/browsers/rename"
            ? { sessionId: request.sessionId, name: request.name }
            : { sessionId: request.sessionId };
        await gatewayAccountFetch(path, { method: "POST", body: JSON.stringify(payload) });
        // Note: disconnecting the local browser closes its socket via the
        // gateway; the extension's existing keepalive may reconnect it
        // later, exactly as after any transient drop. Disconnect is a
        // socket close, not a sign-out: the token stays valid.
        const reloaded = await reloadBrowsersAfterMutation();
        return { ok: true, browsers: reloaded.dashboard, browsersStale: false, browsersCachedAt: reloaded.cachedAt };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/mcp-sessions/revoke": {
      try {
        await gatewayAccountFetch("/account/mcp-clients/revoke", {
          method: "POST",
          body: JSON.stringify({ clientId: request.clientId, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }),
        });
        const reloaded = await reloadBrowsersAfterMutation();
        return { ok: true, browsers: reloaded.dashboard, browsersStale: false, browsersCachedAt: reloaded.cachedAt };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    case "muze/tasks.list":
    case "muze/tasks.get":
    case "muze/tasks.pause":
    case "muze/tasks.resume":
    case "muze/tasks.cancel":
    case "muze/tasks.approvePlan": {
      const port = await taskDashboardPort();
      const result = await handleTaskDashboardRequest(
        {
          type: request.type,
          taskId: (request as { taskId?: string }).taskId,
          reason: (request as { reason?: string }).reason,
          bounds: (request as { bounds?: unknown }).bounds,
        },
        port,
      );
      if (!result.ok) return { ok: false, error: result.error ?? "task request failed" };
      return { ok: true, tasks: result.tasks, task: result.task };
    }
    default:
      return { ok: false, error: "unknown_message" };
  }
}
/**
 * Trust boundary (narrowed, not eliminated): Chrome extension messaging
 * carries no per-page origin for extension pages — `sender.id` is the
 * extension's own id for the dashboard, content scripts and the offscreen
 * document alike. The check below therefore rejects messages that claim a
 * *different* extension id (the only forgery the sender field can express),
 * and additionally rejects consequential dashboard routes (policy,
 * kill-switch, approvals, gateway session, files, browsers, revocation,
 * task control — see `CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES`) from any
 * sender that cannot prove it is this extension, i.e. an undefined
 * `sender.id`. Read-only routes keep the previous behaviour. Web pages
 * cannot send runtime messages to this extension at all unless it is
 * listed in `externally_connectable` (it is not). What this check still
 * cannot do: a script already running inside extension context (a
 * content script, the offscreen document, or code injected into the
 * dashboard page itself) arrives with `sender.id` equal to the extension
 * id, so it still passes — that is Chrome's extension trust model, not
 * something a sender-id check can distinguish. The message-type prefix
 * alone is NOT treated as authentication.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: DashboardResponse) => void) => {
  const request = message as { target?: string; type?: string };
  if (request?.type === "SW_KEEPALIVE" || request?.target === "muze-service-worker" || request?.target === "uabb-service-worker") {
    sendResponse({ ok: true } as any);
    return false;
  }
  if (request?.target === OFFSCREEN_TARGET || request?.target === LEGACY_OFFSCREEN_TARGET) return false;
  // The page agent's op messages share the "muze/"/"uabb/" prefix family but
  // are not dashboard requests; they are handled by the page agent itself.
  if (request?.type === "muze/page-op" || request?.type === "uabb/page-op") return false;
  const senderId = (sender as { id?: string } | undefined)?.id;
  const runtimeId = typeof chrome !== "undefined" ? chrome.runtime?.id : undefined;
  if (senderId !== undefined && runtimeId !== undefined && senderId !== runtimeId) return false;
  const normalized = normalizeDashboardRequestType(request?.type);
  if (normalized === null) return false;
  if (!isDashboardSenderAllowedForRequest(normalized, senderId, runtimeId)) {
    // Explicit rejection (not a silent channel close): the caller learns
    // the attempt was refused, and handleRequest never runs, so no state
    // changes, no gateway call and no approval decision can follow.
    sendResponse({ ok: false, error: "untrusted_sender" });
    return false;
  }
  handleRequest({ ...(request as DashboardRequest), type: normalized } as DashboardRequest)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== GATEWAY_KEEPALIVE_ALARM) return;
  // Approvals expire on their own after their TTL, so re-check the badge on
  // every wake even when nothing else has happened.
  syncActionBadge();
  if (!activeSettings.gatewayEnabled) return;
  // Already healthy: nothing to do (the wake itself resets the idle timer).
  if (manager?.isConnected()) return;
  void connectGateway(activeSettings);
});

/**
 * Warm the per-domain favicon cache for the active tab, so the
 * dashboard card tile can show instantly instead of waiting for the
 * site (and its favIconUrl) to finish loading. Best-effort only:
 * prefetch never fails a task or a connection.
 */
async function warmActiveTabFavicon(): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab) await prefetchFaviconForTab({ url: tab.url, favIconUrl: tab.favIconUrl });
  } catch {
    // Prefetch is best-effort.
  }
}

async function initialize(): Promise<void> {
  const storedPolicy = await loadPolicy();
  policy.setConfig(storedPolicy);
  activeSettings = await loadBridgeSettings();
  onboarding = await loadOnboarding();
  try {
    chrome.tabs.onActivated?.addListener?.(() => {
      void warmActiveTabFavicon();
    });
    chrome.tabs.onUpdated?.addListener?.((_tabId, _changeInfo, tab) => {
      if (tab?.active) void warmActiveTabFavicon();
    });
  } catch {
    // Tab listeners are best-effort; the dashboard resolves favicons too.
  }
  void warmActiveTabFavicon();
  // The observer keeps running in pages that were already open, so its
  // on/off state is restored and re-applied after a service worker restart.
  await context.observer?.restore?.();
  syncKeepAlive(activeSettings);
  await connectGateway(activeSettings);
  syncActionBadge();
  audit.record({ kind: "client.connect", decision: "allowed", details: { registryVersion: REGISTRY_VERSION } });
}

void initialize();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
});
