import type { GatewayEnv } from "./config.js";
import { dirCall } from "./directory-client.js";
import { escapeHtml, html, json, readJson } from "./util.js";

const SUPPORTED_SCOPES = ["read:tools", "call:tools"];

/**
 * The authorize page submits a form that the server answers with a 302 to the
 * client's `redirect_uri`. Browsers enforce `form-action` across the whole
 * redirect chain, so the default `form-action 'self'` policy would block the
 * redirect back to the client (e.g. Claude) and strand the flow. This CSP keeps
 * everything else locked down but omits `form-action`.
 */
const AUTHORIZE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'";

export function protectedResourceMetadata(issuer: string, resource = issuer): Response {
  return json({
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: SUPPORTED_SCOPES,
    resource_documentation: `${issuer}/`,
  });
}

export function authorizationServerMetadata(issuer: string): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SUPPORTED_SCOPES,
    resource_indicators_supported: true,
  });
}

/** RFC 7591 dynamic client registration. */
export async function handleRegister(request: Request, env: GatewayEnv): Promise<Response> {
  const body = await readJson<Record<string, any>>(request);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (redirectUris.length === 0 || redirectUris.length > 5) {
    return json({ error: "invalid_client_metadata", error_description: "1-5 redirect_uris are required" }, 400);
  }
  for (const value of redirectUris) {
    if (value.length > 2048) {
      return json({ error: "invalid_client_metadata", error_description: "redirect_uri is too long" }, 400);
    }
    try {
      const uri = new URL(value);
      const loopback = uri.hostname === "localhost" || uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
      if (uri.username || uri.password) throw new Error("credentials are not allowed");
      if (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback)) throw new Error("https is required");
      if (uri.hash) throw new Error("fragments are not allowed");
    } catch {
      return json({ error: "invalid_client_metadata", error_description: `invalid redirect_uri: ${value}` }, 400);
    }
  }
  if (new Set(redirectUris).size !== redirectUris.length) {
    return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be unique" }, 400);
  }
  const clientName = String(body.client_name ?? "MCP Client").slice(0, 120);
  const result = await dirCall(env, "createClient", {
    clientName,
    redirectUris,
    tokenEndpointAuthMethod: "none",
  });
  if (result.ok === false) return json({ error: "invalid_client_metadata", error_description: result.error }, 400);
  return json(
    {
      client_id: result.clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SUPPORTED_SCOPES.join(" "),
    },
    201,
  );
}

function redirectWithCode(redirectUri: string, code: string, state: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  console.log(`[authorize] -> ${url.origin}${url.pathname} (code, state=${state ? "yes" : "no"})`);
  return Response.redirect(url.toString(), 302);
}

/** OAuth errors must be delivered by redirect, or an embedded client shows nothing. */
function redirectWithError(redirectUri: string, description: string, state: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  console.log(`[authorize] -> ${url.origin}${url.pathname} (error: ${description})`);
  return Response.redirect(url.toString(), 302);
}

/**
 * Authorization endpoint (GET): validate the client and show the approval
 * form. The caller must already be signed in to the website; index.ts
 * enforces that. Authorization in 0.3.0 uses that signed-in user: the form
 * never asks for a device token, and the session authorized is the signed-in
 * user's own session (shown on the form, never taken from form input).
 */
export async function handleAuthorizeGet(request: Request, env: GatewayEnv, userId: string, sessionId = ""): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const responseType = url.searchParams.get("response_type") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
  const state = url.searchParams.get("state") ?? "";
  const requestedScope = (url.searchParams.get("scope") ?? SUPPORTED_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const scope = requestedScope.filter((item) => SUPPORTED_SCOPES.includes(item)).join(" ") || SUPPORTED_SCOPES.join(" ");
  const resource = url.searchParams.get("resource") ?? "";

  if (!userId) return html(errorPage("Sign in to authorize a client."), 401);
  // response_type is part of the OAuth request and must be exactly "code";
  // a missing or different value is an OAuth error, not a defaulted value.
  // (Clients that previously omitted it must now send response_type=code.)
  if (responseType !== "code") {
    return html(errorPage('response_type must be "code".'), 400);
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return html(errorPage("PKCE with S256 is required."), 400);
  }
  if (resource) {
    const issuer = new URL(request.url).origin;
    if (resource !== issuer && resource !== `${issuer}/mcp`) {
      return html(errorPage("The requested resource is not served here."), 400);
    }
  }

  const clientResult = await dirCall(env, "getClient", { clientId });
  if (clientResult.ok === false) {
    return html(errorPage("Unknown client. Register the client before authorizing."), 400);
  }
  const client = clientResult.client as { redirectUris: string[]; clientName: string };
  if (!client.redirectUris.includes(redirectUri)) {
    return html(errorPage("The redirect URI is not registered for this client."), 400);
  }

  const created = await dirCall(env, "createAuthRequest", {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope,
    state,
  });
  if (created.ok === false) return html(errorPage(created.error ?? "Could not start authorization"), 400, { "content-security-policy": AUTHORIZE_CSP });

  return html(authorizePage(client.clientName, String(created.authReqId), scope, sessionId), 200, { "content-security-policy": AUTHORIZE_CSP });
}

