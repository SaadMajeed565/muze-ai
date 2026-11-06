import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare } from "miniflare";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  PROTOCOL_VERSION,
  TOOL_SCHEMAS,
  toToolDescriptor,
  type ApprovalRequestInfo,
  type BridgeClientMessage,
  type BridgeHostMessage,
} from "../libs/tool-contracts/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, "..");

const REDIRECT_URI = "https://client.example/callback";

interface Account {
  email: string;
  password: string;
  token: string;
  cookie: string;
  sessionId: string;
}

let mf: Miniflare;
let serverUrl: URL;

async function http(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `10.${randomBytes(3).readUIntBE(0, 3) % 250}.1.1`);
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, name) => {
    headerRecord[name] = value;
  });
  return mf.dispatchFetch(
    `${serverUrl.origin}${path}`,
    { ...init, headers: headerRecord } as unknown as Parameters<typeof mf.dispatchFetch>[1],
  ) as unknown as Promise<Response>;
}

async function createAccount(): Promise<Account> {
  const email = `unbound_${randomBytes(6).toString("hex")}@example.com`;
  const password = "password123";
  const form = new URLSearchParams({ email, password });
  const response = await http("/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("signup did not set a session cookie");
  const redirectUri = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/";
  const state = "state_0123456789abcdef";
  const auth = await http(
    `/extension/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    { headers: { cookie }, redirect: "manual" },
  );
  if (auth.status !== 302) throw new Error(`extension auth failed: ${auth.status}`);
  const fragment = new URLSearchParams(new URL(auth.headers.get("location") ?? "").hash.slice(1));
  const code = fragment.get("code") ?? "";
  if (!code) throw new Error("no extension code in redirect");
  const redeem = await http("/extension/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  const redeemed = (await redeem.json()) as { token: string; sessionId: string };
  if (!redeemed.token || !redeemed.sessionId) throw new Error("extension redeem did not return a token");
  return { email, password, token: redeemed.token, cookie, sessionId: redeemed.sessionId };
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authorizeWithClient(account: Account, scope?: string): Promise<{ token: string; clientId: string }> {
  const register = await http("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Unbound Client", redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await register.json()) as { client_id: string };
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authorizeUrl = new URL(`${serverUrl.origin}/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "xyz");
  if (scope) authorizeUrl.searchParams.set("scope", scope);
  const page = await http(`${authorizeUrl.pathname}${authorizeUrl.search}`, { headers: { cookie: account.cookie } });
  const html = await page.text();
  const match = /name="authReqId" value="([^"]+)"/.exec(html);
  if (!match) throw new Error(`no authReqId in authorize page: ${html.slice(0, 200)}`);
  const form = new URLSearchParams();
  form.set("authReqId", match[1]);
  const approved = await http("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: account.cookie },
    body: form.toString(),
    redirect: "manual",
  });
  const location = approved.headers.get("location");
  if (!location) throw new Error(`authorize did not redirect (status ${approved.status})`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("no code in redirect");
  const tokenForm = new URLSearchParams();
  tokenForm.set("grant_type", "authorization_code");
  tokenForm.set("code", code);
  tokenForm.set("client_id", clientId);
  tokenForm.set("redirect_uri", REDIRECT_URI);
  tokenForm.set("code_verifier", verifier);
  const tokenResponse = await http("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm.toString(),
  });
  const tokens = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  return { token: tokens.access_token, clientId };
}

/** A second browser for the same account, via extension sign-in. */
async function secondBrowser(account: Account, name: string): Promise<{ token: string; sessionId: string }> {
  const response = await http("/extension/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password, browserInfo: { name } }),
  });
  const body = (await response.json()) as { token?: string; sessionId?: string; error?: string };
  if (!body.token || !body.sessionId) throw new Error(`second browser sign-in failed: ${JSON.stringify(body)}`);
  return { token: body.token, sessionId: body.sessionId };
}

async function removeBrowser(account: Account, sessionId: string): Promise<void> {
  const response = await http("/account/browsers/remove", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: account.cookie },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error(`remove browser failed: ${response.status} ${await response.text()}`);
}

/**
 * Fake extension host. Every tool call answers with this browser's
 * marker URL, so a test can tell which browser served a call.
 */
