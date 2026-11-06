import {
  PROTOCOL_VERSION,
  ToolErrorException,
  type ApprovalRequestInfo,
  type BridgeClientMessage,
  type BridgeHostMessage,
  type ClientIdentity,
  type ToolBatchItemResult,
  type ToolCallBatchItem,
  type ToolDescriptor,
  type ToolErrorCode,
} from "../libs/tool-contracts/index.js";
import { dirCall } from "./directory-client.js";
import type { GatewayEnv } from "./config.js";

export interface BridgeToolResult {
  result: unknown;
  dryRun: boolean;
  durationMs: number;
}

/** The subset of bridge operations the MCP layer depends on. */
export interface GatewayBridge {
  isConnected(): boolean;
  /**
   * Resolves when the bridge handshake (hello) has settled successfully.
   * Present on DoBridge; a bridge without it is treated as already usable
   * once isConnected() is true. Used by BridgeSlot's grace wait.
   */
  ready?: () => Promise<void>;
  /**
   * Monotonic generation bumped every time the slot's bridge is replaced
   * (BridgeSlot only). Lets ListTools callers notice a reconnect even
   * when connectedness looks unchanged. Absent on other bridges.
   */
  generation?: () => number;
  /**
   * The tools the extension currently offers. The list is filtered by the
   * user's permission level on the extension side, so it is the authority on
   * what a model may currently call.
   */
  listTools(): Promise<ToolDescriptor[]>;
  callTool(call: {
    tool: string;
    input: unknown;
    approvalId?: string;
    dryRun?: boolean;
    client?: ClientIdentity;
    signal?: AbortSignal;
    /**
     * Description-task filing id, extracted by the MCP layer from the
     * call's arguments (never part of a tool schema) and sent as the
     * bridge message field. The extension validates and files by it.
     */
    taskId?: string;
  }): Promise<BridgeToolResult>;
  /** One round trip for several independent read-only calls. */
  callToolBatch(calls: ToolCallBatchItem[], options?: { client?: ClientIdentity; signal?: AbortSignal }): Promise<ToolBatchItemResult[]>;
  createApproval(tool: string, input: unknown, client?: ClientIdentity): Promise<ApprovalRequestInfo>;
  respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void>;
  /**
   * Wait for a dashboard decision. Returns true only if the user approved
   * before the deadline or the caller aborted.
   */
  waitApproval(approvalId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean>;
}

interface Pending {
  kind: "tools" | "call" | "batch" | "approval-request" | "approval-respond" | "approval-wait";
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export const GATEWAY_CLIENT: ClientIdentity = {
  id: "muze-gateway",
  name: "Universal Browser Tools (remote MCP)",
  version: "0.6.0",
  transport: "remote",
};

export interface DoBridgeOptions {
  /** Send a raw protocol message over the socket. Must throw if the socket is closed. */
  send: (message: BridgeClientMessage) => void;
  /** Whether the underlying socket is currently open. */
  isOpen: () => boolean;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

/**
 * The gateway side of the bridge protocol. It is always the protocol *client*:
 * the extension (protocol host) dials in and the DO drives it. This mirrors
 * {@link SocketBridge} from the local server but is implemented on the standard
 * `WebSocket` global so it runs inside a Durable Object.
 */
export class DoBridge implements GatewayBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly requestTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private counter = 0;
  private connected = false;
  private helloSettled = false;
  private helloResolve!: () => void;
  private helloReject!: (error: Error) => void;
  private readonly helloPromise: Promise<void>;

  constructor(private readonly options: DoBridgeOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.helloPromise = new Promise<void>((resolve, reject) => {
      this.helloResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.helloReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        this.failHello(new ToolErrorException("TIMEOUT", "Bridge handshake timed out", { retryable: true }));
      }, this.requestTimeoutMs);
    });
    this.helloPromise.catch(() => undefined);
  }

  /** Begin the handshake. Call once the socket is open. */
  start(): void {
    this.sendHello();
  }

  ready(): Promise<void> {
    return this.helloPromise;
  }

  isConnected(): boolean {
    return this.connected && this.options.isOpen();
  }

