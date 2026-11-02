import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../src/messages.js";
import { relativeTime, shortDate } from "./ui-logic.js";

/** Pure view helpers for the Connections page (unit-tested, no chrome APIs). */

export { relativeTime, shortDate };

/**
 * Browser + OS for a row's meta line, e.g. "Chrome - Linux". Empty
 * parts are dropped; an empty result means the meta part is omitted,
 * never guessed.
 */
export function browserOsName(browser: DashboardBrowser): string {
  return [browser.browser, browser.os].filter(Boolean).join(" - ");
}

/** Browser status is always a dot + a word, never colour alone. */
export function browserStatus(browser: DashboardBrowser): "Online" | "Offline" {
  return browser.connected ? "Online" : "Offline";
}

export function mcpClientStatus(client: DashboardMcpClient): "Connected" | "Not connected" {
  return client.live ? "Connected" : "Not connected";
}

export function attachedClients(data: BrowsersDashboard, sessionId: string): DashboardMcpClient[] {
  return data.mcpClients.filter((client) => client.sessionId === sessionId);
}

export function defaultBrowser(data: BrowsersDashboard): DashboardBrowser | null {
  return data.browsers.find((browser) => browser.sessionId === data.defaultSessionId) ?? data.browsers[0] ?? null;
}

/**
 * The browser running this dashboard ("this browser"), the single
 * resolution shared by Home and any other this-browser caller.
 * Priority: currentSessionId first — it names the session this
 * dashboard runs in, so it must win over the account default; then
 * the row flagged isLocal; then the account default (defaultBrowser),
 * which exists for routing old clients, not for identifying this
 * browser. defaultBrowser itself is unchanged: it still answers the
 * account-default question (e.g. browserCounts) only.
 */
export function currentBrowser(data: BrowsersDashboard): DashboardBrowser | null {
  return (
    data.browsers.find((browser) => browser.sessionId === data.currentSessionId) ??
    data.browsers.find((browser) => browser.isLocal) ??
    defaultBrowser(data)
  );
}

/** The last browser cannot be removed (account deletion is the path for it). */
export function canRemoveBrowser(data: BrowsersDashboard, sessionId: string): boolean {
  return data.browsers.length > 1 && data.browsers.some((browser) => browser.sessionId === sessionId);
}

export function browserDetail(browser: DashboardBrowser): string {
  return [browser.browser, browser.os, browser.version].filter(Boolean).join(" · ");
}

/**
 * Tab count, only when connected AND known. Unknown is null so the
 * caller omits it — never "Unknown", never a guess.
 */
export function tabCountText(browser: DashboardBrowser): string | null {
  if (!browser.connected) return null;
  if (browser.tabCount === null) return null;
  return `${browser.tabCount} tab${browser.tabCount === 1 ? "" : "s"}`;
}

export interface BrowserCounts {
  attached: number;
  connected: number;
  liveClients: number;
  defaultName: string | null;
}

export function browserCounts(data: BrowsersDashboard): BrowserCounts {
  const fallback = defaultBrowser(data);
  return {
    attached: data.browsers.length,
    connected: data.browsers.filter((browser) => browser.connected).length,
    liveClients: data.mcpClients.filter((client) => client.live).length,
    defaultName: fallback ? fallback.name : null,
  };
}
