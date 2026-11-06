import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Preflight skip on reconnect, exercised through the real service-worker
 * `connectGateway` (via the `muze/bridge/settings` and
 * `muze/bridge/reconnect` dashboard routes), not just the decision helper:
 * a stubbed chrome captures the onMessage listener at import time, a
 * stubbed fetch counts `/session/status` preflight calls, and a fake
 * WebSocket lets the test open (and 4401-close) the gateway socket.
 *
 * The four tests share one imported module on purpose and must run in
 * order: they are a single scenario — first connect, reconnect with the
 * same token, reconnect with a changed token, then a 4401 rejection —
 * and each step's assertions depend on the module state the previous
 * step built. A fresh module would restart the scenario at "first
 * connect".
 */

const EXTENSION_ID = "test-extension-id-abcdefghijklmnop";
const TOKEN_A = "device-token-a";
const TOKEN_B = "device-token-b";
const SESSION_ID = "session-1";

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

let capturedListener: Listener | null = null;
/** Every URL the service worker fetched for the gateway status preflight. */
const statusFetchUrls: string[] = [];

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

beforeAll(async () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener: (listener: Listener) => {
          capturedListener = listener;
        },
      },
      onInstalled: { addListener: () => undefined },
      sendMessage: async () => undefined,
    },
    alarms: {
      onAlarm: { addListener: () => undefined },
      create: () => undefined,
      clear: async () => undefined,
    },
    tabs: {
      onActivated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      query: async () => [],
    },
    action: {
      setBadgeText: () => undefined,
      setBadgeBackgroundColor: () => undefined,
    },
    sidePanel: { setPanelBehavior: async () => undefined },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async () => undefined,
      },
    },
    offscreen: { hasDocument: async () => true },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes("/session/status")) {
        statusFetchUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      // The on-connect browsers-cache refresh hits /account/browsers;
      // any other gateway fetch gets an empty-but-ok body.
      return { ok: true, status: 200, json: async () => ({ browsers: [], mcpClients: [] }) };
    }),
  );
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // Dynamic import AFTER the stubs: the module registers its listeners
  // and runs initialize() at import time.
  await import("../src/service-worker.js");
  // Let initialize() settle (storage reads, keepalive, gateway no-op:
  // gateway is disabled until the first test signs in).
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(capturedListener).not.toBeNull();
});

function invoke(message: unknown, sender: unknown = { id: EXTENSION_ID }): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = capturedListener as Listener;
    const returned = listener(message, sender, (response: unknown) => resolve(response));
    // Listeners that return false without responding close the channel
    // with no response; resolve as undefined so the test can assert it.
    if (returned === false) {
      setTimeout(() => resolve(undefined), 10);
    }
  });
}

/** Open the most recently dialled socket, as the gateway would accept it. */
function openLatestSocket(): void {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  expect(socket).toBeDefined();
  socket.open();
}

describe("gateway preflight skip on reconnect", () => {
  it("runs the preflight on the first connect (no prior successful connect)", async () => {
    const response = (await invoke({
      type: "muze/bridge/settings",
      patch: { gatewayEnabled: true, gatewayToken: TOKEN_A, gatewaySessionId: SESSION_ID },
    })) as { ok: boolean };
    expect(response.ok).toBe(true);
    expect(statusFetchUrls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("session=session-1");
    // The socket opens: this token has now proved itself.
    openLatestSocket();
    // Let the on-connect browsers-cache refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("skips the preflight on reconnect with the same token", async () => {
    const response = (await invoke({ type: "muze/bridge/reconnect" })) as { ok: boolean };
    expect(response.ok).toBe(true);
    expect(statusFetchUrls).toHaveLength(1);
    // A fresh socket was still dialled — only the HTTPS preflight is skipped.
    expect(FakeWebSocket.instances).toHaveLength(2);
    openLatestSocket();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("runs the preflight again for a changed token, then skips for the new one", async () => {
    const response = (await invoke({
      type: "muze/bridge/settings",
      patch: { gatewayToken: TOKEN_B },
    })) as { ok: boolean };
    expect(response.ok).toBe(true);
    expect(statusFetchUrls).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(3);
    openLatestSocket();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The new token has now proved itself too: reconnecting with it skips.
    const reconnected = (await invoke({ type: "muze/bridge/reconnect" })) as { ok: boolean };
    expect(reconnected.ok).toBe(true);
    expect(statusFetchUrls).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(4);
    openLatestSocket();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("keeps the 4401 backstop: a rejected token latches auth-required and is not redialled", async () => {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    socket.closeWithCode(4401);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = (await invoke({ type: "muze/bridge/reconnect" })) as { ok: boolean };
    expect(response.ok).toBe(true);
    // Latched: no new socket and no new preflight for the rejected token.
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(statusFetchUrls).toHaveLength(2);
  });
});
