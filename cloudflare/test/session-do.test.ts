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

describe("SessionDO Phase A mode persistence", () => {
  async function postRpc(method: string, params: unknown, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return new Request("https://gateway.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
    }) as unknown as Response;
  }

  // The DO fetch handler takes a Request; postRpc above builds one.
  async function doFetch(sut: SessionDO, method: string, params: unknown, sessionId?: string): Promise<Response> {
    const req = await postRpc(method, params, sessionId);
    return sut.fetch(req as unknown as Request);
  }

  function sseResults(text: string): unknown[] {
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim()) as { result?: unknown };
        if (parsed.result !== undefined) out.push(parsed.result);
      } catch {
        // ignore non-JSON SSE lines
      }
    }
    return out;
  }

  test("read mode selected via prompt survives a cold DO rebuild", async () => {
    const store = memoryStorage();
    const warm = new SessionDO(fakeState("do-mode", store));
    const init = await warm.fetch(post("initialize"));
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const promptRes = await doFetch(warm, "prompts/get", { name: "autonomous_browser_agent", arguments: { goal: "read", mode: "read" } }, sessionId ?? undefined);
    expect(promptRes.status).toBe(200);

    const listRes = await doFetch(warm, "tools/list", {}, sessionId ?? undefined);
    const warmNames = sseResults(await listRes.text()).flatMap((r) => {
      const tools = (r as { tools?: { name: string }[] }).tools ?? [];
      return tools.map((t) => t.name);
    });
    expect(warmNames).toContain("observe");
    expect(warmNames).not.toContain("act");
    expect(warmNames).not.toContain("form");

    // Cold instance: no in-memory transport, rebuilds from durable storage.
    const cold = new SessionDO(fakeState("do-mode", store));
    const coldList = await doFetch(cold, "tools/list", {}, sessionId ?? undefined);
    expect(coldList.status).toBe(200);
    const coldNames = sseResults(await coldList.text()).flatMap((r) => {
      const tools = (r as { tools?: { name: string }[] }).tools ?? [];
      return tools.map((t) => t.name);
    });
    expect(coldNames).toContain("observe");
    expect(coldNames).not.toContain("act");
    expect(coldNames).not.toContain("form");
  });
});

describe("SessionDO Phase D session unification", () => {
  /** memoryStorage wrapped with a put-key spy: proves session state lands in one record. */
  function spyStorage() {
    const inner = memoryStorage();
    const putKeys: string[] = [];
    const storage = {
      ...inner,
      async put(key: string, value: unknown): Promise<void> {
        putKeys.push(key);
        await inner.put(key, value);
      },
    };
    return { storage, putKeys };
  }

  function scopedPost(method: string, params: unknown, sessionId?: string): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-muze-client-scope": "call:tools",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return new Request("https://gateway.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method, params }),
    });
  }

  function sseToolNames(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim()) as { result?: { tools?: { name: string }[] } };
        for (const tool of parsed.result?.tools ?? []) out.push(tool.name);
      } catch {
        // ignore non-JSON SSE lines
      }
    }
    return out;
  }

  function sseCallText(text: string): string {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(5).trim()) as {
          result?: { content?: { type: string; text?: string }[] };
        };
        const first = parsed.result?.content?.[0];
        if (first?.type === "text" && typeof first.text === "string") return first.text;
      } catch {
        // ignore non-JSON SSE lines
      }
    }
    return "";
  }

  test("mode + discovered set survive a cold rebuild from the single mcp:sessions record", async () => {
    const { storage, putKeys } = spyStorage();
    const warm = new SessionDO(fakeState("do-phase-d", storage as never));
    const initParams = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    };
    const init = await warm.fetch(scopedPost("initialize", initParams));
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const promptRes = await warm.fetch(
      scopedPost("prompts/get", { name: "autonomous_browser_agent", arguments: { goal: "read", mode: "read" } }, sessionId ?? undefined),
    );
    expect(promptRes.status).toBe(200);

    // tools.discover runs before the bridge-connected check, so a
    // disconnected bridge still populates the session's discovered set.
    const discoverRes = await warm.fetch(
      scopedPost(
        "tools/call",
        { name: "tools.discover", arguments: { query: "organise tabs", limit: 3 } },
        sessionId ?? undefined,
      ),
    );
    expect(discoverRes.status).toBe(200);
    const discovered = (
      JSON.parse(sseCallText(await discoverRes.text())) as { found?: { name: string }[] }
    ).found?.map((f) => f.name) ?? [];
    expect(discovered.length).toBeGreaterThan(0);

    // Single-record invariant: every session-state write went to
    // mcp:sessions, and the stored record carries BOTH mode and the
    // discovered set — no second record, no in-memory-only copy.
    expect(new Set(putKeys)).toEqual(new Set(["mcp:sessions"]));
    const stored = (await storage.get("mcp:sessions")) as Record<string, { mode?: string; discovered?: string[] }>;
    expect(stored[sessionId ?? ""].mode).toBe("read");
    for (const name of discovered) expect(stored[sessionId ?? ""].discovered).toContain(name);

    // Cold instance: no in-memory transport, rebuilds from that record.
    const cold = new SessionDO(fakeState("do-phase-d", storage as never));
    const coldList = await cold.fetch(scopedPost("tools/list", {}, sessionId ?? undefined));
    expect(coldList.status).toBe(200);
    const coldNames = sseToolNames(await coldList.text());
    expect(coldNames).toContain("observe");
    expect(coldNames).not.toContain("act");
    expect(coldNames).not.toContain("form");
    for (const name of discovered) expect(coldNames).toContain(name);
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
