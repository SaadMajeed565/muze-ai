/**
 * Regression tests for the 2026-10-28 retest3 navigation / windows
 * failures, gateway side. The fake bridge only records what it was
 * asked to forward, so these tests pin the forwarded form and the
 * scope resolution; the extension-side tests in
 * extension/test/navfix.test.ts pin the actual dispatch (including the
 * strict-schema tabId rejection, which only shows up in-process in the
 * extension executor).
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, resolveUnifiedToolForScope } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

type SeenCall = { tool: string; input: Record<string, unknown> };

async function connect(scope: string, seen: SeenCall[]) {
  const fakeBridge: GatewayBridge = {
    isConnected: () => true,
    listTools: async () => [],
    callTool: async (call) => {
      seen.push({ tool: call.tool, input: call.input as Record<string, unknown> });
      return { result: { ok: true }, dryRun: false, durationMs: 0 };
    },
    callToolBatch: async () => [],
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
  const server = createGatewayMcpServer(fakeBridge, undefined, undefined, scope);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("navfix: gateway forwarding for navigation / windows", () => {
  test("tabs.navigate forwards as navigate open carrying its tabId", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "tabs.navigate", arguments: { tabId: 5, url: "https://b.test/" } });
    expect(seen).toEqual([{ tool: "navigate", input: { action: "open", url: "https://b.test/", tabId: 5 } }]);
    await client.close();
    await server.close();
  });

  test("navigation.open forwards as navigate open (extension strips the key before the strict schema)", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "navigation.open", arguments: { url: "https://b.test/" } });
    expect(seen[0].tool).toBe("navigate");
    expect(seen[0].input).toMatchObject({ action: "open", url: "https://b.test/" });
    await client.close();
    await server.close();
  });

  test("windows.list/create forward as navigate window actions (not tab actions)", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "windows.list", arguments: {} });
    await client.callTool({ name: "windows.create", arguments: { url: "https://b.test/" } });
    await client.callTool({ name: "windows.close", arguments: { windowId: 2 } });
    expect(seen.map((s) => s.input)).toEqual([
      { category: "window", action: "list" },
      { category: "window", action: "create", url: "https://b.test/" },
      { category: "window", action: "close", windowId: 2 },
    ]);
    await client.close();
    await server.close();
  });

  test("unified tabs reload forwards as navigate tab reload (the form that failed live)", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "tabs", arguments: { action: "reload", tabId: 1 } });
    expect(seen).toEqual([{ tool: "navigate", input: { category: "tab", action: "reload", tabId: 1 } }]);
    await client.close();
    await server.close();
  });

  test("unified windows forwards as navigate window actions", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "windows", arguments: { action: "list" } });
    await client.callTool({ name: "windows", arguments: { action: "create", url: "https://b.test/" } });
    expect(seen.map((s) => s.input)).toEqual([
      { category: "window", action: "list" },
      { category: "window", action: "create", url: "https://b.test/" },
    ]);
    await client.close();
    await server.close();
  });
});

describe("navfix: gateway scope resolution matches the fixed handler", () => {
  test("navigate window list/create/close resolve to windows.*, not tabs.*", () => {
    expect(resolveUnifiedToolForScope("navigate", { category: "window", action: "list" })?.granular).toBe("windows.list");
    expect(resolveUnifiedToolForScope("navigate", { category: "window", action: "create" })?.granular).toBe("windows.create");
    expect(resolveUnifiedToolForScope("navigate", { category: "window", action: "close" })?.granular).toBe("windows.close");
  });

  test("navigate window tab-only actions still resolve to tabs.*", () => {
    expect(resolveUnifiedToolForScope("navigate", { category: "window", action: "get" })?.granular).toBe("tabs.get");
  });

  test("navigate tab open/reload resolve to tabs.navigate/tabs.reload", () => {
    expect(resolveUnifiedToolForScope("navigate", { category: "tab", action: "open" })?.granular).toBe("tabs.navigate");
    expect(resolveUnifiedToolForScope("navigate", { category: "tab", action: "reload" })?.granular).toBe("tabs.reload");
  });

  test("action-only open/reload still resolve to navigation.open/reload", () => {
    expect(resolveUnifiedToolForScope("navigate", { action: "open" })?.granular).toBe("navigation.open");
    expect(resolveUnifiedToolForScope("navigate", { action: "reload" })?.granular).toBe("navigation.reload");
  });
});