function connectFakeHost(
  sessionId: string,
  token: string,
  options: {
    marker: string;
    requireApproval?: boolean;
    waitApproval?: boolean;
    waitApprovalDelayMs?: number;
  },
) {
  const socket = new WebSocket(`${serverUrl.origin.replace("http", "ws")}/bridge?session=${encodeURIComponent(sessionId)}`);
  let closed = false;
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "auth", token }));
  });
  socket.on("close", () => {
    closed = true;
  });
  let approvalCount = 0;
  const send = (message: BridgeHostMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as BridgeClientMessage;
    switch (message.type) {
      case "hello":
        send({
          type: "hello.ok",
          id: message.id,
          protocolVersion: PROTOCOL_VERSION,
          registryVersion: "1",
          server: { name: "fake-host", version: "1.0.0" },
        });
        return;
      case "registry.list":
        send({ type: "registry.result", id: message.id, tools: TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool)) });
        return;
      case "tool.call": {
        if (options.requireApproval && !message.approvalId) {
          send({ type: "tool.error", id: message.id, error: { code: "APPROVAL_REQUIRED", message: "approval required" } as never });
          return;
        }
        send({
          type: "tool.result",
          id: message.id,
          result: [{ id: 1, url: `https://example.com/${options.marker}`, title: options.marker }],
          dryRun: false,
          durationMs: 1,
        });
        return;
      }
      case "approval.request": {
        approvalCount += 1;
        const approval: ApprovalRequestInfo = {
          id: `appr_${approvalCount}`,
          tool: message.tool,
          title: "Approve operation",
          summary: "Fake host approval",
          risk: "reversible",
          client: message.client ?? { id: "muze-gateway", name: "Universal Browser Tools", transport: "remote" },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        send({ type: "approval.requested", id: message.id, approval });
        return;
      }
      case "approval.respond":
        send({ type: "approval.resolved", id: message.id, approvalId: message.approvalId, approved: message.approved });
        return;
      case "approval.wait": {
        const respond = (): void =>
          send({ type: "approval.resolved", id: message.id, approvalId: message.approvalId, approved: options.waitApproval === true });
        if (options.waitApprovalDelayMs) setTimeout(respond, options.waitApprovalDelayMs);
        else respond();
        return;
      }
      default:
        return;
    }
  });
  return {
    socket,
    isClosed: () => closed,
    approvals: () => approvalCount,
    ready: () =>
      new Promise<void>((resolveOpen, rejectOpen) => {
        if (socket.readyState === WebSocket.OPEN) return resolveOpen();
        socket.once("open", () => resolveOpen());
        socket.once("error", (error) => rejectOpen(error));
      }),
    close: () => socket.close(),
  };
}

