import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

function fakeBridge(seen: { toolCalls: string[]; batchCalls: number; calls: unknown[]; batchItems: unknown[] }): GatewayBridge {
  return {
    isConnected: () => true,
    listTools: async () => [],
    callTool: async (call) => {
      seen.toolCalls.push(call.tool);
      seen.calls.push(call);
      return { result: {}, dryRun: false, durationMs: 0 };
    },
    callToolBatch: async (calls) => {
      seen.batchCalls += 1;
      seen.batchItems.push(...calls);
      return [];
    },
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
}

async function makeClient(scope: string | undefined) {
  const seen = { toolCalls: [] as string[], batchCalls: 0, calls: [] as unknown[], batchItems: [] as unknown[] };
  const server = createGatewayMcpServer(fakeBridge(seen), undefined, undefined, scope);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const callText = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
  };
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { seen, callText, close };
}

describe("task-required gate for tools.batch (whole batch)", () => {
  test("a pure-read batch is allowed and forwarded", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tools.batch", {
        calls: [
          { tool: "tabs", input: { action: "list" } },
          { tool: "tabs.list", input: {} },
        ],
      });
      expect(result.isError).toBeFalsy();
      expect(seen.batchCalls).toBe(1);
    } finally {
      await close();
    }
  });

  test("a batch with any action step is rejected as a whole with TASK_REQUIRED, nothing forwarded", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const mixed = await callText("tools.batch", {
        calls: [
          { tool: "tabs", input: { action: "list" } },
          { tool: "tabs", input: { action: "close", tabId: 1 } },
        ],
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.text).toContain("TASK_REQUIRED");
      expect(mixed.text).toContain("tasks.create");
      expect(seen.batchCalls).toBe(0);

      const granular = await callText("tools.batch", {
        calls: [{ tool: "dom.click", input: { ref: "r1" } }],
      });
      expect(granular.isError).toBe(true);
      expect(granular.text).toContain("TASK_REQUIRED");
      expect(seen.batchCalls).toBe(0);

      const unified = await callText("tools.batch", {
        calls: [{ tool: "navigate", input: { category: "tab", action: "create", url: "https://example.com" } }],
      });
      expect(unified.isError).toBe(true);
      expect(unified.text).toContain("TASK_REQUIRED");
      expect(seen.batchCalls).toBe(0);
    } finally {
      await close();
    }
  });

  test("a tasks.create item is exempt from the batch gate (management, not a page action)", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tools.batch", {
        calls: [
          { tool: "tabs", input: { action: "list" } },
          { tool: "tasks.create", input: { goal: "x", steps: [{ tool: "tabs.list", input: {} }] } },
        ],
      });
      expect(result.text).not.toContain("TASK_REQUIRED");
      expect(seen.batchCalls).toBe(1);
    } finally {
      await close();
    }
  });
});

describe("taskId forwarding (description-task filing)", () => {
  test("a single call's taskId argument is stripped from the input and sent as the bridge message field", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("observe", { include: ["text"], taskId: "task_1" });
      expect(result.isError).toBeFalsy();
      expect(seen.calls).toHaveLength(1);
      const call = seen.calls[0] as { tool: string; input: Record<string, unknown>; taskId?: string };
      expect(call.tool).toBe("observe");
      expect(call.taskId).toBe("task_1");
      expect(call.input).not.toHaveProperty("taskId");
    } finally {
      await close();
    }
  });

  test("a legacy-adapted call keeps its taskId: tabs.list still files as navigate with the id", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tabs.list", { taskId: "task_1" });
      expect(result.isError).toBeFalsy();
      expect(seen.calls).toHaveLength(1);
      const call = seen.calls[0] as { tool: string; input: Record<string, unknown>; taskId?: string };
      expect(call.tool).toBe("navigate");
      expect(call.taskId).toBe("task_1");
      expect(call.input).not.toHaveProperty("taskId");
    } finally {
      await close();
    }
  });

  test("a tasks.* call keeps its taskId inside the input (it is a real schema field there)", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tasks.get", { taskId: "task_1" });
      expect(result.isError).toBeFalsy();
      const call = seen.calls[0] as { tool: string; input: Record<string, unknown>; taskId?: string };
      expect(call.tool).toBe("tasks.get");
      expect(call.input.taskId).toBe("task_1");
      expect(call.taskId).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("an action batch item WITH a task id is forwarded (gateway presence rule); extension validation owns it", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tools.batch", {
        calls: [{ tool: "dom.click", input: { ref: "r1", taskId: "task_1" } }],
      });
      expect(result.isError).toBeFalsy();
      expect(seen.batchCalls).toBe(1);
      const item = seen.batchItems[0] as { tool: string; input: Record<string, unknown>; taskId?: string };
      // dom.click is legacy-adapted to act before forwarding.
      expect(item.tool).toBe("act");
      expect(item.taskId).toBe("task_1");
      expect(item.input).not.toHaveProperty("taskId");
    } finally {
      await close();
    }
  });

  test("a read batch item WITH a task id is forwarded with the id stripped from its input", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const result = await callText("tools.batch", {
        calls: [{ tool: "tabs.list", input: { taskId: "task_1" } }],
      });
      expect(result.isError).toBeFalsy();
      expect(seen.batchCalls).toBe(1);
      const item = seen.batchItems[0] as { tool: string; input: Record<string, unknown>; taskId?: string };
      // tabs.list is legacy-adapted to navigate before forwarding.
      expect(item.tool).toBe("navigate");
      expect(item.taskId).toBe("task_1");
      expect(item.input).not.toHaveProperty("taskId");
    } finally {
      await close();
    }
  });
});
