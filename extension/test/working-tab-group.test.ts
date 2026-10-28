/**
 * Working-tab group tests: the "Muze AI" group is visible while a
 * task runs, and ungrouping on finish never closes a tab and
 * restores a tab's previous group.
 */
import { describe, expect, it } from "vitest";
import { ChromeWorkingTabGroup, WORKING_TAB_GROUP_TITLE } from "../libs/browser-engine/working-tab-group.js";
import type { RawTab } from "../libs/browser-engine/context.js";

interface FakeTab {
  id: number;
  groupId: number;
}

class FakeContext {
  tabs = new Map<number, FakeTab>();
  groupCalls: { tabIds: number[]; groupId?: number; title?: string; color?: string }[] = [];
  ungroupCalls: number[][] = [];
  closedTabs: number[] = [];
  private nextGroupId = 10;

  constructor(tabs: FakeTab[]) {
    for (const tab of tabs) this.tabs.set(tab.id, { ...tab });
  }

  async getTab(tabId: number): Promise<RawTab> {
    const tab = this.tabs.get(tabId);
    if (!tab || this.closedTabs.includes(tabId)) throw new Error(`tab ${tabId} not found`);
    return { id: tab.id, index: 0, windowId: 1, active: false, pinned: false, highlighted: false, groupId: tab.groupId, discarded: false, incognito: false };
  }

  async groupTabs(tabIds: number[], options: { groupId?: number; title?: string; color?: string }): Promise<number> {
    const groupId = options.groupId ?? this.nextGroupId++;
    this.groupCalls.push({ tabIds, groupId, title: options.title, color: options.color });
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab) tab.groupId = groupId;
    }
    return groupId;
  }

  async ungroupTabs(tabIds: number[]): Promise<void> {
    this.ungroupCalls.push(tabIds);
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab) tab.groupId = -1;
    }
  }
}

describe("ChromeWorkingTabGroup", () => {
  it("groups touched tabs into one Muze AI group and ungroups them on finish, keeping tabs open", async () => {
    const ctx = new FakeContext([
      { id: 1, groupId: -1 },
      { id: 2, groupId: 7 },
    ]);
    const group = new ChromeWorkingTabGroup(ctx);
    await group.trackTab("task-1", 1);
    await group.trackTab("task-1", 2);
    expect(ctx.groupCalls[0].title).toBe(WORKING_TAB_GROUP_TITLE);
    expect(ctx.tabs.get(1)?.groupId).toBe(ctx.tabs.get(2)?.groupId);
    expect(ctx.tabs.get(1)?.groupId).not.toBe(-1);

    await group.finish("task-1");
    // Tab 1 had no group: ungrouped. Tab 2 had group 7: restored.
    expect(ctx.ungroupCalls.flat()).toContain(1);
    expect(ctx.tabs.get(2)?.groupId).toBe(7);
    expect(ctx.tabs.get(1)?.groupId).toBe(-1);
    expect(ctx.tabs.size).toBe(2);
    expect(group.trackedTabIds("task-1")).toEqual([]);
  });

  it("does not track the same tab twice and does not ungroup another task's tabs", async () => {
    const ctx = new FakeContext([{ id: 1, groupId: -1 }]);
    const group = new ChromeWorkingTabGroup(ctx);
    await group.trackTab("task-1", 1);
    await group.trackTab("task-1", 1);
    expect(ctx.groupCalls.length).toBe(1);
    await group.trackTab("task-2", 1);
    await group.finish("task-1");
    // task-2 still owns tab 1 in its own group tracking; task-1's
    // finish must not have cleared task-2's record.
    expect(group.trackedTabIds("task-2")).toEqual([1]);
    await group.finish("task-2");
    expect(group.trackedTabIds("task-2")).toEqual([]);
  });

  it("skips closed tabs and still finishes the rest", async () => {
    const ctx = new FakeContext([
      { id: 1, groupId: -1 },
      { id: 2, groupId: -1 },
    ]);
    const group = new ChromeWorkingTabGroup(ctx);
    await group.trackTab("task-1", 1);
    await group.trackTab("task-1", 2);
    ctx.closedTabs.push(2);
    await expect(group.finish("task-1")).resolves.toBeUndefined();
    expect(ctx.tabs.get(1)?.groupId).toBe(-1);
    expect(ctx.tabs.has(2)).toBe(true);
  });

  it("finish is idempotent", async () => {
    const ctx = new FakeContext([{ id: 1, groupId: -1 }]);
    const group = new ChromeWorkingTabGroup(ctx);
    await group.trackTab("task-1", 1);
    await group.finish("task-1");
    const ungroupCount = ctx.ungroupCalls.length;
    await group.finish("task-1");
    expect(ctx.ungroupCalls.length).toBe(ungroupCount);
  });
});
