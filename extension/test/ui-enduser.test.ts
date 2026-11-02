import { describe, expect, it } from "vitest";
import {
  NAV_TABS,
  activityVerb,
  dedupeAppsByName,
  plainCapabilities,
  plainPauseReason,
  plainStep,
  plainTaskStatus,
  relativeTime,
  resolveAppName,
  shortDate,
  stripToolTokens,
  truncateText,
} from "../dashboard/ui-logic.js";

describe("end-user navigation", () => {
  it("has exactly five tabs with no Tools, Browsers, Safety, or Activity entry", () => {
    expect(NAV_TABS).toEqual(["home", "tasks", "connections", "files", "account"]);
    expect(NAV_TABS).not.toContain("tools");
    expect(NAV_TABS).not.toContain("browsers");
    expect(NAV_TABS).not.toContain("permissions");
    expect(NAV_TABS).not.toContain("activity");
    expect(NAV_TABS).not.toContain("overview");
    expect(NAV_TABS).not.toContain("profile");
    expect(new Set(NAV_TABS).size).toBe(NAV_TABS.length);
  });
});

describe("v3 audit presentation", () => {
  const registered = [{ clientId: "oc_1", clientName: "ChatGPT" }];

  it("resolves the gateway hello name to the registered app, and unknown actors to AI app", () => {
    // Gateway name + a real registered client id resolves to that app.
    expect(resolveAppName({ id: "oc_1", name: "Universal Browser Tools (remote MCP)" }, registered)).toBe("ChatGPT");
    // A pure hello-client actor (id muze-gateway, no matching
    // registration) honestly falls back to "AI app" — it cannot be
    // guessed from a list that may hold several apps.
    expect(resolveAppName({ id: "muze-gateway", name: "Universal Browser Tools (remote MCP)" }, registered)).toBe("AI app");
    expect(resolveAppName({ id: "oc_1", name: "oc_1" }, registered)).toBe("ChatGPT");
    expect(resolveAppName({ id: "oc_9", name: "Universal Browser Tools" }, registered)).toBe("AI app");
    expect(resolveAppName(null, registered)).toBe("AI app");
    expect(resolveAppName({ id: "c2", name: "Claude" }, registered)).toBe("Claude");
  });

  it("dedupes apps by name, keeping every underlying authorisation", () => {
    const groups = dedupeAppsByName([
      { clientId: "oc_1", clientName: "ChatGPT", sessionId: "s1", live: true } as never,
      { clientId: "oc_2", clientName: "ChatGPT", sessionId: "s2", live: false } as never,
      { clientId: "oc_3", clientName: "Claude", sessionId: "s1", live: false } as never,
    ]);
    expect(groups.map((group) => group.name)).toEqual(["ChatGPT", "Claude"]);
    expect(groups[0].clients).toHaveLength(2);
    expect(groups[0].live).toBe(true);
  });

  it("omits unknown dates instead of printing Unknown, and shortens known ones", () => {
    expect(shortDate(null)).toBeNull();
    expect(shortDate(0)).toBeNull();
    expect(shortDate(new Date(2026, 9, 15).getTime())).toBe("Oct 15");
    const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
    expect(relativeTime(now - 13_000, now)).toBe("13s");
    expect(relativeTime(now - 2 * 60_000, now)).toBe("2m");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime(now - 20 * 86_400_000, now)).toBe("Sep 25");
  });

  it("maps tool names to plain verbs, never the raw name", () => {
    expect(activityVerb("tabs.list")).toBe("read a page");
    expect(activityVerb("tabs.navigate")).toBe("opened a page");
    expect(activityVerb("dom.click")).toBe("used the page");
    expect(activityVerb("tabs.create")).toBe("opened a page");
    expect(activityVerb("something.new")).toBe("acted in the browser");
    expect(activityVerb(undefined)).toBe("acted in the browser");
  });


});

describe("plain-word mappings", () => {
  it("maps task statuses and step states to plain words", () => {
    expect(plainTaskStatus("waiting_approval")).toBe("Waiting for you");
    expect(plainTaskStatus("failed")).toBe("Didn't finish");
    expect(plainTaskStatus("partial")).toBe("Partly done");
    expect(plainStep({ index: 0, state: "done", outputSummary: "3 tabs listed" })).toEqual({
      number: 1,
      state: "Done",
      summary: "3 tabs listed",
    });
  });

  it("never surfaces a tool name in a step summary", () => {
    const step = plainStep({ index: 1, state: "failed", outputSummary: "Step 1 (dom.click) failed" });
    expect(step.summary).not.toContain("dom.click");
    expect(stripToolTokens("Step 0 (tabs.list): close-tab — executed.")).toBe("Step 0: close-tab — executed.");
  });

  it("truncates long text and maps pause reasons to plain words", () => {
    expect(truncateText("word ".repeat(100), 30).length).toBeLessThanOrEqual(30);
    expect(truncateText("short")).toBe("short");
    expect(plainPauseReason("verify-failed")).toBe("A check didn't pass, so the task paused.");
    expect(plainPauseReason(undefined)).toBeNull();
  });

  it("derives capabilities from level and groups only, never tool names", () => {
    const caps = plainCapabilities("default", { bookmarks: true, history: false, downloads: true, clipboard: true });
    expect(caps).toContain("Read pages");
    expect(caps).toContain("Use bookmarks");
    expect(caps).toContain("Manage downloads");
    expect(caps).not.toContain("history");
    expect(caps.join(" ")).not.toMatch(/[a-z]+\.[a-z]+/);
    expect(plainCapabilities("restricted", {})).toEqual(["Read pages"]);
  });

});
