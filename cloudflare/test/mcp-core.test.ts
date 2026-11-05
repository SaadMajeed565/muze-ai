import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_SCHEMAS } from "../libs/tool-contracts/index.js";
import { CORE_TOOL_NAMES, GENERATED_TOOL_SELECTION, MCP_INSTRUCTIONS, SEARCH_DESCRIPTORS, buildLayeredInstructions, createGatewayMcpServer, filterDescriptorsByMode, measureInitializePayloads, scopeAllowsTool, toMcpContent } from "../src/mcp.js";
import { stripConfirmationFlags } from "../libs/tool-contracts/index.js";
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
    // Interrupted-turn prompt rewrite: the autonomous prompt no longer
    // carries the old protocol heading; it teaches how-only brief building.
    expect(messageText).toContain("THIS PROMPT TEACHES HOW, NOT WHAT");
    expect(messageText).toContain("Build your own task brief");

    await client.close();
    await server.close();
  });

  test("no hardcoded task prompt: prompts are generic, instructions teach how not what", async () => {
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
    expect(promptNames).not.toContain("post_image_to_instagram");

    const result = await client.getPrompt({
      name: "autonomous_browser_agent",
      arguments: { goal: "Do something on a page I have not seen yet" },
    });
    expect(result.messages.length).toBeGreaterThan(0);
    const messageText = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(messageText).toContain("TEACHES HOW, NOT WHAT");
    expect(messageText).toContain("Build your own task brief");
    expect(messageText).not.toContain("Instagram");
    expect(messageText).not.toContain("Post shared");

    await client.close();
    await server.close();
  });

  test("initialize instructions carry execution discipline, not the master-tools lists", () => {
    expect(MCP_INSTRUCTIONS).toContain("## Grounding and acting");
    expect(MCP_INSTRUCTIONS).toContain("Work in a loop: observe, act, verify");
    expect(MCP_INSTRUCTIONS).not.toContain("THE 5 MASTER TOOLS");
    expect(MCP_INSTRUCTIONS).toContain("How to build your own task brief");
    expect(MCP_INSTRUCTIONS).not.toContain("Instagram");
    expect(MCP_INSTRUCTIONS).not.toContain("Post shared");
  });
});

