import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare } from "miniflare";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PROTOCOL_VERSION,
  TOOL_SCHEMAS,
  toToolDescriptor,
  type ApprovalRequestInfo,
  type BridgeClientMessage,
  type BridgeHostMessage,
} from "../libs/tool-contracts/index.js";
import { taskTools, type TaskView } from "../libs/tool-contracts/schemas/tasks.js";

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
  const email = `tasks_${randomBytes(6).toString("hex")}@example.com`;
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

async function authorizeWithClient(account: Account, scope?: string): Promise<{ token: string; clientId: string }> {
  const register = await http("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Tasks Client", redirect_uris: [REDIRECT_URI] }),
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

function taskView(status: TaskView["status"]): TaskView {
  return {
    id: "task_mirror_1",
    // Deliberately sensitive-looking: the gateway mirror must never retain it.
    goal: "SECRET-GOAL-DO-NOT-MIRROR",
    clientId: "tasks-client",
    browserSessionId: "browser-session-placeholder",
    status,
    steps: [
      { index: 0, tool: "observe", inputSummary: "observe page", state: "done", attempts: 1, outputSummary: "page text" },
      { index: 1, tool: "act", inputSummary: "click button", state: "running", attempts: 1, outputSummary: "" },
      { index: 2, tool: "observe", inputSummary: "verify", state: "pending", attempts: 0, outputSummary: "" },
    ],
    totalSteps: 3,
    doneSteps: [0],
    undoneSteps: [1, 2],
    totalBudgetMs: 120_000,
    correlationId: "corr_tasks_1",
    resultSummary: "",
    createdAt: 1000,
    updatedAt: 2000,
  };
}

/**
 * Fake extension host that answers tasks.* tool calls with TaskViews and
 * everything else with a generic result. It is the bridge; the gateway
 * never executes a task step itself.
 */
