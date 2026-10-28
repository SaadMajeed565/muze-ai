// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installObserver,
  MAX_OBSERVER_DIALOGS,
  MAX_OBSERVER_REQUESTS,
  OBSERVER_GLOBAL_KEY,
  type ObserverPageState,
} from "../libs/browser-engine/page/observer.js";

/**
 * The observer wraps the page's own fetch, so the mock has to be in place
 * before the observer is installed.
 */
function installWithMock(mock: typeof fetch): ObserverPageState {
  delete (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL_KEY];
  window.fetch = mock;
  const state = installObserver();
  state.enabled = true;
  return state;
}

let nativeFetch: typeof fetch;

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL_KEY];
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("prompt", vi.fn(() => "native"));
  nativeFetch = window.fetch;
});

afterEach(() => {
  window.fetch = nativeFetch;
  vi.unstubAllGlobals();
});

describe("page observer", () => {
  it("starts switched off so an unobserved page behaves normally", () => {
    const state = installObserver();
    expect(state.enabled).toBe(false);
    expect(state.requests).toEqual([]);
    expect(state.dialogs).toEqual([]);
  });

  it("is idempotent", () => {
    const first = installObserver();
    const second = installObserver();
    expect(second).toBe(first);
  });

  it("does not record a request while it is off", async () => {
    const state = installObserver();
    window.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    await window.fetch("https://example.test/api");
    expect(state.requests).toHaveLength(0);
  });

  it("records the method, url and status of a request once it is on", async () => {
    const state = installWithMock(vi.fn(async () => new Response("ok", { status: 201 })) as unknown as typeof fetch);
    await window.fetch("https://example.test/api", { method: "post" });

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].method).toBe("POST");
    expect(state.requests[0].url).toBe("https://example.test/api");
    expect(state.requests[0].status).toBe(201);
    expect(state.requests[0].failed).toBe(false);
  });

  it("never stores a request body", async () => {
    const state = installWithMock(vi.fn(async () => new Response("ok")) as unknown as typeof fetch);
    await window.fetch("https://example.test/api", { method: "POST", body: JSON.stringify({ card: "4111111111111111" }) });

    expect(JSON.stringify(state.requests)).not.toContain("4111111111111111");
    expect(JSON.stringify(state.requests)).not.toContain("card");
  });

  it("records a failed request", async () => {
    const state = installWithMock(
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    await expect(window.fetch("https://example.test/api")).rejects.toThrow("offline");

    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].failed).toBe(true);
  });

  it("keeps the request log bounded", async () => {
    const state = installWithMock(vi.fn(async () => new Response("ok")) as unknown as typeof fetch);
    for (let i = 0; i < MAX_OBSERVER_REQUESTS + 25; i++) {
      await window.fetch(`https://example.test/${i}`);
    }
    expect(state.requests.length).toBe(MAX_OBSERVER_REQUESTS);
  });

  it("dismisses a confirm by default rather than accepting it", () => {
    const state = installObserver();
    state.enabled = true;
    expect(window.confirm("really?")).toBe(false);
    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0].answered).toBe("dismiss");
  });

  it("accepts a confirm once the default answer is changed", () => {
    const state = installObserver();
    state.enabled = true;
    state.defaultAnswer = "accept";
    expect(window.confirm("really?")).toBe(true);
    expect(state.dialogs[0].answered).toBe("accept");
  });

  it("returns the configured text for a prompt", () => {
    const state = installObserver();
    state.enabled = true;
    state.defaultAnswer = "accept";
    state.defaultText = "hello";
    expect(window.prompt("name?")).toBe("hello");
  });

  it("keeps the dialog log bounded", () => {
    const state = installObserver();
    state.enabled = true;
    for (let i = 0; i < MAX_OBSERVER_DIALOGS + 10; i++) window.confirm(`q${i}`);
    expect(state.dialogs.length).toBe(MAX_OBSERVER_DIALOGS);
  });

  it("counts a request that is still running as pending", async () => {
    let release: (() => void) | undefined;
    const state = installWithMock(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(new Response("ok"));
          }),
      ) as unknown as typeof fetch,
    );

    const pending = window.fetch("https://example.test/slow");
    expect(state.pendingRequests).toBe(1);
    release?.();
    await pending;
    expect(state.pendingRequests).toBe(0);
  });
});

describe("observer/diagnostics prefix", () => {
  it("uses the muze page global, not the old prefix", async () => {
    const { installObserver, OBSERVER_GLOBAL_KEY } = await import("../libs/browser-engine/page/observer.js");
    expect(OBSERVER_GLOBAL_KEY).toBe("__muzeObserver");
    delete (window as unknown as Record<string, unknown>)[OBSERVER_GLOBAL_KEY];
    delete (window as unknown as Record<string, unknown>).__uabbObserver;
    installObserver();
    expect((window as unknown as Record<string, unknown>).__muzeObserver).toBeDefined();
    expect((window as unknown as Record<string, unknown>).__uabbObserver).toBeUndefined();
  });

  it("stores diagnostics under the muze global", async () => {
    const { diagnosticsHook, readDiagnosticsLog } = await import("../libs/browser-engine/page/diagnostics.js");
    delete (window as unknown as Record<string, unknown>).__muzeDiagnostics;
    diagnosticsHook();
    expect((window as unknown as Record<string, unknown>).__muzeDiagnostics).toBeDefined();
    expect(readDiagnosticsLog().console).toBeDefined();
  });
});
