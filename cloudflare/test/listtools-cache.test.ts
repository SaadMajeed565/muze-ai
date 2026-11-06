import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeSlot, type GatewayBridge } from "../src/bridge.js";
import { SEARCH_DESCRIPTORS, createGatewayMcpServer } from "../src/mcp.js";
import type { ToolDescriptor } from "../libs/tool-contracts/index.js";

/** Live list like the real host: unified tools only, non-empty. */
const LIVE_A: ToolDescriptor[] = SEARCH_DESCRIPTORS.filter((d) =>
  ["observe", "act", "navigate", "form", "data", "browser", "tabs", "windows", "devtools", "clipboard", "files", "wait", "submit"].includes(d.name),
);
/** A narrower live list, as if the permission level dropped to read-only. */
const LIVE_B: ToolDescriptor[] = SEARCH_DESCRIPTORS.filter((d) => ["observe"].includes(d.name));

function countingBridge() {
  let calls = 0;
  let live: ToolDescriptor[] = LIVE_A;
  let connected = true;
  const bridge: GatewayBridge = {
    isConnected: () => connected,
    listTools: async () => {
      calls += 1;
      return [...live];
    },
    callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
    callToolBatch: async () => [],
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
  return {
    bridge,
    calls: () => calls,
    setLive: (tools: ToolDescriptor[]) => {
      live = tools;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

async function connect(
  bridge: GatewayBridge,
  scope = "call:tools",
  options?: { clientType?: string; listToolsCacheTtlMs?: number },
) {
  const server = createGatewayMcpServer(bridge, undefined, undefined, scope, options);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function listNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

async function discover(client: Client, query: string): Promise<{ found: Array<Record<string, unknown>> }> {
  const result = (await client.callTool({ name: "tools.discover", arguments: { query } })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as { found: Array<Record<string, unknown>> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("assembled ListTools cache (per MCP session)", () => {
  test("second ListTools in the same session returns the cached response without a second bridge round trip", async () => {
    const counting = countingBridge();
    const { server, client } = await connect(counting.bridge);
    try {
      const first = await client.listTools();
      const second = await client.listTools();
      expect(counting.calls()).toBe(1);
      expect(second).toEqual(first);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a mode change invalidates the cache", async () => {
    const counting = countingBridge();
    const { server, client } = await connect(counting.bridge);
    try {
      const before = await listNames(client);
      expect(before).toContain("act");
      expect(counting.calls()).toBe(1);
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      const after = await listNames(client);
      expect(counting.calls()).toBe(2);
      expect(after).toContain("observe");
      expect(after).not.toContain("act");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a discovered tool invalidates the cache", async () => {
    const counting = countingBridge();
    const { server, client } = await connect(counting.bridge);
    try {
      const before = await listNames(client);
      expect(before).not.toContain("workflows.collectLinks");
      expect(counting.calls()).toBe(1);
      await discover(client, "collect links");
      const after = await listNames(client);
      expect(counting.calls()).toBe(2);
      expect(after).toContain("workflows.collectLinks");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a bridge replace invalidates the cache, so a permission-level change shows up", async () => {
    const counting = countingBridge();
    const slot = new BridgeSlot();
    slot.set(counting.bridge);
    const { server, client } = await connect(slot);
    try {
      const before = await listNames(client);
      expect(before).toContain("act");
      expect(counting.calls()).toBe(1);
      // Permission level drops in the extension; the new socket's bridge
      // serves the narrower list. The slot generation bump invalidates.
      counting.setLive(LIVE_B);
      slot.set(counting.bridge);
      const after = await listNames(client);
      expect(counting.calls()).toBe(2);
      expect(after).toContain("observe");
      expect(after).not.toContain("act");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("without a bridge replace, a permission-level change propagates within the TTL", async () => {
    const counting = countingBridge();
    const { server, client } = await connect(counting.bridge, "call:tools", { listToolsCacheTtlMs: 300 });
    try {
      const before = await listNames(client);
      expect(before).toContain("act");
      expect(counting.calls()).toBe(1);
      counting.setLive(LIVE_B);
      // Still inside the TTL: the cached offer is served, no refetch.
      const cached = await listNames(client);
      expect(counting.calls()).toBe(1);
      expect(cached).toContain("act");
      await sleep(400);
      const after = await listNames(client);
      expect(counting.calls()).toBe(2);
      expect(after).toContain("observe");
      expect(after).not.toContain("act");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("different sessions do not share a cache", async () => {
    const counting = countingBridge();
    const first = await connect(counting.bridge);
    const second = await connect(counting.bridge);
    try {
      await listNames(first.client);
      await listNames(second.client);
      expect(counting.calls()).toBe(2);
      // Repeat lists are served from each session's own cache.
      await listNames(first.client);
      await listNames(second.client);
      expect(counting.calls()).toBe(2);
      // A mode change in the first session does not leak into the second.
      await first.client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      const firstAfter = await listNames(first.client);
      expect(counting.calls()).toBe(3);
      expect(firstAfter).not.toContain("act");
      const secondAfter = await listNames(second.client);
      expect(counting.calls()).toBe(3);
      expect(secondAfter).toContain("act");
    } finally {
      await first.client.close();
      await first.server.close();
      await second.client.close();
      await second.server.close();
    }
  });
});