  async listTools(): Promise<ToolDescriptor[]> {
    await this.helloPromise;
    const response = await this.request<{ tools: ToolDescriptor[] }>({ type: "registry.list", id: this.nextId() });
    return response.tools;
  }

  async callTool(
    call: {
      tool: string;
      input: unknown;
      approvalId?: string;
      dryRun?: boolean;
      client?: ClientIdentity;
      signal?: AbortSignal;
      taskId?: string;
    },
  ): Promise<BridgeToolResult> {
    await this.helloPromise;
    const message: BridgeClientMessage = {
      type: "tool.call",
      id: this.nextId(),
      tool: call.tool,
      input: call.input,
      approvalId: call.approvalId,
      dryRun: call.dryRun,
      ...(call.client ? { client: call.client } : {}),
      ...(call.taskId ? { taskId: call.taskId } : {}),
    };
    return (await this.request(message, call.signal)) as BridgeToolResult;
  }

  async callToolBatch(
    calls: ToolCallBatchItem[],
    options?: { client?: ClientIdentity; signal?: AbortSignal },
  ): Promise<ToolBatchItemResult[]> {
    await this.helloPromise;
    const message: BridgeClientMessage = {
      type: "tool.call.batch",
      id: this.nextId(),
      calls,
      ...(options?.client ? { client: options.client } : {}),
    };
    const response = (await this.request(message, options?.signal)) as { results: ToolBatchItemResult[] };
    return response.results;
  }

  /** Ask the extension to mint a single-use approval token for this exact call. */
  async createApproval(tool: string, input: unknown, client?: ClientIdentity): Promise<ApprovalRequestInfo> {
    await this.helloPromise;
    const response = await this.request<{ approval: ApprovalRequestInfo }>(
      { type: "approval.request", id: this.nextId(), tool, input, ...(client ? { client } : {}) },
    );
    return response.approval;
  }

