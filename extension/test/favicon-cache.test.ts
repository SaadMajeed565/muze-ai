import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAVICON_CACHE_KEY,
  FAVICON_MAX_BYTES,
  FAVICON_TTL_MS,
  cacheFavIconUrl,
  domainOf,
  ensureFavicon,
  fetchFaviconDataUrl,
  isFaviconFresh,
  prefetchFaviconForTab,
  readFaviconCache,
  writeFaviconEntry,
} from "../src/favicon-cache.js";

type Store = Record<string, unknown>;
let store: Store;

function stubStorage(): void {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Store) => Object.assign(store, items),
        remove: async (keys: string[]) => {
          for (const key of keys) delete store[key];
        },
      },
    },
  });
}

function fakeResponse(body: ArrayBuffer, contentType: string, ok = true): Response {
  return {
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => body,
  } as unknown as Response;
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("favicon-cache", () => {
  beforeEach(() => {
    stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts domains only from http(s) URLs", () => {
    expect(domainOf("https://example.com/path?q=1")).toBe("example.com");
    expect(domainOf("http://sub.example.co.uk:8080/")).toBe("sub.example.co.uk");
    expect(domainOf("chrome://extensions")).toBeNull();
    expect(domainOf("about:blank")).toBeNull();
    expect(domainOf("")).toBeNull();
    expect(domainOf("not a url")).toBeNull();
  });

  it("treats entries as fresh only within the 7-day TTL", () => {
    const now = 10_000_000;
    expect(isFaviconFresh({ dataUrl: "d", fetchedAt: now - FAVICON_TTL_MS + 1 }, now)).toBe(true);
    expect(isFaviconFresh({ dataUrl: "d", fetchedAt: now - FAVICON_TTL_MS }, now)).toBe(false);
    expect(isFaviconFresh({ dataUrl: "d", fetchedAt: now - FAVICON_TTL_MS - 1 }, now)).toBe(false);
  });

  it("fetches a small image into a data URL and rejects the rest", async () => {
    const fetchOk = async () => fakeResponse(bytes("ICO"), "image/x-icon");
    const dataUrl = await fetchFaviconDataUrl("https://example.com/favicon.ico", fetchOk as unknown as typeof fetch);
    expect(dataUrl).toMatch(/^data:image\/x-icon;base64,/);
    expect(await fetchFaviconDataUrl("https://example.com/favicon.ico", (async () =>
      fakeResponse(bytes("ICO"), "text/html")) as unknown as typeof fetch)).toBeNull();
    expect(await fetchFaviconDataUrl("https://example.com/favicon.ico", (async () =>
      fakeResponse(bytes("ICO"), "image/x-icon", false)) as unknown as typeof fetch)).toBeNull();
    expect(await fetchFaviconDataUrl("https://example.com/favicon.ico", (async () =>
      fakeResponse(new Uint8Array(FAVICON_MAX_BYTES + 1).buffer as ArrayBuffer, "image/x-icon")) as unknown as typeof fetch)).toBeNull();
    expect(await fetchFaviconDataUrl("https://example.com/favicon.ico", (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch)).toBeNull();
  });

  it("round-trips entries and evicts the oldest past the entry cap", async () => {
    await writeFaviconEntry("a.test", "data:a", 1000);
    expect(await readFaviconCache()).toEqual({ "a.test": { dataUrl: "data:a", fetchedAt: 1000 } });
    for (let i = 0; i < 105; i++) {
      await writeFaviconEntry(`d${i}.test`, `data:${i}`, 2000 + i);
    }
    const cache = await readFaviconCache();
    expect(Object.keys(cache).length).toBe(100);
    expect(cache["a.test"]).toBeUndefined();
    expect(cache["d104.test"]).toBeDefined();
  });

  it("ensureFavicon skips the fetch for fresh entries and serves stale on failure", async () => {
    let calls = 0;
    const failingFetch = async () => {
      calls += 1;
      throw new Error("down");
    };
    await writeFaviconEntry("fresh.test", "data:fresh", Date.now());
    expect(await ensureFavicon("fresh.test", failingFetch as unknown as typeof fetch)).toEqual({
      dataUrl: "data:fresh",
      fetchedAt: expect.any(Number),
    });
    expect(calls).toBe(0);
    await writeFaviconEntry("stale.test", "data:stale", Date.now() - FAVICON_TTL_MS - 1);
    const served = await ensureFavicon("stale.test", failingFetch as unknown as typeof fetch);
    expect(served?.dataUrl).toBe("data:stale");
    expect(calls).toBe(1);
  });

  it("prefetch returns fresh cache without fetching, and favIconUrl instantly when uncached", async () => {
    await writeFaviconEntry("cached.test", "data:cached", Date.now());
    let calls = 0;
    const countingFetch = async () => {
      calls += 1;
      return fakeResponse(bytes("ICO"), "image/x-icon");
    };
    expect(await prefetchFaviconForTab({ url: "https://cached.test/page" }, countingFetch as unknown as typeof fetch)).toBe("data:cached");
    expect(calls).toBe(0);

    expect(
      await prefetchFaviconForTab(
        { url: "https://new.test/page", favIconUrl: "https://new.test/favicon.ico" },
        countingFetch as unknown as typeof fetch,
      ),
    ).toBe("https://new.test/favicon.ico");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cache = await readFaviconCache();
    expect(cache["new.test"]?.dataUrl).toMatch(/^data:image\/x-icon;base64,/);
  });

  it("never fetches chrome://favicon URLs into the cache", async () => {
    let calls = 0;
    const countingFetch = async () => {
      calls += 1;
      return fakeResponse(bytes("ICO"), "image/x-icon");
    };
    expect(
      await cacheFavIconUrl("example.com", "chrome://favicon2/?url=https://example.com", countingFetch as unknown as typeof fetch),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(store[FAVICON_CACHE_KEY]).toBeUndefined();
  });
});
