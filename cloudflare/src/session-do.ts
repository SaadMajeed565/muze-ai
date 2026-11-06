import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  ApprovalRequestInfo,
  BridgeClientMessage,
  BridgeHostMessage,
  ClientIdentity,
  ToolBatchItemResult,
  ToolCallBatchItem,
} from "../libs/tool-contracts/index.js";
import { BridgeSlot, DoBridge, ForwardingBridge, type BridgeToolResult, type ForwardTarget, type GatewayBridge } from "./bridge.js";
import { createGatewayMcpServer } from "./mcp.js";
import { browsersDeltaBrowser, browsersDeltaClient, dirCall, pushBrowsersDelta } from "./directory-client.js";
import type { BrowsersDelta } from "../libs/tool-contracts/protocol.js";
import { json, text } from "./util.js";
import type { GatewayEnv } from "./config.js";

interface SocketAttachment {
  authorized: boolean;
  /** Routed session id for a socket still waiting for first-message auth. */
  sessionId?: string;
}

/** WebSocket auth (0.3.0): the extension must send, as the FIRST message
 * on a new bridge socket, exactly:
 *   {"type":"auth","token":"<device token>"}
 * The gateway sends no bridge hello until that message verifies. The token
 * is never sent as a URL query parameter. Verification goes through
 * DirectoryDO authDevice, and the verified session must match the session
 * this DO was routed for (the `session` query parameter on /bridge);
 * otherwise the socket closes with 4403. A missing, non-auth, or late
 * first message closes with 4401 after the 5-second deadline. */
const BRIDGE_AUTH_TIMEOUT_MS = 5_000;
const BRIDGE_AUTH_CLOSE_MISSING = 4401;
const BRIDGE_AUTH_CLOSE_INVALID = 4403;

/** The subset of an MCP `initialize` request we persist to rebuild a session. */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

/** Durable-storage key holding the initialize params for each MCP client session. */
const MCP_SESSIONS_KEY = "mcp:sessions";
/** Durable-storage key holding the task status mirror (same pattern as mcp:sessions). */
const TASK_MIRROR_KEY = "mcp:tasks";
/** Bound on mirrored tasks, same spirit as the MAX_MCP_SESSIONS bound. */
const MAX_MIRROR_ENTRIES = 100;

/**
 * Status-only mirror entry for one task. Deliberately minimal: task id,
 * status, step progress, browser session, and timestamp. NEVER the task
 * goal, step inputs, or step outputs — the gateway must not retain what
 * a task is doing, only how far it has got.
 */
export interface TaskMirrorEntry {
  taskId: string;
  status: string;
  stepIndex: number;
  totalSteps: number;
  browserSessionId?: string;
  updatedAt: number;
}

/**
 * Extract a status-only mirror entry from a tasks.* bridge result, or
 * null when the result does not carry a usable TaskView. Fields that
 * are absent are never invented: a missing id or status means no
 * mirror update at all, and missing progress defaults to zero steps
 * done out of zero known steps only when id+status are present.
 */
export function taskMirrorFromResult(result: unknown): TaskMirrorEntry | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const view = result as Record<string, unknown>;
  if (typeof view.id !== "string" || view.id === "" || typeof view.status !== "string" || view.status === "") return null;
  const doneSteps = Array.isArray(view.doneSteps) ? view.doneSteps.length : 0;
  const totalSteps = typeof view.totalSteps === "number" && Number.isFinite(view.totalSteps) ? view.totalSteps : 0;
  return {
    taskId: view.id,
    status: view.status,
    stepIndex: doneSteps,
    totalSteps,
    ...(typeof view.browserSessionId === "string" && view.browserSessionId !== "" ? { browserSessionId: view.browserSessionId } : {}),
    updatedAt: typeof view.updatedAt === "number" && Number.isFinite(view.updatedAt) ? view.updatedAt : Date.now(),
  };
}

/**
 * Pure eviction choice for MCP sessions (Phase 3 session pinning):
 * the oldest session whose client owns no running task. When every
 * session is pinned, the oldest overall is still evicted, so the
 * MAX_MCP_SESSIONS bound is never broken by pinning — pinning only
 * reorders eviction, it never disables it. With nothing pinned this
 * returns the oldest session, exactly the pre-pinning behaviour.
 */
export function chooseEvictionCandidate(
  sessionIdsInOrder: string[],
  clientBySession: Map<string, string> | Record<string, string | undefined>,
  pinnedClientIds: ReadonlySet<string>,
): string | undefined {
  const clientOf = (id: string): string | undefined =>
    clientBySession instanceof Map ? clientBySession.get(id) : clientBySession[id];
  for (const id of sessionIdsInOrder) {
    const client = clientOf(id);
    if (client === undefined || !pinnedClientIds.has(client)) return id;
  }
  return sessionIdsInOrder[0];
}

/**
 * GatewayBridge decorator that mirrors task status only. Every method
 * delegates to the inner bridge unchanged; only callTool results for
 * tasks.* tools are inspected, and only their status/progress fields
 * are recorded. The gateway never executes a step and never synthesises
 * a TaskView — the mirror updates solely from what the bridge returned.
 * The calling client's id is passed to the mirror callback (metadata
 * only, never persisted in the mirror entry) so the SessionDO can pin
 * sessions that own a running task against eviction.
 */
class TaskMirrorBridge implements GatewayBridge {
  constructor(
    private readonly inner: GatewayBridge,
    private readonly onTaskResult: (entry: TaskMirrorEntry, clientId?: string) => Promise<void>,
  ) {}

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  /** Forward the slot's bridge generation so ListTools caching (mcp.ts)
   * notices a reconnect even when connectedness looks unchanged. */
  generation(): number {
    return typeof this.inner.generation === "function" ? this.inner.generation() : 0;
  }

  listTools(): Promise<import("../libs/tool-contracts/index.js").ToolDescriptor[]> {
    return this.inner.listTools();
  }

  async callTool(call: {
    tool: string;
    input: unknown;
    approvalId?: string;
    dryRun?: boolean;
    client?: ClientIdentity;
    signal?: AbortSignal;
  }): Promise<BridgeToolResult> {
    const outcome = await this.inner.callTool(call);
    if (call.tool.startsWith("tasks.")) {
      const entry = taskMirrorFromResult(outcome.result);
      if (entry) await this.onTaskResult(entry, call.client?.id);
    }
    return outcome;
  }

  callToolBatch(calls: ToolCallBatchItem[], options?: { client?: ClientIdentity; signal?: AbortSignal }): Promise<ToolBatchItemResult[]> {
    return this.inner.callToolBatch(calls, options);
  }

  createApproval(tool: string, input: unknown, client?: ClientIdentity): Promise<ApprovalRequestInfo> {
    return this.inner.createApproval(tool, input, client);
  }

  respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    return this.inner.respondApproval(approvalId, approved, reason);
  }

  waitApproval(approvalId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    return this.inner.waitApproval(approvalId, timeoutMs, signal);
  }
}
/** How long to keep the DO (and its cached MCP transports) warm after activity. */
const WARM_WINDOW_MS = 5 * 60_000;
/** Keep-alive cadence; must stay below the ~10s hibernation threshold. */
const KEEPALIVE_INTERVAL_MS = 5_000;
/** Bound on concurrent MCP clients per browser session. */
const MAX_MCP_SESSIONS = 32;