  /** Resolve a previously created approval token on the extension side. */
  async respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    if (!this.options.isOpen()) return;
    await this.helloPromise;
    await this.request<{ approved: boolean }>({
      type: "approval.respond",
      id: this.nextId(),
      approvalId,
      approved,
      reason,
    });
  }

  async waitApproval(approvalId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    await this.helloPromise;
    const response = await this.request<{ approved: boolean }>(
      {
        type: "approval.wait",
        id: this.nextId(),
        approvalId,
        timeoutMs,
      },
      signal,
    );
    return response.approved === true;
  }

  handleMessage(message: BridgeHostMessage): void {
    switch (message.type) {
      case "hello.ok":
        this.connected = true;
        if (!this.helloSettled) {
          this.helloSettled = true;
          this.helloResolve();
        }
        return;
      case "hello.error":
        this.failHello(new ToolErrorException(message.error.code, message.error.message, { retryable: message.error.retryable }));
        return;
      case "registry.result":
        this.settle(message.id, { tools: message.tools });
        return;
      case "tool.result":
        this.settle(message.id, { result: message.result, dryRun: message.dryRun, durationMs: message.durationMs });
        return;
      case "tool.batch.result":
        this.settle(message.id, { results: message.results });
        return;
      case "tool.error":
        this.rejectPending(
          message.id,
          new ToolErrorException(message.error.code, message.error.message, {
            retryable: message.error.retryable,
            details: message.error.details,
          }),
        );
        return;
      case "approval.requested":
        this.settle(message.id, { approval: message.approval });
        return;
      case "approval.resolved":
        this.settle(message.id, { approved: message.approved });
        return;
      case "cancelled":
        this.rejectPending(message.targetId, new ToolErrorException("CANCELLED", "Operation cancelled"));
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  onClose(reason = "Bridge socket closed"): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.failHello(new ToolErrorException("CONFLICT", reason, { retryable: true }));
    for (const [id, entry] of this.pending) {
      this.cleanupPending(entry);
      entry.reject(new ToolErrorException("CONFLICT", reason, { retryable: true }));
      this.pending.delete(id);
    }
    return void wasConnected;
  }

  private failHello(error: Error): void {
    if (!this.helloSettled) {
      this.helloSettled = true;
      this.helloReject(error);
    }
  }

  private sendHello(): void {
    this.send({
      type: "hello",
      id: this.nextId(),
      protocolVersion: PROTOCOL_VERSION,
      client: GATEWAY_CLIENT,
    });
  }

  private nextId(): string {
    this.counter += 1;
    return `gw_${this.counter}`;
  }

  private send(message: BridgeClientMessage): void {
    if (!this.options.isOpen()) throw new ToolErrorException("CONFLICT", "Bridge socket is not open", { retryable: true });
    this.options.send(message);
  }

  private request<T>(message: BridgeClientMessage, signal?: AbortSignal): Promise<T> {
    const id = (message as { id: string }).id;
    // An approval wait carries its own per-client budget in the message
    // (V2-25): the local timer honours it so the budget is enforced even
    // if the extension ignores the field. Other approval messages keep
    // the bridge-wide approval timeout.
    const waitTimeoutMs =
      message.type === "approval.wait" && typeof (message as { timeoutMs?: unknown }).timeoutMs === "number"
        ? (message as { timeoutMs: number }).timeoutMs
        : undefined;
    const timeout =
      waitTimeoutMs !== undefined
        ? waitTimeoutMs
        : message.type === "approval.request" || message.type === "approval.respond" || message.type === "approval.wait"
          ? this.approvalTimeoutMs
          : this.requestTimeoutMs;
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(id, new ToolErrorException("TIMEOUT", `Bridge request ${message.type} timed out`, { retryable: true }));
      }, timeout);
      const kind: Pending["kind"] =
        message.type === "registry.list"
          ? "tools"
          : message.type === "tool.call"
            ? "call"
            : message.type === "tool.call.batch"
              ? "batch"
              : message.type === "approval.request"
                ? "approval-request"
                : message.type === "approval.wait"
                  ? "approval-wait"
                  : "approval-respond";
      const onAbort = signal
        ? () => {
            try {
              this.send({ type: "cancel", id: this.nextId(), targetId: id });
            } catch {
              // Socket already closed; cancellation still settles locally.
            }
            this.rejectPending(
              id,
              signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled"),
            );
          }
        : undefined;
      const entry: Pending = { kind, resolve, reject, timer, signal, onAbort };
      this.pending.set(id, entry);
      if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    });
  }

  private settle(id: string, value: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.cleanupPending(entry);
    this.pending.delete(id);
    entry.resolve(value);
  }

  private rejectPending(id: string, error: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.cleanupPending(entry);
    this.pending.delete(id);
    entry.reject(error);
  }

  private cleanupPending(entry: Pending): void {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }
}

/**
 * Bounded grace wait before a model-facing call fails with "no browser
 * connected". A cold bridge fails the first call instead of waiting for
 * the extension socket that is about to authenticate, so the slot waits
 * up to this long for a bridge to become usable. Far under the per-client
 * approval-wait budgets (claude/chatgpt 50 s, unknown 120 s in
 * tool-meta.ts APPROVAL_WAIT_BUDGET_MS) and never stacked: one wait per
 * call, on the model-facing paths only.
 */
export const BRIDGE_GRACE_WAIT_MS = 3_000;

/**
 * A stable facade over whichever bridge is currently attached. The MCP server
 * is created once per Durable Object, so it must never hold a specific socket's
 * bridge directly (the extension can reconnect at any time).
 */
export class BridgeSlot implements GatewayBridge {
  private current: GatewayBridge | null = null;
  private generationCount = 0;
  private readonly graceWaitMs: number;
  /** Waiters woken when set() replaces the bridge. */
  private readonly waiters = new Set<() => void>();

  constructor(options?: { graceWaitMs?: number }) {
    this.graceWaitMs = options?.graceWaitMs ?? BRIDGE_GRACE_WAIT_MS;
  }

  set(bridge: GatewayBridge | null): void {
    this.current = bridge;
    this.generationCount += 1;
    for (const notify of [...this.waiters]) notify();
  }

  /** Monotonic generation, bumped on every set() (including set(null)). */
  generation(): number {
    return this.generationCount;
  }

  isConnected(): boolean {
    return this.current?.isConnected() ?? false;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return (await this.requireGrace()).listTools();
  }

