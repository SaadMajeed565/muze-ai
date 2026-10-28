import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewaySocketTransport, normalizeBridgeUrl } from "../src/transports.js";
import { BridgeManager } from "../src/bridge-manager.js";

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

describe("GatewaySocketTransport reconnection", () => {
  const original = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = original;
  });

  function buildManager(): BridgeManager {
    return new BridgeManager({
      registry: { descriptors: () => [], require: () => { throw new Error("unused"); }, get: () => undefined } as never,
      policy: {} as never,
      approvals: {} as never,
      executor: {} as never,
      getContext: () => ({}) as never,
      server: { name: "test", version: "0.0.0" },
    });
  }

  it("keeps the connection registered and reconnects after a drop", () => {
    const manager = buildManager();
    manager.connectGateway("https://gw.example.com", "token");
    expect(manager.clientCount()).toBe(1);

    FakeWebSocket.instances[0].open();
    expect(manager.isConnected()).toBe(true);

    // A transient drop must not unregister the connection: the transport owns
    // reconnection and the manager has to keep dispatching inbound frames.
    FakeWebSocket.instances[0].close();
    expect(manager.clientCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].open();
    expect(manager.isConnected()).toBe(true);
    expect(manager.clientCount()).toBe(1);

    manager.disposeAll();
  });

  it("never puts the token in the WebSocket URL and sends it as the first message", () => {
    const transport = new GatewaySocketTransport("https://gw.example.com", "secret-token", { onMessage: () => {} });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).not.toContain("secret-token");
    expect(socket.url).not.toContain("token=");
    socket.open();
    // The auth frame is the first thing sent, before any bridge traffic.
    expect(socket.sent).toEqual([{ type: "auth", token: "secret-token" }]);
    transport.dispose();
  });

  it("latches auth-required on a 4401 close and does not retry with the same token", () => {
    const onAuthFailure = vi.fn();
    const transport = new GatewaySocketTransport("https://gw.example.com", "bad-token", {
      onMessage: () => {},
      onAuthFailure,
    });
    transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.closeWithCode(4401);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    transport.dispose();
  });

  it("does not stack sockets when connect() is called while one is open", () => {
    const transport = new GatewaySocketTransport("https://gw.example.com", "token", { onMessage: () => {} });
    transport.connect();
    FakeWebSocket.instances[0].open();

    transport.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    transport.dispose();
  });

  it("ignores a redundant close from an already-replaced socket", () => {
    const transport = new GatewaySocketTransport("https://gw.example.com", "token", { onMessage: () => {} });
    transport.connect();
    const first = FakeWebSocket.instances[0];
    first.open();
    first.close();

    // A duplicate close from the same socket must neither clobber state nor
    // schedule a second reconnect.
    first.close();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    transport.dispose();
  });
});

describe("normalizeBridgeUrl", () => {
  it("upgrades http to ws and defaults the path to /bridge", () => {
    expect(normalizeBridgeUrl("http://127.0.0.1:8788")).toBe("ws://127.0.0.1:8788/bridge");
  });

  it("upgrades https to wss", () => {
    expect(normalizeBridgeUrl("https://bridge.example.com")).toBe("wss://bridge.example.com/bridge");
  });

  it("leaves ws/wss URLs (and explicit paths) intact", () => {
    expect(normalizeBridgeUrl("ws://127.0.0.1:8788/bridge")).toBe("ws://127.0.0.1:8788/bridge");
    expect(normalizeBridgeUrl("wss://host:9443/bridge")).toBe("wss://host:9443/bridge");
  });

  it("defaults a scheme-less host to secure wss", () => {
    expect(normalizeBridgeUrl("127.0.0.1:8788")).toBe("wss://127.0.0.1:8788/bridge");
  });

  it("rejects plaintext sockets to non-loopback hosts", () => {
    expect(() => normalizeBridgeUrl("http://bridge.example.com")).toThrow(/localhost development/);
    expect(() => normalizeBridgeUrl("ws://bridge.example.com")).toThrow(/localhost development/);
  });

  it("preserves an explicit non-root path and query", () => {
    expect(normalizeBridgeUrl("http://127.0.0.1:8788/custom?x=1")).toBe("ws://127.0.0.1:8788/custom?x=1");
  });

  it("preserves the bridge session query the gateway routes on (0.5.1 regression)", () => {
    expect(normalizeBridgeUrl("https://gw.example.com?session=abc-123")).toBe("wss://gw.example.com/bridge?session=abc-123");
  });
});
