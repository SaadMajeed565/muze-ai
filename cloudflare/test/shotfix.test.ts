/**
 * Shotfix gateway tests (2026-10-28 retest3 set_file failures).
 *
 * The gateway adapts granular forms.setFile to the unified form tool
 * before it reaches the bridge. The adaptation used to fold a ref into
 * the selector field (a ref is an opaque registry id, not a CSS
 * selector), so a ref-only call was later fed to querySelector and
 * misreported as STALE_ELEMENT. These tests drive real CallTool
 * requests through an in-memory MCP client/server pair with a fake
 * bridge and assert what the bridge actually receives.
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer } from "../src/mcp.js";
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
  return { client };
}

const INLINE = [{ name: "a.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }];

describe("shotfix: gateway set_file adaptation", () => {
  test("granular forms.setFile with a ref + inline files keeps the ref as a ref and keeps the files", async () => {
    const seen: SeenCall[] = [];
    const { client } = await connect("read:tools call:tools", seen);
    const result = (await client.callTool({ name: "forms.setFile", arguments: { ref: "r1", files: INLINE } })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe("form");
    expect(seen[0].input.phase).toBe("set_file");
    expect(seen[0].input.ref).toBe("r1");
    expect(seen[0].input.selector).toBeUndefined();
    expect(seen[0].input.files).toEqual(INLINE);
  });

  test("granular forms.setFile with a real selector keeps the selector", async () => {
    const seen: SeenCall[] = [];
    const { client } = await connect("read:tools call:tools", seen);
    await client.callTool({ name: "forms.setFile", arguments: { selector: "input[type=file]", files: INLINE } });
    expect(seen[0].input.selector).toBe("input[type=file]");
    expect(seen[0].input.files).toEqual(INLINE);
  });

  test("unified submit set_file with a ref + inline files reaches the bridge with both intact", async () => {
    const seen: SeenCall[] = [];
    const { client } = await connect("read:tools call:tools", seen);
    const result = (await client.callTool({ name: "submit", arguments: { action: "set_file", ref: "r1", files: INLINE } })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(seen[0].tool).toBe("form");
    expect(seen[0].input.phase).toBe("set_file");
    expect(seen[0].input.ref).toBe("r1");
    expect(seen[0].input.files).toEqual(INLINE);
  });
});
