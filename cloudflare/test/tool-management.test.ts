import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CORE_TOOL_NAMES, createGatewayMcpServer } from "../src/mcp.js";
import { SEARCH_DESCRIPTORS } from "../src/mcp.js";
import type { GatewayBridge } from "../src/bridge.js";
import type { ToolDescriptor } from "../libs/tool-contracts/index.js";

function fakeBridge(connected = true): GatewayBridge {
  // Live list like the real host: unified tools only, non-empty, so the
  // session-aware append path (not the fail-closed empty-list path) runs.
  const live: ToolDescriptor[] = SEARCH_DESCRIPTORS.filter((d) =>
    ["observe", "act", "navigate", "form", "data", "browser", "tabs", "windows", "devtools", "clipboard", "files", "wait", "submit"].includes(d.name),
  );
  return {
    isConnected: () => connected,
    listTools: async () => live,
    callTool: async () => ({ result: {}, dryRun: false, durationMs: 0 }),
    callToolBatch: async () => [],
    createApproval: async () => ({ id: "appr_1", tool: "x", title: "t", summary: "s", risk: "read-only", client: { id: "c", name: "c", transport: "remote" }, createdAt: 0, expiresAt: 0 }),
    respondApproval: async () => undefined,
    waitApproval: async () => true,
  };
}

async function connect(bridge: GatewayBridge, scope = "call:tools", options?: { clientType?: string }) {
  const server = createGatewayMcpServer(bridge, undefined, undefined, scope, options);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function discover(client: Client, query: string): Promise<{ found: Array<Record<string, unknown>>; count: number }> {
  const result = (await client.callTool({ name: "tools.discover", arguments: { query } })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as { found: Array<Record<string, unknown>>; count: number };
}

describe("discovery v2 via gateway (Phase 2)", () => {
  test("organise tabs returns tabs + workflows.organizeTabs in top 5, no clipboard/download in top 5", async () => {
    const { server, client } = await connect(fakeBridge());
    try {
      const { found } = await discover(client, "organise tabs");
      const top5 = found.slice(0, 5).map((f) => String(f.name));
      expect(top5).toContain("tabs");
      expect(top5).toContain("workflows.organizeTabs");
      expect(top5.some((n) => n.startsWith("clipboard.") || n.startsWith("downloads."))).toBe(false);
      const tabs = found.find((f) => f.name === "tabs")!;
      expect(tabs.matchedAction).toBe("organize");
      expect(tabs.matchedActionRisk).toBe("consequential");
      expect(tabs.matchedActionApproval).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("form submit discovery includes preview + fill as related, with preview-required note", async () => {
    const { server, client } = await connect(fakeBridge());
    try {
      const { found } = await discover(client, "submit a form");
      const form = found.find((f) => f.name === "form")!;
      const related = (form.related as Array<{ name: string; note?: string }>).map((r) => r.name);
      expect(related).toContain("form.preview");
      expect(related).toContain("form.fill");
      expect((form.prerequisites as string[]).join(" ")).toMatch(/Preview is required before submit/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("read:tools scope never surfaces a tool it cannot call", async () => {
    const { server, client } = await connect(fakeBridge(), "read:tools");
    try {
      const { found } = await discover(client, "download a file");
      // downloads.start is consequential: a read-only client must not discover it.
      expect(found.map((f) => f.name)).not.toContain("downloads.start");
      // But a read-only discoverable tool still surfaces.
      const { found: reads } = await discover(client, "list open tabs");
      expect(reads.map((f) => f.name)).toContain("tabs.list");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("session-aware ListTools + task-mode tool sets (Phase 2)", () => {
  test("a discovered tool is still in ListTools after 10 more calls, without re-discovering", async () => {
    const { server, client } = await connect(fakeBridge());
    try {
      await discover(client, "collect links");
      for (let i = 0; i < 10; i++) await client.listTools();
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("workflows.collectLinks");
      expect(tools.map((t) => t.name)).toContain("page.links");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("task-mode: plan tools are offered at task creation, other tools still discoverable", async () => {
    const { server, client } = await connect(fakeBridge());
    try {
      const before = (await client.listTools()).tools.map((t) => t.name);
      expect(before).not.toContain("tabs.list");
      await client.callTool({
        name: "tasks.create",
        arguments: { goal: "test", steps: [{ tool: "tabs.list", input: {} }, { tool: "page.read", input: {} }] },
      });
      const after = (await client.listTools()).tools.map((t) => t.name);
      expect(after).toContain("tabs.list");
      expect(after).toContain("page.read");
      // Normal discovery still works for anything else.
      const { found } = await discover(client, "take a screenshot");
      expect(found.map((f) => f.name)).toContain("screenshots.visible");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("session cache is per-server: a fresh server does not inherit discovered tools", async () => {
    const bridge = fakeBridge();
    const first = await connect(bridge);
    await discover(first.client, "collect links");
    await first.client.close();
    await first.server.close();
    const second = await connect(bridge);
    try {
      const { tools } = await second.client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("workflows.collectLinks");
    } finally {
      await second.client.close();
      await second.server.close();
    }
  });
});

describe("deprecation + generated instructions (Phases 2-3)", () => {
  test("no deprecated tool is in the core set, and core still contains the unified tools", () => {
    // Deprecated items are ACTIONS (navigate tab/window, data domains),
    // not tools: the core tools navigate/data themselves remain core and
    // working. The inventory script pins the same fact from the registry.
    expect(CORE_TOOL_NAMES.has("navigate")).toBe(true);
    expect(CORE_TOOL_NAMES.has("data")).toBe(true);
    expect(CORE_TOOL_NAMES.has("tabs")).toBe(false);
  });

  test("server instructions contain the registry-generated tool-selection section", async () => {
    const { server, client } = await connect(fakeBridge());
    try {
      // Instructions are visible through the SDK client only via initialize
      // result in some clients; here we assert the generated module text
      // directly, which is what the server serves.
      const { GENERATED_TOOL_SELECTION } = await import("../src/mcp.js");
      expect(GENERATED_TOOL_SELECTION).toContain("`tabs`");
      expect(GENERATED_TOOL_SELECTION).toContain("navigate tab/window");
      expect(GENERATED_TOOL_SELECTION).toContain("data devtools/clipboard");
      expect(GENERATED_TOOL_SELECTION).toContain("preview before submit");
      expect(SEARCH_DESCRIPTORS.length).toBeGreaterThanOrEqual(135);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("client type is recorded from the declared name, with the documented conservative cap", async () => {
    const { server, client } = await connect(fakeBridge(), "call:tools", { clientType: "Claude Desktop" });
    try {
      const { found } = await discover(client, "organise tabs");
      expect(found.length).toBeGreaterThan(0);
      // The discover result carries the recorded client type and cap.
      const result = (await client.callTool({ name: "tools.discover", arguments: { query: "organise tabs" } })) as {
        content: Array<{ text: string }>;
      };
      const parsed = JSON.parse(result.content[0]!.text) as { clientType: string; listToolsCap: number };
      expect(parsed.clientType).toBe("claude");
      expect(parsed.listToolsCap).toBe(50);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
