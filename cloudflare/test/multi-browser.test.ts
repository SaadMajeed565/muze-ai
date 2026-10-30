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

  test("per-browser revoke isolation: removing one browser leaves the other's tokens working", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "revoke@example.com");
    const browserA = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser A" } });
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const tokensA = await call(dir, { action: "mintTokens", sessionId: browserA.sessionId, clientId: "oc_client_a", scope: "read:tools call:tools" });
    const tokensB = await call(dir, { action: "mintTokens", sessionId: browserB.sessionId, clientId: "oc_client_b", scope: "read:tools call:tools" });
    expect((await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken })).sessionId).toBe(browserA.sessionId);

    const removed = await call(dir, { action: "removeBrowser", userId, targetSessionId: browserA.sessionId });
    expect(removed.ok).not.toBe(false);
    expect((await call(dir, { action: "verifyAccess", accessToken: tokensA.accessToken })).ok).toBe(false);
    const stillGood = await call(dir, { action: "verifyAccess", accessToken: tokensB.accessToken });
    expect(stillGood.ok).not.toBe(false);
    expect(stillGood.sessionId).toBe(browserB.sessionId);

    const listed = await call(dir, { action: "browsersForUser", userId });
    expect(listed.browsers.map((entry: { sessionId: string }) => entry.sessionId)).not.toContain(browserA.sessionId);
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

  test("browser select persistence: a client's tokens rebind to the target browser of the same account", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "select@example.com");
    const browserB = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: "Browser B" } });
    const listed = await call(dir, { action: "browsersForUser", userId });
    const current = listed.defaultSessionId as string;
    const tokens = await call(dir, { action: "mintTokens", sessionId: current, clientId: "oc_client_s", scope: "read:tools call:tools" });
    const other = await call(dir, { action: "mintTokens", sessionId: current, clientId: "oc_client_other", scope: "read:tools" });

    const selected = await call(dir, {
      action: "setClientBrowser",
      clientId: "oc_client_s",
      currentSessionId: current,
      targetSessionId: browserB.sessionId,
    });
    expect(selected.ok).not.toBe(false);
    expect((await call(dir, { action: "verifyAccess", accessToken: tokens.accessToken })).sessionId).toBe(browserB.sessionId);
    // Another client's tokens on the same browser are untouched.
    expect((await call(dir, { action: "verifyAccess", accessToken: other.accessToken })).sessionId).toBe(current);

    // Selecting a browser from another account is refused.
    const { userId: userId2 } = await signup(dir, "select2@example.com");
    const foreign = await call(dir, { action: "createBrowserSession", userId: userId2, browserInfo: { name: "Foreign" } });
    const denied = await call(dir, {
      action: "setClientBrowser",
      clientId: "oc_client_s",
      currentSessionId: browserB.sessionId,
      targetSessionId: foreign.sessionId,
    });
    expect(denied.ok).toBe(false);
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
