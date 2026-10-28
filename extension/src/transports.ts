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
export class GatewaySocketTransport implements BridgeTransport {
  private socket: WebSocket | null = null;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1000;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly sink: TransportSink,
  ) {}

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
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
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
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer) return;
    // The MV3 keepalive alarm is the recovery path while offline; do not spin
    // futile reconnects when the OS already knows the network is down.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
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
