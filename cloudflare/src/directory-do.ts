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
interface AccountRow {
  userId: string;
  sessionId: string;
  deviceToken: string;
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
}
interface ExtensionCodeRow {
  sessionId: string;
  userId: string;
  extensionId: string;
  redirectUri: string;
  expiresAt: number;
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
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
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
      case "accountBySession":
        return this.accountBySession(String(body.sessionToken ?? ""));
      case "logout":
        return this.logout(String(body.sessionToken ?? ""));
      case "deleteAccount":
        return this.deleteAccount(String(body.sessionToken ?? ""));
      case "createExtensionCode":
        return this.createExtensionCode(
          String(body.sessionId ?? ""),
          String(body.userId ?? ""),
          String(body.extensionId ?? ""),
          String(body.redirectUri ?? ""),
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
    return { sessionId, name: session?.name ?? "Browser" };
  }

  /**
   * Rotate a session's device token, keeping the same sessionId. The caller
   * (Worker) must already have authenticated the old token or the website
   * session that owns this session; this method only verifies the session
   * exists. The old token stops working immediately: every `d:` index entry
   * for this session is deleted before the new one is written, and the
   * account row (if any) is updated to the new token.
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
      const account = await this.storage.get<AccountRow>(`acct:${session.userId}`);
      if (account && account.sessionId === sessionId) {
        await this.storage.put(`acct:${session.userId}`, { ...account, deviceToken });
      }
    }
    return { deviceToken, sessionId };
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
    const account = await this.storage.get<AccountRow>(`acct:${userId}`);
    if (!account) return { ok: false, error: "no browser session for this account", redirectUri, state };
    const session = await this.storage.get<SessionRow>(`s:${account.sessionId}`);
    if (!session || session.userId !== userId) {
      return { ok: false, error: "no browser session for this account", redirectUri, state };
    }
    const code = randomHex(24);
    const codeHash = await sha256Hex(code);
    const row: AuthCodeRow = {
      sessionId: account.sessionId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      scope: request.scope,
      expiresAt: nowMs() + AUTH_CODE_TTL_MS,
    };
    await this.storage.put(`ac:${codeHash}`, row);
    return { code, redirectUri, state, sessionId: account.sessionId };
  }

  /**
   * Create (or reuse) the long-lived browser session + device token that a
   * website account owns. The token is held by the extension for bridge
   * authentication; it is never rendered in full on the website and is
   * never entered on the authorize form (0.3.0: authorization uses the
   * signed-in website user instead).
   */
  private async ensureAccount(userId: string, email: string): Promise<AccountRow> {
    const existing = await this.storage.get<AccountRow>(`acct:${userId}`);
    if (existing) return existing;
    const sessionId = crypto.randomUUID();
    const deviceToken = randomHex(32);
    const deviceTokenHash = await sha256Hex(deviceToken);
    await this.storage.put(`s:${sessionId}`, { sessionId, name: email, userId, createdAt: nowMs() } satisfies SessionRow);
    await this.storage.put(`d:${deviceTokenHash}`, sessionId);
    const account: AccountRow = { userId, sessionId, deviceToken, createdAt: nowMs() };
    await this.storage.put(`acct:${userId}`, account);
    return account;
  }

  private async newWebSession(userId: string): Promise<string> {
    const token = randomHex(32);
    await this.storage.put(`ws:${await sha256Hex(token)}`, {
      userId,
      expiresAt: nowMs() + WEB_SESSION_TTL_MS,
    } satisfies WebSessionRow);
    return token;
  }

  private async signup(email: string, password: string): Promise<Record<string, any>> {
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
    const account = await this.ensureAccount(userId, normalized);
    const webToken = await this.newWebSession(userId);
    return { userId, email: normalized, token: account.deviceToken, sessionId: account.sessionId, webToken };
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
    return { userId, email: user.email, token: account.deviceToken, sessionId: account.sessionId, webToken };
  }

  private async accountBySession(sessionToken: string): Promise<Record<string, any>> {
    if (!sessionToken) return { ok: false, error: "not signed in" };
    const row = await this.storage.get<WebSessionRow>(`ws:${await sha256Hex(sessionToken)}`);
    if (!row || row.expiresAt < nowMs()) return { ok: false, error: "not signed in" };
    const user = await this.storage.get<UserRow>(`u:${row.userId}`);
    const account = await this.storage.get<AccountRow>(`acct:${row.userId}`);
    if (!user || !account) return { ok: false, error: "not signed in" };
    return { userId: row.userId, email: user.email, token: account.deviceToken, sessionId: account.sessionId };
  }