interface PersistedMcpSession {
  params: InitializeParams;
  client?: ClientIdentity;
  /** Verified OAuth scope for this client; restored on cold-DO rebuild so
   * scope enforcement does not silently become "missing scope denies all"
   * after hibernation. */
  scope?: string;
  /** Phase A agent mode for this MCP session, restored on cold-DO rebuild
   * so a restart does not silently reset a read/plan client back to act. */
  mode?: string;
  /** Phase A discovered tools for this MCP session, restored the same way. */
  discovered?: string[];
  /** Account id for this MCP session (contract C1), restored on cold-DO
   * rebuild so routing and live presence keep working after hibernation
   * even if a later request ever arrives without the header. */
  userId?: string;
}

/**
 * Per-browser-session Durable Object. It owns two things:
 *  1. The outbound WebSocket from the browser extension (hibernatable).
 *  2. The MCP endpoint for AI clients authorized against this session.
 *
 * The MCP transport is stateful (required for in-client elicitation), so it
 * lives in memory. Because the extension socket is hibernatable and DOs are
 * evicted while idle, that cache would otherwise be lost — and a client that
 * does not re-`initialize` (Claude Code / the MCP SDK neither do) would then get
 * HTTP 400 "Server not initialized". Two things guard against that:
 *
 *  - Cache lifetime: activity keeps the DO awake for {@link WARM_WINDOW_MS} via
 *    a keep-alive alarm, so the transport survives short idle gaps.
 *  - Key storing: the client's `initialize` params are persisted, so a cold DO
 *    can rebuild the transport and transparently replay `initialize` (public
 *    API only) to restore the negotiated session and its capabilities.
 */
