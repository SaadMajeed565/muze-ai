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
} from "../libs/tool-contracts/index.js";

export interface BridgeToolResult {
  result: unknown;
  dryRun: boolean;
  durationMs: number;
}

/** The subset of bridge operations the MCP layer depends on. */
export interface GatewayBridge {
  isConnected(): boolean;
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
  version: "0.5.0",
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
    const timeout = message.type === "approval.request" || message.type === "approval.respond" || message.type === "approval.wait"
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
 * A stable facade over whichever bridge is currently attached. The MCP server
 * is created once per Durable Object, so it must never hold a specific socket's
 * bridge directly (the extension can reconnect at any time).
 */
export class BridgeSlot implements GatewayBridge {
  private current: GatewayBridge | null = null;

  set(bridge: GatewayBridge | null): void {
    this.current = bridge;
  }

  isConnected(): boolean {
    return this.current?.isConnected() ?? false;
  }

  listTools(): Promise<ToolDescriptor[]> {
    return this.require().listTools();
  }

  callTool(call: {
    tool: string;
    input: unknown;
    approvalId?: string;
    dryRun?: boolean;
    client?: ClientIdentity;
    signal?: AbortSignal;
  }): Promise<BridgeToolResult> {
    return this.require().callTool(call);
  }

  callToolBatch(calls: ToolCallBatchItem[], options?: { client?: ClientIdentity; signal?: AbortSignal }): Promise<ToolBatchItemResult[]> {
    return this.require().callToolBatch(calls, options);
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
    if (!this.current || !this.current.isConnected()) {
      throw new ToolErrorException("CONFLICT", "No browser is connected to this session", { retryable: true });
    }
    return this.current;
  }
}
