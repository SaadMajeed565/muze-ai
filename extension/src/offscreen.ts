import { sliceGeometry } from "../libs/browser-engine/page/stitch.js";
import { LEGACY_OFFSCREEN_TARGET, OFFSCREEN_TARGET } from "./messages.js";

const TARGET = OFFSCREEN_TARGET;

// SW keepalive — offscreen documents are NOT subject to MV3's 30-second idle kill.
// A message every 20s resets the service worker's idle timer, keeping the WebSocket
// connection to the gateway running 24/7 without disconnects.
setInterval(() => {
  chrome.runtime.sendMessage({ target: "muze-service-worker", type: "SW_KEEPALIVE" }).catch(() => {
    // SW restarting — self-heals at next tick
  });
}, 20_000);

type OffscreenRequest = { target?: string; type: string; payload?: unknown };

async function handle(type: string, payload: unknown): Promise<unknown> {
  switch (type) {
    case "clipboardRead":
      return await navigator.clipboard.readText();
    case "clipboardWrite": {
      const { text } = payload as { text: string };
      await navigator.clipboard.writeText(text);
      return null;
    }
    case "imageDimensions": {
      const { dataUrl } = payload as { dataUrl: string };
      const image = await loadImage(dataUrl);
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
    case "cropImage": {
      const { dataUrl, rect, format, quality } = payload as {
        dataUrl: string;
        rect: { x: number; y: number; width: number; height: number };
        format: "png" | "jpeg";
        quality?: number;
      };
      const image = await loadImage(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
      return {
        dataUrl: canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png", quality),
        width: canvas.width,
        height: canvas.height,
      };
    }
    case "stitchImages": {
      const { slices, width, height, viewportHeight, documentHeight, format, quality } = payload as {
        slices: { dataUrl: string; docStart: number; docEnd: number; scrollY: number }[];
        width: number;
        height: number;
        viewportHeight: number;
        documentHeight: number;
        format: "png" | "jpeg";
        quality?: number;
      };
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      for (const slice of slices) {
        const image = await loadImage(slice.dataUrl);
        const rect = sliceGeometry(slice, {
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          viewportHeight,
          documentHeight,
        });
        ctx.drawImage(image, 0, rect.sy, image.naturalWidth, rect.sh, 0, rect.dy, canvas.width, rect.dh);
      }
      return {
        dataUrl: canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png", quality),
        width: canvas.width,
        height: canvas.height,
        pages: slices.length,
      };
    }
    default:
      throw new Error(`Unknown offscreen request "${type}"`);
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = dataUrl;
  });
}

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse: (response: unknown) => void) => {
  // Accept the legacy target inbound so an in-flight service worker built
  // before v0.3.0 can still reach this document; all new sends use TARGET.
  // No payload, token or secret is ever logged here.
  if (message?.target !== TARGET && message?.target !== LEGACY_OFFSCREEN_TARGET) return false;
  handle(message.type, message.payload)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
