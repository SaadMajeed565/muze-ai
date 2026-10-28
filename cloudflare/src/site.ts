import type { GatewayEnv } from "./config.js";
import { dirCall } from "./directory-client.js";
import { clearCookie, escapeHtml, html, json, parseCookies, readJson, setCookie } from "./util.js";

const SESSION_COOKIE = "muze_session";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface Account {
  userId: string;
  email: string;
  token: string;
  sessionId: string;
}

/** Resolve the signed-in website account from the session cookie, if any. */
export async function currentAccount(request: Request, env: GatewayEnv): Promise<Account | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const sessionToken = cookies[SESSION_COOKIE] ?? "";
  if (!sessionToken) return null;
  const result = await dirCall(env, "accountBySession", { sessionToken });
  if (result.ok === false) return null;
  return {
    userId: String(result.userId),
    email: String(result.email),
    token: String(result.token),
    sessionId: String(result.sessionId),
  };
}

/** Only allow same-site relative paths as post-login destinations. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/account";
  return value;
}

export function loginRedirect(next: string): Response {
  return redirectTo(`/login?next=${encodeURIComponent(next)}`);
}

function redirectTo(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

interface ExtensionRedirect {
  redirectUri: string;
  extensionId: string;
}

function extensionIds(env: GatewayEnv): string[] {
  return String(env.EXTENSION_IDS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Only the exact Chromium app origin for an allowlisted extension may receive a handoff. */
function parseExtensionRedirect(value: string, env: GatewayEnv): ExtensionRedirect | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    const match = /^([a-p]{32})\.chromiumapp\.org$/.exec(url.hostname);
    if (!match) return null;
    const extensionId = match[1];
    if (!extensionIds(env).includes(extensionId)) return null;
    return { redirectUri: `https://${url.host}/`, extensionId };
  } catch {
    return null;
  }
}

function validState(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

// --- Signup / login ---------------------------------------------------------

export async function handleSignupGet(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const account = await currentAccount(request, env);
  if (account) return redirectTo(safeNext(url.searchParams.get("next")));
  return html(signupPage(safeNext(url.searchParams.get("next"))));
}

export async function handleSignupPost(request: Request, env: GatewayEnv): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const result = await dirCall(env, "signup", { email, password });
  if (result.ok === false) {
    return html(signupPage(next, email, String(result.error ?? "Could not create the account.")), 400);
  }
  return redirectTo(next, [setCookie(SESSION_COOKIE, String(result.webToken), SESSION_MAX_AGE)]);
}

export async function handleLoginGet(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const account = await currentAccount(request, env);
  const next = safeNext(url.searchParams.get("next"));
  if (account) return redirectTo(next);
  return html(loginPage(next));
}

export async function handleLoginPost(request: Request, env: GatewayEnv): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const result = await dirCall(env, "login", { email, password });
  if (result.ok === false) {
    return html(loginPage(next, email, String(result.error ?? "Invalid email or password.")), 400);
  }
  return redirectTo(next, [setCookie(SESSION_COOKIE, String(result.webToken), SESSION_MAX_AGE)]);
}

export async function handleLogout(request: Request, env: GatewayEnv): Promise<Response> {
  const cookies = parseCookies(request.headers.get("cookie"));
  await dirCall(env, "logout", { sessionToken: cookies[SESSION_COOKIE] ?? "" });
  return redirectTo("/", [clearCookie(SESSION_COOKIE)]);
}

// --- Account -----------------------------------------------------------------

export async function handleAccount(request: Request, env: GatewayEnv, issuer: string): Promise<Response> {
  const account = await currentAccount(request, env);
  if (!account) return loginRedirect("/account");
  const connected = await sessionConnected(env, account.sessionId);
  return html(accountPage(account, issuer, connected));
}