  async callTool(call: {
    tool: string;
    input: unknown;
    approvalId?: string;
    dryRun?: boolean;
    client?: ClientIdentity;
    signal?: AbortSignal;
    taskId?: string;
  }): Promise<BridgeToolResult> {
    return (await this.requireGrace(call.signal)).callTool(call);
  }

  async callToolBatch(calls: ToolCallBatchItem[], options?: { client?: ClientIdentity; signal?: AbortSignal }): Promise<ToolBatchItemResult[]> {
    return (await this.requireGrace(options?.signal)).callToolBatch(calls, options);
  }

  createApproval(tool: string, input: unknown, client?: ClientIdentity): Promise<ApprovalRequestInfo> {
    return this.require().createApproval(tool, input, client);
  }

  respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    return this.require().respondApproval(approvalId, approved, reason);
  }

  waitApproval(approvalId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    return this.require().waitApproval(approvalId, timeoutMs, signal);
  }

  private require(): GatewayBridge {
    const bridge = this.tryRequire();
    if (!bridge) {
      throw new ToolErrorException("CONFLICT", "No browser is connected to this session", { retryable: true });
    }
    return bridge;
  }

  private tryRequire(): GatewayBridge | null {
    if (!this.current || !this.current.isConnected()) return null;
    return this.current;
  }

  /**
   * Model-facing require: before throwing CONFLICT, wait up to the grace
   * window for a bridge to become usable — (a) no bridge set yet: wait for
   * set() to register one; (b) a bridge is set but its hello hasn't
   * settled: wait for its ready() with the same cap. Approval paths keep
   * the synchronous fail-fast require() above. The caller's AbortSignal,
   * when passed, ends the wait immediately.
   */
  private async requireGrace(signal?: AbortSignal): Promise<GatewayBridge> {
    const direct = this.tryRequire();
    if (direct) return direct;
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled");
    }
    const deadline = Date.now() + this.graceWaitMs;
    // Each bridge instance gets exactly one ready() waiter per grace wait:
    // re-attaching to an already-settled hello would wake the loop in a
    // tight spin until the deadline.
    let readyAttachedFor: GatewayBridge | null = null;
    while (Date.now() < deadline) {
      const found = this.tryRequire();
      if (found) return found;
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const current = this.current;
      await new Promise<void>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(finish);
          if (signal) signal.removeEventListener("abort", finish);
          resolve();
        };
        timer = setTimeout(finish, remaining);
        this.waiters.add(finish);
        if (signal) signal.addEventListener("abort", finish, { once: true });
        if (current && current !== readyAttachedFor && typeof current.ready === "function") {
          readyAttachedFor = current;
          void current.ready().then(finish, finish);
        }
      });
    }
    return this.require();
  }
}

/**
 * Unbound account-level routing: the MCP side of the bridge.
 *
 * An MCP session is bound to an ACCOUNT, never to a browser. This bridge
 * resolves the target browser at call time (DirectoryDO `resolveRoute`:
 * the client's routing preference, else the account default) and forwards
 * each operation to that browser's SessionDO over its internal
 * `/bridge-call` route, which executes it over the browser's local slot.
 * The browser DO keeps its bridge websocket, slot, `/status`,
 * `/browser-tab-count` and `/disconnect-bridge` — all browser-role
 * behaviour stays there.
 *
 * Long-lived DO-to-DO subrequests are NOT a platform problem: Cloudflare
 * documents "no set time limit on individual subrequests" (Workers
 * limits), and waiting on network I/O does not count toward CPU time —
 * so `waitApproval` forwards as one long subrequest (bounded by the
 * caller's approval budget, at most 120 s), exactly like the direct
 * DoBridge wait it replaces. No polling loop is needed; the extension's
 * own approval wait already polls its broker record.
 *
 * Failover: the resolved target is cached (60 s TTL). On a failure that
 * proves the call never ran on the extension (`executed: false` from the
 * browser DO — e.g. its bridge is down), the target is re-resolved once
 * and the call is retried ONLY when the route changed (a removed
 * preferred browser falls back to the account default this way; a merely
 * offline preferred browser resolves to itself, so no retry happens).
 * A retry after an unknown outcome could double-execute a consequential
 * tool call, so any failure that may have executed — including a
 * fetch-level failure, whose outcome is unknown — is never retried.
 * `AbortSignal`s end the local wait only: the browser-side operation
 * runs to its own timeout, which is bounded and side-effect-free for
 * waits (a read-only poll of the broker record) and identical to the
 * pre-forwarding behaviour for tool calls (the extension cannot be
 * un-invoked mid-call either).
 */