export class SessionDO implements DurableObject {
  private readonly slot = new BridgeSlot();
  private bridge: DoBridge | null = null;
  /** The socket the current bridge is bound to; stale sockets are ignored. */
  private activeSocket: WebSocket | null = null;
  /**
   * One stateful MCP transport per connected AI client. Multiple clients can
   * share the same browser session without closing each other's transport.
   */
  private readonly mcpSessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  /**
   * Live MCP session metadata per transport (in-memory only): client id
   * for eviction pinning, plus created/last-activity timestamps served on
   * the internal /mcp-clients route for the Browsers dashboard. A cold DO
   * has no live transports, so there is nothing stale to serve.
   */
  private readonly sessionClients = new Map<string, { clientId: string; createdAt: number; lastActivityAt: number }>();
  /** Browser session id this DO serves, when known (set from the bridge
   * route; needed for browsers.* tools on browser-role DOs). MCP-role
   * DOs never set this: the MCP session is bound to the account, and
   * routing resolves per call through the forwarding bridge. */
  private browserSessionId = "";
  /**
   * Account id for this MCP session (contract C1), from the
   * `x-muze-user-id` header the Worker sets from verifyAccess. Empty on
   * browser-role DOs and on directly-constructed (test) DOs.
   */
  private userId = "";
  /**
   * Routing key for this MCP session (the `mcp-session-id`), from the
   * `x-muze-mcp-session` header the Worker sets when it routes /mcp.
   * Empty for direct-DO use, which keeps the legacy
   * `<doId>:<uuid>` session-id scheme.
   */
  private mcpRoutingKey = "";
  /**
   * One forwarding bridge per live OAuth client in this DO (one per MCP
   * session's server), for routing and for the live-row target lookup
   * in emitClientUpsert. Browser-role DOs never populate this.
   */
  private readonly routingBridges = new Map<string, ForwardingBridge>();
  /**
   * Live-row display fields per MCP session id (client name + OAuth
   * scope), for the live registry. In-memory only; the stored session
   * record is the source on a cold rebuild.
   */
  private readonly liveClientInfo = new Map<string, { clientName?: string; scope?: string }>();
  /**
   * Client id per task that currently mirrors as running (in-memory
   * only, never persisted in the mirror entry and never served on
   * /status). A client in this map owns a running task, so its MCP
   * sessions are skipped by eviction until the task leaves `running`.
   */
  private readonly runningTaskClients = new Map<string, string>();
  private name = "Browser";
  /** In-memory task status mirror; persisted under TASK_MIRROR_KEY so a
   * cold DO can still report task status from durable storage. */
  private readonly taskMirror = new Map<string, TaskMirrorEntry>();
  private lastActivity = 0;
  private keepAliveScheduled = false;
  /**
   * Socket closed by the internal /disconnect-bridge route. disconnectBridge
   * clears activeSocket before the runtime delivers webSocketClose, so the
   * close handler would otherwise ignore that socket as stale and the
   * connected=false delta would never fire. Recording it here lets the
   * close handler emit exactly one delta for it (the socket-close path,
   * not the disconnect handler itself) and then forget it. Sockets
   * superseded by a new connection are never recorded, so a replacement
   * never emits a spurious offline delta for the browser that just came
   * online.
   */
  private disconnectPendingSocket: WebSocket | null = null;
  /** Socket waiting for its first-message auth, plus its deadline timer. */
  private pendingAuthSocket: WebSocket | null = null;
  private pendingAuthSessionId: string | null = null;
  private pendingAuthTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly state: DurableObjectState, private readonly env?: GatewayEnv) {
    const [ws] = this.state.getWebSockets();
    if (ws) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.authorized) {
        this.attachBridge(ws);
      } else if (attachment?.sessionId) {
        // DO evicted while a socket was still waiting for auth: restore the
        // pending state (with a fresh 5s deadline) so its auth message can
        // still verify instead of hanging forever.
        this.pendingAuthSocket = ws;
        this.pendingAuthSessionId = attachment.sessionId;
        this.startPendingAuthTimer(ws);
      }
    }
  }

  private startPendingAuthTimer(ws: WebSocket): void {
    this.pendingAuthTimer = setTimeout(() => {
      if (this.pendingAuthSocket === ws) {
        try {
          ws.close(BRIDGE_AUTH_CLOSE_MISSING, "bridge auth timeout");
        } catch {
          // ignore
        }
        this.clearPendingAuth();
      }
    }, BRIDGE_AUTH_TIMEOUT_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/connect":
      case "/bridge":
        return this.handleConnect(request);
      case "/mcp":
        return this.handleMcp(request);
      case "/status":
        // Existing /session/status route carries the mirror cleanly as a
        // `tasks` field; no new public endpoint was added. The field is
        // status-only (see TaskMirrorEntry): no goals, inputs, or outputs.
        return json({ connected: this.slot.isConnected(), name: this.name, tasks: await this.getMirrorEntries() });
      case "/purge-mcp-sessions":
        // Internal route, called only by the Worker delete-account path
        // (after DirectoryDO.deleteAccount, before the cookie is cleared).
        // It is not reachable from a public Worker route.
        return this.purgeMcpSessions();
      case "/browser-tab-count":
        return this.browserTabCount();
      case "/bridge-call": {
        // Internal route, called only by an MCP DO's forwarding bridge
        // (never by a public Worker route). Executes one bridge op over
        // THIS browser DO's local slot and returns the result, so an MCP
        // session can act on the browser it is currently routed to.
        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          body = {};
        }
        return this.bridgeCall(body);
      }
      case "/task-mirror": {
        // Internal route, called only by an MCP DO after a tasks.* result
        // (never by a public Worker route). Records a status-only mirror
        // entry for a task running on THIS browser, so /session/status
        // keeps reporting the mirror exactly as before the unbinding.
        let body: { entry?: unknown } = {};
        try {
          body = (await request.json()) as { entry?: unknown };
        } catch {
          body = {};
        }
        return this.storeMirrorEntry(body.entry);
      }
      case "/mcp-clients":
        return this.mcpClients();
      case "/disconnect-bridge":
        return this.disconnectBridge();
      case "/push-browsers-delta": {
        // Internal route, called only by pushBrowsersDelta fan-out (Worker
        // handlers and this DO's own triggers). Delivers the delta to THIS
        // session's bridge socket only — it never fans out again, so a
        // fan-out cannot loop. Never throws: a closed/absent socket, a
        // malformed body, or a send failure all report delivered:false.
        let body: { delta?: unknown } = {};
        try {
          body = (await request.json()) as { delta?: unknown };
        } catch {
          body = {};
        }
        return this.pushBrowsersDelta(body.delta);
      }
      case "/drop-mcp-client": {
        let body: { clientId?: unknown } = {};
        try {
          body = (await request.json()) as { clientId?: unknown };
        } catch {
          body = {};
        }
        return this.dropMcpClient(String(body.clientId ?? ""));
      }
      default:
        return text("not found", 404);
    }
  }

  private async purgeMcpSessions(): Promise<Response> {
    const count = this.mcpSessions.size;
    const liveClientIds = [...new Set([...this.sessionClients.values()].map((meta) => meta.clientId))];
    for (const transport of this.mcpSessions.values()) {
      void transport.close().catch(() => undefined);
    }
    this.mcpSessions.clear();
    this.sessionClients.clear();
    this.runningTaskClients.clear();
    this.liveClientInfo.clear();
    this.routingBridges.clear();
    await this.state.storage.delete(MCP_SESSIONS_KEY);
    this.taskMirror.clear();
    await this.state.storage.delete(TASK_MIRROR_KEY);
    // Live rows are account-level (contract C3): a purge must clear them
    // too, or the dashboard would keep showing a deleted account's
    // clients as live until the registry's staleness window passes.
    for (const clientId of liveClientIds) {
      await this.clearLiveClientRow(clientId);
    }
    return json({ ok: true, sessions: count });
  }

  /**
   * Internal route: tab count for the Browsers dashboard, from the
   * extension's own tabs.list (count only — tab URLs/titles are discarded
   * here and never leave this DO). A 3s race bounds the dashboard list;
   * any failure or disconnect reports null (unknown), never a guess.
   */
  private async browserTabCount(): Promise<Response> {
    if (!this.slot.isConnected() || !this.bridge) return json({ tabCount: null });
    try {
      const outcome = await Promise.race([
        this.bridge.callTool({ tool: "tabs.list", input: {} }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("tab count timeout")), 3000)),
      ]);
      const tabs = (outcome.result as { tabs?: unknown[] } | undefined)?.tabs;
      return json({ tabCount: Array.isArray(tabs) ? tabs.length : null });
    } catch {
      return json({ tabCount: null });
    }
  }

  /**
   * Internal /bridge-call route (browser role): execute one bridge op
   * over this DO's local slot, for an MCP DO's forwarding bridge. The
   * envelope always carries `connected` so the caller can track
   * liveness, and `error.executed` so it knows whether a retry on
   * another browser is safe: false ONLY when the slot was not connected
   * and nothing ran. Any error raised by the slot itself counts as
   * executed — it may have run, and a retry could double-execute a
   * consequential call. Never throws: a malformed body is an
   * INVALID_INPUT envelope, never a 500.
   */
  private async bridgeCall(body: Record<string, unknown>): Promise<Response> {
    const op = typeof body.op === "string" ? body.op : "";
    const fail = (code: string, message: string, executed: boolean, retryable = false): Response =>
      json({
        ok: false,
        connected: this.slot.isConnected(),
        error: { code, message, retryable, executed },
      });
    if (!this.slot.isConnected() || !this.bridge) {
      return fail("CONFLICT", "No browser is connected to this session", false, true);
    }
    const client = (body.client && typeof body.client === "object" ? body.client : undefined) as ClientIdentity | undefined;
    try {
      switch (op) {
        case "listTools": {
          const tools = await this.slot.listTools();
          return json({ ok: true, connected: true, tools });
        }
        case "call": {
          const outcome = await this.slot.callTool({
            tool: String(body.tool ?? ""),
            input: body.input ?? {},
            ...(typeof body.approvalId === "string" ? { approvalId: body.approvalId } : {}),
            ...(typeof body.dryRun === "boolean" ? { dryRun: body.dryRun } : {}),
            ...(client ? { client } : {}),
            ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
          });
          return json({ ok: true, connected: true, ...outcome });
        }
        case "batch": {
          const results = await this.slot.callToolBatch(
            (Array.isArray(body.calls) ? body.calls : []) as ToolCallBatchItem[],
            { ...(client ? { client } : {}) },
          );
          return json({ ok: true, connected: true, results });
        }
        case "approval.request": {
          const approval = await this.slot.createApproval(String(body.tool ?? ""), body.input ?? {}, client);
          return json({ ok: true, connected: true, approval });
        }
        case "approval.respond": {
          await this.slot.respondApproval(
            String(body.approvalId ?? ""),
            body.approved === true,
            typeof body.reason === "string" ? body.reason : undefined,
          );
          return json({ ok: true, connected: true });
        }
        case "approval.wait": {
          const approved = await this.slot.waitApproval(
            String(body.approvalId ?? ""),
            typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          );
          return json({ ok: true, connected: true, approved });
        }
        default:
          return fail("INVALID_INPUT", `unknown bridge op "${op}"`, false);
      }
    } catch (error) {
      // The slot ran (or may have run): never retryable-by-failover.
      // Preserve the ToolError code/message when the slot raised one so
      // the MCP layer sees exactly what the extension reported.
      const code =
        error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
          ? (error as { code: string }).code
          : "CONFLICT";
      const retryable =
        error && typeof error === "object" && "retryable" in error ? (error as { retryable: unknown }).retryable === true : true;
      return fail(code, error instanceof Error ? error.message : String(error), true, retryable);
    }
  }

  /**
   * Internal /task-mirror route (browser role): store one status-only
   * mirror entry pushed by the MCP DO that ran the task on this browser.
   * The entry shape is validated exactly like a locally produced one
   * (taskMirrorFromResult rules): no id or no status means no entry,
   * and nothing but status/progress is ever retained.
   */
  private async storeMirrorEntry(entry: unknown): Promise<Response> {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return json({ ok: false, stored: false });
    const rec = entry as Record<string, unknown>;
    if (typeof rec.taskId !== "string" || rec.taskId === "" || typeof rec.status !== "string" || rec.status === "") {
      return json({ ok: false, stored: false });
    }
    const stored: TaskMirrorEntry = {
      taskId: rec.taskId,
      status: rec.status,
      stepIndex: typeof rec.stepIndex === "number" && Number.isFinite(rec.stepIndex) ? rec.stepIndex : 0,
      totalSteps: typeof rec.totalSteps === "number" && Number.isFinite(rec.totalSteps) ? rec.totalSteps : 0,
      ...(typeof rec.browserSessionId === "string" && rec.browserSessionId !== "" ? { browserSessionId: rec.browserSessionId } : {}),
      updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : Date.now(),
    };
    this.taskMirror.set(stored.taskId, stored);
    try {
      const all = await this.loadMirror();
      all[stored.taskId] = stored;
      const ids = Object.keys(all).sort((a, b) => (all[a]?.updatedAt ?? 0) - (all[b]?.updatedAt ?? 0));
      while (ids.length > MAX_MIRROR_ENTRIES) {
        const oldest = ids.shift();
        if (oldest) delete all[oldest];
      }
      await this.state.storage.put(TASK_MIRROR_KEY, all);
    } catch {
      // ignore: mirror persistence is best-effort, never call-breaking
    }
    return json({ ok: true, stored: true });
  }

  /** Internal route: live MCP transports for the Browsers dashboard. */
  private mcpClients(): Response {
    return json({
      clients: [...this.sessionClients.entries()].map(([sessionId, meta]) => ({
        // The transport id is internal routing state, not shown in the UI;
        // the dashboard keys live sessions by client id.
        clientId: meta.clientId,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        transportSessionId: sessionId,
      })),
    });
  }

  /**
   * Internal /push-browsers-delta route (see fetch switch). Sends the
   * delta over this session's bridge socket when it is open; otherwise
   * delivered:false. The send helper already guards on OPEN and the
   * whole body is wrapped so a throwing socket can never fail the route.
   */
  private pushBrowsersDelta(delta: unknown): Response {
    let delivered = false;
    try {
      const rec = delta && typeof delta === "object" ? (delta as { type?: unknown }) : null;
      if (rec && typeof rec.type === "string" && this.activeSocket) {
        this.send(this.activeSocket, { type: "browsers.delta", delta: delta as BrowsersDelta });
        delivered = this.activeSocket.readyState === WebSocket.OPEN;
      }
    } catch {
      delivered = false;
    }
    return json({ ok: true, delivered });
  }

  /**
   * Shared account read for delta emission: the account's browser list
   * (via DirectoryDO browsersForSession, the same read path
   * listAccountBrowsers uses) plus this browser's own record. Returns
   * null when the DO has no env (unit tests), no known browser session
   * (e.g. a hibernation-resumed socket that never re-authenticated in
   * this instance), or the account no longer exists (e.g. the browser
   * was just removed) — in all cases the caller silently emits nothing.
   */
  private async accountBrowsersForDelta(): Promise<{
    browsers: Array<Record<string, unknown>>;
    defaultSessionId: string;
    own: Record<string, unknown> | undefined;
  } | null> {
    if (!this.env || !this.browserSessionId) return null;
    try {
      const result = await dirCall(this.env, "browsersForSession", { sessionId: this.browserSessionId });
      if (result.ok === false || !Array.isArray(result.browsers)) return null;
      const browsers = result.browsers as Array<Record<string, unknown>>;
      return {
        browsers,
        defaultSessionId: String(result.defaultSessionId ?? ""),
        own: browsers.find((entry) => String(entry.sessionId ?? "") === this.browserSessionId),
      };
    } catch {
      return null;
    }
  }

  /**
   * Account read for MCP-role delta emission: the account's browser list
   * via DirectoryDO browsersForUser (contract C1 userId), the same read
   * listAccountBrowsers uses. Returns null when the DO has no env, no
   * known user id (e.g. a directly-constructed test DO), or the account
   * no longer exists — in all cases the caller silently emits nothing.
   */
  private async accountBrowsersForUser(): Promise<{
    browsers: Array<Record<string, unknown>>;
    defaultSessionId: string;
  } | null> {
    if (!this.env || !this.userId) return null;
    try {
      const result = await dirCall(this.env, "browsersForUser", { userId: this.userId });
      if (result.ok === false || !Array.isArray(result.browsers)) return null;
      return {
        browsers: result.browsers as Array<Record<string, unknown>>,
        defaultSessionId: String(result.defaultSessionId ?? ""),
      };
    } catch {
      return null;
    }
  }

  /** Emit browser.upsert for this browser to every browser of the account
   * (including this one: pushing to a just-closed socket is a harmless
   * delivered:false no-op). Callers run this fire-and-forget; a failed
   * directory read or fan-out never throws into the socket/MCP path. */
  private async emitBrowserUpsert(connected: boolean, lastSeenAt?: number): Promise<void> {
    try {
      const account = await this.accountBrowsersForDelta();
      if (!account || !account.own) return;
      const delta: BrowsersDelta = {
        type: "browser.upsert",
        browser: browsersDeltaBrowser(account.own, account.defaultSessionId, {
          connected,
          ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
        }),
      };
      await pushBrowsersDelta(this.env as GatewayEnv, account.browsers.map((entry) => String(entry.sessionId ?? "")), delta);
    } catch {
      // ignore: delta delivery must never break the triggering path
    }
  }

  /**
   * Emit client.upsert for one OAuth client to every browser of the
   * account. Unbound: the MCP session lives at the account level, so the
   * fan-out list comes from the userId-based account read (not from a
   * browser session), the token row is matched by client id only (a
   * token's browser is where it was minted, not where the client is
   * routed), and the row's sessionId is the browser the client is
   * currently routed to when known — never the token's mint browser.
   * The row comes from DirectoryDO clientsForUser (same source as
   * listAccountBrowsers) so names/scopes/authorization dates match a
   * full fetch; when no token row exists yet the row falls back to the
   * client id as its name with null dates, never invented values.
   */
  private async emitClientUpsert(
    clientId: string,
    live: boolean,
    liveMeta?: { createdAt: number; lastActivityAt: number },
  ): Promise<void> {
    try {
      if (!this.env || !this.userId || !clientId) return;
      const account = await this.accountBrowsersForUser();
      if (!account) return;
      let tokenEntry: Record<string, unknown> | undefined;
      try {
        const clientsResult = await dirCall(this.env, "clientsForUser", { userId: this.userId });
        if (clientsResult.ok !== false && Array.isArray(clientsResult.clients)) {
          tokenEntry = (clientsResult.clients as Array<Record<string, unknown>>).find(
            (entry) => String(entry.clientId ?? "") === clientId,
          );
        }
      } catch {
        tokenEntry = undefined;
      }
      const targetSessionId = this.routingBridges.get(clientId)?.currentTarget()?.sessionId;
      const row: Record<string, unknown> = tokenEntry ?? { clientId, clientName: clientId, scope: "" };
      if (targetSessionId) row.sessionId = targetSessionId;
      else if (typeof row.sessionId !== "string") row.sessionId = "";
      const delta: BrowsersDelta = {
        type: "client.upsert",
        client: browsersDeltaClient(row, live, liveMeta),
      };
      await pushBrowsersDelta(this.env, account.browsers.map((entry) => String(entry.sessionId ?? "")), delta);
    } catch {
      // ignore: delta delivery must never break the triggering path
    }
  }

  /**
   * Live registry (contract C3): record one live MCP client in the
   * DirectoryDO, or clear it. Best-effort and never throwing: a
   * registry write must never break session open/close. The live row
   * carries the browser the client is currently routed to when known;
   * connectedSince is the session's creation time so a re-route or a
   * target refresh never resets it. Staleness (10-minute window) is
   * the DirectoryDO's decision.
   */
  private async setLiveClientRow(
    sessionId: string,
    clientId: string,
    meta: { createdAt: number; lastActivityAt: number },
  ): Promise<void> {
    try {
      if (!this.env || !this.userId || !clientId) return;
      const info = this.liveClientInfo.get(sessionId);
      const targetSessionId = this.routingBridges.get(clientId)?.currentTarget()?.sessionId;
      await dirCall(this.env, "setLiveClient", {
        clientId,
        userId: this.userId,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        ...(info?.clientName ? { clientName: info.clientName } : {}),
        ...(info?.scope ? { scope: info.scope } : {}),
        connectedSince: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
      });
    } catch {
      // ignore: live presence must never break the triggering path
    }
  }

  private async clearLiveClientRow(clientId: string): Promise<void> {
    try {
      if (!this.env || !this.userId || !clientId) return;
      await dirCall(this.env, "clearLiveClient", { clientId, userId: this.userId });
    } catch {
      // ignore: live presence must never break the triggering path
    }
  }

  /**
   * Refresh the live rows of one client's sessions after its routed
   * target changed (select, failover, refresh), so the registry keeps
   * pointing at the browser the client is actually routed to.
   */
  private async refreshLiveRowsForClient(clientId: string, _targetSessionId: string): Promise<void> {
    void _targetSessionId;
    for (const [sessionId, meta] of [...this.sessionClients.entries()]) {
      if (meta.clientId !== clientId) continue;
      await this.setLiveClientRow(sessionId, clientId, meta);
    }
  }

  /** Internal route: close the bridge socket only; the browser record and
   * its token stay valid, so the extension can reconnect (Disconnect). */
  private disconnectBridge(): Response {
    if (this.activeSocket) {
      // Do NOT emit here: the single connected=false delta comes from
      // webSocketClose for this socket (see disconnectPendingSocket).
      this.disconnectPendingSocket = this.activeSocket;
      try {
        this.activeSocket.close(1000, "disconnected from dashboard");
      } catch {
        // ignore
      }
    }
    this.bridge?.onClose("disconnected from dashboard");
    this.bridge = null;
    this.activeSocket = null;
    this.slot.set(null);
    return json({ ok: true });
  }

  /**
   * Internal route: close live MCP transports for one OAuth client.
   * Deliberately emits NO live=false delta here: the only caller is the
   * Worker revoke handler, which fans out client.revoked immediately
   * after this call — a live=false upsert first would be a redundant,
   * immediately-superseded event for the same client.
   */
  private async dropMcpClient(clientId: string): Promise<Response> {
    let dropped = 0;
    for (const [sessionId, meta] of [...this.sessionClients.entries()]) {
      if (meta.clientId !== clientId) continue;
      const transport = this.mcpSessions.get(sessionId);
      this.mcpSessions.delete(sessionId);
      this.sessionClients.delete(sessionId);
      this.liveClientInfo.delete(sessionId);
      void transport?.close().catch(() => undefined);
      dropped++;
    }
    const stored = await this.loadSessions();
    let changed = false;
    for (const [sessionId, record] of Object.entries(stored)) {
      if (record.client?.id === clientId) {
        delete stored[sessionId];
        changed = true;
      }
    }
    if (changed) await this.state.storage.put(MCP_SESSIONS_KEY, stored);
    // A revoked client is no longer live anywhere (contract C3); the
    // Worker still fans out client.revoked separately, and this route
    // deliberately emits no live=false delta (see the method comment).
    if (dropped > 0) await this.clearLiveClientRow(clientId);
    return json({ dropped });
  }

  private clearPendingAuth(): void {
    if (this.pendingAuthTimer) clearTimeout(this.pendingAuthTimer);
    this.pendingAuthTimer = null;
    this.pendingAuthSocket = null;
    this.pendingAuthSessionId = null;
  }

  /**
   * Record activity and keep the DO warm for a bounded window. Alarm events
   * reset the hibernation timer, so rescheduling before the window elapses
   * keeps the in-memory MCP transport alive for the whole window.
   */
  private touch(): void {
    this.lastActivity = Date.now();
    if (this.keepAliveScheduled) return;
    this.keepAliveScheduled = true;
    void this.state.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS).catch(() => undefined);
  }

  async alarm(): Promise<void> {
    if (this.pendingAuthSocket) {
      // Auth deadline fallback if the in-memory timer was lost to eviction.
      try {
        this.pendingAuthSocket.close(BRIDGE_AUTH_CLOSE_MISSING, "bridge auth timeout");
      } catch {
        // ignore
      }
      this.clearPendingAuth();
      return;
    }
    if (this.lastActivity > 0 && Date.now() - this.lastActivity < WARM_WINDOW_MS) {
      await this.state.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
      return;
    }
    // Warm window elapsed: stop rescheduling and let the DO hibernate.
    this.keepAliveScheduled = false;
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return text("Expected websocket upgrade", 426);
    }
    this.touch();
    const params = new URL(request.url).searchParams;
    const name = params.get("name");
    if (name) this.name = name;
    // Routing identifier only, never a credential: the Worker forwards the
    // upgrade to the DO named by this session id, and auth is verified
    // against it on the first message. A missing session id cannot be
    // routed, so it is rejected here (400) rather than guessed.
    const routedSessionId = params.get("session") ?? "";
    if (!routedSessionId) return text("session query parameter is required", 400);
    this.browserSessionId = routedSessionId;

    // Do NOT attach the bridge yet and do NOT close the existing authorized
    // socket: the new socket stays unauthenticated until its first message
    // verifies. Only a verified socket replaces the active bridge.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ authorized: false, sessionId: routedSessionId } satisfies SocketAttachment);
    // Close a superseded pending-auth socket before replacing it: the old
    // code only cleared the reference and cancelled its timer, leaving the
    // old socket open and unauthenticated. Its later close event is
    // harmless — webSocketClose ignores a socket that is neither the
    // current pending socket nor the active socket — so closing here
    // cannot clobber the new pending socket assigned below.
    if (this.pendingAuthSocket) {
      try {
        this.pendingAuthSocket.close(BRIDGE_AUTH_CLOSE_MISSING, "superseded by a new connection");
      } catch {
        // ignore: already closed
      }
    }
    this.clearPendingAuth();
    this.pendingAuthSocket = server;
    this.pendingAuthSessionId = routedSessionId;
    this.startPendingAuthTimer(server);
    console.log(`[bridge] connect pending-auth name=${this.name}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Verify a pending socket's first auth message; on success attach it. */
  private async handlePendingAuth(ws: WebSocket, message: string): Promise<void> {
    const expectedSessionId = this.pendingAuthSessionId;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      try {
        ws.close(BRIDGE_AUTH_CLOSE_MISSING, "first bridge message must be auth");
      } catch {
        // ignore
      }
      this.clearPendingAuth();
      return;
    }
    const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const token = rec && rec.type === "auth" && typeof rec.token === "string" ? rec.token : "";
    if (!token) {
      try {
        ws.close(BRIDGE_AUTH_CLOSE_MISSING, "first bridge message must be auth");
      } catch {
        // ignore
      }
      this.clearPendingAuth();
      return;
    }
    // Verify via DirectoryDO; the verified session must match the session
    // this DO was routed for. No token is logged.
    let verifiedSessionId: string | null = null;
    try {
      const result = await dirCall(this.env as GatewayEnv, "authDevice", { deviceToken: token });
      if (result.ok !== false) verifiedSessionId = String((result as { sessionId?: unknown }).sessionId ?? "");
    } catch {
      verifiedSessionId = null;
    }
    if (!verifiedSessionId || !expectedSessionId || verifiedSessionId !== expectedSessionId) {
      try {
        ws.close(BRIDGE_AUTH_CLOSE_INVALID, "invalid or mismatched device token");
      } catch {
        // ignore
      }
      this.clearPendingAuth();
      return;
    }
    this.browserSessionId = verifiedSessionId;
    this.clearPendingAuth();
    try {
      ws.serializeAttachment({ authorized: true } satisfies SocketAttachment);
    } catch {
      // ignore: attachment update is best-effort; in-memory state is authoritative
    }
    // A verified socket replaces any stale socket, as before.
    for (const existing of this.state.getWebSockets()) {
      if (existing !== ws) {
        try {
          existing.close(1000, "replaced by new connection");
        } catch {
          // ignore
        }
      }
    }
    this.attachBridge(ws);
  }

  private attachBridge(ws: WebSocket): void {
    this.bridge?.onClose("replaced by new connection");
    this.bridge = new DoBridge({
      isOpen: () => ws.readyState === WebSocket.OPEN,
      send: (message: BridgeClientMessage) => this.send(ws, message),
    });
    this.activeSocket = ws;
    this.slot.set(this.bridge);
    try {
      this.bridge.start();
    } catch {
      // ignore: the socket may already be closed
    }
    // Bridge attached/verified: this browser is online. Fire-and-forget
    // (attachBridge is synchronous); authDevice already refreshed
    // lastSeenAt before verification, so the directory row is current.
    // A hibernation-resumed socket with no known browserSessionId in
    // this instance emits nothing (see accountBrowsersForDelta).
    void this.emitBrowserUpsert(true);
  }

  private send(ws: WebSocket, message: BridgeClientMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.touch();
    // Unauthenticated sockets may only send their auth message. Nothing
    // is forwarded to the bridge before verification.
    if (ws === this.pendingAuthSocket) {
      if (typeof message !== "string") {
        try {
          ws.close(BRIDGE_AUTH_CLOSE_MISSING, "first bridge message must be auth");
        } catch {
          // ignore
        }
        this.clearPendingAuth();
      } else {
        await this.handlePendingAuth(ws, message);
      }
      return;
    }
    // If the message arrives on a socket we are not bound to (the extension
    // dropped and re-dialed while the DO was evicted), re-attach the new socket
    // before processing so the handshake completes on it. This path is only
    // for sockets already marked authorized (hibernation resume); a pending
    // socket never reaches here.
    if (ws !== this.activeSocket) {
      const attachment = (() => {
        try {
          return ws.deserializeAttachment() as SocketAttachment | null;
        } catch {
          return null;
        }
      })();
      if (!attachment?.authorized) return;
      this.attachBridge(ws);
    }
    if (typeof message !== "string") return;
    let parsed: BridgeHostMessage;
    try {
      parsed = JSON.parse(message) as BridgeHostMessage;
    } catch {
      return;
    }
    this.bridge?.handleMessage(parsed);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (ws === this.pendingAuthSocket) {
      this.clearPendingAuth();
      return;
    }
    // Close of a socket the disconnect route already closed: the bridge
    // state is already cleared, but this is the one place the
    // connected=false delta is emitted for a dashboard disconnect (the
    // disconnect handler itself emits nothing).
    if (ws === this.disconnectPendingSocket) {
      this.disconnectPendingSocket = null;
      console.log(`[bridge] close session=${this.state.id} code=${code} reason=${reason || "-"}`);
      await this.emitBrowserUpsert(false, Date.now());
      return;
    }
    // Ignore the close of a socket that has already been superseded; otherwise
    // the stale socket's teardown would destroy the freshly attached bridge.
    // (Superseded sockets also emit no offline delta: the replacement
    // already announced this browser online.)
    if (ws !== this.activeSocket) {
      console.log(`[bridge] ignore stale close session=${this.state.id} code=${code}`);
      return;
    }
    console.log(`[bridge] close session=${this.state.id} code=${code} reason=${reason || "-"}`);
    this.bridge?.onClose(reason || "extension disconnected");
    this.bridge = null;
    this.activeSocket = null;
    this.slot.set(null);
    // Bridge socket closed: this browser is offline, lastSeenAt=now.
    // Fanned out to ALL account browsers (the closed socket itself is a
    // harmless delivered:false no-op), so remaining browsers learn at once.
    await this.emitBrowserUpsert(false, Date.now());
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (ws === this.pendingAuthSocket) {
      this.clearPendingAuth();
      return;
    }
    if (ws === this.disconnectPendingSocket) {
      this.disconnectPendingSocket = null;
      await this.emitBrowserUpsert(false, Date.now());
      return;
    }
    if (ws !== this.activeSocket) return;
    this.bridge?.onClose("extension socket error");
    this.bridge = null;
    this.activeSocket = null;
    this.slot.set(null);
    await this.emitBrowserUpsert(false, Date.now());
  }

  private async handleMcp(request: Request): Promise<Response> {
    this.touch();
    // The Worker forwards the verified account id on every /mcp request
    // (contract C1: stripped from client input at the Worker boundary);
    // this is how the MCP DO learns its account, for browsers.* tools,
    // routing, and live presence. The old x-muze-browser-session header
    // is gone: the Worker never sets it, and this DO must never learn a
    // browser binding from a header.
    const forwardedUserId = userIdFromHeaders(request);
    if (forwardedUserId) this.userId = forwardedUserId;
    const forwardedRoutingKey = request.headers.get("x-muze-mcp-session")?.trim();
    if (forwardedRoutingKey) this.mcpRoutingKey = forwardedRoutingKey;
    const headerSession = request.headers.get("mcp-session-id");

    const initParams = await readInitializeParams(request);

    if (initParams) {
      return this.openMcpSession(request, initParams);
    }

    if (!headerSession) return text("Mcp-Session-Id header is required", 400);

    // The session id IS the routing key: the Worker routed this request
    // to the DO named by it, so the session must live here — in memory
    // or in storage (cold DO). Anything else is not found here; there is
    // no browser-session prefix to check against anymore.
    let transport = this.mcpSessions.get(headerSession);
    if (!transport) {
      // Cold DO resuming an existing session: rebuild under the same id and
      // replay initialize so negotiated capabilities (elicitation etc.) return.
      const stored = await this.loadSessions();
      const record = stored[headerSession];
      if (!record) return text("Session not found", 404);
      transport = await this.buildTransport(
        headerSession,
        record.params,
        record.client,
        undefined,
        record.scope,
        {
          initialMode: record.mode,
          initialDiscovered: record.discovered,
          onSessionStateChange: (state) => {
            void this.persistSessionStateWithRetry(headerSession, state);
          },
        },
        record.userId || this.userId || undefined,
      );
      this.registerSession(headerSession, transport, record.client?.id, {
        clientName: record.client?.name,
        scope: record.scope,
      });
    } else {
      const meta = this.sessionClients.get(headerSession);
      if (meta) {
        meta.lastActivityAt = Date.now();
        // Liveness is "registered AND lastActivityAt within the window"
        // (contract C3), so activity refreshes the registry row too —
        // without it a long-lived session would go stale mid-use.
        void this.setLiveClientRow(headerSession, meta.clientId, meta);
      }
    }
    return transport.handleRequest(request);
  }

  private async openMcpSession(request: Request, params: InitializeParams): Promise<Response> {
    const client = this.clientFromHeaders(request);
    const scope = this.scopeFromHeaders(request);
    const userId = this.userId || undefined;
    // The session id is the routing key the Worker generated for this
    // initialize (the DO name); the transport's generator returns it
    // verbatim, so the mcp-session-id response header IS the routing key
    // for every later request. Direct-DO use (no header) keeps the
    // legacy <doId>:<uuid> scheme.
    const routingKey = this.mcpRoutingKey || undefined;
    let generated: string | undefined;
    let openSessionId: string | undefined;
    const transport = await this.buildTransport(
      undefined,
      undefined,
      client,
      () => {
        if (routingKey) return routingKey;
        generated ??= `${this.state.id.toString()}:${crypto.randomUUID()}`;
        return generated;
      },
      scope,
      {
        onSessionStateChange: (state) => {
          if (openSessionId) void this.persistSessionStateWithRetry(openSessionId, state);
        },
      },
      userId,
    );
    const response = await transport.handleRequest(request);
    const sessionId = response.headers.get("mcp-session-id") ?? generated;
    openSessionId = sessionId;
    if (sessionId) {
      this.registerSession(sessionId, transport, client?.id, { clientName: client?.name, scope });
      await this.persistSession(sessionId, {
        params,
        ...(client ? { client } : {}),
        ...(scope ? { scope } : {}),
        ...(userId ? { userId } : {}),
      });
    }
    return response;
  }

  private registerSession(
    sessionId: string,
    transport: WebStandardStreamableHTTPServerTransport,
    clientId?: string,
    liveInfo?: { clientName?: string; scope?: string },
  ): void {
    this.mcpSessions.set(sessionId, transport);
    if (clientId) {
      const existing = this.sessionClients.get(sessionId);
      this.sessionClients.set(sessionId, {
        clientId,
        createdAt: existing?.createdAt ?? Date.now(),
        lastActivityAt: Date.now(),
      });
      if (liveInfo && (liveInfo.clientName || liveInfo.scope)) {
        this.liveClientInfo.set(sessionId, { ...(liveInfo.clientName ? { clientName: liveInfo.clientName } : {}), ...(liveInfo.scope ? { scope: liveInfo.scope } : {}) });
      }
      // MCP session established (new initialize, or a cold-DO rebuild of
      // a live session): the client is live on the account. Anonymous
      // initializes (no clientId) have no dashboard row and emit nothing.
      const meta = this.sessionClients.get(sessionId);
      if (meta) {
        void this.emitClientUpsert(clientId, true, meta);
        void this.setLiveClientRow(sessionId, clientId, meta);
      }
    }
    // Evict the oldest client when a caller keeps opening sessions without
    // closing them, bounding memory and persisted state. Sessions whose
    // client owns a running task are skipped (Phase 3 pinning); when
    // every session is pinned the oldest is still evicted, so the bound
    // is never broken by pinning.
    while (this.mcpSessions.size > MAX_MCP_SESSIONS) {
      const bySession: Record<string, string | undefined> = {};
      for (const [id, meta] of this.sessionClients) bySession[id] = meta.clientId;
      const candidate = chooseEvictionCandidate(
        [...this.mcpSessions.keys()],
        bySession,
        new Set(this.runningTaskClients.values()),
      );
      if (!candidate) break;
      const stale = this.mcpSessions.get(candidate);
      const evicted = this.sessionClients.get(candidate);
      this.mcpSessions.delete(candidate);
      this.sessionClients.delete(candidate);
      this.liveClientInfo.delete(candidate);
      void stale?.close().catch(() => undefined);
      // Eviction closes the session, so it is no longer live on the
      // account — same live=false upsert and registry clear as a normal
      // close. (The transport's onsessionclosed also calls dropSession,
      // but the meta is already gone by then, so nothing double-fires.)
      if (evicted) {
        void this.emitClientUpsert(evicted.clientId, false);
        void this.clearLiveClientRow(evicted.clientId);
      }
    }
  }

  private async dropSession(sessionId: string): Promise<void> {
    // MCP session closed (transport onsessionclosed): the client is no
    // longer live on the account. The row keeps the list shape with
    // live=false (connectedSince/lastActivityAt null, per
    // listAccountBrowsers) — it is NOT a revocation, so no client.revoked.
    const closed = this.sessionClients.get(sessionId);
    this.mcpSessions.delete(sessionId);
    this.sessionClients.delete(sessionId);
    this.liveClientInfo.delete(sessionId);
    const stored = await this.loadSessions();
    if (stored[sessionId]) {
      delete stored[sessionId];
      await this.state.storage.put(MCP_SESSIONS_KEY, stored);
    }
    if (closed) {
      await this.emitClientUpsert(closed.clientId, false);
      await this.clearLiveClientRow(closed.clientId);
    }
  }

  private async loadSessions(): Promise<Record<string, PersistedMcpSession>> {
    return (await this.state.storage.get<Record<string, PersistedMcpSession>>(MCP_SESSIONS_KEY)) ?? {};
  }

  /**
   * Record one status-only mirror entry (in-memory immediately, then
   * persisted). A storage failure must never break the tool call that
   * produced the result, so persistence errors are swallowed here; the
   * in-memory entry still serves /status until eviction.
   */
  private async recordTaskMirror(entry: TaskMirrorEntry, clientId?: string): Promise<void> {
    // Phase 3 pinning: only a task mirroring as `running` pins its
    // client; any other status unpins it. The client id is kept in
    // memory only and never written into the persisted mirror entry.
    if (entry.status === "running" && clientId) this.runningTaskClients.set(entry.taskId, clientId);
    else this.runningTaskClients.delete(entry.taskId);
    this.taskMirror.set(entry.taskId, entry);
    try {
      const stored = await this.loadMirror();
      stored[entry.taskId] = entry;
      const ids = Object.keys(stored).sort((a, b) => (stored[a]?.updatedAt ?? 0) - (stored[b]?.updatedAt ?? 0));
      while (ids.length > MAX_MIRROR_ENTRIES) {
        const oldest = ids.shift();
        if (oldest) delete stored[oldest];
      }
      await this.state.storage.put(TASK_MIRROR_KEY, stored);
    } catch {
      // ignore: mirror persistence is best-effort, never call-breaking
    }
    // The mirror also lives on the browser the task ran on, so
    // /session/status (addressed by browser id) keeps reporting it
    // exactly as before the unbinding. Fire-and-forget with a 2 s cap:
    // a slow or gone browser must never stall the tool call that
    // produced the result, and the authoritative copy above is already
    // stored. The entry's browserSessionId comes from the extension's
    // TaskView; the forwarding bridge's current target is the fallback.
    const targetBrowser =
      entry.browserSessionId ??
      (clientId ? this.routingBridges.get(clientId)?.currentTarget()?.sessionId : undefined);
    if (this.env && targetBrowser) {
      try {
        await Promise.race([
          this.env.SESSION_DO.get(this.env.SESSION_DO.idFromName(targetBrowser)).fetch(
            "https://session/task-mirror",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ entry }),
            },
          ),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {
        // ignore: the authoritative mirror above is already stored
      }
    }
  }

  private async loadMirror(): Promise<Record<string, TaskMirrorEntry>> {
    try {
      return (await this.state.storage.get<Record<string, TaskMirrorEntry>>(TASK_MIRROR_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  /** Merged mirror: persisted entries overlaid with newer in-memory ones. */
  private async getMirrorEntries(): Promise<TaskMirrorEntry[]> {
    const merged: Record<string, TaskMirrorEntry> = await this.loadMirror();
    for (const [taskId, entry] of this.taskMirror) merged[taskId] = entry;
    return Object.values(merged).sort((a, b) => a.updatedAt - b.updatedAt);
  }

  private async persistSession(sessionId: string, record: PersistedMcpSession): Promise<void> {
    const stored = await this.loadSessions();
    stored[sessionId] = record;
    // Same pinning rule as registerSession, applied to persisted
    // records (client ids come from the stored records themselves),
    // so memory and storage evict the same sessions.
    while (Object.keys(stored).length > MAX_MCP_SESSIONS) {
      const bySession: Record<string, string | undefined> = {};
      for (const [id, rec] of Object.entries(stored)) bySession[id] = rec.client?.id;
      const candidate = chooseEvictionCandidate(Object.keys(stored), bySession, new Set(this.runningTaskClients.values()));
      if (!candidate) break;
      delete stored[candidate];
    }
    await this.state.storage.put(MCP_SESSIONS_KEY, stored);
  }

  /** Phase A: merge a mode/discovered update into the persisted session
   * record without touching params, client, or scope. Best-effort: a
   * storage failure never breaks the tool call that produced the change.
   * Returns false (instead of throwing) so callers can log and retry. */
  private async persistSessionState(sessionId: string, state: { mode: string; discovered: string[] }): Promise<boolean> {
    try {
      const stored = await this.loadSessions();
      const record = stored[sessionId];
      if (!record) return true;
      stored[sessionId] = { ...record, mode: state.mode, discovered: [...state.discovered] };
      await this.state.storage.put(MCP_SESSIONS_KEY, stored);
      return true;
    } catch (error) {
      // Best-effort, never call-breaking: the caller logs and retries.
      void error;
      return false;
    }
  }

  /** Best-effort persist with bounded retries. Fire-and-forget by design:
   * callers never await it, so a storage outage can delay the persisted
   * mode/discovered view but never blocks session replay or tool calls.
   * Every failed attempt is logged; a failure is never silent. */
  private async persistSessionStateWithRetry(sessionId: string, state: { mode: string; discovered: string[] }): Promise<void> {
    const delaysMs = [100, 300];
    try {
      for (let attempt = 1; attempt <= delaysMs.length + 1; attempt++) {
        if (await this.persistSessionState(sessionId, state)) return;
        if (attempt <= delaysMs.length) {
          console.log(`[bridge] session-state persist failed session=${sessionId} attempt=${attempt} retrying`);
          await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
        } else {
          console.log(`[bridge] session-state persist failed session=${sessionId} attempt=${attempt} giving up`);
        }
      }
    } catch (error) {
      console.log(`[bridge] session-state persist error session=${sessionId} error=${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  private clientFromHeaders(request: Request): ClientIdentity | undefined {
    // 0.3.0 internal prefix is x-muze-*. The old x-uabb-* names are NOT
    // accepted: the Worker strips client-supplied headers and sets these
    // from the verified OAuth record, so any other value would be spoofed.
    const id = request.headers.get("x-muze-client-id")?.trim();
    if (!id) return undefined;
    const name = request.headers.get("x-muze-client-name")?.trim();
    const version = request.headers.get("x-muze-client-version")?.trim();
    return { id, name: name || id, ...(version ? { version } : {}), transport: "remote" };
  }

  /** Verified OAuth scope forwarded by the Worker; undefined if absent. */
  private scopeFromHeaders(request: Request): string | undefined {
    const scope = request.headers.get("x-muze-client-scope")?.trim();
    return scope ? scope : undefined;
  }

  private async buildTransport(
    fixedSessionId?: string,
    initParams?: InitializeParams,
    client?: ClientIdentity,
    generator?: () => string,
    oauthScope?: string,
    sessionState?: {
      initialMode?: string;
      initialDiscovered?: string[];
      onSessionStateChange?: (state: { mode: string; discovered: string[] }) => void;
    },
    userId?: string,
  ): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: generator ?? (() => fixedSessionId ?? `${this.state.id.toString()}:${crypto.randomUUID()}`),
      onsessionclosed: (sessionId) => {
        void this.dropSession(sessionId);
      },
    });
    // Unbound routing: the MCP server talks to the browser through a
    // forwarding bridge that resolves the target browser per call
    // (preference, else account default). One bridge per MCP session, so
    // each client's preference is its own; the task-mirror decorator
    // still wraps it so tasks.* results update the status mirror.
    const effectiveUserId = userId || this.userId || "";
    const forwardingBridge = new ForwardingBridge({
      ...(this.env ? { env: this.env } : {}),
      clientId: client?.id ?? "",
      userId: effectiveUserId,
      ...(client?.id
        ? {
            onTargetChange: (target: ForwardTarget) => {
              void this.refreshLiveRowsForClient(client.id, target.sessionId);
            },
          }
        : {}),
    });
    if (client?.id) this.routingBridges.set(client.id, forwardingBridge);
    // Eager liveness probe so ListTools and the CallTool pre-check see
    // the real connection state from the first call (see
    // ForwardingBridge.probeConnectivity).
    void forwardingBridge.probeConnectivity();
    const mirroringBridge = new TaskMirrorBridge(forwardingBridge, (entry, clientId) => this.recordTaskMirror(entry, clientId));
    // Client type is recorded only if the client declared it in initialize
    // (initParams.clientInfo.name); otherwise it stays "unknown".
    const initialMode = sessionState?.initialMode;
    const server = createGatewayMcpServer(mirroringBridge, client, this.env, oauthScope, {
      clientType: initParams?.clientInfo?.name,
      ...(initialMode && ["read", "act", "plan", "explore", "summary", "compaction"].includes(initialMode)
        ? { initialMode: initialMode as "read" | "act" | "plan" | "explore" | "summary" | "compaction" }
        : {}),
      ...(sessionState?.initialDiscovered ? { initialDiscovered: sessionState.initialDiscovered } : {}),
      ...(sessionState?.onSessionStateChange ? { onSessionStateChange: sessionState.onSessionStateChange } : {}),
      browsers: {
        list: async () => {
          if (!effectiveUserId) throw new Error("browser list needs an account for this connection");
          const result = await dirCall(this.env as GatewayEnv, "browsersForUser", { userId: effectiveUserId });
          if (result.ok === false) throw new Error(String(result.error ?? "could not list browsers"));
          // The currently-resolved target: resolveRoute's preference-or-
          // default for this client (cached by the forwarding bridge).
          const target = await forwardingBridge.resolveTarget();
          return {
            browsers: result.browsers as Array<Record<string, unknown>>,
            defaultSessionId: String(result.defaultSessionId ?? ""),
            currentSessionId: target.sessionId,
          };
        },
        select: async (target: string) => {
          if (!client?.id) throw new Error("browser selection needs an OAuth client identity");
          if (!effectiveUserId && !forwardingBridge.currentTarget()) {
            throw new Error("browser selection needs the current browser or account");
          }
          // The raw target is passed as targetSessionId: the DirectoryDO
          // tries it as an id first, then as a name. No token row is
          // touched; only the routing preference is stored.
          const result = await dirCall(this.env as GatewayEnv, "setRoutingPreference", {
            clientId: client.id,
            ...(effectiveUserId ? { userId: effectiveUserId } : {}),
            ...(forwardingBridge.currentTarget() ? { currentSessionId: forwardingBridge.currentTarget()?.sessionId ?? "" } : {}),
            targetSessionId: target,
          });
          if (result.ok === false) throw new Error(String(result.error ?? "could not select browser"));
          const sessionId = String(result.sessionId ?? target);
          // The NEXT call on this SAME session goes to the new browser:
          // update the cached target, no re-initialization.
          forwardingBridge.setTarget(sessionId, String(result.name ?? ""));
          return { sessionId, name: String(result.name ?? "") };
        },
      },
    });
    await server.connect(transport);
    if (initParams) await replayInitialize(transport, initParams);
    return transport;
  }
}