export async function handleDeleteAccount(request: Request, env: GatewayEnv): Promise<Response> {
  const account = await currentAccount(request, env);
  if (!account) return loginRedirect("/account");
  const form = await request.formData();
  if (String(form.get("confirm") ?? "") !== "delete") {
    return html(errorPage("Confirm the deletion to remove your account."), 400);
  }
  const cookies = parseCookies(request.headers.get("cookie"));
  const result = await dirCall(env, "deleteAccount", { sessionToken: cookies[SESSION_COOKIE] ?? "" });
  if (result.ok === false) {
    return html(errorPage("Could not delete the account. Please sign in again and retry."), 400);
  }
  // Purge persisted MCP sessions in the browser's SessionDO after the
  // DirectoryDO account deletion, before clearing the website cookie.
  // The log carries no token, password, or session identifier.
  try {
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(account.sessionId));
    const purged = await stub.fetch("https://session/purge-mcp-sessions", { method: "POST" });
    console.log(JSON.stringify({ event: "account_mcp_purge", ok: purged.ok }));
  } catch {
    console.log(JSON.stringify({ event: "account_mcp_purge", ok: false }));
  }
  return redirectTo("/", [clearCookie(SESSION_COOKIE)]);
}

// --- Extension sign-in -------------------------------------------------------

export async function handleExtensionAuth(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const account = await currentAccount(request, env);
  if (!account) return loginRedirect(`${url.pathname}${url.search}`);
  const redirect = parseExtensionRedirect(url.searchParams.get("redirect_uri") ?? "", env);
  const state = url.searchParams.get("state") ?? "";
  if (!redirect || !validState(state)) {
    return html(errorPage("This extension is not authorized to connect to this gateway."), 400);
  }
  const created = await dirCall(env, "createExtensionCode", {
    sessionId: account.sessionId,
    userId: account.userId,
    extensionId: redirect.extensionId,
    redirectUri: redirect.redirectUri,
  });
  if (created.ok === false) return html(errorPage("Could not complete extension sign-in."), 400);
  const target = new URL(redirect.redirectUri);
  target.hash = new URLSearchParams({ code: String(created.code), state }).toString();
  return redirectTo(target.toString());
}

/** Exchange the single-use redirect code for the browser's device token. */
export async function handleExtensionRedeem(request: Request, env: GatewayEnv): Promise<Response> {
  let body: { code?: unknown; redirect_uri?: unknown } = {};
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "invalid request" }, 400, { "cache-control": "no-store" });
  }
  const redirect = parseExtensionRedirect(String(body.redirect_uri ?? ""), env);
  if (!redirect) return json({ error: "invalid redirect" }, 400, { "cache-control": "no-store" });
  const result = await dirCall(env, "redeemExtensionCode", {
    code: String(body.code ?? ""),
    extensionId: redirect.extensionId,
    redirectUri: redirect.redirectUri,
  });
  if (result.ok === false) return json({ error: result.error ?? "invalid or expired code" }, 400, { "cache-control": "no-store" });
  return json(
    {
      token: result.token,
      email: result.email,
      sessionId: result.sessionId,
    },
    200,
    { "cache-control": "no-store" },
  );
}

// --- Helpers -----------------------------------------------------------------

