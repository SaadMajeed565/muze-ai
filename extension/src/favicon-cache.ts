/**
 * Per-domain favicon prefetch + cache for the browser-card tile.
 *
 * Why this exists: the card tile used to show the active tab's
 * `favIconUrl`, which stays empty until the whole site finishes
 * loading — so the tile sat blank (or on the brand fallback) while the
 * page loaded. With this cache the tile shows instantly: the first
 * time a domain is seen its favicon is fetched in the background and
 * stored, and every later view of that domain renders from the cache
 * without waiting for the site.
 *
 * Rules (binding):
 * - Direct domain fetch only: `https://<domain>/favicon.ico`. NEVER
 *   the Google favicon service or any third-party favicon service.
 * - The tab's `favIconUrl` stays as a fallback src, and when it is an
 *   http(s) URL it is also fetched into the cache when available.
 *   `chrome://favicon` URLs are usable as <img> src but not fetchable,
 *   so they are never cached — only used directly.
 * - Cache lives in `chrome.storage.local` under `muze.favicons`,
 *   keyed by domain. Blobs over ~100KB are skipped, entries cap at
 *   100 domains (oldest evicted), and entries older than 7 days
 *   refresh in the background while the stale entry keeps serving.
 */

export const FAVICON_CACHE_KEY = "muze.favicons";
export const FAVICON_MAX_BYTES = 100 * 1024;
export const FAVICON_MAX_ENTRIES = 100;
export const FAVICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FaviconEntry {
  dataUrl: string;
  fetchedAt: number;
}

export type FaviconCache = Record<string, FaviconEntry>;

/** Hostname for an http(s) URL; null for chrome://, about:, or garbage. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export function isFaviconFresh(entry: FaviconEntry, now: number = Date.now()): boolean {
  return now - entry.fetchedAt < FAVICON_TTL_MS;
}

type StorageLike = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<unknown>;
};

function localStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { chrome?: { storage?: { local?: StorageLike } } }).chrome?.storage?.local;
    if (storage && typeof storage.get === "function" && typeof storage.set === "function") return storage;
  } catch {
    // No chrome storage here (tests without a stub, tooling): cacheless.
  }
  return null;
}

export async function readFaviconCache(): Promise<FaviconCache> {
  const storage = localStorage();
  if (!storage) return {};
  try {
    const got = await storage.get(FAVICON_CACHE_KEY);
    const raw = got[FAVICON_CACHE_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: FaviconCache = {};
    for (const [domain, entry] of Object.entries(raw as Record<string, unknown>)) {
      const candidate = entry as Partial<FaviconEntry> | null;
      if (candidate && typeof candidate.dataUrl === "string" && typeof candidate.fetchedAt === "number") {
        out[domain] = { dataUrl: candidate.dataUrl, fetchedAt: candidate.fetchedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeFaviconEntry(domain: string, dataUrl: string, now: number = Date.now()): Promise<FaviconEntry> {
  const entry: FaviconEntry = { dataUrl, fetchedAt: now };
  const cache = await readFaviconCache();
  cache[domain] = entry;
  const keys = Object.keys(cache);
  if (keys.length > FAVICON_MAX_ENTRIES) {
    keys.sort((a, b) => cache[a].fetchedAt - cache[b].fetchedAt);
    for (const key of keys.slice(0, keys.length - FAVICON_MAX_ENTRIES)) {
      if (key !== domain) delete cache[key];
    }
  }
  const storage = localStorage();
  if (storage) {
    try {
      await storage.set({ [FAVICON_CACHE_KEY]: cache });
    } catch {
      // Cache persistence is best-effort; the caller still has the entry.
    }
  }
  return entry;
}

function arrayBufferToDataUrl(mime: string, buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Fetch one favicon URL into a data URL. Null on any failure or over-size blob. */
export async function fetchFaviconDataUrl(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const rawType = response.headers.get("content-type") ?? "";
  const mime = rawType.split(";")[0].trim();
  if (mime && !mime.startsWith("image/")) return null;
  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (buffer.byteLength === 0 || buffer.byteLength > FAVICON_MAX_BYTES) return null;
  return arrayBufferToDataUrl(mime || "image/x-icon", buffer);
}

/**
 * Ensure a fresh cache entry for a domain: fresh entries return
 * without a fetch; otherwise the domain's /favicon.ico is fetched and
 * stored. On fetch failure the stale entry (if any) is returned, so a
 * tile keeps showing rather than going blank.
 */
export async function ensureFavicon(domain: string, fetchFn?: typeof fetch): Promise<FaviconEntry | null> {
  const cache = await readFaviconCache();
  const existing = cache[domain];
  if (existing && isFaviconFresh(existing)) return existing;
  const dataUrl = await fetchFaviconDataUrl(`https://${domain}/favicon.ico`, fetchFn);
  if (!dataUrl) return existing ?? null;
  return writeFaviconEntry(domain, dataUrl);
}

/**
 * Cache an http(s) tab favIconUrl under its domain (higher quality
 * than /favicon.ico when the browser already resolved one). Returns
 * null for chrome://favicon URLs, which cannot be fetched.
 */
export async function cacheFavIconUrl(domain: string, favIconUrl: string, fetchFn?: typeof fetch): Promise<FaviconEntry | null> {
  if (domainOf(favIconUrl) === null) return null;
  const dataUrl = await fetchFaviconDataUrl(favIconUrl, fetchFn);
  if (!dataUrl) return null;
  return writeFaviconEntry(domain, dataUrl);
}

/**
 * Best-known tile src for a tab right now — never blocks on the
 * network. Fresh-or-stale cache wins (instant, even while the site is
 * still loading); otherwise the tab's favIconUrl; otherwise null (the
 * caller falls back to the brand tile). A missing or stale entry kicks
 * off a background refresh so the next resolution is cached.
 */
export async function prefetchFaviconForTab(
  tab: { url?: string; favIconUrl?: string },
  fetchFn?: typeof fetch,
): Promise<string | null> {
  const domain = domainOf(tab.url);
  if (!domain) return tab.favIconUrl ?? null;
  const cache = await readFaviconCache();
  const cached = cache[domain] ?? null;
  if (cached && isFaviconFresh(cached)) return cached.dataUrl;
  void ensureFavicon(domain, fetchFn).catch(() => undefined);
  if (tab.favIconUrl && domainOf(tab.favIconUrl) !== null && tab.favIconUrl !== `https://${domain}/favicon.ico`) {
    void cacheFavIconUrl(domain, tab.favIconUrl, fetchFn).catch(() => undefined);
  }
  return cached?.dataUrl ?? tab.favIconUrl ?? null;
}
