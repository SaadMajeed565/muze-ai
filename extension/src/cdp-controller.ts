import type { CdpCapability } from "../libs/browser-engine/index.js";

const CDP_VERSION = "1.3";

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
export class ChromeCdpCapability implements CdpCapability {
  private readonly attachedTabs = new Set<number>();
  private readonly attachingPromises = new Map<number, Promise<void>>();
  /** CDP calls currently running per tab; auto-detach fires only at zero. */
  private readonly inflight = new Map<number, number>();

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
      return await fn();
    } finally {
      const remaining = (this.inflight.get(tabId) ?? 1) - 1;
      if (remaining <= 0) {
        this.inflight.delete(tabId);
        await this.detach(tabId);
      } else {
        this.inflight.set(tabId, remaining);
      }
    }
  }

  async click(tabId: number, x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = { tabId };
      const cdpButton = button === "right" ? "right" : button === "middle" ? "middle" : "left";

      // Move -> Press -> Release
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x),
        y: Math.round(y),
      });

      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        clickCount,
      });

      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        clickCount,
      });
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
