import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, resolveUnifiedToolForScope, scopeAllowsTool } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

function fakeBridge(seen: { toolCalls: string[]; batchCalls: number }): GatewayBridge {
  return {
    isConnected: () => true,
    listTools: async () => [],
    callTool: async (call) => {
      seen.toolCalls.push(call.tool);
      return { result: {}, dryRun: false, durationMs: 0 };
    },
    callToolBatch: async () => {
      seen.batchCalls += 1;
      return [];
    },
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
}

async function makeClient(scope: string | undefined) {
  const seen = { toolCalls: [] as string[], batchCalls: 0 };
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
  return { client, seen, callText, close };
}

describe("per-action scope resolution (Tool Management Phase 1, section B)", () => {
  test("the resolver maps unified actions to distinct granular tools, never conflating them", () => {
    expect(resolveUnifiedToolForScope("tabs", { action: "list" })).toMatchObject({ granular: "tabs.list", calledAs: "tabs", action: "list" });
    expect(resolveUnifiedToolForScope("tabs", { action: "get", tabId: 1 })).toMatchObject({ granular: "tabs.get" });
    expect(resolveUnifiedToolForScope("tabs", { action: "active" })).toMatchObject({ granular: "tabs.active" });
    expect(resolveUnifiedToolForScope("tabs", { action: "search", query: "x" })).toMatchObject({ granular: "tabs.search" });
    expect(resolveUnifiedToolForScope("tabs", { action: "close", tabId: 1 })).toMatchObject({ granular: "tabs.close" });
    expect(resolveUnifiedToolForScope("tabs", { action: "create", url: "https://example.com" })).toMatchObject({ granular: "tabs.create" });
    expect(resolveUnifiedToolForScope("tabs", { action: "zoom", tabId: 1, zoom: 1.5 })).toMatchObject({ granular: "tabs.setZoom" });
    expect(resolveUnifiedToolForScope("navigate", { category: "tab", action: "close", tabId: 1 })).toMatchObject({ granular: "tabs.close" });
    expect(resolveUnifiedToolForScope("navigate", { category: "tab", action: "list" })).toMatchObject({ granular: "tabs.list" });
    expect(resolveUnifiedToolForScope("data", { domain: "bookmarks", action: "delete", id: "b1" })).toMatchObject({ granular: "bookmarks.delete" });
    expect(resolveUnifiedToolForScope("data", { domain: "bookmarks", action: "list" })).toMatchObject({ granular: "bookmarks.list" });
    // Multi-target tools and unknown actions do not resolve to a single
    // granular tool, so they keep the unified-descriptor scope check.
    expect(resolveUnifiedToolForScope("observe", { include: ["text"] })).toBeNull();
    expect(resolveUnifiedToolForScope("act", { steps: [] })).toBeNull();
    expect(resolveUnifiedToolForScope("tabs", { action: "nope" })).toBeNull();
    expect(resolveUnifiedToolForScope("tabs.close", { tabId: 1 })).toBeNull();
    expect(resolveUnifiedToolForScope("tasks.create", { goal: "x" })).toBeNull();
  });

  test("scope decisions differ per action under read:tools, not per unified name", () => {
    const list = resolveUnifiedToolForScope("tabs", { action: "list" })!;
    const close = resolveUnifiedToolForScope("tabs", { action: "close", tabId: 1 })!;
    expect(list.granular).not.toBe(close.granular);
    // Risk comes from the granular registry (read-only vs reversible),
    // so the same unified name yields opposite scope decisions.
    expect(scopeAllowsTool("read:tools", "read-only")).toBe(true);
    expect(scopeAllowsTool("read:tools", "reversible")).toBe(false);
  });

  test("read:tools allows tabs.list/get/active/search via unified and denies tabs.close/create, naming the granular tool", async () => {
    const { seen, callText, close } = await makeClient("read:tools");
    try {
      for (const args of [
        { action: "list" },
        { action: "get", tabId: 1 },
        { action: "active" },
        { action: "search", query: "example" },
      ]) {
        const allowed = await callText("tabs", args);
        expect(allowed.isError).toBeFalsy();
      }
      expect(seen.toolCalls.length).toBe(4);

      const deniedClose = await callText("tabs", { action: "close", tabId: 1 });
      expect(deniedClose.isError).toBe(true);
      expect(deniedClose.text).toContain("PERMISSION_DENIED");
      expect(deniedClose.text).toContain("tabs.close");
      expect(deniedClose.text).toContain("action close");

      const deniedCreate = await callText("tabs", { action: "create", url: "https://example.com" });
      expect(deniedCreate.isError).toBe(true);
      expect(deniedCreate.text).toContain("tabs.create");
      expect(deniedCreate.text).toContain("action create");

      // Denied calls never reached the bridge.
      expect(seen.toolCalls.length).toBe(4);
    } finally {
      await close();
    }
  });

  test("read:tools allows navigate tab list and denies navigate tab close, and denies data bookmarks delete", async () => {
    const { seen, callText, close } = await makeClient("read:tools");
    try {
      const allowed = await callText("navigate", { category: "tab", action: "list" });
      expect(allowed.isError).toBeFalsy();

      const deniedClose = await callText("navigate", { category: "tab", action: "close", tabId: 1 });
      expect(deniedClose.isError).toBe(true);
      expect(deniedClose.text).toContain("tabs.close");

      const deniedDelete = await callText("data", { domain: "bookmarks", action: "delete", id: "b1" });
      expect(deniedDelete.isError).toBe(true);
      expect(deniedDelete.text).toContain("bookmarks.delete");
      expect(deniedDelete.text).toContain("action delete");

      expect(seen.toolCalls.length).toBe(1);
    } finally {
      await close();
    }
  });

  test("call:tools allows tabs.close via unified at the scope layer", async () => {
    const { seen, callText, close } = await makeClient("call:tools");
    try {
      const allowed = await callText("tabs", { action: "close", tabId: 1 });
      expect(allowed.isError).toBeFalsy();
      expect(seen.toolCalls.length).toBe(1);
    } finally {
      await close();
    }
  });

  test("batch scope is checked per item against the granular tool", async () => {
    const { seen, callText, close } = await makeClient("read:tools");
    try {
      const allowedBatch = await callText("tools.batch", {
        calls: [{ tool: "tabs", input: { action: "list" } }],
      });
      expect(allowedBatch.isError).toBeFalsy();
      expect(seen.batchCalls).toBe(1);

      const deniedBatch = await callText("tools.batch", {
        calls: [{ tool: "tabs", input: { action: "close", tabId: 1 } }],
      });
      expect(deniedBatch.isError).toBe(true);
      expect(deniedBatch.text).toContain("tabs.close");
      expect(seen.batchCalls).toBe(1);
    } finally {
      await close();
    }
  });

  test("missing scope still denies everything, including resolved reads", async () => {
    const { callText, close } = await makeClient(undefined);
    try {
      const denied = await callText("tabs", { action: "list" });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("PERMISSION_DENIED");
    } finally {
      await close();
    }
  });

  test("read:tools may not append steps, while call:tools forwards the append to the bridge", async () => {
    // tasks.appendSteps is a reversible mutation, like tasks.create:
    // the scope check runs before anything is forwarded, so a
    // read-only client is denied and the bridge never sees the call.
    const read = await makeClient("read:tools");
    try {
      const denied = await read.callText("tasks.appendSteps", {
        taskId: "task_1",
        steps: [{ tool: "observe", input: { include: ["text"] } }],
      });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("PERMISSION_DENIED");
      expect(denied.text).toContain("tasks.appendSteps");
      expect(read.seen.toolCalls).toEqual([]);
    } finally {
      await read.close();
    }
    const call = await makeClient("call:tools");
    try {
      const forwarded = await call.callText("tasks.appendSteps", {
        taskId: "task_1",
        steps: [{ tool: "observe", input: { include: ["text"] } }],
      });
      expect(forwarded.isError).toBeFalsy();
      expect(call.seen.toolCalls).toEqual(["tasks.appendSteps"]);
    } finally {
      await call.close();
    }
  });
});
