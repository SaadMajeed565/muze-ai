import { ToolErrorException, type TabInfo, type ToolErrorCode, type WindowInfo } from "../../tool-contracts/index.js";
import { isRestrictedUrl, validateNavigableUrl } from "../../security/index.js";
import { pageAgent, type PageOp } from "../page/agent.js";
import type { BrowserContext, RawTab, RawWindow } from "../context.js";

export function toTabInfo(tab: RawTab): TabInfo {
  const status = tab.status === "loading" || tab.status === "complete" || tab.status === "unloaded" ? tab.status : "unknown";
  return {
    id: tab.id ?? -1,
    index: tab.index,
    windowId: tab.windowId,
    active: tab.active,
    pinned: tab.pinned,
    highlighted: tab.highlighted,
    title: tab.title ?? "",
    // Restricted-page URLs are never exposed in listings: both branches of
    // the old ternary returned the URL, leaking it. A restricted tab reports
    // an empty URL (the schema describes the field as omittable for
    // restricted URLs); acting on the tab is still blocked elsewhere.
    url: tab.url && !isRestrictedUrl(tab.url) ? tab.url : "",
    status,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    audible: tab.audible,
    discarded: tab.discarded,
    incognito: tab.incognito,
  };
}

export function toWindowInfo(win: RawWindow): WindowInfo {
  const states = ["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen"] as const;
  const types = ["normal", "popup", "panel", "devtools"] as const;
  const state = states.find((s) => s === win.state) ?? "unknown";
  const type = types.find((t) => t === win.type) ?? "unknown";
  const activeTab = win.tabs?.find((t) => t.active);
  return {
    id: win.id ?? -1,
    focused: win.focused,
    state,
    type,
    tabCount: win.tabs?.length ?? 0,
    activeTabId: activeTab?.id,
  };
}

/** Resolve an explicit tab id or fall back to the active tab. */
export async function resolveTabId(ctx: BrowserContext, tabId?: number, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  if (typeof tabId === "number") {
    const tab = await raceWithAbort(ctx.getTab(tabId), signal);
    if (typeof tab.id !== "number") throw new ToolErrorException("NOT_FOUND", "Tab has no id");
    return tab.id;
  }
  const active = await raceWithAbort(ctx.getActiveTab(), signal);
  if (!active || typeof active.id !== "number") {
    throw new ToolErrorException("NOT_FOUND", "No active tab is available");
  }
  return active.id;
}

/** Resolve a writable/scriptable tab, rejecting restricted pages. */
export async function requireScriptableTab(ctx: BrowserContext, tabId?: number, signal?: AbortSignal): Promise<RawTab> {
  const resolved = await resolveTabId(ctx, tabId, signal);
  const tab = await raceWithAbort(ctx.getTab(resolved), signal);
  throwIfAborted(signal);
  if (isRestrictedUrl(tab.url)) {
    throw new ToolErrorException("RESTRICTED_PAGE", "This page does not allow extension access");
  }
  return tab;
}

export function validateUrlInput(raw: string, allowAboutBlank = true): string {
  return validateNavigableUrl(raw, { allowAboutBlank }).href;
}

/**
 * Turn a file name and an optional sub-folder into the relative path Chrome
 * expects. Absolute paths and parent-directory segments are refused so a
 * download can never be written outside the browser's download folder.
 */
export function validateDownloadPath(filename?: string, directory?: string): string | undefined {
  const clean = (value: string, label: string): string => {
    const trimmed = value.trim();
    if (!trimmed) throw new ToolErrorException("INVALID_INPUT", `The ${label} cannot be empty`);
    if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
      throw new ToolErrorException("INVALID_INPUT", `The ${label} must be a relative path inside the download folder`);
    }
    if (trimmed.split(/[\\/]+/).some((part) => part === "..")) {
      throw new ToolErrorException("INVALID_INPUT", `The ${label} cannot leave the download folder`);
    }
    return trimmed.replace(/^[/\\]+|[/\\]+$/g, "");
  };

  const parts: string[] = [];
  if (directory) parts.push(clean(directory, "directory"));
  if (filename) parts.push(clean(filename, "filename"));
  if (parts.length === 0) return undefined;
  return parts.join("/");
}

/** Keys whose string values are element refs (top frame: bare, sub-frames: "f<id>.<ref>"). */
const REF_KEYS = new Set(["ref", "fromRef", "toRef", "formRef"]);

/**
 * Element refs are namespaced with their frame so the same local ref can exist
 * in several frames at once. Top-frame refs stay bare for backward compat.
 */
export function frameRef(frameId: number, ref: string): string {
  return frameId > 0 ? `f${frameId}.${ref}` : ref;
}

