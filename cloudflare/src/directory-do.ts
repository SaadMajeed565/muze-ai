import { hashPassword, json, randomHex, sha256Hex, verifyPassword, verifyPkce, nowMs } from "./util.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXTENSION_CODE_TTL_MS = 60 * 1000;

interface SessionRow {
  sessionId: string;
  name: string;
  createdAt: number;
  /** Present when the session belongs to a website account. */
  userId?: string;
}
interface UserRow {
  userId: string;
  email: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
}
interface WebSessionRow {
  userId: string;
  expiresAt: number;
}
/**
 * One browser attached to an account. The device token is deliberately NOT
 * stored here: tokens live only in the `d:` hash index, so a browsers list
 * can never leak one. `claimed` is false only for the placeholder browser
 * created at website signup, which no extension has adopted yet; the first
 * extension sign-in adopts it instead of creating a second entry.
 */
export interface BrowserSession {
  sessionId: string;
  name: string;
  browser: string;
  os: string;
  version: string;
  createdAt: number;
  lastSeenAt: number;
  claimed: boolean;
}

export interface BrowserInfo {
  name?: string;
  browser?: string;
  os?: string;
  version?: string;
}

interface AccountRow {
  userId: string;
  /** Legacy single-session fields, kept only so old rows can migrate. */
  sessionId?: string;
  deviceToken?: string;
  browsers: BrowserSession[];
  defaultSessionId: string;
  createdAt: number;
}
interface ClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  createdAt: number;
}
interface PairRow {
  sessionId: string;
  expiresAt: number;
  used: boolean;
}
interface AuthRequestRow {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  expiresAt: number;
}
interface AuthCodeRow {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expiresAt: number;
}
interface TokenRow {
  sessionId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  /** Owning account, when known (older rows lack it; see setClientBrowser). */
  userId?: string;
  createdAt: number;
  lastRefreshedAt: number;
  /**
   * Refresh-token rows only: the sha-256 hash of the access token minted
   * alongside this refresh token. Refresh uses it to retire exactly the
   * paired access token, without touching any concurrent access tokens
   * for the same session+client. Rows minted before this field existed
   * lack it; their paired access token then simply expires on its own
   * 1-hour TTL instead of being retired early (see refresh).
   */
  pairedAccessHash?: string;
}
interface ExtensionCodeRow {
  /** Bound browser when adopting an existing one; empty when redeem creates one. */
  sessionId: string;
  userId: string;
  extensionId: string;
  redirectUri: string;
  expiresAt: number;
  browserInfo?: BrowserInfo;
  createNew?: boolean;
}

/** 32-bit numeric pairing code, rendered as two 5-digit groups (00000-00000). */
function randomPairCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const digits = String(buf[0]).padStart(10, "0");
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

function normalizePairCode(input: string): string {
  return input.replace(/\D/g, "");
}