export interface ForwardTarget {
  sessionId: string;
  name: string;
  defaultSessionId: string;
}

/** Resolved-target cache TTL: a dashboard default change reaches a
 * preference-less client within a minute; a select or a failover
 * refreshes the cache immediately instead. */
export const FORWARD_TARGET_TTL_MS = 60_000;

export interface ForwardingBridgeOptions {
  env?: GatewayEnv;
  clientId: string;
  userId: string;
  /** Resolve the target browser (default: dirCall `resolveRoute`). */
  resolveRoute?: (
    clientId: string,
    userId: string,
    currentSessionId: string,
  ) => Promise<{ sessionId: string; defaultSessionId: string; browsers?: Array<Record<string, unknown>> }>;
  /** Execute one op on a browser DO (default: POST `/bridge-call`). */
  callBrowser?: (targetSessionId: string, body: Record<string, unknown>) => Promise<Record<string, any>>;
  /** Check whether a browser DO currently has a live bridge (default:
   * GET `/status` on the browser DO). Used by probeConnectivity. */
  probeBrowser?: (targetSessionId: string) => Promise<boolean>;
  /** Called whenever the resolved target changes (select, failover, refresh). */
  onTargetChange?: (target: ForwardTarget) => void;
}

/**
 * A bridge error that records whether the operation ran on the
 * extension. Only `executed: false` failures are safe to retry on a
 * different browser; everything else surfaces as-is.
 */
export class BridgeForwardError extends ToolErrorException {
  readonly executed: boolean;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; executed: boolean },
  ) {
    super(code, message, { details: options.details, retryable: options.retryable });
    this.executed = options.executed;
  }
}

export class ForwardingBridge implements GatewayBridge {
  private cached: ForwardTarget | null = null;
  private cachedAt = 0;
  private resolving: Promise<ForwardTarget> | null = null;
  private knownDisconnected = false;
  private knownDisconnectedAt = 0;
  private generationCount = 0;
  /**
   * Whether this bridge can ever resolve a target. With neither an env
   * nor an injected resolver (a directly-constructed test DO) no browser
   * can be reached, so isConnected is false from the start and the MCP
   * layer uses the static list — exactly like the old disconnected slot.
   */
  private readonly canResolve: boolean;

  constructor(private readonly options: ForwardingBridgeOptions) {
    this.canResolve = Boolean(options.env || options.resolveRoute);
  }

  /** The currently cached target, if one has been resolved. */
  currentTarget(): ForwardTarget | null {
    return this.cached;
  }

  /**
   * Adopt a target resolved elsewhere (browsers.select): the NEXT call on
   * this same session goes to the new browser, with no re-initialization.
   */
  setTarget(sessionId: string, name: string): void {
    this.adopt({ sessionId, name, defaultSessionId: this.cached?.defaultSessionId ?? "" });
  }

  /** Monotonic generation, bumped whenever the resolved target changes,
   * so ListTools caching notices a move to another browser. */
  generation(): number {
    return this.generationCount;
  }

  /**
   * Sync connectedness, as the MCP layer needs it. Optimistic until a
   * forwarded call proves otherwise: the layer's CallTool pre-check
   * throws CONFLICT without ever calling the bridge when this is false,
   * so a sticky false would deadlock (nothing would ever flip it true —
   * this bridge has no socket event to learn of a reconnect from). The
   * disconnected state therefore lasts only BRIDGE_GRACE_WAIT_MS after
   * the proof, mirroring the old slot's grace window: immediately after
   * a disconnect the layer reports the friendly no-browser error and
   * ListTools uses the static list; a moment later calls are attempted
   * again and the live browser DO is the authority. SessionDO kicks off
   * probeConnectivity at session open so the first call already sees
   * the real state instead of the optimistic default. A bridge that can
   * never resolve (no env, no injected resolver) reports false from
   * the start: nothing could ever flip it true, and the static list is
   * the correct answer there.
   */
  isConnected(): boolean {
    if (!this.canResolve) return false;
    return !this.knownDisconnected || Date.now() - this.knownDisconnectedAt >= BRIDGE_GRACE_WAIT_MS;
  }

