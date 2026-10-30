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

describe("extension auth routes (DirectoryDO level)", () => {
  test("extension signup creates a claimed browser and returns a device token", async () => {
    const { dir } = directoryDO();
    const result = await call(dir, {
      action: "extensionSignup",
      email: "ext@example.com",
      password: "password123",
      browserInfo: { name: "Chrome on Linux", browser: "Chrome", os: "Linux" },
    });
    expect(result.ok).not.toBe(false);
    expect(result.token).toBeTruthy();
    expect(result.email).toBe("ext@example.com");
    expect(result.sessionId).toBeTruthy();

    // Exactly one browser, already claimed — no unclaimed placeholder.
    // (The signup response carries no userId, so resolve it via the session.)
    const session = await call(dir, { action: "browsersForSession", sessionId: result.sessionId });
    expect(session.ok).not.toBe(false);
    const listed = await call(dir, { action: "browsersForUser", userId: session.userId });
    expect(listed.ok).not.toBe(false);
    expect(listed.browsers).toHaveLength(1);
    expect(listed.browsers[0]).toMatchObject({ sessionId: result.sessionId, claimed: true });
    expect(listed.browsers[0].name).toBe("Chrome on Linux");

    // The token authenticates to that session.
    const auth = await call(dir, { action: "authDevice", deviceToken: result.token });
    expect(auth.ok).not.toBe(false);
    expect(auth.sessionId).toBe(result.sessionId);
  });

  test("extension login with a wrong password returns the generic error", async () => {
    const { dir } = directoryDO();
    await call(dir, { action: "extensionSignup", email: "login@example.com", password: "password123", browserInfo: {} });
    const wrong = await call(dir, { action: "extensionLogin", email: "login@example.com", password: "wrongpassword", browserInfo: {} });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toBe("Invalid email or password.");
    // Unknown users get the identical message (no account enumeration).
    const unknown = await call(dir, { action: "extensionLogin", email: "nobody@example.com", password: "wrongpassword", browserInfo: {} });
    expect(unknown.error).toBe("Invalid email or password.");
  });

  test("duplicate extension signup is rejected", async () => {
    const { dir } = directoryDO();
    await call(dir, { action: "extensionSignup", email: "dup@example.com", password: "password123", browserInfo: {} });
    const again = await call(dir, { action: "extensionSignup", email: "dup@example.com", password: "password123", browserInfo: {} });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already exists/);
  });

  test("extension login on a website-signed-up account adopts the placeholder instead of adding a browser", async () => {
    const { dir } = directoryDO();
    const signedUp = await call(dir, { action: "signup", email: "web@example.com", password: "password123" });
    expect(signedUp.ok).not.toBe(false);
    const before = await call(dir, { action: "browsersForUser", userId: signedUp.userId });
    expect(before.browsers).toHaveLength(1);
    expect(before.browsers[0].claimed).toBe(false);
    const placeholderSessionId = before.browsers[0].sessionId;

    const loggedIn = await call(dir, {
      action: "extensionLogin",
      email: "web@example.com",
      password: "password123",
      browserInfo: { name: "Chrome on Windows", browser: "Chrome", os: "Windows" },
    });
    expect(loggedIn.ok).not.toBe(false);
    expect(loggedIn.sessionId).toBe(placeholderSessionId);
    expect(loggedIn.token).toBeTruthy();

    const after = await call(dir, { action: "browsersForUser", userId: signedUp.userId });
    expect(after.browsers).toHaveLength(1);
    expect(after.browsers[0]).toMatchObject({ sessionId: placeholderSessionId, claimed: true, name: "Chrome on Windows" });
  });

  test("extension login enforces the 10-browser cap", async () => {
    const { dir } = directoryDO();
    const first = await call(dir, { action: "extensionSignup", email: "cap@example.com", password: "password123", browserInfo: {} });
    expect(first.ok).not.toBe(false);
    // Resolve the user id through the account listing: the signup response
    // carries no userId, so list via the session's account row instead.
    const account = await call(dir, { action: "browsersForSession", sessionId: first.sessionId });
    const userId = account.userId as string;
    expect(userId).toBeTruthy();
    for (let i = 1; i < 10; i++) {
      const created = await call(dir, { action: "createBrowserSession", userId, browserInfo: { name: `Browser ${i + 1}` } });
      expect(created.ok).not.toBe(false);
    }
    const over = await call(dir, { action: "extensionLogin", email: "cap@example.com", password: "password123", browserInfo: {} });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/browser limit/);
  });

  test("deleteAccountByUser removes the user, account, and sessions", async () => {
    const { dir } = directoryDO();
    const created = await call(dir, { action: "extensionSignup", email: "gone@example.com", password: "password123", browserInfo: {} });
    expect(created.ok).not.toBe(false);
    const account = await call(dir, { action: "browsersForSession", sessionId: created.sessionId });
    const userId = account.userId as string;
    const deleted = await call(dir, { action: "deleteAccountByUser", userId });
    expect(deleted.ok).toBe(true);
    // The token no longer authenticates, and the email is free again.
    const auth = await call(dir, { action: "authDevice", deviceToken: created.token });
    expect(auth.ok).toBe(false);
    const again = await call(dir, { action: "extensionSignup", email: "gone@example.com", password: "password123", browserInfo: {} });
    expect(again.ok).not.toBe(false);
  });
});
