import { describe, expect, it } from "vitest";
import {
  NAV_TABS,
  activityRows,
  activityVerb,
  dedupeAppsByName,
  homeNextAction,
  mergeActivity,
  plainActivityKind,
  plainCapabilities,
  plainDecision,
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

  it("merges only consecutive call/result pairs, and never drops unpaired records", () => {
    const call = (id: string, tool: string, client = "c1") =>
      ({ id, kind: "tool.call", tool, decision: "allowed", client: { id: client, name: "ChatGPT" }, at: new Date(1000).toISOString() }) as never;
    const result = (id: string, tool: string, decision = "allowed", client = "c1") =>
      ({ id, kind: "tool.result", tool, decision, client: { id: client, name: "ChatGPT" }, at: new Date(2000).toISOString() }) as never;
    // Newest-first input: audit_3 result, audit_2 call merge; audit_1 stays.
    expect(mergeActivity([result("audit_3", "tabs.list"), call("audit_2", "tabs.list"), call("audit_1", "tabs.list")])).toHaveLength(2);
    // Interleaved concurrent call breaks consecutiveness: nothing merges.
    const interleaved = [
      result("audit_4", "tabs.list"),
      call("audit_3", "dom.click"),
      call("audit_2", "tabs.list"),
    ];
    expect(mergeActivity(interleaved as never)).toHaveLength(3);
    // Different tool or different client: no merge.
    expect(mergeActivity([result("audit_3", "dom.click"), call("audit_2", "tabs.list")] as never)).toHaveLength(2);
    expect(mergeActivity([result("audit_3", "tabs.list", "allowed", "c2"), call("audit_2", "tabs.list")] as never)).toHaveLength(2);
    // Non-sequential ids: no merge.
    expect(mergeActivity([result("audit_9", "tabs.list"), call("audit_2", "tabs.list")] as never)).toHaveLength(2);
  });

  it("builds merged rows with one plain sentence, relative time, and Denied/Failed only", () => {
    const events = [
      { id: "audit_2", kind: "tool.result", tool: "tabs.list", decision: "denied", client: { id: "oc_1", name: "Universal Browser Tools (remote MCP)" }, at: new Date(2000).toISOString() },
      { id: "audit_1", kind: "tool.call", tool: "tabs.list", decision: "allowed", client: { id: "oc_1", name: "Universal Browser Tools (remote MCP)" }, at: new Date(1000).toISOString() },
    ] as never;
    const rows = activityRows(events, registered, 2000);
    expect(rows).toHaveLength(1);
    expect(rows[0].sentence).toBe("ChatGPT read a page.");
    expect(rows[0].state).toBe("Denied");
    expect(rows[0].time).toBe("0s");
    expect(rows[0].sentence).not.toContain("tabs.list");
    const allowed = activityRows(
      [{ id: "audit_5", kind: "tool.call", tool: "tabs.list", decision: "allowed", client: { id: "c1", name: "Claude" }, at: new Date(2000).toISOString() }] as never,
      registered, 2000,
    );
    expect(allowed[0].state).toBeNull();
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

  it("maps activity kinds and decisions to plain words", () => {
    expect(plainActivityKind("client.connect")).toBe("AI app connected");
    expect(plainActivityKind("tool.call")).toBe("Agent acted");
    expect(plainDecision("approval-required")).toBe("Waiting for approval");
    expect(plainDecision("denied")).toBe("Denied");
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

  it("picks exactly one next action for Home, by priority", () => {
    expect(homeNextAction({ signedIn: false, setupRemaining: 3, pendingApprovals: 2 })).toBe("sign-in");
    expect(homeNextAction({ signedIn: true, setupRemaining: 1, pendingApprovals: 2 })).toBe("setup");
    expect(homeNextAction({ signedIn: true, setupRemaining: 0, pendingApprovals: 1 })).toBe("approvals");
    expect(homeNextAction({ signedIn: true, setupRemaining: 0, pendingApprovals: 0 })).toBe("browsers");
  });
});
