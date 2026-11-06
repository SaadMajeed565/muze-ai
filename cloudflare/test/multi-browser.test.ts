import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DirectoryDO } from "../src/directory-do.js";

/** Minimal Durable Object storage stand-in (get/put/delete/list/transaction). */
interface FakeStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T>;
}

function memoryStorage(): { store: FakeStorage; map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const store: FakeStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [key, value] of map) {
        if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T);
      }
      return out;
    },
    async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
      return fn(store);
    },
  };
  return { store, map };
}

function directoryDO(): { dir: DirectoryDO; map: Map<string, unknown> } {
  const { store, map } = memoryStorage();
  const dir = new DirectoryDO({ storage: store } as unknown as DurableObjectState);
  return { dir, map };
}

async function call(dir: DirectoryDO, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await dir.fetch(
    new Request("https://directory/", { method: "POST", body: JSON.stringify(body) }),
  );
  return (await response.json()) as Record<string, any>;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

async function signup(dir: DirectoryDO, email: string): Promise<{ userId: string; sessionId: string }> {
  const result = await call(dir, { action: "signup", email, password: "password123" });
  expect(result.ok).not.toBe(false);
  return { userId: String(result.userId), sessionId: String(result.sessionId) };
}

describe("multi-browser account model", () => {
  test("migration: a legacy single-session row becomes Browser 1 with the same session and token", async () => {
    const { dir, map } = directoryDO();
    const legacySessionId = "legacy-session-1";
    const legacyToken = "legacy-token-abcdef";
    map.set(`acct:u_legacy`, { userId: "u_legacy", sessionId: legacySessionId, deviceToken: legacyToken, createdAt: 1000 });
    map.set(`s:${legacySessionId}`, { sessionId: legacySessionId, name: "old", userId: "u_legacy", createdAt: 1000 });
    map.set(`d:${sha256(legacyToken)}`, legacySessionId);

    const listed = await call(dir, { action: "browsersForUser", userId: "u_legacy" });
    expect(listed.ok).not.toBe(false);
    expect(listed.browsers).toHaveLength(1);
    expect(listed.browsers[0]).toMatchObject({ sessionId: legacySessionId, name: "Browser 1" });
    expect(listed.defaultSessionId).toBe(legacySessionId);

    // The old token still authenticates to the same session after migration.
    const auth = await call(dir, { action: "authDevice", deviceToken: legacyToken });
    expect(auth.ok).not.toBe(false);
    expect(auth.sessionId).toBe(legacySessionId);
  });

  test("new-browser creation vs token reuse: a stored token reuses only its own session", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "reuse@example.com");
    const first = await call(dir, { action: "browsersForUser", userId });
    expect(first.browsers).toHaveLength(1);

    const created = await call(dir, { action: "createBrowserSession", userId, browserInfo: { browser: "Chrome", os: "Windows" } });
    expect(created.ok).not.toBe(false);
    expect(created.sessionId).not.toBe(first.browsers[0].sessionId);

    const afterCreate = await call(dir, { action: "browsersForUser", userId });
    expect(afterCreate.browsers).toHaveLength(2);

    // Reuse with the new browser's token: same session, no third browser.
    const reused = await call(dir, {
      action: "reuseBrowserSession",
      deviceToken: created.deviceToken,
      browserInfo: { name: "Work Chrome", browser: "Chrome", os: "Windows" },
    });
    expect(reused.ok).not.toBe(false);
    expect(reused.sessionId).toBe(created.sessionId);
    const afterReuse = await call(dir, { action: "browsersForUser", userId });
    expect(afterReuse.browsers).toHaveLength(2);
    expect(afterReuse.browsers.find((entry: { sessionId: string }) => entry.sessionId === created.sessionId).name).toBe("Work Chrome");
  });

  test("removing one browser re-homes its tokens to the default; the other's tokens are untouched", async () => {
    const { dir } = directoryDO();
    const { userId, sessionId: defaultSessionId } = await signup(dir, "revoke@example.com");
    const browserA = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser A" } });
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const tokensA = await call(dir, { action: "mintTokens", sessionId: browserA.sessionId, clientId: "oc_client_a", scope: "read:tools call:tools" });
    const tokensB = await call(dir, { action: "mintTokens", sessionId: browserB.sessionId, clientId: "oc_client_b", scope: "read:tools call:tools" });
    expect((await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken })).sessionId).toBe(browserA.sessionId);

    // Removing a NON-default browser re-homes its tokens to the current
    // default (unchanged) instead of killing them.
    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: browserA.sessionId });
    expect(removed.ok).not.toBe(false);
    expect(removed.defaultSessionId).toBe(defaultSessionId);
    const rehomed = await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken });
    expect(rehomed.ok).not.toBe(false);
    expect(rehomed.sessionId).toBe(defaultSessionId);
    const stillGood = await call(dir, { action: "verifyAccess", accessToken: tokensB.accessToken });
    expect(stillGood.ok).not.toBe(false);
    expect(stillGood.sessionId).toBe(browserB.sessionId);

    const listed = await call(dir, { action: "browsersForUser", userId });
    expect(listed.browsers.map((entry: { sessionId: string }) => entry.sessionId)).not.toContain(browserA.sessionId);
  });

  test("a token re-homed on browser removal is still revocable account-wide", async () => {
    const { dir, map } = directoryDO();
    const { userId, sessionId: defaultSessionId } = await signup(dir, "rehomed-revoke@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const tokensA = await call(dir, { action: "mintTokens", sessionId: defaultSessionId, clientId: "oc_client_a", scope: "read:tools call:tools" });
    const tokensB = await call(dir, { action: "mintTokens", sessionId: browserB.sessionId, clientId: "oc_client_b", scope: "read:tools call:tools" });

    // Remove the DEFAULT browser: A's tokens are re-homed to B, the new default.
    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: defaultSessionId });
    expect(removed.ok).not.toBe(false);
    expect(removed.defaultSessionId).toBe(browserB.sessionId);
    const rehomed = await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken });
    expect(rehomed.ok).not.toBe(false);
    expect(rehomed.sessionId).toBe(browserB.sessionId);
    // Both the access and refresh rows were re-homed, not deleted.
    expect([...map.keys()].filter((key) => key.startsWith("at:") || key.startsWith("rt:")).length).toBe(4);

    // Account-wide revokeClient still kills the re-homed token set...
    const revoked = await call(dir, { action: "revokeClient", userId, clientId: "oc_client_a" });
    expect(revoked.revoked).toBe(2);
    expect((await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken })).ok).toBe(false);
    // ...while the other client's tokens are untouched.
    const stillGood = await call(dir, { action: "verifyAccess", accessToken: tokensB.accessToken });
    expect(stillGood.ok).not.toBe(false);
    expect(stillGood.sessionId).toBe(browserB.sessionId);
  });

  test("the last browser cannot be removed", async () => {
    const { dir } = directoryDO();
    const { userId, sessionId } = await signup(dir, "last@example.com");
    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: sessionId });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/last browser/);
  });

  test("default-browser routing: authorization binds to the default, and follows a default change", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "default@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const defaultFirst = listed.defaultSessionId as string;

    const authReq = async (): Promise<string> => {
      const created = await call(dir, {
        action: "createAuthRequest",
        clientId: "oc_client_x",
        redirectUri: "https://client.example/callback",
        codeChallenge: "challenge-0123456789abcdef",
        codeChallengeMethod: "S256",
        scope: "read:tools call:tools",
        state: "state-1",
      });
      return String(created.authReqId);
    };
    const first = await call(dir, { action: "authorizeWithUser", authReqId: await authReq(), userId });
    expect(first.ok).not.toBe(false);
    expect(first.sessionId).toBe(defaultFirst);

    const changed = await call(dir, { action: "setDefaultBrowser", userId, targetSessionId: browserB.sessionId });
    expect(changed.ok).not.toBe(false);
    const second = await call(dir, { action: "authorizeWithUser", authReqId: await authReq(), userId });
    expect(second.sessionId).toBe(browserB.sessionId);
  });

  test("routing preference: set by id, resolveRoute prefers it; no preference resolves to the default", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "route@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;

    // No preference yet: the default.
    const before = await call(dir, { action: "resolveRoute", clientId: "oc_client_r", userId });
    expect(before.ok).not.toBe(false);
    expect(before.sessionId).toBe(current);
    expect(before.defaultSessionId).toBe(current);
    expect(before.browsers).toHaveLength(2);

    // Set the preference by sessionId.
    const tokens = await call(dir, { action: "mintTokens", sessionId: current, clientId: "oc_client_r", scope: "read:tools call:tools" });
    const selected = await call(dir, {
      action: "setRoutingPreference",
      clientId: "oc_client_r",
      currentSessionId: current,
      targetSessionId: browserB.sessionId,
    });
    expect(selected.ok).not.toBe(false);
    expect(selected.sessionId).toBe(browserB.sessionId);
    expect(selected.name).toBe("Browser B");
    const after = await call(dir, { action: "resolveRoute", clientId: "oc_client_r", userId });
    expect(after.sessionId).toBe(browserB.sessionId);

    // A select never rewrites token rows: the token still verifies
    // against the browser it was minted for.
    expect((await call(dir, { action: "verifyAccess", accessToken: tokens.accessToken })).sessionId).toBe(current);
    // Another client with no preference still resolves to the default.
    expect((await call(dir, { action: "resolveRoute", clientId: "oc_client_other", userId })).sessionId).toBe(current);
  });

  test("routing preference falls back to the default when the preferred browser is removed", async () => {
    const { dir, map } = directoryDO();
    const { userId } = await signup(dir, "fallback@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    await call(dir, {
      action: "setRoutingPreference",
      clientId: "oc_client_f",
      currentSessionId: current,
      targetSessionId: browserB.sessionId,
    });
    expect((await call(dir, { action: "resolveRoute", clientId: "oc_client_f", userId })).sessionId).toBe(browserB.sessionId);

    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: browserB.sessionId });
    expect(removed.ok).not.toBe(false);
    // Never an error, never a stale id: the default, and the stale
    // preference row is cleared lazily by the resolve itself.
    const after = await call(dir, { action: "resolveRoute", clientId: "oc_client_f", userId });
    expect(after.sessionId).toBe(current);
    expect(after.defaultSessionId).toBe(current);
    expect(map.get(`rp:${userId}:oc_client_f`)).toBeUndefined();
  });

  test("name resolution: exact and case-insensitive; duplicates prefer the default, else most-recently-seen", async () => {
    const { dir, map } = directoryDO();
    const { userId } = await signup(dir, "names@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Work" } });
    const browserC = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "work" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    // Deterministic recency: B seen after C; the signup placeholder
    // (the default) is not named "Work", so recency decides.
    const account = map.get(`acct:${userId}`) as { browsers: Array<{ sessionId: string; lastSeenAt: number }> };
    for (const entry of account.browsers) {
      if (entry.sessionId === browserB.sessionId) entry.lastSeenAt = 2000;
      if (entry.sessionId === browserC.sessionId) entry.lastSeenAt = 1000;
    }

    const byName = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_n", currentSessionId: current, name: "Work" });
    expect(byName.sessionId).toBe(browserB.sessionId);
    const byCase = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_n", currentSessionId: current, name: "  wOrK " });
    expect(byCase.sessionId).toBe(browserB.sessionId);
    // sessionId wins when both are given.
    const both = await call(dir, {
      action: "setRoutingPreference",
      clientId: "oc_client_n",
      currentSessionId: current,
      targetSessionId: browserC.sessionId,
      name: "Work",
    });
    expect(both.sessionId).toBe(browserC.sessionId);

    // Make C the default: among the duplicate names the default wins
    // over the most-recently-seen browser.
    await call(dir, { action: "setDefaultBrowser", userId, targetSessionId: browserC.sessionId });
    const byDefault = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_n", currentSessionId: current, name: "work" });
    expect(byDefault.sessionId).toBe(browserC.sessionId);
  });

  test("unknown browser name or id errors and names the available browsers", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "unknown@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;

    const byName = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_u", currentSessionId: current, name: "No Such Browser" });
    expect(byName.ok).toBe(false);
    expect(byName.error).toMatch(/unknown browser "No Such Browser"/);
    expect(byName.error).toMatch(/Browser B/);
    expect(byName.error).not.toMatch(/oc_client_u/);

    const byId = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_u", currentSessionId: current, targetSessionId: "no-such-id" });
    expect(byId.ok).toBe(false);
    expect(byId.error).toMatch(/unknown browser "no-such-id"/);

    // A browser from another account is refused the same way.
    const { userId: userId2 } = await signup(dir, "unknown2@example.com");
    const foreign = await call(dir, { action: "createBrowserSession", userId: userId2, browserInfo: { name: "Foreign" } });
    const denied = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_u", currentSessionId: current, targetSessionId: foreign.sessionId });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/unknown browser/);
    void browserB;
  });

  test("setClientBrowser is gone: the action is unknown and select never rewrote tokens", async () => {
    const { dir } = directoryDO();
    const gone = await call(dir, { action: "setClientBrowser", clientId: "oc_x", currentSessionId: "s", targetSessionId: "t" });
    expect(gone.ok).toBe(false);
    expect(gone.error).toMatch(/unknown action: setClientBrowser/);
  });

  test("rename keeps the id and the new name resolves to the same browser", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "rename-resolve@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    const renamed = await call(dir, { action: "renameBrowser", userId, targetSessionId: browserB.sessionId, name: "Home PC" });
    expect(renamed.ok).not.toBe(false);
    expect(renamed.sessionId).toBe(browserB.sessionId);
    expect(renamed.name).toBe("Home PC");
    const resolved = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_rn", currentSessionId: current, name: "home pc" });
    expect(resolved.sessionId).toBe(browserB.sessionId);
    expect(resolved.name).toBe("Home PC");
    // The old name no longer resolves.
    const stale = await call(dir, { action: "setRoutingPreference", clientId: "oc_client_rn", currentSessionId: current, name: "Browser B" });
    expect(stale.ok).toBe(false);
  });

  test("verifyAccess returns userId, including for token rows minted before userId was stored", async () => {
    const { dir, map } = directoryDO();
    const { userId } = await signup(dir, "verify-user@example.com");
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    const tokens = await call(dir, { action: "mintTokens", sessionId: current, clientId: "oc_client_v", scope: "read:tools call:tools" });
    expect((await call(dir, { action: "verifyAccess", accessToken: tokens.accessToken })).userId).toBe(userId);

    // Simulate a legacy row without userId: verifyAccess resolves the
    // owner via the token's session instead.
    const legacyToken = "legacy-access-token";
    const row = map.get(`at:${sha256(tokens.accessToken)}`) as Record<string, unknown>;
    map.set(`at:${sha256(legacyToken)}`, { ...row });
    const stored = map.get(`at:${sha256(legacyToken)}`) as Record<string, unknown>;
    delete stored.userId;
    const legacy = await call(dir, { action: "verifyAccess", accessToken: legacyToken });
    expect(legacy.ok).not.toBe(false);
    expect(legacy.userId).toBe(userId);
    expect(legacy.sessionId).toBe(current);
  });

  test("live registry: set/clear, staleness window, and clientsForUser enrichment", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "live@example.com");
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    await call(dir, { action: "mintTokens", sessionId: current, clientId: "oc_client_l", scope: "read:tools call:tools" });

    const set = await call(dir, {
      action: "setLiveClient",
      clientId: "oc_client_l",
      userId,
      sessionId: current,
      clientName: "ChatGPT",
      scope: "read:tools call:tools",
    });
    expect(set.ok).not.toBe(false);
    expect(set.live).toBe(true);
    const live = await call(dir, { action: "liveClients", userId });
    expect(live.clients).toHaveLength(1);
    expect(live.clients[0]).toMatchObject({ clientId: "oc_client_l", clientName: "ChatGPT", live: true });
    expect(live.clients[0].connectedSince).toBe(set.connectedSince);
    expect(live.clients[0].lastActivityAt).toBe(set.lastActivityAt);

    // clientsForUser marks the matching row live with the same timestamps.
    const clients = await call(dir, { action: "clientsForUser", userId });
    const row = clients.clients.find((entry: { clientId: string }) => entry.clientId === "oc_client_l");
    expect(row.live).toBe(true);
    expect(row.connectedSince).toBe(set.connectedSince);
    expect(row.lastActivityAt).toBe(set.lastActivityAt);

    // A stale entry (last activity 11 minutes ago) no longer counts.
    const staleAt = Date.now() - 11 * 60 * 1000;
    await call(dir, { action: "setLiveClient", clientId: "oc_client_l", userId, sessionId: current, connectedSince: staleAt, lastActivityAt: staleAt });
    expect((await call(dir, { action: "liveClients", userId })).clients).toHaveLength(0);
    expect((await call(dir, { action: "clientsForUser", userId })).clients.find((entry: { clientId: string }) => entry.clientId === "oc_client_l").live).toBe(false);

    // Clearing removes the registration outright.
    await call(dir, { action: "setLiveClient", clientId: "oc_client_l", userId, sessionId: current });
    expect((await call(dir, { action: "liveClients", userId })).clients).toHaveLength(1);
    const cleared = await call(dir, { action: "clearLiveClient", clientId: "oc_client_l", userId });
    expect(cleared.cleared).toBe(true);
    expect((await call(dir, { action: "liveClients", userId })).clients).toHaveLength(0);
    expect((await call(dir, { action: "clearLiveClient", clientId: "oc_client_l", userId })).cleared).toBe(false);
  });

  test("removeBrowser leaves other browsers' tokens, client rows, and other clients' preferences untouched", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "remove-keeps@example.com");
    const browserA = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser A" } });
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    const tokensB = await call(dir, { action: "mintTokens", sessionId: browserB.sessionId, clientId: "oc_client_b", scope: "read:tools call:tools" });
    const tokensOther = await call(dir, { action: "mintTokens", sessionId: browserB.sessionId, clientId: "oc_client_o", scope: "read:tools" });
    await call(dir, { action: "setRoutingPreference", clientId: "oc_client_b", currentSessionId: current, targetSessionId: browserB.sessionId });
    await call(dir, { action: "setLiveClient", clientId: "oc_client_b", userId, sessionId: browserB.sessionId });

    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: browserA.sessionId });
    expect(removed.ok).not.toBe(false);
    // Other browser's tokens still verify, with the same session and owner.
    const stillGood = await call(dir, { action: "verifyAccess", accessToken: tokensB.accessToken });
    expect(stillGood.ok).not.toBe(false);
    expect(stillGood.sessionId).toBe(browserB.sessionId);
    expect(stillGood.userId).toBe(userId);
    expect((await call(dir, { action: "verifyAccess", accessToken: tokensOther.accessToken })).sessionId).toBe(browserB.sessionId);
    // Client rows and the other client's routing preference survive.
    const clients = await call(dir, { action: "clientsForUser", userId });
    expect(clients.clients.map((entry: { clientId: string }) => entry.clientId).sort()).toEqual(["oc_client_b", "oc_client_o"]);
    expect((await call(dir, { action: "resolveRoute", clientId: "oc_client_b", userId })).sessionId).toBe(browserB.sessionId);
    // The live registry entry survives too: removal kills only the browser.
    expect((await call(dir, { action: "liveClients", userId })).clients).toHaveLength(1);
  });

  test("cap: the 11th browser is refused", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "cap@example.com");
    // Signup placeholder counts as browser 1; 9 more reach the cap of 10.
    for (let index = 0; index < 9; index++) {
      const created = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: `Browser ${index + 2}` } });
      expect(created.ok).not.toBe(false);
    }
    const over = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser 11" } });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/browser limit/);
    const listed = await call(dir, { action: "browsersForUser", userId });
    expect(listed.browsers).toHaveLength(10);
  });

  test("rename validates and renames only the target browser", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "rename@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const empty = await call(dir, { action: "renameBrowser", userId, targetSessionId: browserB.sessionId, name: "   " });
    expect(empty.ok).toBe(false);
    const renamed = await call(dir, { action: "renameBrowser", userId, targetSessionId: browserB.sessionId, name: "Home PC" });
    expect(renamed.ok).not.toBe(false);
    expect(renamed.name).toBe("Home PC");
    const listed = await call(dir, { action: "browsersForUser", userId });
    expect(listed.browsers.find((entry: { sessionId: string }) => entry.sessionId === browserB.sessionId).name).toBe("Home PC");
  });

  test("extension sign-in adopts the signup placeholder, then creates a new browser", async () => {
    const { dir } = directoryDO();
    const { userId, sessionId: placeholder } = await signup(dir, "adopt@example.com");
    const code1 = await call(dir, {
      action: "createExtensionCode",
      userId,
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/",
      browserInfo: { browser: "Chrome", os: "Windows" },
    });
    expect(code1.ok).not.toBe(false);
    const redeemed1 = await call(dir, {
      action: "redeemExtensionCode",
      code: code1.code,
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/",
    });
    expect(redeemed1.ok).not.toBe(false);
    expect(redeemed1.sessionId).toBe(placeholder);
    expect(redeemed1.token).toBeTruthy();

    // A second extension sign-in finds no unclaimed browser: a new entry.
    const code2 = await call(dir, {
      action: "createExtensionCode",
      userId,
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/",
      browserInfo: { browser: "Firefox", os: "Linux" },
    });
    const redeemed2 = await call(dir, {
      action: "redeemExtensionCode",
      code: code2.code,
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      redirectUri: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/",
    });
    expect(redeemed2.sessionId).not.toBe(placeholder);
    const listed = await call(dir, { action: "browsersForUser", userId });
    expect(listed.browsers).toHaveLength(2);
    expect(listed.browsers.every((entry: { claimed: boolean }) => entry.claimed)).toBe(true);
  });
});
