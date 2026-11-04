import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BROWSER_TOOL_DESCRIPTORS, createGatewayMcpServer, isBrowsersToolVisible } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

const fakeBridge: GatewayBridge = {
  isConnected: () => false,
  listTools: async () => [],
  callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
  callToolBatch: async () => [],
  createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
  respondApproval: async () => undefined,
  waitApproval: async () => true,
};

async function connect(options: {
  scope?: string;
  initialMode?: "read" | "act" | "plan" | "explore" | "summary" | "compaction";
  browsers?: { list: () => Promise<{ browsers: Array<Record<string, unknown>>; defaultSessionId: string; currentSessionId: string }>; select: (sessionId: string) => Promise<{ sessionId: string; name: string }> };
}): Promise<Client> {
  const server = createGatewayMcpServer(fakeBridge, { id: "oc_test", name: "test", transport: "remote" }, undefined, options.scope, {
    ...(options.initialMode ? { initialMode: options.initialMode } : {}),
    ...(options.browsers ? { browsers: options.browsers } : {}),
  });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const handler = {
  list: async () => ({
    browsers: [
      { sessionId: "browser-a", name: "Browser A", isDefault: true },
      { sessionId: "browser-b", name: "Browser B", isDefault: false },
    ],
    defaultSessionId: "browser-a",
    currentSessionId: "browser-a",
  }),
  select: async (sessionId: string) => ({ sessionId, name: "Browser B" }),
};

describe("gateway-native browsers tools", () => {
  test("descriptors carry no token fields and list is read-only while select is reversible", () => {
    const list = BROWSER_TOOL_DESCRIPTORS.find((tool) => tool.name === "browsers.list");
    const select = BROWSER_TOOL_DESCRIPTORS.find((tool) => tool.name === "browsers.select");
    expect(list?.risk).toBe("read-only");
    expect(select?.risk).toBe("reversible");
    // No device-token field is ever defined or returned by these tools
    // (the prose mention of "device tokens are never returned" is the rule).
    expect(JSON.stringify(BROWSER_TOOL_DESCRIPTORS)).not.toMatch(/deviceToken/);
    for (const descriptor of BROWSER_TOOL_DESCRIPTORS) {
      const properties = (descriptor.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties)).not.toContain("deviceToken");
      expect(Object.keys(properties)).not.toContain("token");
    }
  });

  test("mode visibility: list is visible in read mode, select is not; neither in summary", () => {
    expect(isBrowsersToolVisible("read", "browsers.list")).toBe(true);
    expect(isBrowsersToolVisible("read", "browsers.select")).toBe(false);
    expect(isBrowsersToolVisible("act", "browsers.select")).toBe(true);
    expect(isBrowsersToolVisible("plan", "browsers.select")).toBe(true);
    expect(isBrowsersToolVisible("summary", "browsers.list")).toBe(false);
  });

  test("ListTools includes both tools and calls work without a connected browser", async () => {
    const client = await connect({ scope: "read:tools call:tools", browsers: handler });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("browsers.list");
    expect(names).toContain("browsers.select");

    const listed = (await client.callTool({ name: "browsers.list", arguments: {} })) as { content: { text: string }[] };
    const body = JSON.parse(listed.content[0].text) as { browsers: unknown[]; defaultSessionId: string };
    expect(body.browsers).toHaveLength(2);
    expect(body.defaultSessionId).toBe("browser-a");

    const selected = (await client.callTool({ name: "browsers.select", arguments: { sessionId: "browser-b" } })) as {
      content: { text: string }[];
    };
    const selectedBody = JSON.parse(selected.content[0].text) as { sessionId: string; note: string };
    expect(selectedBody.sessionId).toBe("browser-b");
    expect(selectedBody.note).toMatch(/re-initialize/);
  });

  test("read-only scope can list but cannot select; read mode cannot select", async () => {
    const readOnly = await connect({ scope: "read:tools", browsers: handler });
    const denied = (await readOnly.callTool({ name: "browsers.select", arguments: { sessionId: "browser-b" } })) as {
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);

    const readMode = await connect({ scope: "read:tools call:tools", initialMode: "read", browsers: handler });
    const { tools } = await readMode.listTools();
    expect(tools.map((tool) => tool.name)).toContain("browsers.list");
    expect(tools.map((tool) => tool.name)).not.toContain("browsers.select");
    const modeDenied = (await readMode.callTool({ name: "browsers.select", arguments: { sessionId: "browser-b" } })) as {
      isError?: boolean;
    };
    expect(modeDenied.isError).toBe(true);
  });

  test("select without a sessionId is an input error, and batching browsers tools is refused", async () => {
    const client = await connect({ scope: "read:tools call:tools", browsers: handler });
    const missing = (await client.callTool({ name: "browsers.select", arguments: {} })) as { isError?: boolean };
    expect(missing.isError).toBe(true);
    const batched = (await client.callTool({
      name: "tools.batch",
      arguments: { calls: [{ tool: "browsers.list", input: {} }] },
    })) as { isError?: boolean };
    expect(batched.isError).toBe(true);
  });

  test("browsers.list/select never reach the bridge, so they can never become activity rows", async () => {
    // Gateway-native by construction: the SessionDO-supplied handler
    // answers them, and the bridge — the only path to the extension
    // executor, hence to the activity feed/history — is never called.
    // A connection check through browsers.list therefore leaves the
    // Tasks record clean without any suppression logic.
    const bridgeCalls: string[] = [];
    const spyingBridge: GatewayBridge = {
      ...fakeBridge,
      callTool: async (call) => {
        bridgeCalls.push(call.tool);
        return { result: {}, dryRun: false, durationMs: 0 };
      },
    };
    const server = createGatewayMcpServer(spyingBridge, { id: "oc_test", name: "test", transport: "remote" }, undefined, "read:tools call:tools", { browsers: handler });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: "browsers.list", arguments: {} });
      await client.callTool({ name: "browsers.select", arguments: { sessionId: "browser-b" } });
      expect(bridgeCalls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
