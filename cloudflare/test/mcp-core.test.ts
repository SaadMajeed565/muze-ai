import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_SCHEMAS } from "../libs/tool-contracts/index.js";
import { CORE_TOOL_NAMES, createGatewayMcpServer, scopeAllowsTool, stripConfirmationFlags, toMcpContent } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";

describe("MCP core toolset", () => {
  test("every advertised core name exists in the registry", () => {
    const registry = new Set(TOOL_SCHEMAS.map((tool) => tool.name));
    const missing = [...CORE_TOOL_NAMES].filter(
      (name) => name !== "tools.discover" && name !== "tools.batch" && !registry.has(name),
    );
    expect(missing).toEqual([]);
  });

  test("core includes the 5 master tools plus meta tools", () => {
    expect(CORE_TOOL_NAMES.has("observe")).toBe(true);
    expect(CORE_TOOL_NAMES.has("act")).toBe(true);
    expect(CORE_TOOL_NAMES.has("navigate")).toBe(true);
    expect(CORE_TOOL_NAMES.has("form")).toBe(true);
    expect(CORE_TOOL_NAMES.has("data")).toBe(true);
    expect(CORE_TOOL_NAMES.has("tools.batch")).toBe(true);
    expect(CORE_TOOL_NAMES.has("tools.discover")).toBe(true);
    expect(TOOL_SCHEMAS.some((tool) => tool.name === "observe")).toBe(true);
    expect(TOOL_SCHEMAS.some((tool) => tool.name === "files")).toBe(true);
  });

  test("snapshot screenshots become MCP image content, not inline JSON blobs", () => {
    const content = toMcpContent({
      nodes: [{ ref: "r1", role: "button", name: "Go", children: 0 }],
      screenshot: { dataUrl: "data:image/jpeg;base64,AAAA", format: "jpeg", width: 10, height: 10 },
    });
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "AAAA" });
    const text = JSON.parse(String((content[0] as { text: string }).text));
    expect(text.screenshot).toMatchObject({ screenshotIncluded: true, mimeType: "image/jpeg", width: 10, height: 10 });
    expect(text.screenshot.dataUrl).toBeUndefined();
  });

  test("advertises agentic browser prompts and generates prompt templates for LLMs", async () => {
    const fakeBridge: GatewayBridge = {
      isConnected: () => false,
      listTools: async () => [],
      callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
      callToolBatch: async () => [],
      createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
      respondApproval: async () => undefined,
      waitApproval: async () => true,
    };
    const server = createGatewayMcpServer(fakeBridge);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { prompts } = await client.listPrompts();
    const promptNames = prompts.map((p) => p.name);
    expect(promptNames).toContain("autonomous_browser_agent");
    expect(promptNames).toContain("extract_structured_data");
    expect(promptNames).toContain("fill_and_submit_form");

    const result = await client.getPrompt({
      name: "autonomous_browser_agent",
      arguments: { goal: "Find cheap flights to Paris", startUrl: "https://flights.example.com" },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    const messageText = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(messageText).toContain("Find cheap flights to Paris");
    expect(messageText).toContain("https://flights.example.com");
    expect(messageText).toContain("Observe → Reason → Act → Verify");

    await client.close();
    await server.close();
  });
});

describe("OAuth scope enforcement", () => {
  test("read:tools allows read-only only", () => {
    expect(scopeAllowsTool("read:tools", "read-only")).toBe(true);
    expect(scopeAllowsTool("read:tools", "reversible")).toBe(false);
    expect(scopeAllowsTool("read:tools", "sensitive-read")).toBe(false);
    expect(scopeAllowsTool("read:tools", "consequential")).toBe(false);
  });

  test("call:tools allows reversible, sensitive-read, and consequential", () => {
    expect(scopeAllowsTool("call:tools", "read-only")).toBe(true);
    expect(scopeAllowsTool("call:tools", "reversible")).toBe(true);
    expect(scopeAllowsTool("call:tools", "sensitive-read")).toBe(true);
    expect(scopeAllowsTool("call:tools", "consequential")).toBe(true);
  });

  test("missing, empty, or unknown scope denies everything; restricted is always denied", () => {
    expect(scopeAllowsTool(undefined, "read-only")).toBe(false);
    expect(scopeAllowsTool("", "read-only")).toBe(false);
    expect(scopeAllowsTool("bogus:scope", "read-only")).toBe(false);
    expect(scopeAllowsTool("read:tools call:tools", "restricted")).toBe(false);
    expect(scopeAllowsTool("read:tools call:tools", undefined)).toBe(false);
  });

  test("confirmation flags are stripped and never forwarded", () => {
    const stripped = stripConfirmationFlags({ confirmed: true, userApproved: true, approved: true, query: "x" });
    expect(stripped).toEqual({ query: "x" });
  });

  test("a read-only token is denied a reversible tool before any bridge call", async () => {
    let bridgeCalls = 0;
    const fakeBridge: GatewayBridge = {
      isConnected: () => true,
      listTools: async () => [],
      callTool: async () => {
        bridgeCalls += 1;
        return { result: {}, dryRun: false, durationMs: 0 };
      },
      callToolBatch: async () => [],
      createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
      respondApproval: async () => undefined,
      waitApproval: async () => true,
    };
    const server = createGatewayMcpServer(fakeBridge, undefined, undefined, "read:tools");
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const allowed = (await client.callTool({ name: "observe", arguments: { include: ["text"] } })) as { isError?: boolean };
    expect(allowed.isError).toBeFalsy();
    const denied = (await client.callTool({ name: "act", arguments: { steps: [] } })) as { content: { text: string }[]; isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("PERMISSION_DENIED");
    // The denied call never reached the bridge; only the allowed one did.
    expect(bridgeCalls).toBe(1);

    await client.close();
    await server.close();
  });

  test("a confirmation flag on a tool call is stripped before the bridge sees it", async () => {
    const seen: unknown[] = [];
    const fakeBridge: GatewayBridge = {
      isConnected: () => true,
      listTools: async () => [],
      callTool: async (call) => {
        seen.push(call.input);
        return { result: {}, dryRun: false, durationMs: 0 };
      },
      callToolBatch: async () => [],
      createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
      respondApproval: async () => undefined,
      waitApproval: async () => true,
    };
    const server = createGatewayMcpServer(fakeBridge, undefined, undefined, "read:tools call:tools");
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "observe", arguments: { include: ["text"], confirmed: true } as Record<string, unknown> });
    expect(seen[0]).toEqual({ include: ["text"] });
    await client.close();
    await server.close();
  });
});
