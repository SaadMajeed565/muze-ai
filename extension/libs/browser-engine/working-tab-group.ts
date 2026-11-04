import type { BrowserContext } from "./context.js";

/**
 * The visible "Muze is working" tab group, in the style of Claude's
 * working tabs.
 *
 * Behaviour, as the user chose it (2026-11-04, reversing the
 * 2026-10-28 "ungroup when done" choice):
 * - Tabs a task touches are moved into a group titled "Muze AI".
 * - When the task ends (done, failed, partial, or cancelled) the
 *   tabs STAY in the "Muze AI" group. Nothing is ungrouped and
 *   nothing is restored: a tab that already belonged to another
 *   group stays in the "Muze AI" group after the task ends. The
 *   group is never used to close anything.
 *
 * Grouping is best-effort and never fails a task step: a tab that was
 * closed, or a grouping call that throws, is skipped, and finish()
 * still clears the tracking. A service-worker restart loses
 * the in-memory tracking, which is safe: the tabs simply stay in
 * whatever group they were in, and the next task run re-tracks the
 * tabs it touches.
 *
 * One instance is shared across tasks, so tracking is keyed by
 * task id: finishing one task only clears its own tracking and
 * never touches another task's tabs.
 */
export const WORKING_TAB_GROUP_TITLE = "Muze AI";
export const WORKING_TAB_GROUP_COLOR = "purple";

export interface WorkingTabGroup {
  trackTab(taskId: string, tabId: number): Promise<void>;
  finish(taskId: string): Promise<void>;
  trackedTabIds(taskId: string): number[];
}

type TabGroupContext = Pick<BrowserContext, "getTab" | "groupTabs">;

interface TrackedTask {
  groupId: number | null;
  tabs: Map<number, number>;
}

export class ChromeWorkingTabGroup implements WorkingTabGroup {
  private readonly tasks = new Map<string, TrackedTask>();

  constructor(private readonly ctx: TabGroupContext) {}

  trackedTabIds(taskId: string): number[] {
    return [...(this.tasks.get(taskId)?.tabs.keys() ?? [])];
  }

  async trackTab(taskId: string, tabId: number): Promise<void> {
    if (!Number.isInteger(tabId)) return;
    let tracked = this.tasks.get(taskId);
    if (!tracked) {
      tracked = { groupId: null, tabs: new Map() };
      this.tasks.set(taskId, tracked);
    }
    if (tracked.tabs.has(tabId)) return;
    let originalGroupId: number;
    try {
      const tab = await this.ctx.getTab(tabId);
      originalGroupId = typeof tab.groupId === "number" ? tab.groupId : -1;
    } catch {
      // Tab closed (or unreadable) between the step and this call:
      // grouping it is impossible, and must not fail the step.
      return;
    }
    // Already in this task's Muze group (for example after a resume):
    // record "no group" — the original is no longer used, since
    // finish() keeps every tab grouped and restores nothing.
    if (tracked.groupId !== null && originalGroupId === tracked.groupId) {
      tracked.tabs.set(tabId, -1);
      return;
    }
    try {
      const groupId = await this.ctx.groupTabs(
        [tabId],
        tracked.groupId === null
          ? { title: WORKING_TAB_GROUP_TITLE, color: WORKING_TAB_GROUP_COLOR }
          : { groupId: tracked.groupId },
      );
      tracked.groupId = groupId;
      tracked.tabs.set(tabId, originalGroupId);
    } catch {
      // Grouping is cosmetic. A failure here must not fail the step.
      return;
    }
  }

  async finish(taskId: string): Promise<void> {
    // The group persists after the task ends (user choice 2026-11-04):
    // finishing only clears this task's tracking. Tabs stay in the
    // "Muze AI" group, exactly as they were — nothing is ungrouped,
    // nothing is restored to an earlier group, nothing is closed.
    this.tasks.delete(taskId);
  }
}
