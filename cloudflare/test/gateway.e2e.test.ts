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
  token: string;
  cookie: string;
  sessionId: string;
}

let mf: Miniflare;
let serverUrl: URL;

async function http(path: string, init?: RequestInit) {
  // Miniflare's dispatchFetch returns a Workers Response and accepts Workers
  // RequestInit; the undici Headers/Response types Node ships are not
  // assignable to those, so headers are passed as a plain record and the
  // return type is inferred from dispatchFetch instead of annotated.
  const headers = new Headers(init?.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", `10.${randomBytes(3).readUIntBE(0, 3) % 250}.1.1`);
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, name) => {
    headerRecord[name] = value;
  });
  // Boundary cast (test only): Miniflare's dispatchFetch is typed against
  // Node/undici RequestInit/Response, while this file's ambient Response is
  // the Workers type. The values are interchangeable at runtime here
  // (string bodies, header records), so cast at this one boundary instead
  // of annotating every caller with the wrong Response type.
  return mf.dispatchFetch(
    `${serverUrl.origin}${path}`,
    { ...init, headers: headerRecord } as unknown as Parameters<typeof mf.dispatchFetch>[1],
  ) as unknown as Promise<Response>;
}

/** Sign up a fresh website account and get its device token the legitimate
 * way: via the extension sign-in handoff (/extension/auth -> /extension/redeem).
 * 0.3.0: the account page renders the token masked only, so it is no longer
 * a source for the token in tests or in production. */
async function createAccount(): Promise<Account> {
  const email = `e2e_${randomBytes(6).toString("hex")}@example.com`;
  const form = new URLSearchParams({ email, password: "password123" });
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
  return { email, token: redeemed.token, cookie, sessionId: redeemed.sessionId };
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Complete the OAuth code + PKCE exchange and return the token plus client id. */
async function authorizeWithClient(account: Account, scope?: string): Promise<{ token: string; clientId: string }> {
  const register = await http("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "E2E Client", redirect_uris: [REDIRECT_URI] }),
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

  const page = await http(`${authorizeUrl.pathname}${authorizeUrl.search}`, {
    headers: { cookie: account.cookie },
  });
  const html = await page.text();
  const match = /name="authReqId" value="([^"]+)"/.exec(html);
  if (!match) throw new Error(`no authReqId in authorize page: ${html.slice(0, 200)}`);

  // 0.3.0: the form carries no token. Authorization uses the signed-in
  // website user (cookie) and that user's own session.
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

async function authorize(account: Account): Promise<string> {
  return (await authorizeWithClient(account)).token;
}

/**
 * A minimal, protocol-faithful stand-in for the browser extension. It speaks the
 * bridge protocol over a real WebSocket and returns canned tool results, so the
 * gateway is exercised without depending on the extension codebase.
 */
function connectFakeHost(
  account: Account,
  options: { requireApproval?: boolean; emptyRegistry?: boolean; waitApproval?: boolean } = {},
) {
  // 0.3.0 bridge auth: route by session id (identifier, not a credential)
  // and send the device token ONLY as the first WebSocket message.
  const socket = new WebSocket(
    `${serverUrl.origin.replace("http", "ws")}/bridge?session=${encodeURIComponent(account.sessionId)}`,
  );
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "auth", token: account.token }));
  });
  let approvalCount = 0;
  const approvalClients: string[] = [];

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
        send({
          type: "registry.result",
          id: message.id,
          tools: options.emptyRegistry ? [] : TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool)),
        });
        return;
      case "tool.call": {
        if (options.requireApproval && !message.approvalId) {
          send({ type: "tool.error", id: message.id, error: { code: "APPROVAL_REQUIRED", message: "approval required" } as never });
          return;
        }
        send({
          type: "tool.result",
          id: message.id,
          result: [{ id: 1, url: "https://example.com", title: "Example" }],
          dryRun: false,
          durationMs: 1,
        });
        return;
      }
      case "approval.request": {
        approvalCount += 1;
        approvalClients.push(message.client?.id ?? "muze-gateway");
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
      case "approval.wait":
        send({ type: "approval.resolved", id: message.id, approvalId: message.approvalId, approved: options.waitApproval === true });
        return;
      default:
        return;
    }
  });

  return {
    socket,
    approvals: () => approvalCount,
    approvalClients: () => approvalClients,
    ready: () =>
      new Promise<void>((resolveOpen, rejectOpen) => {
        if (socket.readyState === WebSocket.OPEN) return resolveOpen();
        socket.once("open", () => resolveOpen());
        socket.once("error", (error) => rejectOpen(error));
      }),
    close: () => socket.close(),
  };
}

