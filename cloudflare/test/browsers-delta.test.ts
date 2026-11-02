import { describe, expect, test } from "vitest";
import { SessionDO } from "../src/session-do.js";
import { browsersDeltaBrowser, browsersDeltaClient, pushBrowsersDelta } from "../src/directory-client.js";
import type { BrowsersDelta } from "../libs/tool-contracts/protocol.js";

/** Minimal in-memory stand-in for a Durable Object's storage backend. */
function memoryStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async setAlarm(time: number): Promise<void> {
      alarm = time;
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    async deleteAlarm(): Promise<void> {
      alarm = null;
    },
  };
}

function fakeState(id: string, sockets: unknown[] = []): DurableObjectState {
  return {
    id: { toString: () => id, name: id },
    getWebSockets: () => sockets,
    storage: memoryStorage(),
  } as unknown as DurableObjectState;
}

/** Fake bridge socket: the SessionDO constructor re-attaches it when its
 * attachment says authorized, which is how the open-socket route test
 * gets an activeSocket without a real hibernatable WebSocket. */
function fakeSocket() {
  const sent: string[] = [];
  const socket = {
    readyState: 1, // WebSocket.OPEN
    send: (message: string) => {
      sent.push(message);
    },
    close: () => undefined,
    serializeAttachment: () => undefined,
    deserializeAttachment: () => ({ authorized: true }),
  };
  return { socket, sent };
}

function fakeSessionEnv(calls: Array<{ sessionId: string; url: string; body: unknown }>, failing: Set<string> = new Set()) {
  return {
    SESSION_DO: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init?: RequestInit) => {
          calls.push({ sessionId: id.name, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
          if (failing.has(id.name)) throw new Error("target offline");
          return new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 });
        },
      }),
    },
  } as never;
}

const REMOVED: BrowsersDelta = { type: "browser.removed", sessionId: "s-gone" };

describe("pushBrowsersDelta fan-out", () => {
  test("targets exactly the given account browsers, one POST each, to /push-browsers-delta", async () => {
    const calls: Array<{ sessionId: string; url: string; body: unknown }> = [];
    await pushBrowsersDelta(fakeSessionEnv(calls), ["s-a", "s-b", "s-a"], REMOVED);
    expect(calls.map((call) => call.sessionId).sort()).toEqual(["s-a", "s-b"]);
    for (const call of calls) {
      expect(call.url).toBe("https://session/push-browsers-delta");
      expect(call.body).toEqual({ delta: REMOVED });
    }
  });

  test("a failing target does not fail the other pushes or the fan-out itself", async () => {
    const calls: Array<{ sessionId: string; url: string; body: unknown }> = [];
    await expect(
      pushBrowsersDelta(fakeSessionEnv(calls, new Set(["s-offline"])), ["s-offline", "s-ok"], REMOVED),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.sessionId).sort()).toEqual(["s-offline", "s-ok"]);
  });

  test("an empty target list resolves without any fetch", async () => {
    const calls: Array<{ sessionId: string; url: string; body: unknown }> = [];
    await expect(pushBrowsersDelta(fakeSessionEnv(calls), [], REMOVED)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("delta row shapes", () => {
  test("browser row mirrors the /account/browsers row (minus tabCount) with isDefault derived", () => {
    const row = browsersDeltaBrowser(
      { sessionId: "s-1", name: "Work", browser: "Chrome", os: "Linux", version: "130", createdAt: 111, lastSeenAt: 222 },
      "s-1",
      { connected: true },
    );
    expect(row).toEqual({
      sessionId: "s-1",
      name: "Work",
      browser: "Chrome",
      os: "Linux",
      version: "130",
      createdAt: 111,
      lastSeenAt: 222,
      isDefault: true,
      connected: true,
    });
    expect(browsersDeltaBrowser({ sessionId: "s-2" }, "s-1", { connected: false, lastSeenAt: 999 })).toEqual({
      sessionId: "s-2",
      name: "Browser",
      browser: "",
      os: "",
      version: "",
      createdAt: null,
      lastSeenAt: 999,
      isDefault: false,
      connected: false,
    });
  });

  test("client row mirrors the /account/browsers mcpClients row, with live timestamps only when live", () => {
    const entry = {
      clientId: "oc_1",
      clientName: "Claude",
      scope: "read:tools call:tools",
      sessionId: "s-1",
      createdAt: 100,
      lastRefreshedAt: 200,
      expiresAt: 300,
    };
    expect(browsersDeltaClient(entry, true, { createdAt: 400, lastActivityAt: 500 })).toEqual({
      clientId: "oc_1",
      clientName: "Claude",
      scope: "read:tools call:tools",
      sessionId: "s-1",
      live: true,
      connectedSince: 400,
      lastActivityAt: 500,
      authorizedSince: 100,
      lastRefreshedAt: 200,
      expiresAt: 300,
    });
    const offline = browsersDeltaClient(entry, false);
    expect(offline.live).toBe(false);
    expect(offline.connectedSince).toBeNull();
    expect(offline.lastActivityAt).toBeNull();
    expect(offline.authorizedSince).toBe(100);
  });
});

describe("SessionDO /push-browsers-delta route", () => {
  test("reports delivered:false and never throws when no bridge socket exists", async () => {
    const sut = new SessionDO(fakeState("do-delta-none"));
    const response = await sut.fetch(
      new Request("https://session/push-browsers-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: REMOVED }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, delivered: false });
  });

  test("delivers the browsers.delta frame over an open socket", async () => {
    const { socket, sent } = fakeSocket();
    const sut = new SessionDO(fakeState("do-delta-open", [socket]));
    const response = await sut.fetch(
      new Request("https://session/push-browsers-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: REMOVED }),
      }),
    );
    expect(await response.json()).toEqual({ ok: true, delivered: true });
    const frames = sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames.at(-1)).toEqual({ type: "browsers.delta", delta: REMOVED });
  });

  test("reports delivered:false and sends nothing when the socket is closed", async () => {
    const { socket, sent } = fakeSocket();
    const sut = new SessionDO(fakeState("do-delta-closed", [socket]));
    sent.length = 0;
    (socket as { readyState: number }).readyState = 3; // WebSocket.CLOSED
    const response = await sut.fetch(
      new Request("https://session/push-browsers-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: REMOVED }),
      }),
    );
    expect(await response.json()).toEqual({ ok: true, delivered: false });
    expect(sent).toEqual([]);
  });

  test("a malformed body never throws and reports delivered:false", async () => {
    const sut = new SessionDO(fakeState("do-delta-bad"));
    const response = await sut.fetch(
      new Request("https://session/push-browsers-delta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, delivered: false });
  });
});
