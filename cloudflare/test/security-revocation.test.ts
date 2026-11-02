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

async function signup(dir: DirectoryDO, email: string): Promise<{ userId: string; sessionId: string }> {
  const result = await call(dir, { action: "signup", email, password: "password123" });
  expect(result.ok).not.toBe(false);
  return { userId: String(result.userId), sessionId: String(result.sessionId) };
}

async function authReqId(dir: DirectoryDO, clientId: string): Promise<string> {
  const created = await call(dir, {
    action: "createAuthRequest",
    clientId,
    redirectUri: "https://client.example/callback",
    codeChallenge: "challenge-0123456789abcdef",
    codeChallengeMethod: "S256",
    scope: "read:tools call:tools",
    state: "state-1",
  });
  expect(created.ok).not.toBe(false);
  return String(created.authReqId);
}

describe("security: token revocation and refresh", () => {
  test("revokeToken kills the whole session+client token set, not just the presented token", async () => {
    const { dir } = directoryDO();
    const { sessionId } = await signup(dir, "revoke-set@example.com");
    const pair1 = await call(dir, { action: "mintTokens", sessionId, clientId: "oc_victim", scope: "read:tools" });
    const pair2 = await call(dir, { action: "mintTokens", sessionId, clientId: "oc_victim", scope: "read:tools" });
    const other = await call(dir, { action: "mintTokens", sessionId, clientId: "oc_other", scope: "read:tools" });
    expect((await call(dir, { action: "verifyAccess", accessToken: pair2.accessToken })).ok).not.toBe(false);

    // Revoking via the first pair's refresh token must also kill the
    // second pair's access+refresh tokens (same session+client).
    const revoked = await call(dir, { action: "revokeToken", token: pair1.refreshToken, clientId: "oc_victim" });
    expect(revoked.revoked).toBe(true);
    expect((await call(dir, { action: "verifyAccess", accessToken: pair1.accessToken })).ok).toBe(false);
    expect((await call(dir, { action: "verifyAccess", accessToken: pair2.accessToken })).ok).toBe(false);
    expect((await call(dir, { action: "refresh", refreshToken: pair2.refreshToken, clientId: "oc_victim" })).ok).toBe(false);
    // A different client's tokens on the same session are untouched.
    expect((await call(dir, { action: "verifyAccess", accessToken: other.accessToken })).ok).not.toBe(false);
    // Unknown tokens still report success (RFC 7009), without deleting anything.
    expect((await call(dir, { action: "revokeToken", token: "nope", clientId: "oc_victim" })).revoked).toBe(true);
    expect((await call(dir, { action: "verifyAccess", accessToken: other.accessToken })).ok).not.toBe(false);
  });

  test("refresh retires the previous access token, not just the old refresh token", async () => {
    const { dir } = directoryDO();
    const { sessionId } = await signup(dir, "refresh-retire@example.com");
    const first = await call(dir, { action: "mintTokens", sessionId, clientId: "oc_ref", scope: "read:tools" });
    const second = await call(dir, { action: "refresh", refreshToken: first.refreshToken, clientId: "oc_ref" });
    expect(second.ok).not.toBe(false);
    expect((await call(dir, { action: "verifyAccess", accessToken: second.accessToken })).ok).not.toBe(false);
    expect((await call(dir, { action: "verifyAccess", accessToken: first.accessToken })).ok).toBe(false);
    expect((await call(dir, { action: "refresh", refreshToken: first.refreshToken, clientId: "oc_ref" })).ok).toBe(false);
    // The new refresh token still works for a further refresh.
    expect(
      (await call(dir, { action: "refresh", refreshToken: second.refreshToken, clientId: "oc_ref" })).ok,
    ).not.toBe(false);
  });

  test("authorizeWithUser consumes the authorization request (no replay)", async () => {
    const { dir } = directoryDO();
    const { userId } = await signup(dir, "auth-replay@example.com");
    const id = await authReqId(dir, "oc_replay");
    const first = await call(dir, { action: "authorizeWithUser", authReqId: id, userId });
    expect(first.ok).not.toBe(false);
    expect(first.code).toBeTruthy();
    const replay = await call(dir, { action: "authorizeWithUser", authReqId: id, userId });
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/expired/);
  });

  test("deleteAccountByUser cleans scoped auth codes and unreferenced clients only", async () => {
    const { dir, map } = directoryDO();
    const { userId } = await signup(dir, "cleanup@example.com");
    const client = await call(dir, {
      action: "createClient",
      clientName: "Doomed Client",
      redirectUris: ["https://client.example/callback"],
    });
    // createClient takes its fields from the body; the clientId it minted:
    const clientId = String(client.clientId);
    expect(clientId).toBeTruthy();
    const id = await authReqId(dir, clientId);
    const authorized = await call(dir, { action: "authorizeWithUser", authReqId: id, userId });
    expect(authorized.ok).not.toBe(false);
    expect([...map.keys()].some((key) => key.startsWith("ac:"))).toBe(true);

    // An authorization request for another (surviving) purpose must NOT be
    // bulk-deleted: ar: rows carry no owner, and this DO is shared.
    const survivingAr = await authReqId(dir, "oc_survivor");
    const deleted = await call(dir, { action: "deleteAccountByUser", userId });
    expect(deleted.ok).toBe(true);
    expect([...map.keys()].some((key) => key.startsWith("ac:"))).toBe(false);
    expect([...map.keys()].some((key) => key.startsWith("at:") || key.startsWith("rt:"))).toBe(false);
    // The doomed client had no surviving references, so its row goes too;
    // the survivor's in-flight request keeps its ar: row (10-min TTL).
    expect(map.has(`c:${clientId}`)).toBe(false);
    expect(map.has(`ar:${survivingAr}`)).toBe(true);
  });
});