  /**
   * Eager liveness probe: resolve the target and read its browser DO's
   * /status, recording whether a bridge is live. Never throws — a
   * failed probe leaves the optimistic default and the next real call
   * is the authority. SessionDO runs this fire-and-forget when a
   * transport is built, so a disconnected client's first ListTools
   * still gets the static list (as before the unbinding) instead of
   * trying the live list once and falling back to empty.
   */
  async probeConnectivity(): Promise<void> {
    try {
      const target = await this.resolveTarget();
      const probe =
        this.options.probeBrowser ??
        (async (targetSessionId: string): Promise<boolean> => {
          if (!this.options.env) return false;
          const stub = this.options.env.SESSION_DO.get(this.options.env.SESSION_DO.idFromName(targetSessionId));
          const response = await stub.fetch("https://session/status");
          const data = (await response.json()) as { connected?: boolean };
          return Boolean(data.connected);
        });
      const connected = await probe(target.sessionId);
      this.knownDisconnected = !connected;
      this.knownDisconnectedAt = connected ? 0 : Date.now();
    } catch {
      // ignore: the next real call is the authority
    }
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const response = await this.forward("listTools", {});
    return (response.tools as ToolDescriptor[]) ?? [];
  }

  async callTool(call: {
    tool: string;
    input: unknown;
    approvalId?: string;
    dryRun?: boolean;
    client?: ClientIdentity;
    signal?: AbortSignal;
    taskId?: string;
  }): Promise<BridgeToolResult> {
    const response = await this.forward(
      "call",
      {
        tool: call.tool,
        input: call.input,
        ...(call.approvalId ? { approvalId: call.approvalId } : {}),
        ...(call.dryRun !== undefined ? { dryRun: call.dryRun } : {}),
        ...(call.client ? { client: call.client } : {}),
        ...(call.taskId ? { taskId: call.taskId } : {}),
      },
      call.signal,
    );
    return { result: response.result, dryRun: Boolean(response.dryRun), durationMs: Number(response.durationMs ?? 0) };
  }

  async callToolBatch(
    calls: ToolCallBatchItem[],
    options?: { client?: ClientIdentity; signal?: AbortSignal },
  ): Promise<ToolBatchItemResult[]> {
    const response = await this.forward(
      "batch",
      { calls, ...(options?.client ? { client: options.client } : {}) },
      options?.signal,
    );
    return (response.results as ToolBatchItemResult[]) ?? [];
  }

  async createApproval(tool: string, input: unknown, client?: ClientIdentity): Promise<ApprovalRequestInfo> {
    const response = await this.forward("approval.request", {
      tool,
      input,
      ...(client ? { client } : {}),
    });
    return response.approval as ApprovalRequestInfo;
  }

