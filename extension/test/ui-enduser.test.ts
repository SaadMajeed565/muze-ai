import { describe, expect, it } from "vitest";
import {
  NAV_GROUPS,
  homeNextAction,
  navGroupTabs,
  plainActivityKind,
  plainCapabilities,
  plainDecision,
  plainPauseReason,
  plainStep,
  plainTaskStatus,
  stripToolTokens,
  truncateText,
} from "../dashboard/ui-logic.js";

describe("end-user navigation", () => {
  it("groups tabs with no Tools entry and covers every tab exactly once", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual(["Home", "Devices", "Safety", "Activity"]);
    const tabs = navGroupTabs();
    expect(tabs).toEqual(["overview", "browsers", "files", "permissions", "tasks", "activity"]);
    expect(tabs).not.toContain("tools");
    expect(new Set(tabs).size).toBe(tabs.length);
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
