import { GATEWAY_NAME, GATEWAY_VERSION, type GatewayEnv } from "./config.js";
import { dirCall } from "./directory-client.js";
import {
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
} from "./oauth.js";
import {
  currentAccount,
  handleAccount,
  handleDeleteAccount,
  handleExtensionAuth,
  handleExtensionRedeem,
  handleLoginGet,
  handleLoginPost,
  handleLogout,
  handlePrivacy,
  handleSignupGet,
  handleSignupPost,
  handleSupport,
  handleTerms,
  loginRedirect,
} from "./site.js";
import { json, text } from "./util.js";

export { SessionDO } from "./session-do.js";
export { DirectoryDO } from "./directory-do.js";
export { RateLimitDO } from "./rate-limit-do.js";

/**
 * Coarse fixed-window rate limits for unauthenticated, credential-handling
 * routes. Counters live in per-key Durable Objects so they survive isolate
 * restarts and are shared by every Worker instance.
 */
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  "/login": { max: 30, windowMs: 60_000 },
  "/signup": { max: 20, windowMs: 60_000 },
  "/logout": { max: 60, windowMs: 60_000 },
  "/account": { max: 120, windowMs: 60_000 },
  "/account/delete": { max: 20, windowMs: 60_000 },
  "/register": { max: 60, windowMs: 60_000 },
  "/token": { max: 120, windowMs: 60_000 },
  "/authorize": { max: 120, windowMs: 60_000 },
  "/revoke": { max: 60, windowMs: 60_000 },
  "/session": { max: 60, windowMs: 60_000 },
  "/session/rotate": { max: 60, windowMs: 60_000 },
  "/session/pair-code": { max: 30, windowMs: 60_000 },
  "/session/status": { max: 120, windowMs: 60_000 },
  "/extension/auth": { max: 60, windowMs: 60_000 },
  "/extension/redeem": { max: 60, windowMs: 60_000 },
  "/extension/reuse": { max: 60, windowMs: 60_000 },
  "/account/browsers": { max: 120, windowMs: 60_000 },
  "/account/browsers/default": { max: 60, windowMs: 60_000 },
  "/account/browsers/rename": { max: 60, windowMs: 60_000 },
  "/account/browsers/remove": { max: 60, windowMs: 60_000 },
  "/account/browsers/disconnect": { max: 60, windowMs: 60_000 },
  "/account/mcp-clients/revoke": { max: 60, windowMs: 60_000 },
  "/bridge": { max: 60, windowMs: 60_000 },
  "/mcp": { max: 300, windowMs: 60_000 },
};

async function rateLimited(request: Request, env: GatewayEnv, path: string, requestId: string): Promise<Response | null> {
  const rule = RATE_LIMITS[path];
  if (!rule || request.method === "OPTIONS") return null;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `${ip}:${path}`;
  try {
    const stub = env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(key));
    const response = await stub.fetch("https://rate-limit.invalid/check", {
      method: "POST",
      body: JSON.stringify({ max: rule.max, windowMs: rule.windowMs }),
    });
    if (!response.ok) {
      // Fail closed on a limiter error response, exactly as on exception:
      // a broken limiter must not silently open a credential route.
      console.error(JSON.stringify({ event: "rate_limit.error", key, status: response.status }));
      return json({ error: "rate_limiter_unavailable", requestId }, 503);
    }
    const result = (await response.json()) as { allowed: boolean; retryAfterMs: number };
    if (result.allowed) return null;
    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    return json({ error: "rate_limited", requestId }, 429, { "retry-after": String(retryAfter) });
  } catch (error) {
    // Fail closed for protected routes when the limiter is unavailable.
    console.error(JSON.stringify({ event: "rate_limit.error", key, message: String(error) }));
    return json({ error: "rate_limiter_unavailable", requestId }, 503);
  }
}

function allowedOrigin(request: Request, env: GatewayEnv): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const allowed = new Set<string>([new URL(request.url).origin]);
  for (const id of String(env.EXTENSION_IDS ?? "").split(",")) {
    const trimmed = id.trim().toLowerCase();
    if (trimmed) allowed.add(`chrome-extension://${trimmed}`);
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") allowed.add(origin);
  return allowed.has(origin) ? origin : null;
}

