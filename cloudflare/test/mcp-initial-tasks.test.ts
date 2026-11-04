import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SEARCH_DESCRIPTORS,
  createGatewayMcpServer,
  searchTools,
} from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

const TASK_SEQUENCE = ["tasks.create", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel", "tasks.approvePlan"];
const MASTER_TOOLS = ["observe", "act", "navigate", "form", "data"];
const SCOPE = "read:tools call:tools";

function connectedBridge(liveTools: Array<{ name: string }>): GatewayBridge {
  return {
    isConnected: () => true,
    listTools: async () => liveTools as never,
    callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
    callToolBatch: async () => [],
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
}

function disconnectedBridge(): GatewayBridge {
  return {
    isConnected: () => false,
    listTools: async () => [],
    callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
    callToolBatch: async () => [],
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
}

function liveUnifiedOnly(): Array<{ name: string }> {
  // What the extension's registry.list actually returns in production:
  // unified tools only (legacyTools: false) — tasks.* are host-protocol
  // tools, not ToolRegistry entries, so they are structurally absent.
  return SEARCH_DESCRIPTORS.filter((d) => MASTER_TOOLS.includes(d.name));
}

async function listToolNames(
  bridge: GatewayBridge,
  options?: { initialMode?: "read" | "act" | "plan" | "explore" | "summary" | "compaction" },
): Promise<string[]> {
  const server = createGatewayMcpServer(bridge, undefined, undefined, SCOPE, options);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("initial ListTools includes tasks tools (connected live list)", () => {
  test("connected session with unified-only live list still lists tasks.* first with tasks.create first", async () => {
    const names = await listToolNames(connectedBridge(liveUnifiedOnly()));
    expect(names.slice(0, 7)).toEqual(TASK_SEQUENCE);
    expect(names.filter((n) => n === "tasks.create")).toHaveLength(1);
    for (const master of MASTER_TOOLS) expect(names).toContain(master);
    expect(names).toContain("tools.discover");
    expect(names).toContain("tools.batch");
    expect(names).toContain("browsers.list");
    expect(names).toContain("browsers.select");
    // No duplicates, and the whole list fits the conservative cap.
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(16);
  });

  test("fail closed: connected session with an empty live list advertises no tasks tools", async () => {
    const names = await listToolNames(connectedBridge([]));
    expect(names.filter((n) => n.startsWith("tasks."))).toEqual([]);
    expect(names).toContain("browsers.list");
  });

  test("read mode keeps only read-only tasks tools in the initial list", async () => {
    const names = await listToolNames(connectedBridge(liveUnifiedOnly()), { initialMode: "read" });
    expect(names).toContain("tasks.get");
    expect(names).toContain("tasks.list");
    expect(names).not.toContain("tasks.create");
    expect(names).not.toContain("tasks.pause");
    expect(names).not.toContain("tasks.resume");
    expect(names).not.toContain("tasks.cancel");
    expect(names).not.toContain("tasks.approvePlan");
  });

  test("disconnected static path does not duplicate tasks tools", async () => {
    const names = await listToolNames(disconnectedBridge());
    expect(names.slice(0, 7)).toEqual(TASK_SEQUENCE);
    expect(names.filter((n) => n === "tasks.create")).toHaveLength(1);
  });
});

describe("tasks discovery ordering", () => {
  test('bare "tasks" query returns tasks.create first', () => {
    const found = searchTools("tasks", 6, { scope: SCOPE, mode: "act" });
    expect(found.length).toBe(6);
    expect(found[0]!.name).toBe("tasks.create");
  });

  test("promotion never injects tasks.create into unrelated queries", () => {
    const found = searchTools("tabs", 6, { scope: SCOPE, mode: "act" });
    expect(found.map((f) => f.name)).not.toContain("tasks.create");
  });
});