  async respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
    await this.forward("approval.respond", {
      approvalId,
      approved,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async waitApproval(approvalId: string, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    const response = await this.forward(
      "approval.wait",
      { approvalId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      signal,
    );
    return response.approved === true;
  }

  /**
   * Resolve the target browser, cached for FORWARD_TARGET_TTL_MS. A
   * forced resolve bypasses the cache (failover) and clears a stale
   * preference via resolveRoute itself. Concurrent callers share one
   * in-flight resolution.
   */
  async resolveTarget(force = false): Promise<ForwardTarget> {
    if (!force && this.cached && Date.now() - this.cachedAt < FORWARD_TARGET_TTL_MS) return this.cached;
    if (this.resolving) return this.resolving;
    this.resolving = this.doResolve().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  private async doResolve(): Promise<ForwardTarget> {
    const resolveRoute =
      this.options.resolveRoute ??
      (async (clientId: string, userId: string, currentSessionId: string) => {
        if (!this.options.env) {
          throw new ToolErrorException("CONFLICT", "No browser is connected to this session", { retryable: true });
        }
        const result = await dirCall(this.options.env, "resolveRoute", { clientId, userId, currentSessionId });
        if (result.ok === false) {
          throw new ToolErrorException("CONFLICT", String(result.error ?? "could not resolve a browser"), {
            retryable: true,
          });
        }
        return {
          sessionId: String(result.sessionId ?? ""),
          defaultSessionId: String(result.defaultSessionId ?? ""),
          browsers: result.browsers as Array<Record<string, unknown>> | undefined,
        };
      });
    const result = await resolveRoute(this.options.clientId, this.options.userId, this.cached?.sessionId ?? "");
    if (!result.sessionId) {
      throw new ToolErrorException("CONFLICT", "No browser is connected to this session", { retryable: true });
    }
    const target: ForwardTarget = {
      sessionId: result.sessionId,
      defaultSessionId: result.defaultSessionId,
      name:
        (result.browsers as Array<Record<string, unknown>> | undefined)?.find(
          (entry) => String(entry.sessionId ?? "") === result.sessionId,
        )?.name?.toString() ??
        this.cached?.name ??
        "Browser",
    };
    this.adopt(target);
    return target;
  }

  private adopt(target: ForwardTarget): void {
    const changed = !this.cached || this.cached.sessionId !== target.sessionId;
    this.cached = target;
    this.cachedAt = Date.now();
    if (changed) {
      // A new browser is unproven either way: optimistic again.
      this.knownDisconnected = false;
      this.knownDisconnectedAt = 0;
      this.generationCount += 1;
      this.options.onTargetChange?.(target);
    }
    // Same target: the disconnected proof (if any) stands — a
    // re-resolution to the browser just proved down is no new evidence.
  }

  /**
   * Forward one op to the resolved target, with the single failover
   * retry described in the class comment. The caller's AbortSignal ends
   * the local wait; the browser-side operation is not cancellable
   * across the DO boundary (see the class comment).
   */
  private async forward(op: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const first = await this.resolveTarget();
    try {
      return await this.callOnce(first.sessionId, op, payload, signal);
    } catch (error) {
      if (!(error instanceof BridgeForwardError) || error.executed) throw error;
      const again = await this.resolveTarget(true);
      if (again.sessionId === first.sessionId) throw error;
      return this.callOnce(again.sessionId, op, payload, signal);
    }
  }

  private async callOnce(
    targetSessionId: string,
    op: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled");
    }
    const callBrowser =
      this.options.callBrowser ??
      (async (target: string, body: Record<string, unknown>): Promise<Record<string, any>> => {
        if (!this.options.env) {
          throw new ToolErrorException("CONFLICT", "No browser is connected to this session", { retryable: true });
        }
        const stub = this.options.env.SESSION_DO.get(this.options.env.SESSION_DO.idFromName(target));
        const response = await stub.fetch("https://session/bridge-call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return (await response.json()) as Record<string, any>;
      });
    let envelope: Record<string, any>;
    try {
      const outcome = signal
        ? await Promise.race([
            callBrowser(targetSessionId, { op, ...payload }),
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled")),
                { once: true },
              );
            }),
          ])
        : await callBrowser(targetSessionId, { op, ...payload });
      envelope = outcome as Record<string, any>;
    } catch (error) {
      if (error instanceof ToolErrorException) throw error;
      // A fetch-level failure: the outcome is unknown, so it must never
      // be retried on another browser (it may already have executed).
      throw new BridgeForwardError("CONFLICT", `Bridge call to the selected browser failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        executed: true,
      });
    }
    if (typeof envelope.connected === "boolean") {
      this.knownDisconnected = !envelope.connected;
      this.knownDisconnectedAt = envelope.connected ? 0 : Date.now();
    }
    if (envelope.ok !== false) return envelope;
    const err = (envelope.error ?? {}) as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown; executed?: unknown };
    const code = typeof err.code === "string" && err.code ? (err.code as ToolErrorCode) : "CONFLICT";
    throw new BridgeForwardError(code, typeof err.message === "string" && err.message ? err.message : "Bridge call failed", {
      retryable: err.retryable === true,
      ...(err.details && typeof err.details === "object" ? { details: err.details as Record<string, unknown> } : {}),
      executed: err.executed === true,
    });
  }
}
