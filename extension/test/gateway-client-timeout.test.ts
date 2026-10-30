/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGatewayStatus,
  signInWithEmailPassword,
  signUpWithEmailPassword,
} from "../src/gateway-client.js";

describe("gateway-client timeout and extension auth", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  }

  it("rejects a hung preflight with 'request timed out'", async () => {
    // A fetch that never resolves, even ignoring the abort signal.
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));
    const pending = fetchGatewayStatus("https://gw.example.com", "token", 50);
    const assertion = expect(pending).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("posts sign-in to /extension/auth/login and returns token/email/sessionId", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init ?? {};
      return jsonResponse({ token: "tok-1", email: "a@example.com", sessionId: "s-1" });
    });
    globalThis.fetch = fetchMock;
    const account = await signInWithEmailPassword(
      "https://gw.example.com",
      "a@example.com",
      "correct horse battery staple",
      { name: "Chrome on Linux", browser: "Chrome", os: "Linux" },
    );
    expect(account).toEqual({ token: "tok-1", email: "a@example.com", sessionId: "s-1" });
    expect(captured.url).toBe("https://gw.example.com/extension/auth/login");
    expect(captured.init?.method).toBe("POST");
    const body = JSON.parse(captured.init?.body as string);
    expect(body.email).toBe("a@example.com");
    expect(body.password).toBe("correct horse battery staple");
    expect(body.browserInfo.name).toBe("Chrome on Linux");
  });

  it("posts sign-up to /extension/auth/signup", async () => {
    const captured: { url?: string } = {};
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      captured.url = String(url);
      return jsonResponse({ token: "tok-2", email: "b@example.com", sessionId: "s-2" });
    });
    globalThis.fetch = fetchMock;
    const account = await signUpWithEmailPassword(
      "https://gw.example.com",
      "b@example.com",
      "another good password",
      {},
    );
    expect(account.token).toBe("tok-2");
    expect(captured.url).toBe("https://gw.example.com/extension/auth/signup");
  });

  it("surfaces the gateway's plain error message on a failed sign-in", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "Invalid email or password." }, false, 401));
    await expect(
      signInWithEmailPassword("https://gw.example.com", "a@example.com", "wrong password", {}),
    ).rejects.toThrow("Invalid email or password.");
  });

  it("rejects when the gateway returns no token", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ email: "a@example.com", sessionId: "s-1" }));
    await expect(
      signInWithEmailPassword("https://gw.example.com", "a@example.com", "some password", {}),
    ).rejects.toThrow("Sign-in did not return a token");
  });
});
