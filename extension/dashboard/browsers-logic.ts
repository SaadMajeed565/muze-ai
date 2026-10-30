import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../src/messages.js";

/** Pure view helpers for the Browsers page (unit-tested, no chrome APIs). */

export function formatTimestamp(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "Unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "Unknown";
  }
}

/** Status is always a dot + a word, never colour alone. */
export function browserStatus(browser: DashboardBrowser): "Connected" | "Disconnected" {
  return browser.connected ? "Connected" : "Disconnected";
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

/** The last browser cannot be removed (account deletion is the path for it). */
export function canRemoveBrowser(data: BrowsersDashboard, sessionId: string): boolean {
  return data.browsers.length > 1 && data.browsers.some((browser) => browser.sessionId === sessionId);
}

export function browserDetail(browser: DashboardBrowser): string {
  return [browser.browser, browser.os, browser.version].filter(Boolean).join(" · ");
}

export function tabCountText(browser: DashboardBrowser): string {
  if (!browser.connected) return "Unknown";
  if (browser.tabCount === null) return "Unknown";
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
