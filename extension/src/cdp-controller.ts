import type { CdpCapability } from "../libs/browser-engine/index.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";

const CDP_VERSION = "1.3";

/**
 * Bound for one CDP input sequence. The 2026-10-28 retest saw dom.click,
 * dom.hover and dom.setChecked time out at the 30s executor / 60s bridge
 * limits on a Wikipedia searchbox, while CDP focus/type/clear/fill/press
 * and clickAt on the same page succeeded — no code cause for a stall on
 * that element type was found (the click/hover paths are the same
 * attach → move → command → detach sequence as the passing paths, and
 * settlePage is a no-op without waitMs/waitForNetworkIdle). A stalled
 * debugger attach or sendCommand must therefore not hang until the
 * executor limit: it fails fast with a diagnosable TIMEOUT, detaches,
 * and leaves the caller free to retry or to use clickAt. This does NOT
 * claim the underlying stall is fixed — a live retest on a different
 * element is still needed to tell a page-specific stall from a CDP one.
 */
const CDP_SEQUENCE_TIMEOUT_MS = 15_000;
const CDP_DETACH_TIMEOUT_MS = 2_000;

/**
 * Enterprise hardware-level interaction via Chrome DevTools Protocol (CDP).
 *
 * Dispatches genuine hardware input events (`isTrusted: true`), which bypasses
 * synthetic-event restrictions on React 18/19 controlled inputs, native HTML5
 * form controls, file pickers, and anti-bot verification turnstiles.
 *
 * DETACH RULE (v0.3.0): a tab must not stay debugger-attached indefinitely.
 * A lingering attachment shows Chrome's debugger banner, blocks the user
 * from using DevTools on that tab, and keeps a privileged channel open with
 * no work in flight. So every input sequence and every screenshot detaches
 * when it finishes — UNLESS another CDP call for the same tab is still in
 * flight, in which case the last one out detaches (reference-counted per
 * tab, so concurrent sequences cannot detach each other mid-input).
 * Detach also happens on tab close / external detach (listeners below).
 *
 * Trade-off, stated plainly: detaching after every call costs one
 * `debugger.attach` round trip on the next call to that tab, versus the old
 * behaviour of attaching once and never letting go. Attach is cheap and
 * local; a lingering debugger banner and an open privileged channel are
 * not, so the re-attach cost is the right side of that trade.
 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ChromeCdpCapability implements CdpCapability {
  private readonly attachedTabs = new Set<number>();
  private readonly attachingPromises = new Map<number, Promise<void>>();
  /** CDP calls currently running per tab; auto-detach fires only at zero. */
  private readonly inflight = new Map<number, number>();
  /** Last genuine mouse position per tab, so a move/click can travel there
   * instead of teleporting. A site that watches mouse behaviour can tell a
   * single instant jump apart from a human move, even though both are
   * isTrusted. Unknown on first use in a tab: the first move goes straight
   * to its target, and later moves travel from the tracked position. */
  private readonly lastMouse = new Map<number, { x: number; y: number }>();

  constructor() {
    if (typeof chrome !== "undefined") {
      if (chrome.debugger?.onDetach) {
        chrome.debugger.onDetach.addListener((source) => {
          if (source.tabId) this.attachedTabs.delete(source.tabId);
        });
      }
      if (chrome.tabs?.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
          this.attachedTabs.delete(tabId);
          this.inflight.delete(tabId);
          this.lastMouse.delete(tabId);
        });
      }
    }
  }

  available(): boolean {
    return typeof chrome !== "undefined" && Boolean(chrome.debugger?.attach);
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    const existing = this.attachingPromises.get(tabId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
        this.attachedTabs.add(tabId);
      } catch (error) {
        // Tab might already have a debugger attached
        if (/Already attached/i.test(String(error))) {
          this.attachedTabs.add(tabId);
          return;
        }
        throw error;
      }
    })().finally(() => {
      this.attachingPromises.delete(tabId);
    });

    this.attachingPromises.set(tabId, promise);
    return promise;
  }

  /** Run one CDP sequence, detaching afterwards unless another call is in flight. */
  private async withTab<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    await this.ensureAttached(tabId);
    this.inflight.set(tabId, (this.inflight.get(tabId) ?? 0) + 1);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(
                new ToolErrorException(
                  "TIMEOUT",
                  `CDP input sequence did not complete within ${CDP_SEQUENCE_TIMEOUT_MS}ms (debugger attach or a command stalled). Detach was attempted; retry once, and if it repeats, check whether another debugger or DevTools session is attached to the tab.`,
                ),
              );
            }, CDP_SEQUENCE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      const remaining = (this.inflight.get(tabId) ?? 1) - 1;
      if (remaining <= 0) {
        this.inflight.delete(tabId);
        // Detach must not itself hang the call: cap it and ignore errors.
        await Promise.race([
          this.detach(tabId),
          new Promise<void>((resolve) => setTimeout(resolve, CDP_DETACH_TIMEOUT_MS)),
        ]).catch(() => undefined);
      } else {
        this.inflight.set(tabId, remaining);
      }
    }
  }

  /** Move the genuine cursor to a point, travelling in steps from the last
   * tracked position when one is known. Must run inside withTab. */
  private async moveInside(tabId: number, x: number, y: number): Promise<void> {
    const target = { tabId };
    const from = this.lastMouse.get(tabId);
    if (!from) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x),
        y: Math.round(y),
      });
    } else {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(from.x + ((x - from.x) * i) / steps),
          y: Math.round(from.y + ((y - from.y) * i) / steps),
        });
        await delay(12);
      }
    }
    this.lastMouse.set(tabId, { x, y });
  }

  async move(tabId: number, x: number, y: number): Promise<void> {
    await this.withTab(tabId, async () => {
      await this.moveInside(tabId, x, y);
    });
  }

  async click(tabId: number, x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      const cdpButton = button === "right" ? "right" : button === "middle" ? "middle" : "left";

      // Travel -> hover dwell -> press -> hold -> release. The old version
      // sent move/press/release back to back with no timing, which is a
      // recognisably non-human sequence even though every event isTrusted.
      await this.moveInside(tabId, x, y);
      await delay(50);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        clickCount,
      });
      await delay(60);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        clickCount,
      });
      this.lastMouse.set(tabId, { x, y });
    });
  }

  async type(tabId: number, text: string): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      // Input.insertText dispatches trusted input directly to the focused element
      await chrome.debugger.sendCommand(target, "Input.insertText", { text });
    });
  }

  async press(tabId: number, key: string, modifiers = 0): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        modifiers,
        windowsVirtualKeyCode: getKeyCode(key),
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        modifiers,
        windowsVirtualKeyCode: getKeyCode(key),
      });
    });
  }

  async scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(x),
        y: Math.round(y),
        deltaX: Math.round(deltaX),
        deltaY: Math.round(deltaY),
      });
    });
  }

  async drag(tabId: number, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(fromX),
        y: Math.round(fromY),
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(fromX),
        y: Math.round(fromY),
        button: "left",
        clickCount: 1,
      });
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        const curX = fromX + ((toX - fromX) * i) / steps;
        const curY = fromY + ((toY - fromY) * i) / steps;
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(curX),
          y: Math.round(curY),
          buttons: 1,
        });
      }
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(toX),
        y: Math.round(toY),
        button: "left",
        clickCount: 1,
      });
      this.lastMouse.set(tabId, { x: toX, y: toY });
    });
  }

  async captureScreenshot(
    tabId: number,
    clip?: { x: number; y: number; width: number; height: number; scale?: number },
    format: "jpeg" | "png" = "jpeg",
    quality = 60,
  ): Promise<string> {
    return this.withTab(tabId, async () => {
      const target = { tabId };
      const params: Record<string, unknown> = {
        format,
        ...(format === "jpeg" ? { quality } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      };
      if (clip) {
        params.clip = { ...clip, scale: clip.scale ?? 1 };
      }
      const result = (await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params)) as { data: string };
      return `data:image/${format};base64,${result.data}`;
    });
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // ignore
    } finally {
      this.attachedTabs.delete(tabId);
    }
  }
}

function getKeyCode(key: string): number {
  switch (key) {
    case "Enter": return 13;
    case "Backspace": return 8;
    case "Tab": return 9;
    case "Escape": return 27;
    case "ArrowUp": return 38;
    case "ArrowDown": return 40;
    case "ArrowLeft": return 37;
    case "ArrowRight": return 39;
    case "Delete": return 46;
    default: return key.charCodeAt(0) || 0;
  }
}