/** Central registry for sessions, device tokens, pairing codes and OAuth state. */
export class DirectoryDO implements DurableObject {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const action = String(body.action ?? "");
    try {
      const result = await this.dispatch(action, body);
      if (result.ok === false) {
        const { status, error, ...rest } = result;
        return json({ ok: false, error, ...rest }, status ?? 200);
      }
      return json({ ok: true, ...result }, result.status ?? 200);
    } catch (error) {
      // Never surface exception text to callers: it can carry storage or
      // runtime internals, and Worker routes forward result.error verbatim
      // (e.g. into OAuth error_description). Detail stays in the server
      // log; callers get a generic code and can be correlated by request.
      console.error(JSON.stringify({ event: "directory.error", action, message: String(error) }));
      return json({ ok: false, error: "internal_error" }, 500);
    }
  }

  private async dispatch(action: string, body: Record<string, any>): Promise<Record<string, any>> {
    switch (action) {
      case "createSession":
        return this.createSession(String(body.name ?? "Browser"));
      case "authDevice":
        return this.authDevice(String(body.deviceToken ?? ""));
      case "verifyDevice": {
        const sessionId = await this.deviceSession(String(body.deviceToken ?? ""));
        return sessionId && sessionId === body.sessionId ? { ok: true } : { ok: false, error: "invalid device token" };
      }
      case "rotateDeviceToken":
        return this.rotateDeviceToken(String(body.sessionId ?? ""));
      case "newPairCode":
        return this.newPairCode(String(body.sessionId ?? ""));
      case "createClient":
        return this.createClient(body);
      case "getClient": {
        const client = await this.storage.get<ClientRow>(`c:${body.clientId}`);
        return client ? { client } : { ok: false, error: "unknown client" };
      }
      case "createAuthRequest":
        return this.createAuthRequest(body);
      case "authorizeWithUser":
        return this.authorizeWithUser(String(body.authReqId ?? ""), String(body.userId ?? ""));
      case "signup":
        return this.signup(String(body.email ?? ""), String(body.password ?? ""));
      case "login":
        return this.login(String(body.email ?? ""), String(body.password ?? ""));
      case "extensionSignup":
        return this.extensionSignup(
          String(body.email ?? ""),
          String(body.password ?? ""),
          (body.browserInfo ?? {}) as BrowserInfo,
        );
      case "extensionLogin":
        return this.extensionLogin(
          String(body.email ?? ""),
          String(body.password ?? ""),
          (body.browserInfo ?? {}) as BrowserInfo,
        );
      case "accountBySession":
        return this.accountBySession(String(body.sessionToken ?? ""));
      case "logout":
        return this.logout(String(body.sessionToken ?? ""));
      case "deleteAccount":
        return this.deleteAccount(String(body.sessionToken ?? ""));
      case "deleteAccountByUser":
        return this.deleteAccountByUser(String(body.userId ?? ""));
      case "createExtensionCode":
        return this.createExtensionCode(
          String(body.userId ?? ""),
          String(body.extensionId ?? ""),
          String(body.redirectUri ?? ""),
          (body.browserInfo ?? {}) as BrowserInfo,
        );
      case "redeemExtensionCode":
        return this.redeemExtensionCode(
          String(body.code ?? ""),
          String(body.extensionId ?? ""),
          String(body.redirectUri ?? ""),
        );
      case "exchangeCode":
        return this.exchangeCode(body);
      case "mintTokens":
        return this.mintTokens(String(body.sessionId ?? ""), String(body.clientId ?? ""), String(body.scope ?? ""));
      case "verifyAccess":
        return this.verifyAccess(String(body.accessToken ?? ""));
      case "refresh":
        return this.refresh(String(body.refreshToken ?? ""), String(body.clientId ?? ""));
      case "revokeToken":
        return this.revokeToken(String(body.token ?? ""), String(body.clientId ?? ""));
      case "revokeSession":
        return this.revokeSession(String(body.sessionId ?? ""));
      case "createBrowserSession":
        return this.createBrowserSession(String(body.userId ?? ""), (body.browserInfo ?? {}) as BrowserInfo);
      case "reuseBrowserSession":
        return this.reuseBrowserSession(String(body.deviceToken ?? ""), (body.browserInfo ?? {}) as BrowserInfo);
      case "browsersForSession":
        return this.browsersForSession(String(body.sessionId ?? ""));
      case "browsersForUser":
        return this.browsersForUser(String(body.userId ?? ""));
      case "clientsForUser":
        return this.clientsForUser(String(body.userId ?? ""));
      case "setDefaultBrowser":
        return this.setDefaultBrowser(String(body.userId ?? ""), String(body.targetSessionId ?? ""));
      case "renameBrowser":
        return this.renameBrowser(String(body.userId ?? ""), String(body.targetSessionId ?? ""), String(body.name ?? ""));
      case "removeBrowser":
        return this.removeBrowser(String(body.userId ?? ""), String(body.targetSessionId ?? ""));
      case "setClientBrowser":
        return this.setClientBrowser(
          String(body.clientId ?? ""),
          String(body.currentSessionId ?? ""),
          String(body.targetSessionId ?? ""),
        );
      case "revokeClient":
        return this.revokeClient(String(body.userId ?? ""), String(body.clientId ?? ""), String(body.sessionId ?? ""));
      case "sessionExists": {
        const row = await this.storage.get<SessionRow>(`s:${body.sessionId}`);
        return row ? { name: row.name } : { ok: false, error: "unknown session" };
      }
      case "stats": {
        const sessions = await this.storage.list({ prefix: "s:" });
        return { sessions: sessions.size };
      }
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  }

  private async createSession(name: string): Promise<Record<string, any>> {
    const sessionId = crypto.randomUUID();
    const deviceToken = randomHex(32);
    const deviceTokenHash = await sha256Hex(deviceToken);
    const row: SessionRow = { sessionId, name, createdAt: nowMs() };
    await this.storage.put(`s:${sessionId}`, row);
    await this.storage.put(`d:${deviceTokenHash}`, sessionId);
    const pairing = await this.newPairCode(sessionId);
    return { sessionId, deviceToken, pairCode: pairing.pairCode, pairExpiresAt: pairing.pairExpiresAt };
  }

  private async deviceSession(deviceToken: string): Promise<string | null> {
    if (!deviceToken) return null;
    const hash = await sha256Hex(deviceToken);
    const sessionId = await this.storage.get<string>(`d:${hash}`);
    return sessionId ?? null;
  }

  private async authDevice(deviceToken: string): Promise<Record<string, any>> {
    const sessionId = await this.deviceSession(deviceToken);
    if (!sessionId) return { ok: false, error: "invalid device token", status: 401 };
    const session = await this.storage.get<SessionRow>(`s:${sessionId}`);
    if (session?.userId) {
      // A placeholder browser that actually connects stops being a
      // placeholder: a later extension sign-in must create a new browser
      // instead of adopting (and re-tokening) this one.
      const account = await this.loadAccount(session.userId);
      const browser = account?.browsers.find((entry) => entry.sessionId === sessionId);
      if (browser) {
        browser.claimed = true;
        browser.lastSeenAt = nowMs();
        await this.storage.put(`acct:${session.userId}`, account);
      }
    }
    return { sessionId, name: session?.name ?? "Browser" };
  }

  /**
   * Rotate a session's device token, keeping the same sessionId. The caller
   * (Worker) must already have authenticated the old token or the website
   * session that owns this session; this method only verifies the session
   * exists. The old token stops working immediately: every `d:` index entry
   * for this session is deleted before the new one is written. Browser
   * records carry no token, so the account row needs no token update;
   * rotation also refreshes the browser's lastSeenAt.
   */
  private async rotateDeviceToken(sessionId: string): Promise<Record<string, any>> {
    const session = await this.storage.get<SessionRow>(`s:${sessionId}`);
    if (!sessionId || !session) return { ok: false, error: "unknown session", status: 404 };
    const deviceToken = randomHex(32);
    const deviceTokenHash = await sha256Hex(deviceToken);
    for (const [key, value] of await this.storage.list<string>({ prefix: "d:" })) {
      if (value === sessionId) await this.storage.delete(key);
    }
    await this.storage.put(`d:${deviceTokenHash}`, sessionId);
    if (session.userId) {
      const account = await this.loadAccount(session.userId);
      if (account) {
        const browser = account.browsers.find((entry) => entry.sessionId === sessionId);
        if (browser) {
          browser.lastSeenAt = nowMs();
          await this.storage.put(`acct:${session.userId}`, account);
        }
      }
    }
    return { deviceToken, sessionId };
  }

  // --- Multi-browser account model -----------------------------------------

  private static readonly MAX_BROWSERS = 10;

  private cleanBrowserInfo(info: BrowserInfo | undefined): BrowserInfo {
    const text = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, 80) : "");
    return {
      ...(text(info?.name) ? { name: text(info?.name) } : {}),
      ...(text(info?.browser) ? { browser: text(info?.browser) } : {}),
      ...(text(info?.os) ? { os: text(info?.os) } : {}),
      ...(text(info?.version) ? { version: text(info?.version) } : {}),
    };
  }

  private autoBrowserName(account: AccountRow, info: BrowserInfo): string {
    const label = [info.browser, info.os].filter(Boolean).join(" on ");
    if (label) {
      const taken = new Set(account.browsers.map((entry) => entry.name));
      if (!taken.has(label)) return label;
    }
    return `Browser ${account.browsers.length + 1}`;
  }

  private async createBrowserRecord(
    account: AccountRow,
    info: BrowserInfo,
    claimed: boolean,
  ): Promise<{ sessionId: string; deviceToken: string; browser: BrowserSession }> {
    const sessionId = crypto.randomUUID();
    const deviceToken = randomHex(32);
    const now = nowMs();
    const browser: BrowserSession = {
      sessionId,
      name: info.name ?? this.autoBrowserName(account, info),
      browser: info.browser ?? "",
      os: info.os ?? "",
      version: info.version ?? "",
      createdAt: now,
      lastSeenAt: now,
      claimed,
    };
    await this.storage.put(`s:${sessionId}`, {
      sessionId,
      name: browser.name,
      userId: account.userId,
      createdAt: now,
    } satisfies SessionRow);
    await this.storage.put(`d:${await sha256Hex(deviceToken)}`, sessionId);
    account.browsers.push(browser);
    if (!account.defaultSessionId) account.defaultSessionId = sessionId;
    await this.storage.put(`acct:${account.userId}`, account);
    return { sessionId, deviceToken, browser };
  }

  /**
   * Load an account, migrating a legacy single-session row on first read:
   * the old session becomes "Browser 1" with the same sessionId, and its
   * token (in the `d:` index, untouched) keeps working, so the currently
   * connected extension stays connected with no re-sign-in.
   */
  private async loadAccount(userId: string): Promise<AccountRow | null> {
    if (!userId) return null;
    const row = await this.storage.get<AccountRow>(`acct:${userId}`);
    if (!row) return null;
    if (Array.isArray(row.browsers) && row.browsers.length > 0) {
      if (!row.defaultSessionId || !row.browsers.some((entry) => entry.sessionId === row.defaultSessionId)) {
        row.defaultSessionId = row.browsers[0].sessionId;
        await this.storage.put(`acct:${userId}`, row);
      }
      return row;
    }
    const legacySessionId = row.sessionId ?? "";
    const legacySession = legacySessionId ? await this.storage.get<SessionRow>(`s:${legacySessionId}`) : undefined;
    if (!legacySessionId || !legacySession) {
      // No usable legacy session: start with an empty browser list rather
      // than inventing a session no extension owns.
      const migrated: AccountRow = { userId, browsers: [], defaultSessionId: "", createdAt: row.createdAt };
      await this.storage.put(`acct:${userId}`, migrated);
      return migrated;
    }
    const migrated: AccountRow = {
      userId,
      browsers: [
        {
          sessionId: legacySessionId,
          name: "Browser 1",
          browser: "",
          os: "",
          version: "",
          createdAt: row.createdAt,
          lastSeenAt: row.createdAt,
          claimed: true,
        },
      ],
      defaultSessionId: legacySessionId,
      createdAt: row.createdAt,
    };
    await this.storage.put(`acct:${userId}`, migrated);
    return migrated;
  }

  private async accountForSession(sessionId: string): Promise<AccountRow | null> {
    if (!sessionId) return null;
    const session = await this.storage.get<SessionRow>(`s:${sessionId}`);
    if (!session?.userId) return null;
    return this.loadAccount(session.userId);
  }

  /** Public browser fields only — never a device token. */
  private publicBrowsers(account: AccountRow): Array<BrowserSession & { isDefault: boolean }> {
    return account.browsers.map((entry) => ({ ...entry, isDefault: entry.sessionId === account.defaultSessionId }));
  }

  private async createBrowserSession(userId: string, info: BrowserInfo): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    if (account.browsers.length >= DirectoryDO.MAX_BROWSERS) {
      return { ok: false, error: "browser limit reached (10 browsers per account)", status: 400 };
    }
    const created = await this.createBrowserRecord(account, this.cleanBrowserInfo(info), true);
    return { sessionId: created.sessionId, deviceToken: created.deviceToken };
  }

  /**
   * Reuse the browser bound to a stored device token (a reinstall or a
   * re-sign-in that still holds its token), updating its info/lastSeen
   * instead of creating a second entry for the same browser.
   */
  private async reuseBrowserSession(deviceToken: string, info: BrowserInfo): Promise<Record<string, any>> {
    const sessionId = await this.deviceSession(deviceToken);
    if (!sessionId) return { ok: false, error: "invalid device token", status: 401 };
    const account = await this.accountForSession(sessionId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    const browser = account.browsers.find((entry) => entry.sessionId === sessionId);
    if (!browser) return { ok: false, error: "unknown browser", status: 404 };
    const cleaned = this.cleanBrowserInfo(info);
    if (cleaned.name) browser.name = cleaned.name;
    if (cleaned.browser) browser.browser = cleaned.browser;
    if (cleaned.os) browser.os = cleaned.os;
    if (cleaned.version) browser.version = cleaned.version;
    browser.lastSeenAt = nowMs();
    browser.claimed = true;
    await this.storage.put(`acct:${account.userId}`, account);
    return { sessionId };
  }

  private async browsersForSession(sessionId: string): Promise<Record<string, any>> {
    const account = await this.accountForSession(sessionId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    return { userId: account.userId, browsers: this.publicBrowsers(account), defaultSessionId: account.defaultSessionId, currentSessionId: sessionId };
  }

  private async browsersForUser(userId: string): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    return { userId: account.userId, browsers: this.publicBrowsers(account), defaultSessionId: account.defaultSessionId };
  }

  /** Authorized OAuth clients, deduped by client + target browser. No tokens. */
  private async clientsForUser(userId: string): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    const known = new Set(account.browsers.map((entry) => entry.sessionId));
    const byKey = new Map<string, Record<string, unknown>>();
    for (const prefix of ["at:", "rt:"] as const) {
      for (const [key, row] of await this.storage.list<TokenRow>({ prefix })) {
        void key;
        if (!known.has(row.sessionId)) continue;
        if (row.userId && row.userId !== userId) continue;
        const client = row.clientId ? await this.storage.get<ClientRow>(`c:${row.clientId}`) : undefined;
        const mapKey = `${row.clientId}:${row.sessionId}`;
        const existing = byKey.get(mapKey);
        if (!existing || (row.createdAt ?? 0) > Number(existing.createdAt ?? 0)) {
          byKey.set(mapKey, {
            clientId: row.clientId,
            clientName: client?.clientName ?? row.clientId,
            scope: row.scope,
            sessionId: row.sessionId,
            expiresAt: row.expiresAt,
            createdAt: row.createdAt ?? null,
            lastRefreshedAt: row.lastRefreshedAt ?? null,
          });
        }
      }
    }
    return { clients: [...byKey.values()] };
  }

  private async setDefaultBrowser(userId: string, targetSessionId: string): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    if (!account.browsers.some((entry) => entry.sessionId === targetSessionId)) {
      return { ok: false, error: "unknown browser", status: 404 };
    }
    account.defaultSessionId = targetSessionId;
    await this.storage.put(`acct:${userId}`, account);
    return { defaultSessionId: targetSessionId };
  }

  private async renameBrowser(userId: string, targetSessionId: string, name: string): Promise<Record<string, any>> {
    const cleaned = name.trim().slice(0, 80);
    if (!cleaned) return { ok: false, error: "browser name is required", status: 400 };
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    const browser = account.browsers.find((entry) => entry.sessionId === targetSessionId);
    if (!browser) return { ok: false, error: "unknown browser", status: 404 };
    browser.name = cleaned;
    await this.storage.put(`acct:${userId}`, account);
    return { sessionId: targetSessionId, name: cleaned };
  }

  /**
   * Remove one browser and revoke only that browser: its session row, its
   * device-token index entries, its OAuth tokens, and its pair codes are
   * deleted; other browsers and their tokens are untouched. The last
   * browser cannot be removed — deleting the account is the path for that.
   * The caller (Worker) closes the browser's bridge and live MCP sessions.
   */
  private async removeBrowser(userId: string, targetSessionId: string): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    if (!account.browsers.some((entry) => entry.sessionId === targetSessionId)) {
      return { ok: false, error: "unknown browser", status: 404 };
    }
    if (account.browsers.length <= 1) {
      return { ok: false, error: "cannot remove the last browser", status: 400 };
    }
    await this.revokeSession(targetSessionId);
    account.browsers = account.browsers.filter((entry) => entry.sessionId !== targetSessionId);
    if (account.defaultSessionId === targetSessionId) account.defaultSessionId = account.browsers[0].sessionId;
    await this.storage.put(`acct:${userId}`, account);
    return { removed: targetSessionId, defaultSessionId: account.defaultSessionId };
  }

  /**
   * Move an OAuth client's future MCP routing to another browser of the
   * same account. The rebind is account-wide, not per-browser: every
   * access/refresh token for that client on ANY browser of this account
   * is rebound (predicate below: the token's session is the current
   * session OR the token row carries this account's userId). That is the
   * intended behaviour — a client is authorized per account, and leaving
   * its tokens on other browsers behind would split its routing — but an
   * earlier comment wrongly claimed other browsers' tokens were left
   * alone. Live transports on the old browser are NOT moved — the client
   * re-initializes on the new browser (see browsers.select).
   */
  private async setClientBrowser(clientId: string, currentSessionId: string, targetSessionId: string): Promise<Record<string, any>> {
    if (!clientId) return { ok: false, error: "client is required", status: 400 };
    const account = await this.accountForSession(currentSessionId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    const target = account.browsers.find((entry) => entry.sessionId === targetSessionId);
    if (!target) return { ok: false, error: "unknown browser", status: 404 };
    let moved = 0;
    for (const prefix of ["at:", "rt:"] as const) {
      for (const [key, row] of await this.storage.list<TokenRow>({ prefix })) {
        const sameAccount = row.sessionId === currentSessionId || (row.userId !== undefined && row.userId === account.userId);
        if (row.clientId === clientId && sameAccount) {
          await this.storage.put(key, { ...row, sessionId: targetSessionId });
          moved++;
        }
      }
    }
    if (moved === 0) return { ok: false, error: "no tokens for this client on this browser", status: 404 };
    return { sessionId: targetSessionId, name: target.name };
  }

  /** Revoke one client's tokens, optionally scoped to a single browser. */
  private async revokeClient(userId: string, clientId: string, sessionId: string): Promise<Record<string, any>> {
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    if (sessionId && !account.browsers.some((entry) => entry.sessionId === sessionId)) {
      return { ok: false, error: "unknown browser", status: 404 };
    }
    let revoked = 0;
    for (const prefix of ["at:", "rt:"] as const) {
      for (const [key, row] of await this.storage.list<TokenRow>({ prefix })) {
        if (row.clientId !== clientId) continue;
        if (sessionId && row.sessionId !== sessionId) continue;
        if (!sessionId && !account.browsers.some((entry) => entry.sessionId === row.sessionId)) continue;
        await this.storage.delete(key);
        revoked++;
      }
    }
    return { revoked };
  }

  private async newPairCode(sessionId: string): Promise<Record<string, any>> {
    if (!(await this.storage.get(`s:${sessionId}`))) {
      return { ok: false, error: "unknown session" };
    }
    const code = randomPairCode();
    const hash = await sha256Hex(normalizePairCode(code));
    const expiresAt = nowMs() + PAIR_TTL_MS;
    await this.storage.put(`p:${hash}`, { sessionId, expiresAt, used: false } satisfies PairRow);
    return { pairCode: code, pairExpiresAt: expiresAt };
  }

  private async createClient(body: Record<string, any>): Promise<Record<string, any>> {
    const clientId = `oc_${randomHex(8)}`;
    const client: ClientRow = {
      clientId,
      clientName: String(body.clientName ?? "MCP Client"),
      redirectUris: Array.isArray(body.redirectUris) ? body.redirectUris.map(String) : [],
      tokenEndpointAuthMethod: String(body.tokenEndpointAuthMethod ?? "none"),
      createdAt: nowMs(),
    };
    await this.storage.put(`c:${clientId}`, client);
    return { clientId, client };
  }

  private async createAuthRequest(body: Record<string, any>): Promise<Record<string, any>> {
    const id = randomHex(16);
    const method = String(body.codeChallengeMethod ?? "S256");
    const challenge = String(body.codeChallenge ?? "");
    if (method !== "S256" || !challenge) return { ok: false, error: "PKCE with S256 is required" };
    const row: AuthRequestRow = {
      clientId: String(body.clientId ?? ""),
      redirectUri: String(body.redirectUri ?? ""),
      codeChallenge: challenge,
      codeChallengeMethod: method,
      scope: String(body.scope ?? "read:tools call:tools"),
      state: String(body.state ?? ""),
      expiresAt: nowMs() + AUTH_REQUEST_TTL_MS,
    };
    await this.storage.put(`ar:${id}`, row);
    return { authReqId: id };
  }

  /**
   * Authorize an MCP client for the browser session owned by the signed-in
   * website user. This is the only authorization path used by the authorize
   * form in 0.3.0: the form never asks for a device token. The session is
   * taken from the user's account row, never from form input, so a user can
   * only authorize their own session. Returns the client's redirect URI
   * even on failure so the caller can report the error back to the client.
   *
   * Pair codes are NOT consumed here. Pair-code minting (newPairCode) is
   * kept for session-pairing display only; the old pair-code authorization
   * path was removed in 0.3.0 because no Worker route ever called it.
   */
  private async authorizeWithUser(authReqId: string, userId: string): Promise<Record<string, any>> {
    const request = await this.storage.get<AuthRequestRow>(`ar:${authReqId}`);
    if (!request || request.expiresAt < nowMs()) return { ok: false, error: "authorization request expired" };
    const redirectUri = request.redirectUri;
    const state = request.state;
    if (!userId) return { ok: false, error: "not signed in", redirectUri, state };
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "no browser session for this account", redirectUri, state };
    const defaultSessionId = account.defaultSessionId;
    const session = defaultSessionId ? await this.storage.get<SessionRow>(`s:${defaultSessionId}`) : undefined;
    if (!session || session.userId !== userId) {
      return { ok: false, error: "no browser session for this account", redirectUri, state };
    }
    const code = randomHex(24);
    const codeHash = await sha256Hex(code);
    const row: AuthCodeRow = {
      sessionId: defaultSessionId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      scope: request.scope,
      expiresAt: nowMs() + AUTH_CODE_TTL_MS,
    };
    await this.storage.put(`ac:${codeHash}`, row);
    // Consume the authorization request: unlike exchangeCode/refresh/
    // redeemExtensionCode, this path previously left the ar: row in place,
    // so the same request could be replayed for a fresh code until its
    // 10-minute TTL expired. Failed attempts above return early and do
    // NOT consume the row (no code was issued, so there is nothing to
    // replay); only a successful authorization burns it.
    await this.storage.delete(`ar:${authReqId}`);
    return { code, redirectUri, state, sessionId: defaultSessionId };
  }

  /**
   * Create (or reuse) the long-lived browser session + device token that a
   * website account owns. The token is held by the extension for bridge
   * authentication; it is never rendered in full on the website and is
   * never entered on the authorize form (0.3.0: authorization uses the
   * signed-in website user instead).
   */
  private async ensureAccount(userId: string, email: string): Promise<AccountRow> {
    const existing = await this.loadAccount(userId);
    if (existing) return existing;
    const now = nowMs();
    const account: AccountRow = { userId, browsers: [], defaultSessionId: "", createdAt: now };
    await this.storage.put(`acct:${userId}`, account);
    // The signup browser is a placeholder: no extension owns it yet, so the
    // first extension sign-in adopts it (claimed flips true at redeem)
    // instead of creating a second entry. Its token is returned to the
    // caller for compatibility but is never rendered on the website.
    const created = await this.createBrowserRecord(account, { name: email }, false);
    return { ...account, browsers: [created.browser], defaultSessionId: created.sessionId };
  }

  private async newWebSession(userId: string): Promise<string> {
    const token = randomHex(32);
    await this.storage.put(`ws:${await sha256Hex(token)}`, {
      userId,
      expiresAt: nowMs() + WEB_SESSION_TTL_MS,
    } satisfies WebSessionRow);
    return token;
  }

  /**
   * Create a user row, shared by website signup and extension signup.
   * It creates no browser: the caller decides what browser (if any)
   * the new account gets — a placeholder for the website flow, a real
   * claimed browser for the extension flow.
   */
  private async createUser(
    email: string,
    password: string,
  ): Promise<{ userId: string; email: string } | { ok: false; error: string }> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { ok: false, error: "Enter a valid email address." };
    if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
    const existing = await this.storage.get<string>(`email:${normalized}`);
    if (existing) return { ok: false, error: "An account with that email already exists." };
    const userId = `u_${randomHex(8)}`;
    const { salt, hash } = await hashPassword(password);
    const user: UserRow = { userId, email: normalized, salt, passwordHash: hash, createdAt: nowMs() };
    await this.storage.put(`email:${normalized}`, userId);
    await this.storage.put(`u:${userId}`, user);
    return { userId, email: normalized };
  }

  private async signup(email: string, password: string): Promise<Record<string, any>> {
    const created = await this.createUser(email, password);
    if ("ok" in created) return created;
    const account = await this.ensureAccount(created.userId, created.email);
    const webToken = await this.newWebSession(created.userId);
    return { userId: created.userId, email: created.email, sessionId: account.defaultSessionId, webToken };
  }

  /**
   * Extension sign-up (POST /extension/auth/signup): creates the account
   * and immediately creates a real, claimed browser for this extension
   * with its own device token — no unclaimed placeholder, because this
   * extension already owns the browser. The token is returned to the
   * extension only; it is never rendered on any website page.
   */
  private async extensionSignup(email: string, password: string, info: BrowserInfo): Promise<Record<string, any>> {
    const created = await this.createUser(email, password);
    if ("ok" in created) return created;
    const account: AccountRow = { userId: created.userId, browsers: [], defaultSessionId: "", createdAt: nowMs() };
    await this.storage.put(`acct:${created.userId}`, account);
    if (account.browsers.length >= DirectoryDO.MAX_BROWSERS) {
      return { ok: false, error: "browser limit reached (10 browsers per account)" };
    }
    const browser = await this.createBrowserRecord(account, this.cleanBrowserInfo(info), true);
    return { token: browser.deviceToken, email: created.email, sessionId: browser.sessionId };
  }

  /**
   * Extension sign-in (POST /extension/auth/login): verifies the user
   * and gives this extension a browser. If the account still has the
   * unclaimed placeholder from a website signup, this extension adopts
   * it (rotating its token, exactly as the website sign-in redeem
   * does) instead of leaving a phantom browser row; otherwise it
   * creates a new browser, cap-checked. The token is returned to the
   * extension only.
   */
  private async extensionLogin(email: string, password: string, info: BrowserInfo): Promise<Record<string, any>> {
    const normalized = email.trim().toLowerCase();
    const userId = await this.storage.get<string>(`email:${normalized}`);
    if (!userId) return { ok: false, error: "Invalid email or password." };
    const user = await this.storage.get<UserRow>(`u:${userId}`);
    if (!user || !(await verifyPassword(password, user.salt, user.passwordHash))) {
      return { ok: false, error: "Invalid email or password." };
    }
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "unknown account", status: 404 };
    const cleaned = this.cleanBrowserInfo(info);
    const unclaimed = account.browsers.find((entry) => !entry.claimed);
    if (unclaimed) {
      const rotated = await this.rotateDeviceToken(unclaimed.sessionId);
      if (rotated.ok === false) return rotated;
      const fresh = await this.loadAccount(userId);
      if (!fresh) return { ok: false, error: "unknown account", status: 404 };
      const browser = fresh.browsers.find((entry) => entry.sessionId === unclaimed.sessionId);
      if (!browser) return { ok: false, error: "unknown browser", status: 404 };
      if (cleaned.name) browser.name = cleaned.name;
      if (cleaned.browser) browser.browser = cleaned.browser;
      if (cleaned.os) browser.os = cleaned.os;
      if (cleaned.version) browser.version = cleaned.version;
      browser.claimed = true;
      browser.lastSeenAt = nowMs();
      await this.storage.put(`acct:${userId}`, fresh);
      return { token: rotated.deviceToken, email: user.email, sessionId: browser.sessionId };
    }
    const created = await this.createBrowserSession(userId, cleaned);
    if ("ok" in created && created.ok === false) return created;
    return { token: created.deviceToken, email: user.email, sessionId: created.sessionId };
  }

  private async login(email: string, password: string): Promise<Record<string, any>> {
    const normalized = email.trim().toLowerCase();
    const userId = await this.storage.get<string>(`email:${normalized}`);
    if (!userId) return { ok: false, error: "Invalid email or password." };
    const user = await this.storage.get<UserRow>(`u:${userId}`);
    if (!user || !(await verifyPassword(password, user.salt, user.passwordHash))) {
      return { ok: false, error: "Invalid email or password." };
    }
    const account = await this.ensureAccount(userId, user.email);
    const webToken = await this.newWebSession(userId);
    return { userId, email: user.email, sessionId: account.defaultSessionId, webToken };
  }

  private async accountBySession(sessionToken: string): Promise<Record<string, any>> {
    if (!sessionToken) return { ok: false, error: "not signed in" };
    const row = await this.storage.get<WebSessionRow>(`ws:${await sha256Hex(sessionToken)}`);
    if (!row || row.expiresAt < nowMs()) return { ok: false, error: "not signed in" };
    const user = await this.storage.get<UserRow>(`u:${row.userId}`);
    const account = await this.loadAccount(row.userId);
    if (!user || !account) return { ok: false, error: "not signed in" };
    // Website callers use the default browser; the device token is never
    // returned here (extension sign-in is the only route that issues one).
    return { userId: row.userId, email: user.email, sessionId: account.defaultSessionId };
  }

  private async logout(sessionToken: string): Promise<Record<string, any>> {
    if (sessionToken) await this.storage.delete(`ws:${await sha256Hex(sessionToken)}`);
    return { ok: true };
  }

  /** Permanently remove an account, every browser session, and every token it owns. */
  private async deleteAccount(sessionToken: string): Promise<Record<string, any>> {
    if (!sessionToken) return { ok: false, error: "not signed in", status: 401 };
    const row = await this.storage.get<WebSessionRow>(`ws:${await sha256Hex(sessionToken)}`);
    if (!row) return { ok: false, error: "not signed in", status: 401 };
    return this.deleteAccountByUser(row.userId);
  }

  /** Same deletion, authenticated by user id (extension device-token route). */
  private async deleteAccountByUser(userId: string): Promise<Record<string, any>> {
    if (!userId) return { ok: false, error: "unknown account", status: 404 };
    const user = await this.storage.get<UserRow>(`u:${userId}`);
    const account = await this.loadAccount(userId);
    if (account) {
      for (const browser of account.browsers) await this.revokeSession(browser.sessionId);
    }
    if (user) await this.storage.delete(`email:${user.email}`);
    await this.storage.delete(`acct:${userId}`);
    await this.storage.delete(`u:${userId}`);
    for (const [key, value] of await this.storage.list<WebSessionRow>({ prefix: "ws:" })) {
      if (value.userId === userId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<ExtensionCodeRow>({ prefix: "ec:" })) {
      if (value.userId === userId) await this.storage.delete(key);
    }
    // Orphan cleanup, scoped so other accounts are untouched. revokeSession
    // (above) already removed this account's sessions, device-token index
    // entries, OAuth tokens, pair codes and session-bound extension codes.
    // Remaining, previously orphaned rows:
    // - ac: authorization codes: attributable via their sessionId, which
    //   belongs to one of this account's (now deleted) browsers. Safe to
    //   delete: minting a token from a code requires a live s: row
    //   (mintTokens returns "unknown session" otherwise), so these codes
    //   could never yield tokens again anyway.
    // - c: client rows: shared — one client can serve many accounts — so
    //   they are deleted ONLY when no row anywhere still references the
    //   client (no at:/rt: token, ac: code, or ar: authorization request).
    // - ar: authorization requests: deliberately NOT bulk-deleted. They
    //   carry no userId or sessionId, so they cannot be attributed to
    //   this account, and this DirectoryDO is a single shared instance
    //   for all accounts; deleting them all would cancel other accounts'
    //   in-flight authorizations. The orphans are inert: authorizeWithUser
    //   requires a live account+session, and they self-expire in 10 min.
    if (account) {
      const sessionIds = new Set(account.browsers.map((entry) => entry.sessionId));
      for (const [key, value] of await this.storage.list<AuthCodeRow>({ prefix: "ac:" })) {
        if (sessionIds.has(value.sessionId)) await this.storage.delete(key);
      }
    }
    const referencedClients = new Set<string>();
    for (const prefix of ["at:", "rt:"] as const) {
      for (const [, row] of await this.storage.list<TokenRow>({ prefix })) {
        if (row.clientId) referencedClients.add(row.clientId);
      }
    }
    for (const [, row] of await this.storage.list<AuthCodeRow>({ prefix: "ac:" })) {
      if (row.clientId) referencedClients.add(row.clientId);
    }
    for (const [, row] of await this.storage.list<AuthRequestRow>({ prefix: "ar:" })) {
      if (row.clientId) referencedClients.add(row.clientId);
    }
    for (const [key, row] of await this.storage.list<ClientRow>({ prefix: "c:" })) {
      if (!referencedClients.has(row.clientId)) await this.storage.delete(key);
    }
    return { ok: true };
  }

  /**
   * Mint a single-use, extension-bound code for the browser sign-in handoff.
   * The device token itself never travels through a redirect URL.
   *
   * Multi-browser rule: if the account still has its unclaimed signup
   * placeholder browser, the code binds to it (the first extension adopts
   * it); otherwise redeem creates a fresh browser. The cap is checked here
   * so a sign-in that would exceed 10 browsers fails before the redirect.
   */
  private async createExtensionCode(
    userId: string,
    extensionId: string,
    redirectUri: string,
    browserInfo: BrowserInfo,
  ): Promise<Record<string, any>> {
    if (!userId || !extensionId || !redirectUri) {
      return { ok: false, error: "invalid extension handoff" };
    }
    const account = await this.loadAccount(userId);
    if (!account) return { ok: false, error: "invalid extension handoff" };
    const unclaimed = account.browsers.find((entry) => !entry.claimed);
    const createNew = !unclaimed;
    if (createNew && account.browsers.length >= DirectoryDO.MAX_BROWSERS) {
      return { ok: false, error: "browser limit reached (10 browsers per account)" };
    }
    const code = randomHex(32);
    await this.storage.put(`ec:${await sha256Hex(code)}`, {
      sessionId: unclaimed?.sessionId ?? "",
      userId,
      extensionId,
      redirectUri,
      expiresAt: nowMs() + EXTENSION_CODE_TTL_MS,
      browserInfo: this.cleanBrowserInfo(browserInfo),
      createNew,
    } satisfies ExtensionCodeRow);
    return { code, expiresAt: nowMs() + EXTENSION_CODE_TTL_MS };
  }

  /** Redeem a browser sign-in code exactly once. */
  private async redeemExtensionCode(
    code: string,
    extensionId: string,
    redirectUri: string,
  ): Promise<Record<string, any>> {
    if (!code || !extensionId || !redirectUri) return { ok: false, error: "invalid or expired code" };
    const key = `ec:${await sha256Hex(code)}`;
    const row = await this.storage.transaction<ExtensionCodeRow | null>(async (txn) => {
      const existing = await txn.get<ExtensionCodeRow>(key);
      if (!existing || existing.expiresAt < nowMs()) {
        if (existing) await txn.delete(key);
        return null;
      }
      if (existing.extensionId !== extensionId || existing.redirectUri !== redirectUri) return null;
      await txn.delete(key);
      return existing;
    });
    if (!row) return { ok: false, error: "invalid or expired code" };
    const user = await this.storage.get<UserRow>(`u:${row.userId}`);
    const account = await this.loadAccount(row.userId);
    if (!user || !account) return { ok: false, error: "invalid or expired code" };
    if (row.createNew) {
      // The browser did not exist at auth time: create it now. A second
      // sign-in racing the cap fails here rather than minting an 11th.
      if (account.browsers.length >= DirectoryDO.MAX_BROWSERS) {
        return { ok: false, error: "browser limit reached (10 browsers per account)" };
      }
      const created = await this.createBrowserRecord(account, row.browserInfo ?? {}, true);
      return { token: created.deviceToken, email: user.email, sessionId: created.sessionId };
    }
    const browser = account.browsers.find((entry) => entry.sessionId === row.sessionId);
    if (!browser) return { ok: false, error: "invalid or expired code" };
    // Adopt: apply the signing-in browser's info and mark it claimed. The
    // placeholder's signup token is stored only as a hash in the `d:`
    // index, so it cannot be handed back; rotate to a fresh token here
    // instead. The placeholder was never connected (a connected one is
    // already claimed and would not reach this path), so nothing breaks.
    const rotated = await this.rotateDeviceToken(browser.sessionId);
    if (rotated.ok === false) return { ok: false, error: "invalid or expired code" };
    const info = row.browserInfo ?? {};
    if (info.name) browser.name = info.name;
    if (info.browser) browser.browser = info.browser;
    if (info.os) browser.os = info.os;
    if (info.version) browser.version = info.version;
    browser.claimed = true;
    browser.lastSeenAt = nowMs();
    await this.storage.put(`acct:${row.userId}`, account);
    return { token: rotated.deviceToken, email: user.email, sessionId: browser.sessionId };
  }

  private async exchangeCode(body: Record<string, any>): Promise<Record<string, any>> {
    const code = String(body.code ?? "");
    const codeHash = await sha256Hex(code);
    const key = `ac:${codeHash}`;
    // Consume before validating so two concurrent redemptions cannot both win.
    // An invalid client/verifier burns the code, which is safe and matches the
    // one-time semantics of an authorization code.
    const row = await this.storage.transaction<AuthCodeRow | null>(async (txn) => {
      const existing = await txn.get<AuthCodeRow>(key);
      if (!existing || existing.expiresAt < nowMs()) {
        if (existing) await txn.delete(key);
        return null;
      }
      await txn.delete(key);
      return existing;
    });
    if (!row) return { ok: false, error: "invalid_grant" };
    if (row.clientId !== body.clientId) return { ok: false, error: "invalid_grant" };
    if (row.redirectUri !== body.redirectUri) return { ok: false, error: "invalid_grant" };
    const ok = await verifyPkce(String(body.codeVerifier ?? ""), row.codeChallenge, row.codeChallengeMethod);
    if (!ok) return { ok: false, error: "invalid_grant" };
    return { sessionId: row.sessionId, clientId: row.clientId, scope: row.scope };
  }

  private async mintTokens(sessionId: string, clientId: string, scope: string, previous?: TokenRow): Promise<Record<string, any>> {
    const session = await this.storage.get<SessionRow>(`s:${sessionId}`);
    if (!session) return { ok: false, error: "unknown session" };
    const accessToken = randomHex(32);
    const refreshToken = randomHex(32);
    const accessHash = await sha256Hex(accessToken);
    const refreshHash = await sha256Hex(refreshToken);
    const now = nowMs();
    const base: Omit<TokenRow, "expiresAt"> = {
      sessionId,
      clientId,
      scope,
      ...(session.userId ? { userId: session.userId } : {}),
      // A refresh keeps the original authorization date and stamps the
      // refresh time, so the dashboard can show both honestly.
      createdAt: previous?.createdAt ?? now,
      lastRefreshedAt: now,
    };
    await this.storage.put(`at:${accessHash}`, { ...base, expiresAt: now + ACCESS_TTL_MS } satisfies TokenRow);
    await this.storage.put(
      `rt:${refreshHash}`,
      { ...base, expiresAt: now + REFRESH_TTL_MS, pairedAccessHash: accessHash } satisfies TokenRow,
    );
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope };
  }

  private async verifyAccess(accessToken: string): Promise<Record<string, any>> {
    if (!accessToken) return { ok: false, error: "missing token", status: 401 };
    const hash = await sha256Hex(accessToken);
    const row = await this.storage.get<TokenRow>(`at:${hash}`);
    if (!row || row.expiresAt < nowMs()) return { ok: false, error: "invalid_token", status: 401 };
    const client = row.clientId ? await this.storage.get<ClientRow>(`c:${row.clientId}`) : undefined;
    return {
      sessionId: row.sessionId,
      clientId: row.clientId,
      clientName: client?.clientName ?? row.clientId,
      scope: row.scope,
    };
  }

  private async refresh(refreshToken: string, clientId: string): Promise<Record<string, any>> {
    if (!refreshToken) return { ok: false, error: "invalid_grant" };
    const hash = await sha256Hex(refreshToken);
    const key = `rt:${hash}`;
    const row = await this.storage.transaction<TokenRow | null>(async (txn) => {
      const existing = await txn.get<TokenRow>(key);
      if (!existing || existing.expiresAt < nowMs()) {
        if (existing) await txn.delete(key);
        return null;
      }
      await txn.delete(key);
      return existing;
    });
    if (!row) return { ok: false, error: "invalid_grant" };
    if (!clientId || row.clientId !== clientId) return { ok: false, error: "invalid_grant" };
    // Retire the previous access token too: previously only the old rt:
    // row was deleted (transactionally, above) and mintTokens issued a
    // fresh pair, so the old access token stayed valid for up to its
    // 1-hour TTL. The paired hash retires exactly that token; deleting
    // every at: row for the session+client instead would also kill
    // concurrent access tokens, so it is deliberately NOT done here.
    // Rows minted before pairedAccessHash existed have no hash: their
    // old access token is left to expire on its TTL (bounded, ≤ 1h).
    if (row.pairedAccessHash) await this.storage.delete(`at:${row.pairedAccessHash}`);
    return this.mintTokens(row.sessionId, row.clientId, row.scope, row);
  }

  /**
   * Revoke a token (RFC 7009: unknown tokens also report success).
   * Revocation kills the whole session+client token set, following the
   * revokeSession pattern: access and refresh tokens are independently
   * random, so deleting only the presented token's row left its pair
   * alive. The presented token is only an anchor — it must match the
   * caller's clientId when one is given — and every at:/rt: row for the
   * same session+client is deleted. Behaviour change, flagged in the
   * security report: previously, other tokens of the same client+session
   * survived a single-token revocation; they no longer do.
   */
  private async revokeToken(token: string, clientId: string): Promise<Record<string, any>> {
    if (!token) return { revoked: true };
    const hash = await sha256Hex(token);
    let anchor: TokenRow | undefined;
    for (const prefix of ["at:", "rt:"] as const) {
      const row = await this.storage.get<TokenRow>(`${prefix}${hash}`);
      if (row && (!clientId || row.clientId === clientId)) {
        anchor = row;
        break;
      }
    }
    if (!anchor) return { revoked: true };
    for (const prefix of ["at:", "rt:"] as const) {
      for (const [key, row] of await this.storage.list<TokenRow>({ prefix })) {
        if (row.sessionId === anchor.sessionId && row.clientId === anchor.clientId) {
          await this.storage.delete(key);
        }
      }
    }
    return { revoked: true };
  }

  private async revokeSession(sessionId: string): Promise<Record<string, any>> {
    await this.storage.delete(`s:${sessionId}`);
    for (const [key, value] of await this.storage.list({ prefix: "d:" })) {
      if (value === sessionId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<TokenRow>({ prefix: "at:" })) {
      if (value.sessionId === sessionId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<TokenRow>({ prefix: "rt:" })) {
      if (value.sessionId === sessionId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<PairRow>({ prefix: "p:" })) {
      if (value.sessionId === sessionId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<ExtensionCodeRow>({ prefix: "ec:" })) {
      if (value.sessionId === sessionId) await this.storage.delete(key);
    }
    return { revoked: true };
  }
}
