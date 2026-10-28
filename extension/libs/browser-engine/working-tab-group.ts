import type { BrowserContext } from "./context.js";

/**
 * The visible "Muze is working" tab group, in the style of Claude's
 * working tabs.
 *
 * Behaviour, as the user chose it:
 * - Tabs a task touches are moved into a group titled "Muze AI".
 * - When the task ends (done, failed, partial, or cancelled) the tabs
 *   are ungrouped again and left OPEN. The group is never used to
 *   close anything.
 * - A tab that already belonged to another group is restored to that
 *   group, not just left ungrouped. A tab with no group is ungrouped.
 *
 * Grouping is best-effort and never fails a task step: a tab that was
 * closed, or a grouping call that throws, is skipped, and finish()
 * still tries every other tracked tab. A service-worker restart loses
 * the in-memory tracking, which is safe: the tabs simply stay in
 * whatever group they were in, and the next task run re-tracks the
 * tabs it touches.
 *
 * One instance is shared across tasks, so tracking is keyed by
 * task id: finishing one task must never ungroup another task's tabs.
 */
export const WORKING_TAB_GROUP_TITLE = "Muze AI";
export const WORKING_TAB_GROUP_COLOR = "purple";

export interface WorkingTabGroup {
  trackTab(taskId: string, tabId: number): Promise<void>;
  finish(taskId: string): Promise<void>;
  trackedTabIds(taskId: string): number[];
}

type TabGroupContext = Pick<BrowserContext, "getTab" | "groupTabs" | "ungroupTabs">;

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
    // there is no earlier group to restore, so record "no group".
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
    const tracked = this.tasks.get(taskId);
    if (!tracked) return;
    this.tasks.delete(taskId);
    for (const [tabId, originalGroupId] of tracked.tabs) {
      try {
        if (originalGroupId >= 0 && originalGroupId !== tracked.groupId) {
          await this.ctx.groupTabs([tabId], { groupId: originalGroupId });
        } else {
          await this.ctx.ungroupTabs([tabId]);
        }
      } catch {
        // Tab closed since tracking, or its group is gone: the tab
        // itself is untouched, which is the only promise that matters.
        continue;
      }
    }
  }
}