/** Split a possibly frame-prefixed ref. Bare refs belong to the top frame. */
export function parseFrameRef(ref: string): { frameId: number; ref: string } {
  const match = /^f(\d+)\.([A-Za-z0-9_-]+)$/.exec(ref);
  if (match) return { frameId: Number(match[1]), ref: match[2] };
  return { frameId: 0, ref };
}

/** Recursively rewrite refs in a result tree, prefixing sub-frame refs. */
function prefixRefs(value: unknown, frameId: number): unknown {
  if (frameId <= 0 || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => prefixRefs(item, frameId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REF_KEYS.has(key) && typeof val === "string" ? frameRef(frameId, val) : prefixRefs(val, frameId);
    }
    return out;
  }
  return value;
}

/** Recursively strip a known frame prefix ("fN.") from refs inside an op. */
function stripRefPrefixes(value: unknown, frameId: number): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => stripRefPrefixes(item, frameId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (REF_KEYS.has(key) && typeof val === "string") {
        const parsed = parseFrameRef(val);
        out[key] = parsed.frameId === frameId ? parsed.ref : val;
      } else if (key === "refs" && Array.isArray(val)) {
        // Plural-ref ops (topViewportBoxes): their array items are refs
        // too, but the old code passed them through unstripped, so a
        // sub-frame agent received "f3.a" and its resolve() (bare-ref
        // regex) returned null → STALE_ELEMENT for every sub-frame
        // call. Strip exactly like singular refs.
        out[key] = val.map((item) => {
          if (typeof item !== "string") return item;
          const parsed = parseFrameRef(item);
          return parsed.frameId === frameId ? parsed.ref : item;
        });
      } else {
        out[key] = stripRefPrefixes(val, frameId);
      }
    }
    return out;
  }
  return value;
}

/**
 * Determine the target frame from an explicit frameId and/or refs embedded in the op.
 * A frameId/ref contradiction is an explicit INVALID_INPUT failure, never a
 * silent fallback to one of the two frames. Likewise, refs from two
 * different frames in one op are an error: the old code took the maximum
 * frame id, silently routing the whole op to one frame while its other
 * refs resolved in that frame's document instead of their own.
 * Bare (top-frame) refs carry no frame inference and are ignored here,
 * preserving the established explicit-frameId behaviour for them.
 */
function resolveFrameTarget(op: PageOp, explicitFrameId?: number): number {
  const inferredFrames = new Set<number>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (REF_KEYS.has(key) && typeof val === "string") {
          const { frameId } = parseFrameRef(val);
          if (frameId > 0) inferredFrames.add(frameId);
        } else if (key === "refs" && Array.isArray(val)) {
          // Plural-ref ops (topViewportBoxes) carry their refs as an
          // array, not under a REF_KEYS key: without this branch those
          // refs were never scanned and mixed frames slipped through.
          for (const item of val) {
            if (typeof item === "string") {
              const { frameId } = parseFrameRef(item);
              if (frameId > 0) inferredFrames.add(frameId);
            }
          }
        } else {
          scan(val);
        }
      }
    }
  };
  scan(op);
  if (inferredFrames.size > 1) {
    const frames = [...inferredFrames].sort((a, b) => a - b).join(", ");
    throw new ToolErrorException("INVALID_INPUT", `Refs in one operation belong to different frames (${frames}); re-observe and retry with refs from a single frame`);
  }
  const inferred = inferredFrames.size === 1 ? [...inferredFrames][0] : 0;
  const frameId = explicitFrameId ?? 0;
  if (frameId > 0 && inferred > 0 && inferred !== frameId) {
    throw new ToolErrorException("INVALID_INPUT", `frameId ${frameId} does not match the frame ${inferred} encoded in the ref`);
  }
  return frameId > 0 ? frameId : inferred;
}

/**
 * Run a self-contained page operation and surface agent errors as typed tool
 * errors. Refs on the way out are frame-namespaced; refs on the way in (or an
 * explicit frameId argument) route the injection into that iframe. The top
 * frame keeps the original single-frame injection path.
 */
export async function settlePage(
  ctx: BrowserContext,
  tabId: number,
  options: { waitMs?: number; waitForNetworkIdle?: boolean },
  frameId?: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (options.waitMs && options.waitMs > 0) {
    await abortableDelay(options.waitMs, signal);
  }
  if (options.waitForNetworkIdle) {
    await runPageOp(ctx, tabId, { op: "networkIdle", quietMs: 300, timeoutMs: 8_000 }, frameId, signal);
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled");
  }
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Coordinate bounds applied at handler level (the schema layer, owned by the
 * contracts section, is asked to carry the same finite / >= 0 / <= 100000
 * bounds): coordinates must be finite and within 0..100000 CSS pixels.
 */
export function assertCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new ToolErrorException("INVALID_INPUT", `Coordinate ${label} must be a finite number between 0 and 100000, got ${value}`);
  }
}