async function waitUntilConnected(token: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const response = await http("/session/status", { headers: { authorization: `Bearer ${token}` } });
    const body = (await response.json()) as { connected?: boolean };
    if (body.connected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("extension never became connected");
}

async function makeClient(
  token: string,
  options: { elicitation?: boolean } = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client(
    { name: "unbound-client", version: "1.0.0" },
    { capabilities: options.elicitation === true ? { elicitation: {} } : {} },
  );
  if (options.elicitation === true) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl.origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function listAccountBrowsers(account: Account): Promise<{
  browsers: Array<{ sessionId: string; connected: boolean; isDefault: boolean }>;
  defaultSessionId: string;
  mcpClients: Array<{ clientId: string; live: boolean; connectedSince: number | null }>;
}> {
  const response = await http("/account/browsers", { headers: { cookie: account.cookie } });
  if (!response.ok) throw new Error(`listAccountBrowsers failed: ${response.status}`);
  return (await response.json()) as {
    browsers: Array<{ sessionId: string; connected: boolean; isDefault: boolean }>;
    defaultSessionId: string;
    mcpClients: Array<{ clientId: string; live: boolean; connectedSince: number | null }>;
  };
}

beforeAll(async () => {
  execFileSync("node", ["build.mjs"], { cwd: gatewayDir, stdio: "inherit" });
  mf = new Miniflare({
    modules: true,
    scriptPath: resolve(gatewayDir, "dist/index.js"),
    compatibilityDate: "2025-10-15",
    compatibilityFlags: ["nodejs_compat_v2"],
    durableObjects: { SESSION_DO: "SessionDO", DIRECTORY_DO: "DirectoryDO", RATE_LIMIT_DO: "RateLimitDO" },
    bindings: {
      OPENAI_APPS_CHALLENGE: "challenge-token-123",
      EXTENSION_IDS: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    migrations: { newTag: "v2", newClasses: ["SessionDO", "DirectoryDO", "RateLimitDO"] },
  });
  serverUrl = await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("unbound account-level routing", () => {
  test("initialize mints an MCP session DO independent of any browser", async () => {
    const account = await createAccount();
    const token = (await authorizeWithClient(account)).token;
    // No browser is connected at all.
    const { client, transport } = await makeClient(token);
    const sessionId = transport.sessionId ?? "";
    expect(sessionId).toMatch(/^mcp:/);

    // Native browsers tools work without a browser; the current target
    // is the account default.
    const listed = (await client.callTool({ name: "browsers.list", arguments: {} })) as ToolResult;
    expect(listed.isError).toBeFalsy();
    const body = JSON.parse(listed.content[0].text) as { browsers: unknown[]; defaultSessionId: string; currentSessionId: string };
    expect(body.browsers).toHaveLength(1);
    expect(body.defaultSessionId).toBe(account.sessionId);
    expect(body.currentSessionId).toBe(account.sessionId);

    // A bridge tool with no browser connected reports the standard
    // no-browser error, not a routing failure.
    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CONFLICT");
    expect(result.content[0].text).toContain("No browser is connected");

    // ListTools still offers the native browsers tools while disconnected.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("browsers.list");

    await client.close();
  });

  test("later calls route by mcp-session-id to the same MCP session", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account.sessionId, account.token, { marker: "browser-a" });
    await browser.ready();
    await waitUntilConnected(account.token);
    const token = (await authorizeWithClient(account)).token;
    const first = await makeClient(token);
    const second = await makeClient(token);
    expect(first.transport.sessionId).toMatch(/^mcp:/);
    expect(second.transport.sessionId).toMatch(/^mcp:/);
    expect(second.transport.sessionId).not.toBe(first.transport.sessionId);

    // Both sessions route independently; each call lands on the same
    // session it initialized (same current target on repeat calls).
    for (const { client } of [first, second]) {
      const one = JSON.parse(
        ((await client.callTool({ name: "browsers.list", arguments: {} })) as ToolResult).content[0].text,
      ) as { currentSessionId: string };
      const two = JSON.parse(
        ((await client.callTool({ name: "browsers.list", arguments: {} })) as ToolResult).content[0].text,
      ) as { currentSessionId: string };
      expect(one.currentSessionId).toBe(account.sessionId);
      expect(two.currentSessionId).toBe(account.sessionId);
      const tabs = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
      expect(tabs.isError).toBeFalsy();
      expect(tabs.content[0].text).toContain("https://example.com/browser-a");
    }

    // A terminated session is gone: its id no longer routes anywhere.
    // (Client.close() alone does not terminate: the SDK's close only
    // aborts locally, so the explicit DELETE is the close signal.)
    const deadSessionId = first.transport.sessionId ?? "";
    await first.transport.terminateSession();
    for (let i = 0; i < 50; i += 1) {
      const probe = await http("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": deadSessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "tabs.list", arguments: {} } }),
      });
      if (probe.status === 404) break;
      if (i === 49) expect(probe.status).toBe(404);
      await new Promise((r) => setTimeout(r, 100));
    }

    await second.client.close();
    browser.close();
  });

  test("select moves the next call to the new browser with no re-init", async () => {
    const account = await createAccount();
    const other = await secondBrowser(account, "Browser B");
    const hostA = connectFakeHost(account.sessionId, account.token, { marker: "browser-a" });
    const hostB = connectFakeHost(other.sessionId, other.token, { marker: "browser-b" });
    await hostA.ready();
    await hostB.ready();
    await waitUntilConnected(account.token);
    await waitUntilConnected(other.token);
    const token = (await authorizeWithClient(account)).token;
    const { client, transport } = await makeClient(token);
    const sessionIdBefore = transport.sessionId;

    const before = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(before.isError).toBeFalsy();
    expect(before.content[0].text).toContain("https://example.com/browser-a");

    const selected = (await client.callTool({
      name: "browsers.select",
      arguments: { sessionId: other.sessionId },
    })) as ToolResult;
    expect(selected.isError).toBeFalsy();
    expect(JSON.parse(selected.content[0].text).sessionId).toBe(other.sessionId);

    // Same MCP session (same id), next call goes to the new browser.
    expect(transport.sessionId).toBe(sessionIdBefore);
    const after = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(after.isError).toBeFalsy();
    expect(after.content[0].text).toContain("https://example.com/browser-b");
    const listed = JSON.parse(
      ((await client.callTool({ name: "browsers.list", arguments: {} })) as ToolResult).content[0].text,
    ) as { currentSessionId: string };
    expect(listed.currentSessionId).toBe(other.sessionId);

    await client.close();
    hostA.close();
    hostB.close();
  });

  test("an approval-gated call completes end-to-end through the forwarding bridge", async () => {
    const account = await createAccount();
    // The dashboard wait answers 2 s after the wait starts, so the
    // MCP DO holds a long-lived DO-to-DO subrequest for the whole wait.
    const browser = connectFakeHost(account.sessionId, account.token, {
      marker: "browser-a",
      requireApproval: true,
      waitApproval: true,
      waitApprovalDelayMs: 2000,
    });
    await browser.ready();
    await waitUntilConnected(account.token);
    const token = (await authorizeWithClient(account)).token;
    // No elicitation capability: the dashboard wait is the approval path.
    const { client } = await makeClient(token, { elicitation: false });
    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("https://example.com/browser-a");
    expect(browser.approvals()).toBe(1);

    await client.close();
    browser.close();
  });

  test("live presence still reaches listAccountBrowsers, and clears on close", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account.sessionId, account.token, { marker: "browser-a" });
    await browser.ready();
    await waitUntilConnected(account.token);
    const { token, clientId } = await authorizeWithClient(account);
    const { client, transport } = await makeClient(token);

    const listed = await listAccountBrowsers(account);
    const row = listed.mcpClients.find((entry) => entry.clientId === clientId);
    expect(row).toBeDefined();
    expect(row?.live).toBe(true);
    expect(row?.connectedSince).not.toBeNull();

    // Terminating the session clears the live registry row.
    await transport.terminateSession();
    await client.close();
    let gone = false;
    for (let i = 0; i < 50; i += 1) {
      const after = await listAccountBrowsers(account);
      const afterRow = after.mcpClients.find((entry) => entry.clientId === clientId);
      if (afterRow && !afterRow.live) {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(gone).toBe(true);

    browser.close();
  });

  test("removing a browser never purges the MCP session: the client stays live", async () => {
    const account = await createAccount();
    const other = await secondBrowser(account, "Browser B");
    const hostA = connectFakeHost(account.sessionId, account.token, { marker: "browser-a" });
    const hostB = connectFakeHost(other.sessionId, other.token, { marker: "browser-b" });
    await hostA.ready();
    await hostB.ready();
    await waitUntilConnected(account.token);
    await waitUntilConnected(other.token);
    const { token, clientId } = await authorizeWithClient(account);
    const { client } = await makeClient(token);
    const tabs = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(tabs.content[0].text).toContain("https://example.com/browser-a");

    // Remove the browser the token was minted for. Its bridge socket is
    // closed, but the MCP session is never purged.
    await removeBrowser(account, account.sessionId);
    let bridgeClosed = false;
    for (let i = 0; i < 20; i += 1) {
      if (hostA.isClosed()) {
        bridgeClosed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(bridgeClosed).toBe(true);
    const after = await listAccountBrowsers(account);
    expect(after.browsers.map((entry) => entry.sessionId)).not.toContain(account.sessionId);
    expect(after.browsers.map((entry) => entry.sessionId)).toContain(other.sessionId);
    expect(after.defaultSessionId).toBe(other.sessionId);
    const row = after.mcpClients.find((entry) => entry.clientId === clientId);
    expect(row).toBeDefined();
    expect(row?.live).toBe(true);

    await client.close();
    hostA.close();
    hostB.close();
  });

  test("a token minted for browser X keeps working after X is removed", async () => {
    const account = await createAccount();
    const other = await secondBrowser(account, "Browser B");
    const hostA = connectFakeHost(account.sessionId, account.token, { marker: "browser-a" });
    const hostB = connectFakeHost(other.sessionId, other.token, { marker: "browser-b" });
    await hostA.ready();
    await hostB.ready();
    await waitUntilConnected(account.token);
    await waitUntilConnected(other.token);
    // Mint the token while Browser A is the default, then remove A: the
    // next call on the SAME MCP session must route to the default (B).
    const { token } = await authorizeWithClient(account);
    const { client, transport } = await makeClient(token);
    const before = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(before.content[0].text).toContain("https://example.com/browser-a");
    const sessionIdBefore = transport.sessionId;

    await removeBrowser(account, account.sessionId);

    expect(transport.sessionId).toBe(sessionIdBefore);
    const after = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(after.isError).toBeFalsy();
    expect(after.content[0].text).toContain("https://example.com/browser-b");

    await client.close();
    hostA.close();
    hostB.close();
  });
});
