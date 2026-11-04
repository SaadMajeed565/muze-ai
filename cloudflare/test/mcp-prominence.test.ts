import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_INSTRUCTIONS,
  SEARCH_DESCRIPTORS,
  buildLayeredInstructions,
  createGatewayMcpServer,
  filterDescriptorsByMode,
  orderToolsTasksFirst,
} from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

const TASK_SEQUENCE = ["tasks.create", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel", "tasks.approvePlan"];

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

describe("tasks prominence in initialize + ListTools", () => {
  test("initialize instructions lead with the IMPORTANT must-create rule", () => {
    expect(MCP_INSTRUCTIONS.startsWith("IMPORTANT: Every task you undertake must be created with tasks.create")).toBe(true);
    const assembled = buildLayeredInstructions({
      mode: "act",
      visibleDescriptors: filterDescriptorsByMode(SEARCH_DESCRIPTORS, "act"),
      environment: { browserConnected: false, clientType: "unknown", scopePresent: true, discoveredCount: 0 },
      discovered: [],
    });
    // Layer 1 is first in the assembly, so the rule is the first thing
    // the client reads at session start.
    expect(assembled.startsWith("IMPORTANT: Every task you undertake must be created with tasks.create")).toBe(true);
    expect(assembled).toContain("Tasks list");
    expect(assembled).toContain("direct tool calls");
  });

  test("orderToolsTasksFirst puts tasks.* first with tasks.create first, set unchanged", () => {
    const input = SEARCH_DESCRIPTORS.map((t) => ({ name: t.name }));
    const ordered = orderToolsTasksFirst(input);
    expect(ordered.map((t) => t.name).slice(0, 7)).toEqual(TASK_SEQUENCE);
    expect(ordered[0].name).toBe("tasks.create");
    // Exact set unchanged (sorted comparison, like the registry test).
    expect(ordered.map((t) => t.name).sort()).toEqual(input.map((t) => t.name).sort());
    // Everything else keeps its current relative order.
    const nonTasksIn = input.filter((t) => !t.name.startsWith("tasks."));
    const nonTasksOut = ordered.filter((t) => !t.name.startsWith("tasks."));
    expect(nonTasksOut.map((t) => t.name)).toEqual(nonTasksIn.map((t) => t.name));
    const tasksIn = input.filter((t) => t.name.startsWith("tasks."));
    expect(tasksIn.map((t) => t.name)).toEqual(TASK_SEQUENCE);
  });

  test("orderToolsTasksFirst pins tasks.create first even when it is not first in input", () => {
    const ordered = orderToolsTasksFirst([{ name: "tabs.list" }, { name: "tasks.get" }, { name: "tasks.create" }, { name: "observe" }]);
    expect(ordered.map((t) => t.name)).toEqual(["tasks.create", "tasks.get", "tabs.list", "observe"]);
  });

  test("live ListTools response lists tasks.* first with tasks.create first", async () => {
    const server = createGatewayMcpServer(disconnectedBridge(), undefined, undefined, "read:tools call:tools");
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names[0]).toBe("tasks.create");
      expect(names.slice(0, 7)).toEqual(TASK_SEQUENCE);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
