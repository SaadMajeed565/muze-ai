/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CONNECT_TIMEOUT_MS,
  BRIDGE_OFFLINE_RETRY_MS,
  GatewaySocketTransport,
} from "../src/transports.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data as string));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  closeWithCode(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

describe("GatewaySocketTransport v2 recovery", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalOnLine = globalThis.navigator.onLine;
  let transports: GatewaySocketTransport[] = [];

  function build(connectTimeoutMs?: number): GatewaySocketTransport {
    const transport = new GatewaySocketTransport("https://gw.example.com", "token", {
      onMessage: () => {},
    }, connectTimeoutMs === undefined ? undefined : { connectTimeoutMs });
    transports.push(transport);
    return transport;
  }

  function setOnLine(value: boolean): void {
    Object.defineProperty(globalThis.navigator, "onLine", { value, configurable: true });
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    transports = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const transport of transports) transport.dispose();
    vi.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
    setOnLine(originalOnLine);
  });

  it("exposes the v2 timeout constants", () => {
    expect(BRIDGE_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(BRIDGE_OFFLINE_RETRY_MS).toBe(30_000);
  });

  it("times out a stalled handshake and retries with backoff", () => {
    const transport = build(100);
    transport.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(transport.isConnected()).toBe(false);

    // No open event: the connect timer fires, closes the socket, and the
    // close handler schedules the normal backoff reconnect (jittered
    // 500–1000ms). Step the clock in small increments and stop the
    // moment the replacement socket exists: a single large advance
    // would also fire the replacement's own 100ms connect timer
    // before the test can open it, and its open would then hit the
    // stale-socket guard.
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(1);
    for (let i = 0; i < 30 && FakeWebSocket.instances.length < 2; i++) {
      vi.advanceTimersByTime(50);
    }
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].open();
    expect(transport.isConnected()).toBe(true);
  });

  it("resumes on the online event after an offline close, without waiting for the fallback", () => {
    const transport = build();
    transport.connect();
    FakeWebSocket.instances[0].open();
    expect(transport.isConnected()).toBe(true);

    setOnLine(false);
    FakeWebSocket.instances[0].close();
    // Offline must not dial immediately, and must not stay dead: no new
    // socket yet, but the online event resumes it at once.
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    setOnLine(true);
    globalThis.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(transport.isConnected()).toBe(true);
  });

  it("still latches auth-required on a 4401 close and does not retry", () => {
    const onAuthFailure = vi.fn();
    const transport = new GatewaySocketTransport("https://gw.example.com", "bad-token", {
      onMessage: () => {},
      onAuthFailure,
    });
    transports.push(transport);
    transport.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].closeWithCode(4401);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
