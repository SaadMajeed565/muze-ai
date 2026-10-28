/**
 * Regression tests for the 2026-10-28 live retest failures.
 *
 * The dominant retest pattern was granular tools denied at the gateway
 * with PERMISSION_DENIED risk "unknown" before reaching the bridge,
 * because the gateway scope descriptor list contained unified + task
 * tools only. These tests drive real CallTool requests through an
 * in-memory MCP client/server pair with a fake bridge, so a regression
 * would show up as a scope denial or a wrong forwarded name, not just
 * as a missing entry in a list.
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, listExposedDescriptors } from "../src/mcp.js";
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

describe("retest fixes: gateway scope descriptors", () => {
  test("granular tools are in the gateway descriptor set, not just unified + tasks", () => {
    const names = new Set(listExposedDescriptors().map((d) => d.name));
    for (const name of [
      "tabs.pin", "tabs.search", "tabs.setZoom", "tabs.reload",
      "dom.read", "dom.boundingBox", "dom.visible", "dom.shadow", "dom.waitFor",
      "frames.list", "page.dialogs", "page.selectedText", "page.respondDialog",
      "devtools.console", "devtools.dom", "devtools.network",
      "browser.activeContext", "browser.observer", "browser.captureTab", "browser.search",
      "screenshots.viewport", "screenshots.element", "screenshots.fullPage",
      "workflows.collectLinks", "workflows.organizeTabs", "workflows.saveSession",
    ]) {
      expect(names.has(name), `missing gateway descriptor for ${name}`).toBe(true);
    }
  });

  test("granular tabs.pin reaches the bridge under its own name with call:tools", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    const result = (await client.callTool({ name: "tabs.pin", arguments: { tabId: 1, pinned: true } })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([{ tool: "tabs.pin", input: { tabId: 1, pinned: true } }]);
    await client.close();
    await server.close();
  });

  test("read-only granular tools reach the bridge with read:tools, reversible ones do not", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools", seen);
    const allowed = (await client.callTool({ name: "dom.read", arguments: { ref: "r1" } })) as { isError?: boolean };
    expect(allowed.isError).toBeFalsy();
    expect(seen.map((s) => s.tool)).toEqual(["dom.read"]);
    const denied = (await client.callTool({ name: "tabs.pin", arguments: { tabId: 1, pinned: true } })) as { content: { text: string }[]; isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("PERMISSION_DENIED");
    expect(seen.map((s) => s.tool)).toEqual(["dom.read"]);
    await client.close();
    await server.close();
  });

  test("browser tools are forwarded under their own names, never to data/navigation.search", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "browser.search", arguments: { query: "wiki" } });
    await client.callTool({ name: "browser", arguments: { action: "status" } });
    expect(seen.map((s) => s.tool)).toEqual(["browser.search", "browser"]);
    await client.close();
    await server.close();
  });

  test("wait for=networkIdle is normalised to network_idle before forwarding", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "wait", arguments: { for: "networkIdle", timeoutMs: 5000 } });
    expect(seen[0].tool).toBe("navigate");
    expect(seen[0].input).toMatchObject({ category: "sync", for: "network_idle" });
    await client.close();
    await server.close();
  });

  test("an unknown tool name still denies and never reaches the bridge", async () => {
    const seen: SeenCall[] = [];
    const { server, client } = await connect("read:tools call:tools", seen);
    const denied = (await client.callTool({ name: "tabs.doesNotExist", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("PERMISSION_DENIED");
    expect(seen).toEqual([]);
    await client.close();
    await server.close();
  });
});
