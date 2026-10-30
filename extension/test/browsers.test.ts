import { describe, expect, test } from "vitest";
import { browserInfoFromUserAgent } from "../src/gateway-client.js";
import {
  attachedClients,
  browserCounts,
  browserDetail,
  canRemoveBrowser,
  defaultBrowser,
  formatTimestamp,
  tabCountText,
} from "../dashboard/browsers-logic.js";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../src/messages.js";

describe("browserInfoFromUserAgent", () => {
  test("parses Chrome on Windows", () => {
    const info = browserInfoFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    );
    expect(info).toMatchObject({ browser: "Chrome", os: "Windows", version: "141.0" });
    expect(info.name).toBe("Chrome on Windows");
  });

  test("parses Edge before Chrome (Edge UA contains Chrome)", () => {
    const info = browserInfoFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    );
    expect(info.browser).toBe("Edge");
  });

  test("parses Firefox on Linux and Safari on macOS", () => {
    expect(
      browserInfoFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"),
    ).toMatchObject({ browser: "Firefox", os: "Linux" });
    expect(
      browserInfoFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    ).toMatchObject({ browser: "Safari", os: "macOS" });
  });

  test("unknown agents degrade to empty fields, never a guessed name", () => {
    expect(browserInfoFromUserAgent("")).toEqual({});
    expect(browserInfoFromUserAgent("SomeBot/1.0")).toEqual({});
  });
});

const browser = (overrides: Partial<DashboardBrowser>): DashboardBrowser => ({
  sessionId: "browser-a",
  name: "Browser A",
  browser: "Chrome",
  os: "Windows",
  version: "141.0",
  createdAt: 1000,
  lastSeenAt: 2000,
  isDefault: true,
  connected: true,
  tabCount: 3,
  ...overrides,
});

const client = (overrides: Partial<DashboardMcpClient>): DashboardMcpClient => ({
  clientId: "oc_1",
  clientName: "ChatGPT",
  scope: "read:tools call:tools",
  sessionId: "browser-a",
  live: true,
  connectedSince: 1500,
  lastActivityAt: 1800,
  authorizedSince: 1200,
  lastRefreshedAt: 1700,
  expiresAt: 9999,
  ...overrides,
});

const data: BrowsersDashboard = {
  browsers: [browser({}), browser({ sessionId: "browser-b", name: "Browser B", isDefault: false, connected: false, tabCount: null })],
  defaultSessionId: "browser-a",
  currentSessionId: "browser-a",
  mcpClients: [client({}), client({ clientId: "oc_2", clientName: "Claude", sessionId: "browser-b", live: false, connectedSince: null, lastActivityAt: null })],
};

describe("browsers dashboard view logic", () => {
  test("tab count shows only when connected, otherwise Unknown", () => {
    expect(tabCountText(data.browsers[0])).toBe("3 tabs");
    expect(tabCountText(data.browsers[1])).toBe("Unknown");
    expect(tabCountText(browser({ connected: true, tabCount: null }))).toBe("Unknown");
    expect(tabCountText(browser({ connected: true, tabCount: 1 }))).toBe("1 tab");
  });

  test("timestamps degrade to Unknown, never a fabricated date", () => {
    expect(formatTimestamp(null)).toBe("Unknown");
    expect(formatTimestamp(0)).toBe("Unknown");
    expect(formatTimestamp(2000)).not.toBe("Unknown");
  });

  test("attached clients are filtered per browser", () => {
    expect(attachedClients(data, "browser-a").map((entry) => entry.clientName)).toEqual(["ChatGPT"]);
    expect(attachedClients(data, "browser-b").map((entry) => entry.clientName)).toEqual(["Claude"]);
  });

  test("the last browser cannot be removed, others can", () => {
    expect(canRemoveBrowser(data, "browser-a")).toBe(true);
    expect(canRemoveBrowser({ ...data, browsers: [data.browsers[0]] }, "browser-a")).toBe(false);
    expect(canRemoveBrowser(data, "browser-missing")).toBe(false);
  });

  test("default browser and counts", () => {
    expect(defaultBrowser(data)?.sessionId).toBe("browser-a");
    expect(browserCounts(data)).toMatchObject({ attached: 2, connected: 1, liveClients: 1, defaultName: "Browser A" });
    expect(browserDetail(data.browsers[0])).toBe("Chrome · Windows · 141.0");
    expect(browserDetail(browser({ browser: "", os: "", version: "" }))).toBe("");
  });
});