async function sessionConnected(env: GatewayEnv, sessionId: string): Promise<boolean> {
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
  try {
    const response = await stub.fetch("https://session/status");
    const data = (await response.json()) as { connected?: boolean };
    return Boolean(data.connected);
  } catch {
    return false;
  }
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Muze AI</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0b0b0f; color: #e7e7ea;
         max-width: 30rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  p.sub { color: #9a9aa5; margin-top: 0; }
  label { display: block; margin: 1rem 0 .35rem; font-size: .85rem; color: #b8b8c2; }
  input, button { font: inherit; width: 100%; padding: .7rem; box-sizing: border-box; border-radius: .5rem; border: 1px solid #2a2a33; }
  input { background: #14141a; color: #e7e7ea; }
  button { background: #6d5efc; color: #fff; border: 0; cursor: pointer; margin-top: 1.25rem; }
  button.secondary { background: #232330; }
  button.danger { background: #b42323; }
  details.card summary { cursor: pointer; }
  details.card[open] summary { margin-bottom: .5rem; }
  .error { color: #ff6b6b; }
  .muted { color: #9a9aa5; }
  a { color: #9d92ff; }
  code, .token { font-family: ui-monospace, monospace; }
  .token { display: block; word-break: break-all; background: #14141a; border: 1px solid #2a2a33;
           border-radius: .5rem; padding: .75rem; margin: .5rem 0 1rem; user-select: all; }
  .row { display: flex; gap: .5rem; align-items: center; }
  form.inline { display: inline; }
  form.inline button { width: auto; padding: .5rem 1rem; margin: 0; }
  .card { background: #101017; border: 1px solid #23232e; border-radius: .75rem; padding: 1.25rem; margin-top: 1.5rem; }
  ol { padding-left: 1.2rem; }
  .footer { margin-top: 3rem; font-size: .8rem; color: #6a6a76; }
  .footer a { color: #9d92ff; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .25rem; }
</style>
</head>
<body>
${body}
<footer class="footer">
  <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/support">Support</a>
</footer>
</body>
</html>`;
}

/** Public privacy policy, linked from the Chrome Web Store listing. */
export function handlePrivacy(): Response {
  return html(privacyPage());
}

/** Public terms of service, required by plugin directory review. */
export function handleTerms(): Response {
  return html(termsPage());
}

/** Public support page, required by plugin directory review. */
export function handleSupport(): Response {
  return html(supportPage());
}

function termsPage(): string {
  return layout(
    "Terms of Service",
    `<h1>Terms of Service</h1>
<p class="sub">Effective date: October 16, 2026</p>

<p>These terms cover your use of the Muze AI browser extension, the Muze AI
gateway, and the MCP tools those expose to AI assistants you connect. By
creating an account or using the service you agree to them.</p>

<h2>The service</h2>
<p>Muze AI lets an AI assistant you choose drive the browser you connect,
through a set of permissioned tools. The extension is the authority on what may
run: it applies your permission level, your per-tool settings, your approval
choices and the kill switch before any tool executes.</p>

<h2>Your responsibilities</h2>
<ul>
  <li>You are responsible for the AI assistant you connect and for the actions
  it takes on your behalf, including anything it does inside your accounts.</li>
  <li>You must have the right to access the pages, accounts and data you let
  the assistant reach, and you must follow the terms of those third-party sites.</li>
  <li>Do not use the service to break the law, to access anything you are not
  authorised to access, or to send malware or unsolicited messages.</li>
  <li>Do not attempt to interfere with, probe or overload the gateway.</li>
</ul>

<h2>Availability</h2>
<p>The service is provided on an "as is" and "as available" basis, without
warranties. It may be interrupted, changed, or withdrawn at any time. You are
responsible for keeping backups of anything the assistant changes on your
behalf; we are not liable for lost data, lost profits, or indirect damages.</p>

<h2>Accounts</h2>
<p>You are responsible for keeping your account credentials secure and for all
activity under your account. You can sign out at any time to unlink your
browser.</p>

<h2>Termination</h2>
<p>You can stop using the service at any time. We may suspend or terminate
access for abuse, for violating these terms, or to protect the service and its
users.</p>

<h2>Changes</h2>
<p>We may update these terms. Material changes will be reflected by a new
effective date on this page.</p>

<h2>Contact</h2>
<p>Questions about these terms? Contact us at
<a href="mailto:legal@muze.ai">legal@muze.ai</a>.</p>`,
  );
}

function supportPage(): string {
  return layout(
    "Support",
    `<h1>Support</h1>
<p class="sub">Muze AI browser extension and gateway</p>

<p>If something is not working, the fastest path is:</p>
<ol>
  <li>Open the extension dashboard and check that the browser shows
  <strong>connected</strong> to your account.</li>
  <li>Check the <strong>Tools</strong> card: a tool that is switched off, or a
  permission group that is disabled, is refused by design.</li>
  <li>Check the <strong>Permission level</strong> card. On <em>Restricted</em>
  only read-only tools run.</li>
  <li>Check the audit log for the exact tool call and its rejection reason.</li>
</ol>

<h2>Common issues</h2>
<ul>
  <li><strong>"No browser is connected to this session"</strong> — the extension
  is signed out or the gateway session expired. Sign in again from the
  dashboard.</li>
  <li><strong>A tool call is refused</strong> — the tool is disabled, the
  permission level excludes it, or an approval is pending in the dashboard.</li>
  <li><strong>Nothing happens on the page</strong> — Chrome blocks scripting on
  <code>chrome://</code>, <code>chrome-extension://</code> and
  <code>devtools://</code> pages.</li>
</ul>

<h2>Contact</h2>
<p>Email <a href="mailto:support@muze.ai">support@muze.ai</a> and include the
tool name, the time of the call, and the dashboard audit entry. For privacy
questions see the <a href="/privacy">Privacy Policy</a>; for contractual
questions see the <a href="/terms">Terms of Service</a>.</p>`,
  );
}

function privacyPage(): string {
  return layout(
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p class="sub">Effective date: October 16, 2026</p>

<p>Muze AI ("we", "us") provides a browser extension and an associated cloud
gateway that let a user connect an AI assistant they choose (such as Claude) to
their own web browser. This policy explains what data the extension and gateway
access, how it is used, and the choices you have.</p>

<p>Muze AI has a single purpose: to let an AI assistant you connected read and
control the user's browser through a set of permissioned tools. The tool groups
are enabled by default, so actions run as the assistant requests them; you can
require an explicit one-time approval for risky actions, or switch off individual
tool groups, from the extension dashboard. We do not use your data for
advertising, profiling, creditworthiness, or lending.</p>

<h2>Data the extension accesses</h2>
<p>The extension only acts in response to a request from the AI assistant you
connected, and only for the permissions and tool groups you have enabled. When a
tool runs, the extension may access:</p>
<ul>
  <li><strong>Website content</strong> — page text, DOM elements, links, tables,
  metadata, selected text, and screenshots of the page you are working with.</li>
  <li><strong>Web history</strong> — tab URLs and titles, and your browser
  history, which the assistant can search or delete. You can switch off the
  history group in the extension dashboard.</li>
  <li><strong>Bookmarks, downloads, and clipboard</strong> — the assistant can
  create, update, and delete bookmarks, start and list downloads, and read or
  write the clipboard. Each of these has its own tool group that you can switch
  off in the extension dashboard.</li>
  <li><strong>Account information</strong> — the email address associated with
  your Muze AI account and an authentication token, used to link this browser to
  the gateway and to show who is signed in.</li>
  <li><strong>Developer diagnostics</strong> — console messages, page errors, and
  performance data for the tab being controlled, when those tools are used.</li>
</ul>

<h2>How the data is used</h2>
<p>Data accessed by a tool is used solely to perform the action you requested and
to return the result to the AI assistant you connected. For example, if you ask
the assistant to summarize a page, the page text is read and returned to that
assistant so it can write the summary.</p>

<h2>What is shared and with whom</h2>
<ul>
  <li><strong>Your AI assistant.</strong> Tool results are sent only to the AI
  client you connected, so it can carry out your request.</li>
  <li><strong>Our gateway.</strong> Requests and results pass through the Muze AI
  gateway solely to relay them between your browser and your AI client.</li>
  <li><strong>No sale.</strong> We do not sell or transfer your data to third
  parties, and we do not use or transfer it for purposes unrelated to the
  extension's single purpose.</li>
  <li><strong>No analytics or advertising.</strong> The extension contains no
  analytics, tracking, or advertising SDKs.</li>
</ul>

<h2>Local storage</h2>
<p>Your settings (permission configuration) and sign-in token are stored locally
in your browser using <code>chrome.storage.local</code>. Clearing the extension's
data or signing out removes them.</p>

<h2>Retention</h2>
<p>The gateway relays tool traffic and does not build a profile of your browsing.
Account records are retained while your account is active and are removed when
you delete your account. Signing out ends the website session; revoking a token
deletes the access and refresh tokens issued to that client.</p>

<h2>Security</h2>
<p>Traffic between the extension, gateway, and AI client uses HTTPS/WSS. Access
tokens are stored hashed on the server side. Approvals and the kill switch let you
stop or deny any action at any time.</p>

<h2>Your choices and controls</h2>
<ul>
  <li>Enable or disable tool groups from the extension dashboard.</li>
  <li>Approve or deny each sensitive action, or stop everything with the kill
  switch.</li>
  <li>Sign out at any time to unlink the browser.</li>
</ul>

<h2>Children's privacy</h2>
<p>Muze AI is not directed to children under 13, and we do not knowingly collect
their data.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy from time to time. Material changes will be reflected
by a new effective date on this page.</p>

<h2>Contact</h2>
<p>Questions about this policy? Contact us at
<a href="mailto:privacy@muze.ai">privacy@muze.ai</a>.</p>`,
  );
}

function signupPage(next: string, email = "", error?: string): string {
  return layout(
    "Create account",
    `<h1>Create your Muze AI account</h1>
<p class="sub">One account connects your browser to Claude and other MCP clients.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/signup">
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(email)}" required />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
  <button type="submit">Create account</button>
</form>
<p class="muted">Already have an account? <a href="/login?next=${encodeURIComponent(next)}">Log in</a></p>`,
  );
}

function loginPage(next: string, email = "", error?: string): string {
  return layout(
    "Log in",
    `<h1>Log in to Muze AI</h1>
<p class="sub">Sign in to connect your browser and authorize clients.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" value="${escapeHtml(email)}" required />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required />
  <button type="submit">Log in</button>
</form>
<p class="muted">Need an account? <a href="/signup?next=${encodeURIComponent(next)}">Create one</a></p>`,
  );
}

function accountPage(account: Account, issuer: string, connected: boolean): string {
  const mcpUrl = `${issuer}/mcp`;
  // Never render the full device token: only the last 4 characters, so a
  // screenshot or shared page cannot leak the credential. The full token
  // lives only in the extension (and in the signed-in account record the
  // server holds for bridge authentication).
  const last4 = account.token.length >= 4 ? account.token.slice(-4) : "••••";
  const masked = `••••••••${last4}`;
  return layout(
    "Account",
    `<h1>Your Muze AI account</h1>
<p class="sub">${escapeHtml(account.email)}</p>

<div class="card">
  <strong>Device token</strong>
  <p class="muted">Shown masked only. It is never displayed in full here and is never pasted to authorize a client.</p>
  <code class="token">${escapeHtml(masked)}</code>
  <p class="muted">Extension status: ${connected ? "connected" : "not connected"}.</p>
  <form method="post" action="/session/rotate">
    <button class="secondary" type="submit">Rotate device token</button>
  </form>
  <p class="muted">Rotating replaces the token immediately: the old token stops working at once. Sign in again in the extension to pick up the new token.</p>
</div>

<div class="card">
  <strong>MCP server URL</strong>
  <code class="token">${escapeHtml(mcpUrl)}</code>
  <ol>
    <li>Open your MCP client's connector settings and add a custom connector.</li>
    <li>Use the URL above as the server URL.</li>
    <li>When the authorize page opens, approve it while signed in here — no token paste is needed.</li>
  </ol>
  <p class="muted">In ChatGPT, add this as a custom connector with developer mode
  enabled, then approve on the authorize page while signed in.</p>
</div>

<form method="post" action="/logout">
  <button class="secondary" type="submit">Log out</button>
</form>

<details class="card">
  <summary><strong>Delete account</strong></summary>
  <p class="muted">Removes your account, browser session, and every access token.
  The extension is signed out and must be paired again.</p>
  <form method="post" action="/account/delete">
    <button class="danger" type="submit" name="confirm" value="delete">Permanently delete my account</button>
  </form>
</details>`,
  );
}

export function errorPage(message: string): string {
  return layout(
    "Error",
    `<h1>Something went wrong</h1><p class="error">${escapeHtml(message)}</p><p><a href="/">Go home</a></p>`,
  );
}