describe("Phase A mode-filtered tool visibility", () => {
  function modeBridge(seen: { toolCalls: string[] }): GatewayBridge {
    return {
      isConnected: () => false,
      listTools: async () => [],
      callTool: async (call) => {
        seen.toolCalls.push(call.tool);
        return { result: {}, dryRun: false, durationMs: 0 };
      },
      callToolBatch: async () => [],
      createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
      respondApproval: async () => undefined,
      waitApproval: async () => true,
    };
  }

  async function makeModeClient(scope: string, onState?: (state: { mode: string; discovered: string[] }) => void) {
    const seen = { toolCalls: [] as string[] };
    const server = createGatewayMcpServer(modeBridge(seen), undefined, undefined, scope, onState ? { onSessionStateChange: onState } : undefined);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listNames = async (): Promise<string[]> => {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    };
    const callText = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: result.isError, text: result.content.map((c) => c.text).join("\n") };
    };
    const close = async () => {
      await client.close();
      await server.close();
    };
    return { client, seen, listNames, callText, close };
  }

  test("read mode ListTools contains no act/form/navigate/data/submit tools", async () => {
    const { client, listNames, close } = await makeModeClient("read:tools call:tools");
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      const names = await listNames();
      expect(names).toContain("observe");
      expect(names).toContain("tools.discover");
      expect(names).toContain("tools.batch");
      expect(names).toContain("tasks.get");
      expect(names).toContain("tasks.list");
      for (const hidden of ["act", "navigate", "form", "data", "submit", "tasks.create", "tasks.pause", "tasks.resume", "tasks.cancel"]) {
        expect(names).not.toContain(hidden);
      }
    } finally {
      await close();
    }
  });

  test("plan mode ListTools contains plan tools but no write tools", async () => {
    const { client, listNames, close } = await makeModeClient("read:tools call:tools");
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "make a plan", mode: "plan" } });
      const names = await listNames();
      expect(names).toContain("observe");
      expect(names).toContain("tasks.create");
      for (const hidden of ["act", "navigate", "form", "data", "submit", "tasks.pause", "tasks.resume", "tasks.cancel"]) {
        expect(names).not.toContain(hidden);
      }
    } finally {
      await close();
    }
  });

  test("a direct call to a hidden tool in read mode still returns PERMISSION_DENIED and never reaches the bridge", async () => {
    const { client, seen, callText, close } = await makeModeClient("read:tools call:tools");
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      const result = await callText("act", { steps: [{ do: "click", target: { ref: "r1" } }] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("PERMISSION_DENIED");
      expect(result.text).toContain("read");
      expect(seen.toolCalls).not.toContain("act");
    } finally {
      await close();
    }
  });

  test("plan mode allows tasks.create only as a dryRun preview", async () => {
    const { client, callText, close } = await makeModeClient("read:tools call:tools");
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "make a plan", mode: "plan" } });
      const denied = await callText("tasks.create", { goal: "do it", steps: [] });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("PERMISSION_DENIED");
      // dryRun passes the mode backstop (it then hits the disconnected
      // bridge, which is CONFLICT, not a mode denial).
      const preview = await callText("tasks.create", { goal: "do it", steps: [], dryRun: true });
      expect(preview.text).not.toContain("PERMISSION_DENIED");
      expect(preview.text).toContain("CONFLICT");
    } finally {
      await close();
    }
  });

  test("discovery in read mode returns read-only tools only", async () => {
    const { client, callText, close } = await makeModeClient("read:tools call:tools");
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      const result = await callText("tools.discover", { query: "tab" });
      const parsed = JSON.parse(result.text) as { found: { name: string; risk: string }[] };
      expect(parsed.found.length).toBeGreaterThan(0);
      for (const tool of parsed.found) {
        expect(tool.risk).toBe("read-only");
      }
    } finally {
      await close();
    }
  });

  test("mode selection reports session state and an invalid mode is rejected, never guessed", async () => {
    const states: { mode: string; discovered: string[] }[] = [];
    const { client, close } = await makeModeClient("read:tools call:tools", (state) => states.push(state));
    try {
      await client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "read something", mode: "read" } });
      expect(states[states.length - 1]?.mode).toBe("read");
      await expect(
        client.getPrompt({ name: "autonomous_browser_agent", arguments: { goal: "x", mode: "bogus" } }),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  test("initialize payload is measured per mode: read is smaller than act and smaller than the old full-registry assembly", () => {
    const env = { browserConnected: false, clientType: "unknown", scopePresent: true, discoveredCount: 0 };
    const read = buildLayeredInstructions({ mode: "read", visibleDescriptors: filterDescriptorsByMode(SEARCH_DESCRIPTORS, "read"), environment: env, discovered: [] });
    const act = buildLayeredInstructions({ mode: "act", visibleDescriptors: filterDescriptorsByMode(SEARCH_DESCRIPTORS, "act"), environment: env, discovered: [] });
    const oldAssembly = `${MCP_INSTRUCTIONS}\n\n${GENERATED_TOOL_SELECTION}`;
    expect(read.length).toBeLessThan(act.length);
    expect(read.length).toBeLessThan(oldAssembly.length);
    expect(read).not.toContain("- `act`");
    expect(read).not.toContain("- `form`");
    expect(act).toContain("## MODE: act");
    // Report sizes in the test name's console output for the batch report.
    console.log(`Phase A payload sizes: old=${oldAssembly.length} act=${act.length} read=${read.length}`);
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

describe("Phase D initialize payload measurement", () => {
  test("per-mode sizes are deterministic and read stays smaller than act and the old assembly", () => {
    const first = measureInitializePayloads();
    const second = measureInitializePayloads();
    expect(second).toEqual(first);
    expect(first.read).toBeLessThan(first.act);
    expect(first.read).toBeLessThan(first.old);
    expect(first.plan).toBeLessThan(first.act);
    expect(first.explore).toBeLessThan(first.act);
    // Internal modes carry an empty effective tool set, so they must not
    // exceed the read-mode surface.
    expect(first.summary).toBeLessThanOrEqual(first.read);
    expect(first.compaction).toBeLessThanOrEqual(first.read);
    console.log(
      `Phase D payload sizes: old=${first.old} act=${first.act} read=${first.read} plan=${first.plan} explore=${first.explore} summary=${first.summary} compaction=${first.compaction}`,
    );
  });
});