  private async logout(sessionToken: string): Promise<Record<string, any>> {
    if (sessionToken) await this.storage.delete(`ws:${await sha256Hex(sessionToken)}`);
    return { ok: true };
  }

  /** Permanently remove an account, its browser session, and every token it owns. */
  private async deleteAccount(sessionToken: string): Promise<Record<string, any>> {
    if (!sessionToken) return { ok: false, error: "not signed in", status: 401 };
    const row = await this.storage.get<WebSessionRow>(`ws:${await sha256Hex(sessionToken)}`);
    if (!row) return { ok: false, error: "not signed in", status: 401 };
    const userId = row.userId;
    const user = await this.storage.get<UserRow>(`u:${userId}`);
    const account = await this.storage.get<AccountRow>(`acct:${userId}`);
    if (account) await this.revokeSession(account.sessionId);
    if (user) await this.storage.delete(`email:${user.email}`);
    await this.storage.delete(`acct:${userId}`);
    await this.storage.delete(`u:${userId}`);
    for (const [key, value] of await this.storage.list<WebSessionRow>({ prefix: "ws:" })) {
      if (value.userId === userId) await this.storage.delete(key);
    }
    for (const [key, value] of await this.storage.list<ExtensionCodeRow>({ prefix: "ec:" })) {
      if (value.userId === userId) await this.storage.delete(key);
    }
    return { ok: true };
  }

  /**
   * Mint a single-use, extension-bound code for the browser sign-in handoff.
   * The device token itself never travels through a redirect URL.
   */
  private async createExtensionCode(
    sessionId: string,
    userId: string,
    extensionId: string,
    redirectUri: string,
  ): Promise<Record<string, any>> {
    if (!sessionId || !userId || !extensionId || !redirectUri) {
      return { ok: false, error: "invalid extension handoff" };
    }
    const session = await this.storage.get<SessionRow>(`s:${sessionId}`);
    const account = await this.storage.get<AccountRow>(`acct:${userId}`);
    if (!session || !account || account.userId !== userId || account.sessionId !== sessionId) {
      return { ok: false, error: "invalid extension handoff" };
    }
    const code = randomHex(32);
    await this.storage.put(`ec:${await sha256Hex(code)}`, {
      sessionId,
      userId,
      extensionId,
      redirectUri,
      expiresAt: nowMs() + EXTENSION_CODE_TTL_MS,
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
    const account = await this.storage.get<AccountRow>(`acct:${row.userId}`);
    if (!user || !account || account.sessionId !== row.sessionId) {
      return { ok: false, error: "invalid or expired code" };
    }
    return {
      token: account.deviceToken,
      email: user.email,
      sessionId: account.sessionId,
    };
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

  private async mintTokens(sessionId: string, clientId: string, scope: string): Promise<Record<string, any>> {
    if (!(await this.storage.get(`s:${sessionId}`))) return { ok: false, error: "unknown session" };
    const accessToken = randomHex(32);
    const refreshToken = randomHex(32);
    const accessHash = await sha256Hex(accessToken);
    const refreshHash = await sha256Hex(refreshToken);
    const now = nowMs();
    await this.storage.put(`at:${accessHash}`, { sessionId, clientId, scope, expiresAt: now + ACCESS_TTL_MS } satisfies TokenRow);
    await this.storage.put(`rt:${refreshHash}`, { sessionId, clientId, scope, expiresAt: now + REFRESH_TTL_MS } satisfies TokenRow);
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
    return this.mintTokens(row.sessionId, row.clientId, row.scope);
  }

  private async revokeToken(token: string, clientId: string): Promise<Record<string, any>> {
    if (!token) return { revoked: true };
    const hash = await sha256Hex(token);
    for (const prefix of ["at:", "rt:"]) {
      const row = await this.storage.get<TokenRow>(`${prefix}${hash}`);
      if (row && (!clientId || row.clientId === clientId)) await this.storage.delete(`${prefix}${hash}`);
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
    return { revoked: true };
  }
}