function withCors(response: Response, requestId: string, request: Request, env: GatewayEnv): Response {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request, env);
  if (origin) headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
  headers.set("access-control-expose-headers", "mcp-session-id");
  headers.set("vary", "Origin");
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    const issuer = url.origin;
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const started = Date.now();

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), requestId, request, env);

    let response: Response;
    try {
      response = await route(request, env, issuer, url, requestId);
    } catch (error) {
      // Structured error log: requestId/method/path only. Never log tokens,
      // passwords, or request bodies here (or anywhere in the gateway).
      console.error(JSON.stringify({ event: "request.error", requestId, method: request.method, path: url.pathname, message: String(error) }));
      response = json({ error: "internal_error", requestId }, 500);
    }
    // Structured request log: requestId, method, path, status, duration.
    // Never tokens, passwords, or bodies. Every non-upgrade response also
    // carries the requestId in its x-request-id header (withCors), and
    // 500/rate-limit bodies carry it in JSON as well.
    console.log(
      JSON.stringify({
        event: "request",
        requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - started,
      }),
    );
    // Never rebuild an upgrade response: wrapping it would drop the `webSocket`.
    if ((response as { webSocket?: unknown }).webSocket) return response;
    return withCors(response, requestId, request, env);
  },
} satisfies ExportedHandler<GatewayEnv>;

