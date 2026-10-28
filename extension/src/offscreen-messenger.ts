import type { OffscreenMessenger } from "./chrome-context.js";
import { OFFSCREEN_TARGET } from "./messages.js";

const OFFSCREEN_PATH = "offscreen.html";

let creating: Promise<void> | null = null;

async function hasDocument(): Promise<boolean> {
  const offscreen = chrome.offscreen;
  if (!offscreen?.hasDocument) return false;
  return offscreen.hasDocument();
}

async function ensureDocument(): Promise<void> {
  if (await hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.BLOBS],
        justification: "Read/write the clipboard and crop element screenshots for approved tool calls.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await Promise.race([
    creating,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("offscreen document creation timed out")), 10_000)),
  ]);
}

/**
 * Bridges the service worker to a short-lived offscreen document that has DOM
 * access (clipboard + canvas). Degrades gracefully when the API is unavailable.
 *
 * Timeouts are kept as-is (10s document creation, 15s per request) and are
 * surfaced as clear errors. No request type, payload, token or secret is
 * ever logged here — errors carry only the request type name.
 */
export class ChromeOffscreenMessenger implements OffscreenMessenger {
  available(): boolean {
    return Boolean(chrome.offscreen && chrome.runtime?.id);
  }

  async request<T>(type: string, payload?: unknown): Promise<T> {
    await ensureDocument();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = (await Promise.race([
          chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type, payload }),
          new Promise<undefined>((_, reject) => setTimeout(() => reject(new Error(`Offscreen request "${type}" timed out`)), 15_000)),
        ])) as
          | { ok: true; value: T }
          | { ok: false; error: string }
          | undefined;
        if (!response || typeof response !== "object") throw new Error(`Offscreen request "${type}" got no response`);
        if (!response.ok) throw new Error(response.error);
        return response.value;
      } catch (error) {
        lastError = error;
        if (!String(error).includes("Receiving end does not exist")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