async function waitUntilConnected(account: Account): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const response = await http("/session/status", {
      headers: { authorization: `Bearer ${account.token}` },
    });
    const body = (await response.json()) as { connected?: boolean };
    if (body.connected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("extension never became connected");
}

async function makeClient(token: string, approve = false): Promise<Client> {
  const client = new Client({ name: "e2e-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  if (approve) {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  } else {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl.origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
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

describe("gateway e2e", () => {
  test("serves health and OAuth metadata", async () => {
    const health = await http("/health");
    expect(health.status).toBe(200);
    const meta = await http("/.well-known/oauth-authorization-server");
    expect(meta.status).toBe(200);
  });

  test("serves the directory domain-verification challenge verbatim", async () => {
    const response = await http("/.well-known/openai-apps-challenge");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-token-123");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  test("publishes the legal and support pages the directory review requires", async () => {
    for (const path of ["/privacy", "/terms", "/support"]) {
      const page = await http(path);
      expect(page.status).toBe(200);
      expect((await page.text()).length).toBeGreaterThan(200);
    }
  });

  test("rate limits repeated login attempts through the durable limiter", async () => {
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "203.0.113.7",
    };
    const body = new URLSearchParams({ email: "nobody@example.com", password: "wrong-password" }).toString();
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await http("/login", { method: "POST", headers, body, redirect: "manual" });
      expect(response.status).not.toBe(429);
    }
    const limited = await http("/login", { method: "POST", headers, body, redirect: "manual" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  test("rejects MCP requests without a valid access token", async () => {
    const response = await http("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });

  test("hands the extension a one-time code instead of the device token", async () => {
    const account = await createAccount();
    const redirectUri = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/";
    const state = "state_0123456789abcdef";
    const auth = await http(
      `/extension/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
      { headers: { cookie: account.cookie }, redirect: "manual" },
    );
    expect(auth.status).toBe(302);
    const location = new URL(auth.headers.get("location") ?? "");
    expect(location.origin).toBe("https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org");
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get("state")).toBe(state);
    expect(fragment.get("token")).toBeNull();
    const code = fragment.get("code") ?? "";
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const redeem = await http("/extension/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    expect(redeem.status).toBe(200);
    const redeemed = (await redeem.json()) as { token: string; email: string; sessionId: string };
    // Multi-browser model: createAccount already adopted the signup
    // placeholder, so a second sign-in creates a NEW browser with its own
    // token and session — the first browser's token keeps working.
    expect(redeemed.token).not.toBe(account.token);
    expect(redeemed.email).toBe(account.email);
    expect(redeemed.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redeemed.sessionId).not.toBe(account.sessionId);
    expect((await http("/session/status", { headers: { authorization: `Bearer ${account.token}` } })).status).toBe(200);
    expect((await http("/session/status", { headers: { authorization: `Bearer ${redeemed.token}` } })).status).toBe(200);

    const replay = await http("/extension/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });
    expect(replay.status).toBe(400);
  });

  test("rejects extension redirects that are not allowlisted", async () => {
    const account = await createAccount();
    const response = await http(
      `/extension/auth?redirect_uri=${encodeURIComponent("https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.chromiumapp.org/")}&state=state_0123456789abcdef`,
      { headers: { cookie: account.cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(400);
  });

  test("deletes an account and invalidates its token", async () => {
    const account = await createAccount();
    const status = (): Promise<Response> =>
      http("/session/status", { headers: { authorization: `Bearer ${account.token}` } });
    expect((await status()).status).toBe(200);

    const deleted = await http("/account/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: account.cookie },
      body: new URLSearchParams({ confirm: "delete" }).toString(),
      redirect: "manual",
    });
    expect(deleted.status).toBe(302);
    expect(deleted.headers.get("location")).toBe("/");
    expect(deleted.headers.get("set-cookie")).toContain("muze_session=");

    expect((await status()).status).toBe(401);
    const page = await http("/account", { headers: { cookie: account.cookie }, redirect: "manual" });
    expect(page.status).toBe(302);
  });

  test("revokes an access token so it can no longer reach /mcp", async () => {
    const account = await createAccount();
    const token = await authorize(account);
    const call = (bearer: string): Promise<Response> =>
      http("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    expect((await call(token)).status).not.toBe(401);

    const revoke = await http("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(revoke.status).toBe(200);

    const revoked = await call(token);
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { error?: string }).error).toBe("invalid_token");

    // Revoking an unknown token is idempotent, per RFC 7009.
    const again = await http("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(again.status).toBe(200);
  });

  test("lists tools and executes a read-only tool through the browser bridge", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account);
    await browser.ready();
    await waitUntilConnected(account);
    const token = await authorize(account);
    const client = await makeClient(token);

    const tools = await client.listTools();
    const advertised = tools.tools.map((t) => t.name);
    expect(advertised).toContain("navigate");
    expect(advertised).toContain("observe");
    expect(advertised).toContain("act");
    expect(advertised).toContain("form");
    expect(advertised).toContain("data");
    expect(advertised).toContain("tools.discover");
    expect(advertised).toContain("tools.batch");
    // Core mode advertises a curated set by default; full registry remains
    // discoverable via tools.discover.
    expect(tools.tools.length).toBeLessThan(TOOL_SCHEMAS.length);
    expect(advertised).not.toContain("downloads.list");
    expect(advertised).not.toContain("tabs.current");
    expect(advertised).not.toContain("navigation.goto");
    const registry = new Set(TOOL_SCHEMAS.map((tool) => tool.name));
    for (const name of advertised) {
      // Gateway-native tools (discovery, batching, browser routing) are
      // not registry tools: they never reach the bridge.
      if (name === "tools.discover" || name === "tools.batch" || name === "browsers.list" || name === "browsers.select") continue;
      expect(registry.has(name), `${name} must exist in TOOL_SCHEMAS`).toBe(true);
    }

    // Every tool advertises explicit annotations so clients can decide when to
    // ask the user for a confirmation.
    for (const tool of tools.tools) {
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
    }
    const observe = tools.tools.find((t) => t.name === "observe");
    expect(observe?.annotations?.readOnlyHint).toBe(true);
    expect(observe?.annotations?.destructiveHint).toBe(false);

    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("https://example.com");

    await client.close();
    browser.close();
  });

  test("advertises nothing when the extension allows nothing", async () => {
    const account = await createAccount();
    // The extension reports an empty registry when the user's permission
    // level does not allow a single tool.
    const browser = connectFakeHost(account, { emptyRegistry: true });
    await browser.ready();
    await waitUntilConnected(account);
    const token = await authorize(account);
    const client = await makeClient(token);

    const tools = await client.listTools();
    // Exception, by design: the gateway-native browsers tools are not
    // extension tools — they reveal no browser state and act on no
    // browser, they only route the caller's own future calls — so they
    // stay advertised even when the extension allows nothing.
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["browsers.list", "browsers.select"]);

    await client.close();
    browser.close();
  });

  test("uses dashboard approval even when the client supports elicitation", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account, { requireApproval: true, waitApproval: true });
    await browser.ready();
    await waitUntilConnected(account);
    const token = await authorize(account);
    const client = await makeClient(token, true);

    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(browser.approvals()).toBe(1);

    await client.close();
    browser.close();
  });

  test("a client cannot self-approve when the dashboard denies", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account, { requireApproval: true });
    await browser.ready();
    await waitUntilConnected(account);
    const token = await authorize(account);
    const client = await makeClient(token, true);

    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("APPROVAL_DENIED");

    await client.close();
    browser.close();
  });

  test("a reconnecting extension replaces the old socket and keeps working", async () => {
    const account = await createAccount();
    const first = connectFakeHost(account);
    await first.ready();
    await waitUntilConnected(account);

    // A reconnect (new socket, same token) must replace the previous one without
    // the old socket's close event tearing down the new bridge.
    const second = connectFakeHost(account);
    await second.ready();
    await new Promise((r) => setTimeout(r, 100));
    await waitUntilConnected(account);

    const token = await authorize(account);
    const client = await makeClient(token);
    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("https://example.com");

    await client.close();
    first.close();
    second.close();
  });

  test("requires a signed-in account to rotate a session and its pair code", async () => {
    const anonymous = await http("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);

    const account = await createAccount();
    const first = await http("/session", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: account.cookie },
      body: "{}",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { sessionId: string; deviceToken?: string; pairCode: string };
    expect(firstBody.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // 0.3.0: /session must NOT return the device token.
    expect(firstBody.deviceToken).toBeUndefined();
    expect(firstBody.pairCode).toMatch(/^\d{5}-\d{5}$/);

    const second = await http("/session", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: account.cookie },
      body: "{}",
    });
    const secondBody = (await second.json()) as { pairCode: string };
    expect(secondBody.pairCode).not.toBe(firstBody.pairCode);
  });

  test("rejects unsafe registrations and non-S256 authorization requests", async () => {
    const cases = [
      { redirect_uris: ["http://evil.example/callback"] },
      { redirect_uris: ["https://user:pass@client.example/callback"] },
      { redirect_uris: ["https://client.example/callback#fragment"] },
      { redirect_uris: ["https://client.example/callback", "https://client.example/callback"] },
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://client.example/cb${i}`) },
    ];
    for (const body of cases) {
      const response = await http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Unsafe", ...body }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const account = await createAccount();
    const register = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "PKCE", redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const url = new URL(`${serverUrl.origin}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", "plain-value");
    url.searchParams.set("code_challenge_method", "plain");
    const response = await http(`${url.pathname}${url.search}`, { headers: { cookie: account.cookie } });
    expect(response.status).toBe(400);

    const noChallenge = new URL(url);
    noChallenge.searchParams.delete("code_challenge");
    const missing = await http(`${noChallenge.pathname}${noChallenge.search}`, { headers: { cookie: account.cookie } });
    expect(missing.status).toBe(400);

    const wrongResource = new URL(url);
    wrongResource.searchParams.set("response_type", "code");
    wrongResource.searchParams.set("code_challenge", base64Url(randomBytes(32)));
    wrongResource.searchParams.set("code_challenge_method", "S256");
    wrongResource.searchParams.set("resource", "https://other.example/mcp");
    const resourceResponse = await http(`${wrongResource.pathname}${wrongResource.search}`, {
      headers: { cookie: account.cookie },
    });
    expect(resourceResponse.status).toBe(400);
  });

  test("rejects an explicitly requested scope that names nothing supported", async () => {
    const account = await createAccount();
    const register = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Scope Check", redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const authorizeUrl = (scope?: string): string => {
      const url = new URL(`${serverUrl.origin}/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", "xyz");
      if (scope) url.searchParams.set("scope", scope);
      return `${url.pathname}${url.search}`;
    };

    // An invented scope is rejected, not silently widened to full scope.
    const rejected = await http(authorizeUrl("invented:scope"), { headers: { cookie: account.cookie } });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("invalid_scope");

    // A known scope still authorizes, and a partly-unknown scope keeps
    // only its known values instead of rejecting.
    const known = await http(authorizeUrl("read:tools"), { headers: { cookie: account.cookie } });
    expect(known.status).toBe(200);
    expect(await known.text()).toContain("read:tools");
    const partial = await http(authorizeUrl("read:tools invented:scope"), { headers: { cookie: account.cookie } });
    expect(partial.status).toBe(200);
    const partialHtml = await partial.text();
    expect(partialHtml).toContain("read:tools");
    expect(partialHtml).not.toContain("invented:scope");
  });

  test("consent page shows the redirect destination, client id, and the unverified-name warning", async () => {
    const account = await createAccount();
    const register = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const url = new URL(`${serverUrl.origin}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "xyz");
    const response = await http(`${url.pathname}${url.search}`, { headers: { cookie: account.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(REDIRECT_URI);
    expect(html).toContain(clientId);
    expect(html).toContain("not verified");
  });

  test("tags dashboard approvals with the OAuth client identity", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account, { requireApproval: true, waitApproval: true });
    await browser.ready();
    await waitUntilConnected(account);
    const { token, clientId } = await authorizeWithClient(account);
    const client = new Client({ name: "no-elicitation", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);

    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("https://example.com");
    expect(browser.approvals()).toBe(1);
    expect(browser.approvalClients()).toEqual([clientId]);

    await client.close();
    browser.close();
  });

  test("account page never renders the device token, not even masked", async () => {
    const account = await createAccount();
    const page = await http("/account", { headers: { cookie: account.cookie } });
    const pageHtml = await page.text();
    expect(pageHtml).not.toContain(account.token);
    // The old masked rendering (bullets + last 4) is gone: tokens live
    // only in the extension. The page lists browser names instead.
    expect(pageHtml).not.toContain(`••••••••${account.token.slice(-4)}`);
    expect(pageHtml).toContain("Browsers");
    // The Rotate button posts to /session/rotate via the website session.
    expect(pageHtml).toContain('action="/session/rotate"');
  });

  test("rotates a device token: old token dies immediately, session id is kept", async () => {
    const account = await createAccount();
    const status = (token: string): Promise<Response> =>
      http("/session/status", { headers: { authorization: `Bearer ${token}` } });
    expect((await status(account.token)).status).toBe(200);

    const rotated = await http("/session/rotate", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}` },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toContain("no-store");
    const body = (await rotated.json()) as { deviceToken: string; sessionId: string };
    expect(body.deviceToken).not.toBe(account.token);
    expect(body.sessionId).toBe(account.sessionId);

    expect((await status(account.token)).status).toBe(401);
    expect((await status(body.deviceToken)).status).toBe(200);

    // Website-session rotation works too, without any token in the request.
    const again = await http("/session/rotate", {
      method: "POST",
      headers: { cookie: account.cookie },
    });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { deviceToken: string; sessionId: string };
    expect(againBody.deviceToken).not.toBe(body.deviceToken);
    expect(againBody.sessionId).toBe(account.sessionId);
    expect((await status(body.deviceToken)).status).toBe(401);
    expect((await status(againBody.deviceToken)).status).toBe(200);
  });

  test("bridge closes an unauthenticated socket with 4403 on a bad first auth message", async () => {
    const account = await createAccount();
    const socket = new WebSocket(
      `${serverUrl.origin.replace("http", "ws")}/bridge?session=${encodeURIComponent(account.sessionId)}`,
    );
    const closed = await new Promise<number>((resolve, reject) => {
      socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: "bad-token" })));
      socket.on("close", (code) => resolve(code));
      socket.on("error", (error) => reject(error));
    });
    expect(closed).toBe(4403);
  });

  // No per-test timeout override here: the suite default (60s) applies.
  // Measured in Miniflare, the server-side close fires at the 5s deadline
  // (setTimeout and the DO alarm both fire at 5s, and the DO's own
  // webSocketClose runs then), but the close frame only reaches the
  // external client ~10s later (~15s after connect) for a hibernatable
  // Durable Object socket — a plain-Worker timer close, by contrast,
  // arrives on time. A 20s budget therefore left only ~5s of headroom
  // over the nominal ~15s delivery, which parallel load eats. The
  // assertion is unchanged: the socket must still close with 4401.
  test("bridge closes a socket that never authenticates within 5 seconds", async () => {
    const account = await createAccount();
    const socket = new WebSocket(
      `${serverUrl.origin.replace("http", "ws")}/bridge?session=${encodeURIComponent(account.sessionId)}`,
    );
    const closed = await new Promise<number>((resolve, reject) => {
      socket.on("close", (code) => resolve(code));
      socket.on("error", (error) => reject(error));
    });
    expect(closed).toBe(4401);
  });

  test("a read:tools-only token can read but cannot call a reversible tool", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account);
    await browser.ready();
    await waitUntilConnected(account);
    const token = await authorizeWithClient(account, "read:tools").then((result) => result.token);
    const client = await makeClient(token);

    const observed = (await client.callTool({ name: "observe", arguments: { include: ["text"] } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(observed.isError).toBeFalsy();

    const denied = (await client.callTool({ name: "act", arguments: { steps: [] } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("PERMISSION_DENIED");

    await client.close();
    browser.close();
  });

  test("rejects an authorize request without response_type=code", async () => {
    const account = await createAccount();
    const register = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "NoResponseType", redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const url = new URL(`${serverUrl.origin}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", "challenge-value");
    url.searchParams.set("code_challenge_method", "S256");
    const response = await http(`${url.pathname}${url.search}`, { headers: { cookie: account.cookie } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("response_type");
  });

  test("reports an error when no browser is connected", async () => {
    const account = await createAccount();
    const token = await authorize(account);
    const client = await makeClient(token);
    const result = (await client.callTool({ name: "tabs.list", arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CONFLICT");
    await client.close();
  });
});