async function route(request: Request, env: GatewayEnv, issuer: string, url: URL, requestId: string): Promise<Response> {
  const path = url.pathname;
  const limited = await rateLimited(request, env, path, requestId);
  if (limited) return limited;

  if (path === "/" || path === "/health") {
    return json({
      name: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      status: "ok",
      endpoints: { mcp: `${issuer}/mcp`, bridge: `${issuer}/bridge`, authorize: `${issuer}/authorize` },
    });
  }

  // Website: account signup/login and the extension sign-in handoff.
  if (path === "/signup") {
    if (request.method === "GET") return handleSignupGet(request, env);
    if (request.method === "POST") return handleSignupPost(request, env);
    return text("method not allowed", 405);
  }
  if (path === "/login") {
    if (request.method === "GET") return handleLoginGet(request, env);
    if (request.method === "POST") return handleLoginPost(request, env);
    return text("method not allowed", 405);
  }
  if (path === "/logout" && request.method === "POST") return handleLogout(request, env);
  if (path === "/account") return handleAccount(request, env, issuer);
  if (path === "/account/delete" && request.method === "POST") return handleDeleteAccount(request, env);
  if (path === "/privacy") return handlePrivacy();
  if (path === "/terms") return handleTerms();
  if (path === "/support") return handleSupport();
  if (path === "/extension/auth") return handleExtensionAuth(request, env);
  if (path === "/extension/redeem" && request.method === "POST") return handleExtensionRedeem(request, env);

  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    const resource = path.endsWith("/mcp") ? `${issuer}/mcp` : issuer;
    return protectedResourceMetadata(issuer, resource);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return authorizationServerMetadata(issuer);
  }
  // Domain verification for plugin directory submissions: the exact token, as
  // plain text, on the MCP hostname.
  if (path === "/.well-known/openai-apps-challenge") {
    const token = (env.OPENAI_APPS_CHALLENGE ?? "").trim();
    if (!token) return text("challenge token not configured", 404);
    return new Response(token, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (path === "/register" && request.method === "POST") return handleRegister(request, env);
  if (path === "/authorize") {
    const account = await currentAccount(request, env);
    if (!account) return loginRedirect(`${path}${url.search}`);
    if (request.method === "GET") return handleAuthorizeGet(request, env, account.userId, account.sessionId);
    if (request.method === "POST") return handleAuthorizePost(request, env, account.userId);
    return text("method not allowed", 405);
  }
  if (path === "/token" && request.method === "POST") return handleToken(request, env);
  if (path === "/revoke" && request.method === "POST") return handleRevoke(request, env);

  // Session lifecycle. Creating arbitrary sessions is not public: an account
  // already owns a browser session/token, and the extension gets it via the
  // website sign-in handoff.
  //
  // Pair codes: POST /session mints a fresh pair code for session-pairing
  // display only. Pair codes do NOT authorize OAuth in 0.3.0 (the old
  // pair-code authorization path was removed); OAuth authorization uses
  // the signed-in website user. Pair codes are kept for future pairing.
  if (path === "/session") {
    if (request.method === "POST") {
      const account = await currentAccount(request, env);
      if (!account) return json({ error: "not signed in" }, 401);
      const pairing = await dirCall(env, "newPairCode", { sessionId: account.sessionId });
      if (pairing.ok === false) return json({ error: pairing.error }, 400);
      // 0.3.0: the device token is NEVER returned from /session. The
      // extension already holds it from the sign-in handoff; rotation is
      // the only route that returns a (new) token, via /session/rotate.
      return json({
        sessionId: account.sessionId,
        pairCode: pairing.pairCode,
        pairExpiresAt: pairing.pairExpiresAt,
      });
    }
    return text("method not allowed", 405);
  }
  if (path === "/session/rotate" && request.method === "POST") return rotateSession(request, env);
  if (path === "/session/pair-code" && request.method === "POST") return newPairCode(request, env);
  if (path === "/session/status" && request.method === "GET") return sessionStatus(request, env);

  // Multi-browser account management, for the extension dashboard (via the
  // service worker) and the website session. Auth is either a device token
  // (proves ownership of one of the account's browsers) or the website
  // session cookie. Responses never contain device tokens.
  if (path === "/extension/reuse" && request.method === "POST") return reuseBrowser(request, env);
  if (path === "/account/browsers" && request.method === "GET") return listAccountBrowsers(request, env);
  if (path === "/account/browsers/default" && request.method === "POST") return setAccountDefaultBrowser(request, env);
  if (path === "/account/browsers/rename" && request.method === "POST") return renameAccountBrowser(request, env);
  if (path === "/account/browsers/remove" && request.method === "POST") return removeAccountBrowser(request, env);
  if (path === "/account/browsers/disconnect" && request.method === "POST") return disconnectAccountBrowser(request, env);
  if (path === "/account/mcp-clients/revoke" && request.method === "POST") return revokeAccountMcpClient(request, env);

  if (path === "/bridge") return bridge(request, env, url);
  if (path === "/mcp") return mcp(request, env, url, requestId);

  return text("not found", 404);
}

async function newPairCode(request: Request, env: GatewayEnv): Promise<Response> {
  const session = await authenticateDevice(request, env);
  if ("response" in session) return session.response;
  const result = await dirCall(env, "newPairCode", { sessionId: session.sessionId });
  if (result.ok === false) return json({ error: result.error }, 400);
  return json({ pairCode: result.pairCode, pairExpiresAt: result.pairExpiresAt });
}

async function sessionStatus(request: Request, env: GatewayEnv): Promise<Response> {
  const session = await authenticateDevice(request, env);
  if ("response" in session) return session.response;
  return forwardToSession(env, session.sessionId, "/status", request);
}

// --- Multi-browser account management ---------------------------------------

interface AccountBrowsers {
  userId: string;
  browsers: Array<Record<string, unknown>>;
  defaultSessionId: string;
  currentSessionId?: string;
}

async function resolveAccount(request: Request, env: GatewayEnv): Promise<AccountBrowsers | null> {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const session = await authenticateDevice(request, env);
    if ("response" in session) return null;
    const result = await dirCall(env, "browsersForSession", { sessionId: session.sessionId });
    if (result.ok === false || !Array.isArray(result.browsers)) return null;
    return {
      userId: String(result.userId ?? ""),
      browsers: result.browsers as Array<Record<string, unknown>>,
      defaultSessionId: String(result.defaultSessionId ?? ""),
      currentSessionId: session.sessionId,
    };
  }
  const account = await currentAccount(request, env);
  if (!account) return null;
  const result = await dirCall(env, "browsersForUser", { userId: account.userId });
  if (result.ok === false || !Array.isArray(result.browsers)) return null;
  return {
    userId: account.userId,
    browsers: result.browsers as Array<Record<string, unknown>>,
    defaultSessionId: String(result.defaultSessionId ?? ""),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function sessionDoJson(env: GatewayEnv, sessionId: string, path: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await withTimeout(
      sessionStub(env, sessionId).fetch(`https://session${path}`, init),
      4000,
      null,
    );
    if (!response || !response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listAccountBrowsers(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const clientsResult = await dirCall(env, "clientsForUser", { userId: account.userId });
  const tokenClients = (clientsResult.ok === false ? [] : (clientsResult.clients as Array<Record<string, unknown>> | undefined) ?? []);
  const browsers = [];
  const liveByBrowser = new Map<string, Array<Record<string, unknown>>>();
  for (const browser of account.browsers) {
    const sessionId = String(browser.sessionId ?? "");
    const status = await sessionDoJson(env, sessionId, "/status");
    const connected = Boolean(status?.connected);
    const tabCount = connected ? (await sessionDoJson(env, sessionId, "/browser-tab-count"))?.tabCount ?? null : null;
    const live = connected ? ((await sessionDoJson(env, sessionId, "/mcp-clients"))?.clients as Array<Record<string, unknown>> | undefined) ?? [] : [];
    liveByBrowser.set(sessionId, live);
    browsers.push({
      sessionId,
      name: browser.name ?? "Browser",
      browser: browser.browser ?? "",
      os: browser.os ?? "",
      version: browser.version ?? "",
      createdAt: browser.createdAt ?? null,
      lastSeenAt: browser.lastSeenAt ?? null,
      isDefault: browser.sessionId === account.defaultSessionId,
      connected,
      // Tab count is known only for connected browsers; null means unknown,
      // never a guess. (The local dashboard overlays its own exact count.)
      tabCount: typeof tabCount === "number" ? tabCount : null,
    });
  }
  const mcpClients = tokenClients.map((entry) => {
    const sessionId = String(entry.sessionId ?? "");
    const live = (liveByBrowser.get(sessionId) ?? []).find((item) => String(item.clientId ?? "") === String(entry.clientId ?? ""));
    return {
      clientId: entry.clientId ?? "",
      clientName: entry.clientName ?? entry.clientId ?? "",
      scope: entry.scope ?? "",
      sessionId,
      live: Boolean(live),
      // Live transport timestamps when connected; otherwise the honest
      // proxies are the authorization date and the last token refresh.
      connectedSince: live ? Number(live.createdAt ?? 0) || null : null,
      lastActivityAt: live ? Number(live.lastActivityAt ?? 0) || null : null,
      authorizedSince: entry.createdAt ?? null,
      lastRefreshedAt: entry.lastRefreshedAt ?? null,
      expiresAt: entry.expiresAt ?? null,
    };
  });
  return json({
    browsers,
    defaultSessionId: account.defaultSessionId,
    ...(account.currentSessionId ? { currentSessionId: account.currentSessionId } : {}),
    mcpClients,
  });
}

async function reuseBrowser(request: Request, env: GatewayEnv): Promise<Response> {
  const session = await authenticateDevice(request, env);
  if ("response" in session) return session.response;
  const body = await readJsonBody(request);
  const info = (body.browserInfo && typeof body.browserInfo === "object" ? body.browserInfo : {}) as Record<string, unknown>;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.slice(7).trim();
  const result = await dirCall(env, "reuseBrowserSession", { deviceToken: bearer, browserInfo: info });
  if (result.ok === false) return json({ error: result.error ?? "could not reuse browser session" }, 400);
  return json({ sessionId: result.sessionId });
}

async function setAccountDefaultBrowser(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const body = await readJsonBody(request);
  const target = String(body.sessionId ?? "");
  if (!account.browsers.some((entry) => String(entry.sessionId ?? "") === target)) {
    return json({ error: "unknown browser" }, 404);
  }
  const result = await dirCall(env, "setDefaultBrowser", { userId: account.userId, targetSessionId: target });
  if (result.ok === false) return json({ error: result.error ?? "could not set default browser" }, 400);
  return json({ defaultSessionId: result.defaultSessionId });
}

async function renameAccountBrowser(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const body = await readJsonBody(request);
  const target = String(body.sessionId ?? "");
  const name = String(body.name ?? "");
  if (!account.browsers.some((entry) => String(entry.sessionId ?? "") === target)) {
    return json({ error: "unknown browser" }, 404);
  }
  const result = await dirCall(env, "renameBrowser", { userId: account.userId, targetSessionId: target, name });
  if (result.ok === false) return json({ error: result.error ?? "could not rename browser" }, 400);
  return json({ sessionId: result.sessionId, name: result.name });
}

async function removeAccountBrowser(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const body = await readJsonBody(request);
  const target = String(body.sessionId ?? "");
  if (!account.browsers.some((entry) => String(entry.sessionId ?? "") === target)) {
    return json({ error: "unknown browser" }, 404);
  }
  const result = await dirCall(env, "removeBrowser", { userId: account.userId, targetSessionId: target });
  if (result.ok === false) return json({ error: result.error ?? "could not remove browser" }, 400);
  // Close the removed browser's bridge and live MCP sessions; the
  // DirectoryDO record and tokens are already gone.
  await sessionDoJson(env, target, "/disconnect-bridge", { method: "POST" });
  await sessionDoJson(env, target, "/purge-mcp-sessions", { method: "POST" });
  return json({ removed: result.removed, defaultSessionId: result.defaultSessionId });
}

async function disconnectAccountBrowser(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const body = await readJsonBody(request);
  const target = String(body.sessionId ?? "");
  if (!account.browsers.some((entry) => String(entry.sessionId ?? "") === target)) {
    return json({ error: "unknown browser" }, 404);
  }
  await sessionDoJson(env, target, "/disconnect-bridge", { method: "POST" });
  return json({ disconnected: target });
}

async function revokeAccountMcpClient(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await resolveAccount(request, env);
  if (!account) return json({ error: "not signed in" }, 401);
  const body = await readJsonBody(request);
  const clientId = String(body.clientId ?? "");
  const target = String(body.sessionId ?? "");
  if (!clientId) return json({ error: "client is required" }, 400);
  if (target && !account.browsers.some((entry) => String(entry.sessionId ?? "") === target)) {
    return json({ error: "unknown browser" }, 404);
  }
  const result = await dirCall(env, "revokeClient", { userId: account.userId, clientId, sessionId: target });
  if (result.ok === false) return json({ error: result.error ?? "could not revoke client" }, 400);
  const affected = target
    ? [target]
    : account.browsers.map((entry) => String(entry.sessionId ?? "")).filter(Boolean);
  for (const sessionId of affected) {
    await sessionDoJson(env, sessionId, "/drop-mcp-client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
  }
  return json({ revoked: result.revoked ?? 0 });
}

/**
 * Verify the extension's device token from the Authorization Bearer header
 * ONLY. The token is never accepted from a URL query parameter in 0.3.0
 * (that was the old /bridge ?token= exposure; bridge auth is now a first
 * WebSocket message instead).
 */
async function authenticateDevice(
  request: Request,
  env: GatewayEnv,
): Promise<{ sessionId: string; name: string } | { response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!bearer) return { response: json({ error: "missing device token" }, 401) };
  const result = await dirCall(env, "authDevice", { deviceToken: bearer });
  if (result.ok === false) return { response: json({ error: "invalid device token" }, 401) };
  return { sessionId: String(result.sessionId), name: String(result.name ?? "Browser") };
}

/**
 * POST /session/rotate — rotate a session's device token.
 *
 * Accepted auth (either, never a query parameter and never a token in the
 * form body):
 *  - Authorization: Bearer <device token> (extension/API callers), or
 *  - a signed-in website session cookie (the account page Rotate button).
 * Returns { deviceToken, sessionId } with Cache-Control: no-store. The old
 * token stops working immediately. A website rotation therefore disconnects
 * the extension until it signs in again and picks up the new token.
 */
async function rotateSession(request: Request, env: GatewayEnv): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  let sessionId: string | null = null;
  if (header.toLowerCase().startsWith("bearer ")) {
    const session = await authenticateDevice(request, env);
    if ("response" in session) return session.response;
    sessionId = session.sessionId;
  } else {
    const account = await currentAccount(request, env);
    if (!account) return json({ error: "not signed in" }, 401);
    sessionId = account.sessionId;
  }
  const result = await dirCall(env, "rotateDeviceToken", { sessionId });
  if (result.ok === false) return json({ error: result.error ?? "unknown session" }, 400);
  return json(
    { deviceToken: result.deviceToken, sessionId: result.sessionId },
    200,
    { "cache-control": "no-store" },
  );
}

async function bridge(request: Request, env: GatewayEnv, url: URL): Promise<Response> {
  if (request.headers.get("upgrade") !== "websocket") return text("Expected websocket upgrade", 426);
  // 0.3.0 WebSocket auth: NO token query parameter and NO Bearer check here.
  // The upgrade is forwarded unauthenticated to the SessionDO named by the
  // `session` query parameter (a routing identifier, not a credential), and
  // the SessionDO holds the socket unauthenticated until the first message
  // {"type":"auth","token":"..."} verifies via DirectoryDO within 5 seconds
  // (close 4401 missing/timeout, 4403 invalid/mismatched). A ?token=
  // parameter, if an old client still sends one, is ignored entirely: it
  // neither authenticates nor is logged.
  // Forward the *original* upgrade request so the WebSocket handshake and
  // the `session` query parameter survive to the SessionDO.
  const sessionId = url.searchParams.get("session") ?? "";
  if (!sessionId) return text("session query parameter is required", 400);
  return sessionStub(env, sessionId).fetch(request);
}

async function mcp(request: Request, env: GatewayEnv, url: URL, requestId: string): Promise<Response> {
  void url;
  const header = request.headers.get("authorization") ?? "";
  const issuer = new URL(request.url).origin;
  if (!header.toLowerCase().startsWith("bearer ")) {
    return unauthorized(issuer, requestId);
  }
  const accessToken = header.slice(7).trim();
  const verified = await dirCall(env, "verifyAccess", { accessToken });
  if (verified.ok === false) return unauthorized(issuer, requestId);
  // Forward the verified OAuth client as the caller identity. These headers
  // are stripped from the inbound request first so a client cannot spoof
  // them. 0.3.0 internal prefix is x-muze-* (old x-uabb-* is not accepted
  // by SessionDO). The client's original version header is restored here,
  // sanitised (control characters stripped, max 120 chars), instead of
  // being dropped as in 0.2.0. The verified OAuth scope is forwarded the
  // same way so SessionDO/mcp.ts can enforce it before any bridge call.
  const originalVersion = (request.headers.get("x-muze-client-version") ?? "").trim();
  const sanitisedVersion = originalVersion.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 120);
  const verifiedScope = String(verified.scope ?? "")
    .split(/\s+/)
    .filter((item) => item === "read:tools" || item === "call:tools")
    .join(" ");
  const headers = new Headers(request.headers);
  for (const name of ["x-muze-client-id", "x-muze-client-name", "x-muze-client-version", "x-muze-client-scope", "x-muze-browser-session"]) headers.delete(name);
  const clientId = String(verified.clientId ?? "");
  if (clientId) {
    headers.set("x-muze-client-id", clientId);
    headers.set("x-muze-client-name", String(verified.clientName ?? clientId));
  }
  // The browser this access token is bound to (after any browsers.select
  // rebind): SessionDO uses it for browsers.* tools and for routing.
  headers.set("x-muze-browser-session", String(verified.sessionId));
  if (sanitisedVersion) headers.set("x-muze-client-version", sanitisedVersion);
  if (verifiedScope) headers.set("x-muze-client-scope", verifiedScope);
  const forwarded = new Request(request, { headers });
  return sessionStub(env, String(verified.sessionId)).fetch(forwarded);
}

function sessionStub(env: GatewayEnv, sessionId: string): DurableObjectStub {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
}

function unauthorized(issuer: string, requestId?: string): Response {
  return json(
    { error: "invalid_token", ...(requestId ? { requestId } : {}) },
    401,
    {
      "www-authenticate":
        `Bearer realm="mcp", resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    },
  );
}

function forwardToSession(
  env: GatewayEnv,
  sessionId: string,
  path: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = new Headers(request.headers);
  headers.set("x-muze-session", sessionId);
  const forwarded = new Request(url.toString(), { method: request.method, headers });
  return sessionStub(env, sessionId).fetch(forwarded);
}

