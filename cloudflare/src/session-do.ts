import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  ApprovalRequestInfo,
  BridgeClientMessage,
  BridgeHostMessage,
  ClientIdentity,
  ToolBatchItemResult,
  ToolCallBatchItem,
} from "../libs/tool-contracts/index.js";
import { BridgeSlot, DoBridge, type BridgeToolResult, type GatewayBridge } from "./bridge.js";
import { createGatewayMcpServer } from "./mcp.js";
import { dirCall } from "./directory-client.js";
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
   * route or the /mcp forward headers; needed for browsers.* tools). */
  private browserSessionId = "";
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
      case "/mcp-clients":
        return this.mcpClients();
      case "/disconnect-bridge":
        return this.disconnectBridge();
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
    for (const transport of this.mcpSessions.values()) {
      void transport.close().catch(() => undefined);
    }
    this.mcpSessions.clear();
    this.sessionClients.clear();
    this.runningTaskClients.clear();
    await this.state.storage.delete(MCP_SESSIONS_KEY);
    this.taskMirror.clear();
    await this.state.storage.delete(TASK_MIRROR_KEY);
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

  /** Internal route: close the bridge socket only; the browser record and
   * its token stay valid, so the extension can reconnect (Disconnect). */
  private disconnectBridge(): Response {
    if (this.activeSocket) {
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

  /** Internal route: close live MCP transports for one OAuth client. */
  private async dropMcpClient(clientId: string): Promise<Response> {
    let dropped = 0;
    for (const [sessionId, meta] of [...this.sessionClients.entries()]) {
      if (meta.clientId !== clientId) continue;
      const transport = this.mcpSessions.get(sessionId);
      this.mcpSessions.delete(sessionId);
      this.sessionClients.delete(sessionId);
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
    // Ignore the close of a socket that has already been superseded; otherwise
    // the stale socket's teardown would destroy the freshly attached bridge.
    if (ws !== this.activeSocket) {
      console.log(`[bridge] ignore stale close session=${this.state.id} code=${code}`);
      return;
    }
    console.log(`[bridge] close session=${this.state.id} code=${code} reason=${reason || "-"}`);
    this.bridge?.onClose(reason || "extension disconnected");
    this.bridge = null;
    this.activeSocket = null;
    this.slot.set(null);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (ws === this.pendingAuthSocket) {
      this.clearPendingAuth();
      return;
    }
    if (ws !== this.activeSocket) return;
    this.bridge?.onClose("extension socket error");
    this.bridge = null;
    this.activeSocket = null;
    this.slot.set(null);
  }

  private async handleMcp(request: Request): Promise<Response> {
    this.touch();
    // The Worker forwards the verified browser session id on every /mcp
    // request (stripped from client input at the Worker boundary); this is
    // how the DO learns which browser it serves, for browsers.* tools.
    const forwardedBrowser = request.headers.get("x-muze-browser-session")?.trim();
    if (forwardedBrowser) this.browserSessionId = forwardedBrowser;
    const baseSessionId = this.state.id.toString();
    const headerSession = request.headers.get("mcp-session-id");
    const initParams = await readInitializeParams(request);

    if (initParams) {
      return this.openMcpSession(request, initParams);
    }

    if (!headerSession) return text("Mcp-Session-Id header is required", 400);
    if (headerSession !== baseSessionId && !headerSession.startsWith(`${baseSessionId}:`)) {
      return text("Session not found", 404);
    }

    let transport = this.mcpSessions.get(headerSession);
    if (!transport) {
      // Cold DO resuming an existing session: rebuild under the same id and
      // replay initialize so negotiated capabilities (elicitation etc.) return.
      const stored = await this.loadSessions();
      const record = stored[headerSession];
      if (!record) return text("Session not found", 404);
      transport = await this.buildTransport(headerSession, record.params, record.client, undefined, record.scope, {
        initialMode: record.mode,
        initialDiscovered: record.discovered,
        onSessionStateChange: (state) => {
          void this.persistSessionState(headerSession, state).catch(() => undefined);
        },
      });
      this.registerSession(headerSession, transport, record.client?.id);
    } else {
      const meta = this.sessionClients.get(headerSession);
      if (meta) meta.lastActivityAt = Date.now();
    }
    return transport.handleRequest(request);
  }

  private async openMcpSession(request: Request, params: InitializeParams): Promise<Response> {
    const client = this.clientFromHeaders(request);
    const scope = this.scopeFromHeaders(request);
    let generated: string | undefined;
    let openSessionId: string | undefined;
    const transport = await this.buildTransport(undefined, undefined, client, () => {
      generated ??= `${this.state.id.toString()}:${crypto.randomUUID()}`;
      return generated;
    }, scope, {
      onSessionStateChange: (state) => {
        if (openSessionId) void this.persistSessionState(openSessionId, state).catch(() => undefined);
      },
    });
    const response = await transport.handleRequest(request);
    const sessionId = response.headers.get("mcp-session-id") ?? generated;
    openSessionId = sessionId;
    if (sessionId) {
      this.registerSession(sessionId, transport, client?.id);
      await this.persistSession(sessionId, { params, ...(client ? { client } : {}), ...(scope ? { scope } : {}) });
    }
    return response;
  }

  private registerSession(sessionId: string, transport: WebStandardStreamableHTTPServerTransport, clientId?: string): void {
    this.mcpSessions.set(sessionId, transport);
    if (clientId) {
      const existing = this.sessionClients.get(sessionId);
      this.sessionClients.set(sessionId, {
        clientId,
        createdAt: existing?.createdAt ?? Date.now(),
        lastActivityAt: Date.now(),
      });
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
      this.mcpSessions.delete(candidate);
      this.sessionClients.delete(candidate);
      void stale?.close().catch(() => undefined);
    }
  }

  private async dropSession(sessionId: string): Promise<void> {
    this.mcpSessions.delete(sessionId);
    this.sessionClients.delete(sessionId);
    const stored = await this.loadSessions();
    if (stored[sessionId]) {
      delete stored[sessionId];
      await this.state.storage.put(MCP_SESSIONS_KEY, stored);
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
   * storage failure never breaks the tool call that produced the change. */
  private async persistSessionState(sessionId: string, state: { mode: string; discovered: string[] }): Promise<void> {
    try {
      const stored = await this.loadSessions();
      const record = stored[sessionId];
      if (!record) return;
      stored[sessionId] = { ...record, mode: state.mode, discovered: [...state.discovered] };
      await this.state.storage.put(MCP_SESSIONS_KEY, stored);
    } catch {
      // ignore: persistence is best-effort, never call-breaking
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
  ): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: generator ?? (() => fixedSessionId ?? `${this.state.id.toString()}:${crypto.randomUUID()}`),
      onsessionclosed: (sessionId) => {
        void this.dropSession(sessionId);
      },
    });
    // The MCP server talks to the bridge through the task-mirror decorator
    // so tasks.* results update the status mirror; all other bridge
    // behaviour (including scope enforcement in mcp.ts) is unchanged.
    const mirroringBridge = new TaskMirrorBridge(this.slot, (entry, clientId) => this.recordTaskMirror(entry, clientId));
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
          if (!this.browserSessionId) throw new Error("browser session is unknown for this connection");
          const result = await dirCall(this.env as GatewayEnv, "browsersForSession", { sessionId: this.browserSessionId });
          if (result.ok === false) throw new Error(String(result.error ?? "could not list browsers"));
          return {
            browsers: result.browsers as Array<Record<string, unknown>>,
            defaultSessionId: String(result.defaultSessionId ?? ""),
            currentSessionId: String(result.currentSessionId ?? this.browserSessionId),
          };
        },
        select: async (targetSessionId: string) => {
          if (!client?.id) throw new Error("browser selection needs an OAuth client identity");
          if (!this.browserSessionId) throw new Error("browser session is unknown for this connection");
          const result = await dirCall(this.env as GatewayEnv, "setClientBrowser", {
            clientId: client.id,
            currentSessionId: this.browserSessionId,
            targetSessionId,
          });
          if (result.ok === false) throw new Error(String(result.error ?? "could not select browser"));
          return { sessionId: String(result.sessionId ?? targetSessionId), name: String(result.name ?? "") };
        },
      },
    });
    await server.connect(transport);
    if (initParams) await replayInitialize(transport, initParams);
    return transport;
  }
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