/** Authorization endpoint (POST): authorize for the signed-in user.
 * No device token is read from the form in 0.3.0. DirectoryDO
 * authorizeWithUser mints the code for the signed-in user's own session.
 * The old token-paste variant (authorizeWithToken) was removed in 0.3.0. */
export async function handleAuthorizePost(request: Request, env: GatewayEnv, userId: string): Promise<Response> {
  const form = await request.formData();
  const authReqId = String(form.get("authReqId") ?? "");
  const result = await dirCall(env, "authorizeWithUser", { authReqId, userId });
  if (result.ok === false) {
    const error = String(result.error ?? "authorization failed");
    console.log(`[authorize] rejected: ${error}`);
    const redirectUri = result.redirectUri ? String(result.redirectUri) : "";
    const state = String(result.state ?? "");
    if (redirectUri) return redirectWithError(redirectUri, error, state);
    return html(authorizePage("Client", authReqId, "", "", error), 400, { "content-security-policy": AUTHORIZE_CSP });
  }
  console.log("[authorize] approved");
  return redirectWithCode(String(result.redirectUri), String(result.code), String(result.state ?? ""));
}

/** Token endpoint: authorization_code and refresh_token grants. */
export async function handleToken(request: Request, env: GatewayEnv): Promise<Response> {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const codeVerifier = String(form.get("code_verifier") ?? "");
    if (!code || !codeVerifier) {
      return json({ error: "invalid_request", error_description: "code and code_verifier are required" }, 400);
    }
    const exchanged = await dirCall(env, "exchangeCode", { code, clientId, redirectUri, codeVerifier });
    if (exchanged.ok === false) return json({ error: "invalid_grant", error_description: exchanged.error }, 400);
    const tokens = await dirCall(env, "mintTokens", {
      sessionId: exchanged.sessionId,
      clientId: exchanged.clientId,
      scope: exchanged.scope,
    });
    if (tokens.ok === false) return json({ error: "invalid_grant", error_description: tokens.error }, 400);
    return json(tokenResponse(tokens));
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") ?? "");
    if (!clientId) return json({ error: "invalid_request", error_description: "client_id is required" }, 400);
    if (!refreshToken) return json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
    const tokens = await dirCall(env, "refresh", { refreshToken, clientId });
    if (tokens.ok === false) return json({ error: "invalid_grant", error_description: tokens.error }, 400);
    return json(tokenResponse(tokens));
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

/** RFC 7009 token revocation. Unknown or already-revoked tokens also return 200. */
export async function handleRevoke(request: Request, env: GatewayEnv): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (token) await dirCall(env, "revokeToken", { token, clientId });
  return json({ revoked: true });
}

function tokenResponse(tokens: Record<string, any>): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  };
}

function authorizePage(clientName: string, authReqId: string, scope = "", sessionId = "", error?: string): string {
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  const scopeBlock = scope ? `<p>Requested scope: <code>${escapeHtml(scope)}</code></p>` : "";
  const sessionBlock = sessionId
    ? `<p>Browser session being authorized: <code>${escapeHtml(sessionId)}</code></p>`
    : `<p>Browser session being authorized: your signed-in account's session.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escapeHtml(clientName)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  input, button { font: inherit; width: 100%; padding: .65rem; box-sizing: border-box; }
  button { background: #6d5efc; color: #fff; border: 0; border-radius: .4rem; cursor: pointer; }
  .error { color: #b00020; }
  code { word-break: break-all; }
</style>
</head>
<body>
  <h1>Connect ${escapeHtml(clientName)} to your browser</h1>
  <p>Authorizing this client gives it access to your browser through your signed-in Muze AI account. No token is needed here.</p>
  ${scopeBlock}
  ${sessionBlock}
  ${errorBlock}
  <form method="post" action="/authorize">
    <input type="hidden" name="authReqId" value="${escapeHtml(authReqId)}" />
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Authorization error</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto;">
<h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`;
}