function connectFakeHost(account: Account) {
  const socket = new WebSocket(
    `${serverUrl.origin.replace("http", "ws")}/bridge?session=${encodeURIComponent(account.sessionId)}`,
  );
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "auth", token: account.token }));
  });
  const send = (message: BridgeHostMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as BridgeClientMessage;
    switch (message.type) {
      case "hello":
        send({ type: "hello.ok", id: message.id, protocolVersion: PROTOCOL_VERSION, registryVersion: "2.1.0", server: { name: "fake-host", version: "1.0.0" } });
        return;
      case "registry.list":
        send({
          type: "registry.result",
          id: message.id,
          tools: [...TOOL_SCHEMAS.map((tool) => toToolDescriptor(tool)), ...taskTools.map((tool) => toToolDescriptor(tool))],
        });
        return;
      case "tool.call": {
        let result: unknown;
        if (message.tool === "tasks.create") result = { ...taskView("running"), browserSessionId: account.sessionId };
        else if (message.tool === "tasks.get") result = taskView("running");
        else if (message.tool === "tasks.list") result = { tasks: [taskView("running")] };
        else if (message.tool === "tasks.pause") result = taskView("paused");
        else if (message.tool === "tasks.resume") result = taskView("running");
        else if (message.tool === "tasks.cancel") result = taskView("cancelled");
        else result = [{ id: 1, url: "https://example.com", title: "Example" }];
        send({ type: "tool.result", id: message.id, result, dryRun: false, durationMs: 1 });
        return;
      }
      case "approval.request": {
        const approval: ApprovalRequestInfo = {
          id: "appr_1",
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
        send({ type: "approval.resolved", id: message.id, approvalId: message.approvalId, approved: true });
        return;
      default:
        return;
    }
  });
  return {
    socket,
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
    const response = await http("/session/status", { headers: { authorization: `Bearer ${account.token}` } });
    const body = (await response.json()) as { connected?: boolean };
    if (body.connected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("extension never became connected");
}

async function makeClient(token: string): Promise<Client> {
  const client = new Client({ name: "tasks-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl.origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

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

describe("tasks.* gateway", () => {
  test("lists task tools in the core set and calls all six with call:tools", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account);
    await browser.ready();
    await waitUntilConnected(account);
    const token = (await authorizeWithClient(account)).token;
    const client = await makeClient(token);

    const tools = await client.listTools();
    const advertised = tools.tools.map((t) => t.name);
    for (const name of ["tasks.create", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel"]) {
      expect(advertised).toContain(name);
    }

    const created = (await client.callTool({
      name: "tasks.create",
      arguments: { goal: "Do the thing", steps: [{ tool: "observe", input: {} }] },
    })) as ToolResult;
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toContain("task_mirror_1");

    for (const [name, args, status] of [
      ["tasks.get", { taskId: "task_mirror_1" }, "running"],
      ["tasks.pause", { taskId: "task_mirror_1" }, "paused"],
      ["tasks.resume", { taskId: "task_mirror_1" }, "running"],
      ["tasks.cancel", { taskId: "task_mirror_1" }, "cancelled"],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(result.isError, name).toBeFalsy();
      expect(result.content[0].text).toContain(`"${status}"`);
    }
    const listed = (await client.callTool({ name: "tasks.list", arguments: {} })) as ToolResult;
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("task_mirror_1");

    await client.close();
    browser.close();
  });

  test("read:tools can get/list but is denied create/pause/resume/cancel", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account);
    await browser.ready();
    await waitUntilConnected(account);
    const token = (await authorizeWithClient(account, "read:tools")).token;
    const client = await makeClient(token);

    for (const [name, args] of [
      ["tasks.get", { taskId: "task_mirror_1" }],
      ["tasks.list", {}],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(result.isError, name).toBeFalsy();
    }
    for (const [name, args] of [
      ["tasks.create", { goal: "x", steps: [{ tool: "observe", input: {} }] }],
      ["tasks.pause", { taskId: "task_mirror_1" }],
      ["tasks.resume", { taskId: "task_mirror_1" }],
      ["tasks.cancel", { taskId: "task_mirror_1" }],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text).toContain("PERMISSION_DENIED");
    }

    await client.close();
    browser.close();
  });

  test("returns the standard no-browser error for tasks.* when no browser is connected", async () => {
    const account = await createAccount();
    const token = (await authorizeWithClient(account)).token;
    const client = await makeClient(token);
    const result = (await client.callTool({ name: "tasks.get", arguments: { taskId: "task_mirror_1" } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CONFLICT");
    expect(result.content[0].text).toContain("No browser is connected");
    await client.close();
  });

  test("mirror updates from a tasks.create result and contains no goal, inputs, or outputs", async () => {
    const account = await createAccount();
    const browser = connectFakeHost(account);
    await browser.ready();
    await waitUntilConnected(account);
    const token = (await authorizeWithClient(account)).token;
    const client = await makeClient(token);

    const created = (await client.callTool({
      name: "tasks.create",
      arguments: { goal: "Do the thing", steps: [{ tool: "observe", input: {} }] },
    })) as ToolResult;
    expect(created.isError).toBeFalsy();

    // A non-task call must not add or change mirror entries.
    const other = (await client.callTool({ name: "tabs.list", arguments: {} })) as ToolResult;
    expect(other.isError).toBeFalsy();

    const status = await http("/session/status", { headers: { authorization: `Bearer ${account.token}` } });
    expect(status.status).toBe(200);
    const body = (await status.json()) as { connected?: boolean; tasks?: Record<string, unknown>[] };
    expect(body.connected).toBe(true);
    expect(body.tasks).toHaveLength(1);
    const entry = body.tasks?.[0] ?? {};
    expect(entry).toMatchObject({ taskId: "task_mirror_1", status: "running", stepIndex: 1, totalSteps: 3, browserSessionId: account.sessionId });
    expect(Object.keys(entry).sort()).toEqual(["browserSessionId", "status", "stepIndex", "taskId", "totalSteps", "updatedAt"]);
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("SECRET-GOAL-DO-NOT-MIRROR");
    expect(bodyText).not.toContain("observe page");
    expect(bodyText).not.toContain("page text");

    await client.close();
    browser.close();
  });
});
