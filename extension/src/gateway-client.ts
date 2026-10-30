/**
 * Talks to the cloud gateway. Signing in happens on the website via
 * `chrome.identity`: the account's token is handed back to the extension and
 * used to both authenticate the bridge socket and authorize AI clients.
 */

export interface GatewayAccount {
  token: string;
  email: string;
  sessionId: string;
}

/** Browser/OS identity sent at sign-in so the dashboard can name the browser. No token, no URLs. */
export interface BrowserInfo {
  name?: string;
  browser?: string;
  os?: string;
  version?: string;
}

/**
 * Pure user-agent parse for dashboard naming. Unknown agents degrade to
 * empty fields (the gateway auto-names from "Browser N"), never to a guess
 * presented as fact.
 */
export function browserInfoFromUserAgent(userAgent: string): BrowserInfo {
  const ua = userAgent ?? "";
  let browser = "";
  let version = "";
  const browserMatch =
    /Edg\/([\d.]+)/.exec(ua) ??
    /OPR\/([\d.]+)/.exec(ua) ??
    /Brave\/([\d.]+)/.exec(ua) ??
    /Chrome\/([\d.]+)/.exec(ua) ??
    /Firefox\/([\d.]+)/.exec(ua) ??
    /Version\/([\d.]+).*Safari/.exec(ua);
  if (browserMatch) {
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/OPR\//.test(ua)) browser = "Opera";
    else if (/Brave\//.test(ua)) browser = "Brave";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
    else browser = "Safari";
    version = browserMatch[1].split(".").slice(0, 2).join(".");
  }
  let os = "";
  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  const name = [browser, os].filter(Boolean).join(" on ");
  return { ...(name ? { name } : {}), ...(browser ? { browser } : {}), ...(os ? { os } : {}), ...(version ? { version } : {}) };
}

export interface GatewayStatus {
  connected: boolean;
  name?: string;
}

/** A non-2xx gateway response, carrying the status so callers can classify auth failures. */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export function isGatewayAuthError(error: unknown): error is GatewayHttpError {
  return error instanceof GatewayHttpError && (error.status === 401 || error.status === 403);
}

function isLoopbackGateway(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * Strip trailing slashes, default to HTTPS, and reject plaintext endpoints
 * unless they are loopback development gateways.
 */
export function normalizeGatewayUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackGateway(parsed.hostname))) {
    throw new Error("The gateway must use HTTPS (plain HTTP is only allowed for localhost development)");
  }
  return value;
}

export function gatewayMcpUrl(baseUrl: string): string {
  const normalized = normalizeGatewayUrl(baseUrl);
  return normalized ? `${normalized}/mcp` : "";
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed (${response.status})`;
  } catch {
    return `request failed (${response.status})`;
  }
}

/**
 * Open the website sign-in flow in a browser popup. After the user signs up or
 * logs in, the website redirects back with a one-time code that the extension
 * exchanges for the account token.
 */
/**
 * Reuse the browser bound to a stored device token (a reinstall or a
 * re-sign-in that still holds its token): the gateway updates that
 * browser's info/lastSeen instead of creating a second entry. Returns the
 * session id; the token itself is unchanged and is never returned.
 */
export async function reuseBrowserSession(baseUrl: string, deviceToken: string, info: BrowserInfo): Promise<{ sessionId: string }> {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) throw new Error("Gateway URL is required");
  const response = await fetch(`${base}/extension/reuse`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ browserInfo: info }),
  });
  if (!response.ok) throw new GatewayHttpError(response.status, await readError(response));
  const body = (await response.json()) as { sessionId?: string };
  if (!body.sessionId) throw new Error("Browser reuse did not return a session");
  return { sessionId: body.sessionId };
}

export async function signInWithBrowser(baseUrl: string, info?: BrowserInfo): Promise<GatewayAccount> {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) throw new Error("Gateway URL is required");
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID().replace(/-/g, "");
  const authUrl = new URL(`${base}/extension/auth`);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  if (info && Object.keys(info).length > 0) {
    authUrl.searchParams.set("browser_info", JSON.stringify(info));
  }
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  if (!responseUrl) throw new Error("Sign-in was cancelled");
  const fragment = responseUrl.includes("#") ? responseUrl.slice(responseUrl.indexOf("#") + 1) : "";
  const params = new URLSearchParams(fragment);
  if (params.get("state") !== state) throw new Error("Sign-in response did not match this request");
  const code = params.get("code") ?? "";
  if (!code) throw new Error("Sign-in did not return an authorization code");
  const response = await fetch(`${base}/extension/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const account = (await response.json()) as Partial<GatewayAccount>;
  const token = account.token ?? "";
  if (!token) throw new Error("Sign-in did not return a token");
  return { token, email: account.email ?? "", sessionId: account.sessionId ?? "" };
}

export interface RotatedDeviceToken {
  deviceToken: string;
  sessionId: string;
}

/**
 * Rotate the device token.
 *
 * Exact contract for the gateway section to implement (coordinator note):
 *   POST {base}/session/rotate
 *   Authorization: Bearer <current device token>
 *   Response JSON: { "deviceToken": "<new token>", "sessionId": "<new session id>" }
 * The response parser also accepts a `token` field as the new token, for
 * tolerance only — the canonical field is `deviceToken`. The caller saves
 * the new token, reconnects, and audits the rotation; the old token must
 * stop working once rotation succeeds.
 */
export async function rotateDeviceToken(baseUrl: string, deviceToken: string): Promise<RotatedDeviceToken> {
  const base = normalizeGatewayUrl(baseUrl);
  if (!base) throw new Error("Gateway URL is required");
  const response = await fetch(`${base}/session/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  if (!response.ok) throw new GatewayHttpError(response.status, await readError(response));
  const body = (await response.json()) as Partial<RotatedDeviceToken> & { token?: string };
  const next = body.deviceToken ?? body.token ?? "";
  if (!next) throw new Error("Token rotation did not return a new token");
  return { deviceToken: next, sessionId: body.sessionId ?? "" };
}

export async function fetchGatewayStatus(baseUrl: string, deviceToken: string): Promise<GatewayStatus> {
  const base = normalizeGatewayUrl(baseUrl);
  const response = await fetch(`${base}/session/status`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  if (!response.ok) throw new GatewayHttpError(response.status, await readError(response));
  return (await response.json()) as GatewayStatus;
}
