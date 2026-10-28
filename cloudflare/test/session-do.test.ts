import { describe, expect, test } from "vitest";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { PROTOCOL_VERSION } from "../libs/tool-contracts/index.js";
import { SessionDO, replayInitialize, type InitializeParams } from "../src/session-do.js";
import { createGatewayMcpServer } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

/** A minimal in-memory stand-in for a Durable Object's storage backend. */
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

type Storage = ReturnType<typeof memoryStorage>;

/**
 * A minimal stand-in for the Durable Object state. `id.toString()` is what the
 * DO uses as its stable MCP session id, so the test controls it directly.
 * Passing a shared storage simulates the same object waking up after eviction.
 */
function fakeState(id: string, storage: Storage = memoryStorage()): DurableObjectState {
  return {
    id: { toString: () => id, name: id },
    getWebSockets: () => [],
    storage,
  } as unknown as DurableObjectState;
}

function post(method: string, sessionId?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const params =
    method === "initialize"
      ? { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
      : { name: "tabs.list", arguments: {} };
  return new Request("https://gateway.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const disconnectedBridge: GatewayBridge = {
  isConnected: () => false,
  listTools: async () => [],
  callTool: () => Promise.reject(new Error("no browser")),
  callToolBatch: () => Promise.reject(new Error("no browser")),
  createApproval: () => Promise.reject(new Error("no browser")),
  respondApproval: () => Promise.resolve(),
  waitApproval: () => Promise.resolve(false),
};

describe("SessionDO MCP session recovery", () => {
  test("opens a new session on initialize", async () => {
    const sut = new SessionDO(fakeState("do-init"));
    const response = await sut.fetch(post("initialize"));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toMatch(/^do-init:/);
  });

  test("rebuilds a resumed session from storage after eviction instead of returning 400", async () => {
    // One DO instance initializes and persists its params...
    const store = memoryStorage();
    const warm = new SessionDO(fakeState("do-resume", store));
    const init = await warm.fetch(post("initialize"));
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // ...then a cold instance (as after hibernation/eviction) shares the same
    // durable storage but has no in-memory transport. A resumed `tools/call`
    // must be served, not rejected with 400 "Server not initialized".
    const cold = new SessionDO(fakeState("do-resume", store));
    const response = await cold.fetch(post("tools/call", sessionId ?? undefined));
    expect(response.status).toBe(200);
    // No OAuth scope reaches a directly-constructed SessionDO in this test,
    // so scope enforcement denies before the (disconnected) bridge is even
    // consulted — fail closed, exactly as production requires.
    expect(await response.text()).toContain("PERMISSION_DENIED");
  });

  test("keeps multiple MCP client sessions open independently", async () => {
    const sut = new SessionDO(fakeState("do-multi"));
    const first = await sut.fetch(post("initialize"));
    const second = await sut.fetch(post("initialize"));
    const firstId = first.headers.get("mcp-session-id");
    const secondId = second.headers.get("mcp-session-id");
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);

    // Neither initialize may tear down the other's transport.
    expect((await sut.fetch(post("tools/call", firstId ?? undefined))).status).toBe(200);
    expect((await sut.fetch(post("tools/call", secondId ?? undefined))).status).toBe(200);
  });

  test("rejects a session id this object does not own", async () => {
    const sut = new SessionDO(fakeState("do-owned"));
    const response = await sut.fetch(post("tools/call", "some-other-session"));
    expect(response.status).toBe(404);
  });

  test("replayed initialize restores the client's capabilities", async () => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => "do-replay",
    });
    const server = createGatewayMcpServer(disconnectedBridge);
    await server.connect(transport);

    expect(server.getClientCapabilities()).toBeUndefined();
    const params: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: "test", version: "1.0.0" },
    };
    await replayInitialize(transport, params);
    expect(server.getClientCapabilities()?.elicitation).toBeDefined();
  });
});

describe("SessionDO internal purge", () => {
  test("purge-mcp-sessions clears persisted sessions so a resumed call 404s", async () => {
    const store = memoryStorage();
    const warm = new SessionDO(fakeState("do-purge", store));
    const init = await warm.fetch(post("initialize"));
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const purged = await warm.fetch(
      new Request("https://gateway.test/purge-mcp-sessions", { method: "POST" }),
    );
    expect(purged.status).toBe(200);
    expect(((await purged.json()) as { ok?: boolean }).ok).toBe(true);

    const cold = new SessionDO(fakeState("do-purge", store));
    const response = await cold.fetch(post("tools/call", sessionId ?? undefined));
    expect(response.status).toBe(404);
  });
});
