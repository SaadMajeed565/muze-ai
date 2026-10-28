/**
 * Isolated-world page agent. Stays loaded so tool calls message this script
 * instead of re-serializing pageAgent on every chrome.scripting.executeScript.
 */

import { pageAgent, type PageOp } from "../../libs/browser-engine/page/agent.js";

chrome.runtime.onMessage.addListener((message: { type?: string; op?: PageOp }, _sender, sendResponse) => {
  // Canonical "muze/page-op" (v0.3.0); the legacy "uabb/page-op" spelling is
  // accepted inbound so pages injected by an older build keep working.
  if (!message || (message.type !== "muze/page-op" && message.type !== "uabb/page-op") || !message.op) return;
  Promise.resolve(pageAgent(message.op))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
