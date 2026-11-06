import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CORE_TOOL_NAMES,
  MCP_INSTRUCTIONS,
  SEARCH_DESCRIPTORS,
  buildLayeredInstructions,
  createGatewayMcpServer,
  orderToolsTasksFirst,
} from "../src/mcp.js";
import { TASK_REQUIRED_MESSAGE } from "../libs/tool-contracts/index.js";
import type { GatewayBridge } from "../src/bridge.js";

const TASK_SEQUENCE = ["tasks.create", "tasks.complete", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel"];

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
  test("initialize instructions weave tasks.create into the workflow, with no top banner", () => {
    // The banner is gone: the rule lives inside the workflow sections,
    // not as a standalone paragraph the client can skim past.
    expect(MCP_INSTRUCTIONS.startsWith("You are an expert agentic browser operator")).toBe(true);
    expect(MCP_INSTRUCTIONS).not.toContain("IMPORTANT: Every task you undertake must be created with tasks.create");
    // Core agentic loop: task creation is step 1 of how work runs.
    expect(MCP_INSTRUCTIONS).toContain("Brief and create the task");
    expect(MCP_INSTRUCTIONS).toContain("call `tasks.create`");
    // Execution discipline: no bare multi-step direct calls.
    expect(MCP_INSTRUCTIONS).toContain("Work needing more than one action never runs as bare direct calls");
    // Direct-vs-task: direct calls are for read-only work, at most two
    // grounding reads before the task exists; the old "single read-only
    // observation" and "Decide direct vs task" lines are gone.
    expect(MCP_INSTRUCTIONS).toContain("at most two grounding reads before the task exists");
    expect(MCP_INSTRUCTIONS).toContain("Direct calls are for read-only work");
    expect(MCP_INSTRUCTIONS).not.toContain("Decide direct vs task");
    expect(MCP_INSTRUCTIONS).not.toContain("1-3 steps");
    expect(MCP_INSTRUCTIONS).not.toContain("Decide direct vs plan");
    // Steps are not named at all — not even to forbid them — so the
    // AI has no task-step concept to fall back on.
    expect(MCP_INSTRUCTIONS).not.toMatch(/step/i);
    // Follow-up work files into the existing task by id, never a
    // second task; connection checks go through browsers.list, never
    // probe reads.
    expect(MCP_INSTRUCTIONS).toContain("include the returned task id in every subsequent tool call");
    expect(MCP_INSTRUCTIONS).toContain("never create a second task for the same job");
    expect(MCP_INSTRUCTIONS).toContain("To check the Muze connection itself, call `browsers.list`");
    // The brief becomes the task's description.
    expect(MCP_INSTRUCTIONS).toContain("The brief becomes the task's description");
    // Assembled instructions carry the same weave, still starting with
    // the agent line rather than a banner.
    const assembled = buildLayeredInstructions({
      mode: "act",
      environment: { browserConnected: false, clientType: "unknown", scopePresent: true, discoveredCount: 0 },
      discovered: [],
    });
    expect(assembled.startsWith("You are an expert agentic browser operator")).toBe(true);
    expect(assembled).not.toContain("IMPORTANT: Every task you undertake must be created with tasks.create");
    expect(assembled).toContain("Brief and create the task");
    expect(assembled).toContain("at most two grounding reads before the task exists");
    // The tool-selection layer moved out of initialize (startup-latency
    // batch): it is served by tools.discover, not assembled here.
    expect(assembled).not.toContain("GENERATED TOOL SELECTION");
  });

  test("speed guidance is taught and the taskId sentence matches the advertised schema", () => {
    // Speed without losing accuracy: batch reads, text-only observe,
    // act on the first good observe, light verify.
    expect(MCP_INSTRUCTIONS).toContain("batch independent grounding reads in one `tools.batch` call");
    expect(MCP_INSTRUCTIONS).toContain("ask for a screenshot only when refs and text cannot identify the target");
    expect(MCP_INSTRUCTIONS).toContain("Act on the first good observe");
    expect(MCP_INSTRUCTIONS).toContain("light re-observe (text and refs)");
    // taskId is filed by the gateway before validation, so no instruction
    // may still claim it is schema-invisible, and the wording must not
    // overclaim it is declared on every tool's input schema.
    expect(MCP_INSTRUCTIONS).not.toContain("does not appear in any tool's input schema");
    expect(TASK_REQUIRED_MESSAGE).not.toContain("does not appear in any tool's input schema");
    expect(TASK_REQUIRED_MESSAGE).toContain("the gateway reads it before validation");
    expect(TASK_REQUIRED_MESSAGE).not.toContain("declared optional field on every tool's input schema");
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

  test("live ListTools response still contains the full 14-tool core set", async () => {
    // Moving the tool-selection layer out of initialize must not change
    // ListTools coverage: common jobs still work without a discover call.
    const server = createGatewayMcpServer(disconnectedBridge(), undefined, undefined, "read:tools call:tools");
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      expect(CORE_TOOL_NAMES.size).toBe(14);
      for (const name of CORE_TOOL_NAMES) expect(names.has(name)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("live ListTools trims the tasks.create description and the injected taskId text", async () => {
    // Startup-latency batch: the description was 1,165 chars and the
    // injected taskId text 224 chars, duplicating what the initialize
    // instructions already carry. Both stay meaningful, just shorter.
    const server = createGatewayMcpServer(disconnectedBridge(), undefined, undefined, "read:tools call:tools");
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const create = tools.find((t) => t.name === "tasks.create");
      expect(create).toBeDefined();
      const createDescription = create?.description ?? "";
      expect(createDescription.length).toBeLessThan(500);
      expect(createDescription).toContain("exactly ONE task per job");
      expect(createDescription).toContain("include the returned task id in every later call");
      const observe = tools.find((t) => t.name === "observe");
      const schema = observe?.inputSchema as { properties?: { taskId?: { description?: string } } };
      const taskIdDescription = schema?.properties?.taskId?.description ?? "";
      expect(taskIdDescription.length).toBeGreaterThan(0);
      expect(taskIdDescription.length).toBeLessThan(130);
      expect(taskIdDescription).toContain("include it in every call");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