/**
 * Verified account id forwarded by the Worker on every /mcp request
 * (contract C1). The Worker strips any client-supplied value first and
 * sets it from verifyAccess, so a value here is never spoofed; an
 * absent value means the caller is not an MCP request (direct-DO use).
 */
function userIdFromHeaders(request: Request): string {
  return request.headers.get("x-muze-user-id")?.trim() ?? "";
}

/** Parse an MCP `initialize` POST body, returning its params (if any). */
async function readInitializeParams(request: Request): Promise<InitializeParams | null> {
  if (request.method !== "POST") return null;
  try {
    const body = (await request.clone().json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "initialize"
      ) {
        const params = (message as { params?: InitializeParams }).params;
        if (params) return params;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Feed a stored `initialize` through the transport so a rebuilt session looks
 * initialized (protocol negotiated, client capabilities registered) to the SDK,
 * without touching SDK internals. The synthetic response is drained and dropped.
 */
export async function replayInitialize(
  transport: WebStandardStreamableHTTPServerTransport,
  params: InitializeParams,
): Promise<void> {
  const synthetic = new Request("https://gateway.internal/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "muze-rehydrate", method: "initialize", params }),
  });
  const response = await transport.handleRequest(synthetic);
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  try {
    // The first SSE event is the initialize result; once it lands the server
    // has processed the handshake and recorded the client's capabilities.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (decoder.decode(value, { stream: true }).includes("data:")) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