/**
 * Best-effort viewport check: coordinates that fall outside the visible
 * viewport cannot be hit by elementFromPoint, so they are rejected rather
 * than silently clicking the page body. When the viewport cannot be read
 * (injection failure), the check is skipped and the coordinate bounds above
 * are the only guard.
 */
export async function assertViewportCoords(
  ctx: BrowserContext,
  tabId: number,
  points: { x: number; y: number }[],
  frameId?: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const point of points) {
    assertCoordinate(point.x, "x");
    assertCoordinate(point.y, "y");
  }
  let viewport: { width: number; height: number } | null = null;
  try {
    viewport = await runPageOp<{ width: number; height: number }>(ctx, tabId, { op: "getViewport" }, frameId, signal);
  } catch {
    viewport = null;
  }
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return;
  for (const point of points) {
    if (point.x > viewport.width || point.y > viewport.height) {
      throw new ToolErrorException(
        "INVALID_INPUT",
        `Coordinate (${point.x}, ${point.y}) is outside the ${viewport.width}x${viewport.height} viewport; scroll the target into view first`,
      );
    }
  }
}

/**
 * CDP fast paths are top-frame only. Callers must check this before touching
 * CDP: a sub-frame (frameId > 0) always takes the synthetic page-agent path,
 * which records method: "synthetic" in its result.
 */
export function isTopFrameCdp(ctx: BrowserContext, frameId?: number): boolean {
  return Boolean(ctx.cdp?.available()) && (!frameId || frameId === 0);
}

/** CDP is available at all, regardless of frame. CDP input is tab-level:
 * mouse input needs top-viewport coordinates (see topViewportBox), but
 * key/text input goes to whatever element is focused, in any frame, so
 * type/press/fill/clear can use CDP in a sub-frame after focusing. */
export function isCdpAvailable(ctx: BrowserContext): boolean {
  return Boolean(ctx.cdp?.available());
}

export async function mapScreenshotCoords(
  ctx: BrowserContext,
  tabId: number,
  x: number,
  y: number,
  coordinateSpace: "css" | "screenshot" | undefined,
  frameId?: number,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  if (coordinateSpace !== "screenshot") return { x, y };
  const viewport = await runPageOp<{ devicePixelRatio: number }>(ctx, tabId, { op: "getViewport" }, frameId, signal);
  const dpr = viewport.devicePixelRatio || 1;
  return { x: x / dpr, y: y / dpr };
}

export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new ToolErrorException("CANCELLED", "Operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function runPageOp<T>(
  ctx: BrowserContext,
  tabId: number,
  op: PageOp,
  frameId?: number,
  signal?: AbortSignal,
): Promise<T> {
  const targetFrame = resolveFrameTarget(op, frameId);
  const attempt = async (): Promise<unknown> => {
    throwIfAborted(signal);
    if (targetFrame > 0) {
      const frames = await ctx.executeInFrames(tabId, pageAgent, stripRefPrefixes(op, targetFrame) as PageOp, [targetFrame]);
      const hit = frames[0];
      if (!hit) throw new ToolErrorException("NOT_FOUND", `Frame ${targetFrame} is not reachable in this tab`);
      if (hit.error) throw new ToolErrorException(hit.error as ToolErrorCode, `Page operation ${op.op} failed: ${hit.error}`);
      return prefixRefs(hit.result, targetFrame);
    }
    return (await ctx.executeInPage(tabId, pageAgent, op)) as Record<string, unknown>;
  };
  let raw: unknown;
  try {
    raw = await raceWithAbort(attempt(), signal);
    throwIfAborted(signal);
  } catch (error) {
    if (ToolErrorException.is(error) && (error.code === "STALE_ELEMENT" || /STALE_ELEMENT/.test(error.message))) {
      await abortableDelay(50, signal);
      raw = await raceWithAbort(attempt(), signal);
    } else {
      throw error;
    }
  }
  const failed = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).error === "string";
  if (failed) {
    const code = (raw as Record<string, string>).error;
    if (code === "STALE_ELEMENT") {
      await abortableDelay(50, signal);
      raw = await raceWithAbort(attempt(), signal);
      const failed2 = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).error === "string";
      if (failed2) {
        throw new ToolErrorException((raw as Record<string, string>).error as ToolErrorCode, `Page operation ${op.op} failed: ${(raw as Record<string, string>).error}`);
      }
      return raw as T;
    }
    throw new ToolErrorException(code as ToolErrorCode, `Page operation ${op.op} failed: ${code}`);
  }
  return raw as T;
}
