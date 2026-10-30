import type { BridgeClientMessage, BridgeHostMessage } from "../libs/tool-contracts/index.js";
import type { BridgeTransport } from "./host-protocol.js";

export interface TransportSink {
  onMessage: (message: BridgeClientMessage) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string, code?: number) => void;
  /** The gateway rejected our credentials; do not retry until the user signs in again. */
  onAuthFailure?: (reason: string) => void;
}

/**
 * WebSocket transport for the cloud gateway. The extension dials out to the
 * gateway's `/bridge` endpoint over TLS and authenticates with its device token.
 *
 * SECURITY (v0.3.0): the token is NEVER placed in the WebSocket URL. URLs
 * are logged by proxies, servers and crash reports; a `?token=` query
 * parameter would leak the credential into all of them. The new flow opens
 * the socket with no credential, then sends the token as the FIRST message
 * over the (TLS) socket, in exactly this shape:
 *
 *   { "type": "auth", "token": "<device token>" }
 *
 * The gateway verifies that message and closes the socket with 4401
 * (unauthenticated) or 4403 (forbidden) on failure — see the coordinator
 * notes, because the gateway section must implement that close behaviour.
 * On such a close this transport latches auth-required (via onAuthFailure)
 * and does NOT retry with the same token, exactly as before.
 *
 * The socket is always `wss://` in production. `ws://` is accepted only for
 * loopback development gateways, because a plaintext socket carrying a device
 * token is never acceptable for a deployed extension.
 */
/** Default time to wait for a WebSocket handshake before giving up and retrying. */
export const BRIDGE_CONNECT_TIMEOUT_MS = 15_000;
/** Fallback retry delay when the network is down, even if no `online` event fires. */
export const BRIDGE_OFFLINE_RETRY_MS = 30_000;

export interface GatewaySocketTransportOptions {
  /** Override for tests; defaults to BRIDGE_CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
}

export class GatewaySocketTransport implements BridgeTransport {
  private socket: WebSocket | null = null;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private onlineListener: (() => void) | null = null;
  private retryDelay = 1000;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly sink: TransportSink,
    options?: GatewaySocketTransportOptions,
  ) {
    this.connectTimeoutMs = options?.connectTimeoutMs ?? BRIDGE_CONNECT_TIMEOUT_MS;
  }

  connect(): void {
    if (this.disposed) return;
    // Never stack sockets: skip if one is already live or still connecting.
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return;
    }
    let url: string;
    try {
      url = normalizeBridgeUrl(this.url);
      // Defence in depth: even if a caller embedded a token in the URL, it
      // must not reach the wire as a query parameter.
      const parsed = new URL(url);
      parsed.searchParams.delete("token");
      url = parsed.toString();
    } catch (error) {
      this.sink.onDisconnect?.(`invalid bridge URL: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.sink.onDisconnect?.(`could not open bridge socket: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    // A stalled handshake must not sit in CONNECTING forever: without a
    // timeout the socket never fires close, no reconnect is scheduled,
    // and a later connect() early-returns because a socket is "still
    // connecting". On timeout, close the socket so the close handler
    // below runs the normal backoff reconnect.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close();
        } catch {
          // A failed close still leaves the close handler to run; if it
          // never fires, the next connectGateway call disposes this
          // transport and starts a fresh one.
        }
      }
    }, this.connectTimeoutMs);
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.retryDelay = 1000;
      // Authenticate as the first frame, before any bridge traffic. The
      // gateway closes with 4401/4403 if this fails; that close is handled
      // below by latching auth-required with no retry.
      if (this.token) {
        try {
          socket.send(JSON.stringify({ type: "auth", token: this.token }));
        } catch {
          // A failed send surfaces as a socket error/close, handled below.
        }
      }
      this.sink.onConnect?.();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      try {
        this.sink.onMessage(JSON.parse(String(event.data)) as BridgeClientMessage);
      } catch {
        // ignore malformed frames
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.disposed) return;
      // A stale socket closing after a newer one took over must not clobber the
      // live reference or trigger another reconnect (that would thrash).
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.socket = null;
      const code = typeof (event as CloseEvent).code === "number" ? (event as CloseEvent).code : 1006;
      if (isAuthCloseCode(code)) {
        this.sink.onAuthFailure?.(`gateway rejected the session (${code})`);
        this.sink.onDisconnect?.(`authentication required (${code})`, code);
        return;
      }
      this.sink.onDisconnect?.(`socket closed (${code})`, code);
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // "close" fires afterwards and drives reconnection.
    });
  }

  post(message: BridgeHostMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearConnectTimer();
    this.clearOnlineListener();
    this.socket?.close();
    this.socket = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearOnlineListener(): void {
    if (!this.onlineListener) return;
    const target = globalThis as { removeEventListener?: unknown };
    if (typeof target.removeEventListener === "function") {
      (target.removeEventListener as (type: string, listener: () => void) => void)("online", this.onlineListener);
    }
    this.onlineListener = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Offline used to be a dead end: this returned without scheduling
      // anything and there was no `online` listener, so the transport
      // stayed dead until the keepalive alarm or a manual reconnect.
      // Now resume the moment the network returns, with a capped
      // fallback retry in case the `online` event never fires.
      const target = globalThis as { addEventListener?: unknown };
      if (!this.onlineListener && typeof target.addEventListener === "function") {
        const handler = (): void => {
          this.onlineListener = null;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = null;
          if (!this.disposed) this.connect();
        };
        this.onlineListener = handler;
        (target.addEventListener as (type: string, listener: () => void, options?: { once?: boolean }) => void)(
          "online",
          handler,
          { once: true },
        );
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, BRIDGE_OFFLINE_RETRY_MS);
      return;
    }
    const jittered = Math.round(this.retryDelay * (0.5 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, jittered);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }
}

function isAuthCloseCode(code: number): boolean {
  return code === 1008 || code === 4401 || code === 4403;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * Normalize a configured gateway origin into a bridge URL.
 *
 * Production URLs must be HTTPS and become WSS. Plain HTTP/WS is only
 * permitted for loopback development. A missing scheme is treated as HTTPS
 * (never as an insecure socket), and an empty path becomes `/bridge`.
 */
export function normalizeBridgeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Bridge URL is required");

  let value = trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) {
    value = `wss://${value}`;
  } else if (scheme === "https") {
    value = `wss://${value.slice("https://".length)}`;
  } else if (scheme === "http") {
    value = `ws://${value.slice("http://".length)}`;
  }

  const parsed = new URL(value);
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error(`Unsupported bridge scheme "${parsed.protocol}"`);
  }
  if (parsed.protocol === "ws:" && !isLoopback(parsed.hostname)) {
    throw new Error("Insecure ws:// is only allowed for localhost development; use https://");
  }
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/bridge";
  return parsed.toString();
}

/** The first-message auth shape the gateway must accept (see header comment). */
export const BRIDGE_AUTH_MESSAGE_TYPE = "auth";
