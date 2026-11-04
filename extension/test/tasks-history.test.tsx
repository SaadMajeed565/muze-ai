/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dayKeyForTimestamp,
  dayLabelForKey,
  groupTasksAndActionsByDay,
} from "../dashboard/ui-logic.js";
import { TasksPage } from "../dashboard/pages/Tasks.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";
import type { ActivityRow } from "../libs/activity.js";

/** Local-calendar timestamp: `daysAgo` days before today at noon local (TZ-safe). */
function atLocal(daysAgo: number, hour = 12): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, 0, 0).getTime();
}

function oldDateLabel(daysAgo: number): string {
  const d = new Date();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo);
  return target.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type MiniTask = { id: string; createdAt: number; status: string };
type MiniAction = { id: string; at: number; state: string };

describe("groupTasksAndActionsByDay", () => {
  it("labels today, yesterday, and older dates (local calendar dates)", () => {
    const now = new Date(2026, 10, 3, 12).getTime(); // Nov 3, 2026, noon local
    expect(dayLabelForKey(dayKeyForTimestamp(now), now)).toBe("Today");
    expect(dayLabelForKey(dayKeyForTimestamp(now - 24 * 60 * 60 * 1000), now)).toBe("Yesterday");
    expect(dayLabelForKey(dayKeyForTimestamp(new Date(2026, 9, 30, 12).getTime()), now)).toBe("Oct 30, 2026");
  });

  it("orders sections newest first, tasks before actions within a date", () => {
    const today = atLocal(0);
    const tasks: MiniTask[] = [
      { id: "done-new", createdAt: today + 2000, status: "done" },
      { id: "running-old", createdAt: today + 1000, status: "running" },
    ];
    const actions: MiniAction[] = [
      { id: "act-old", at: today + 500, state: "done" },
      { id: "act-new", at: today + 3000, state: "done" },
    ];
    const sections = groupTasksAndActionsByDay(tasks, actions, "all", today);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Today");
    // Running first even though older, then newest first; actions newest first.
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["running-old", "done-new"]);
    expect(sections[0].actions.map((a) => a.id)).toEqual(["act-new", "act-old"]);
  });

  it("renders a section for a date with actions but no tasks", () => {
    const sections = groupTasksAndActionsByDay([], [{ id: "a1", at: atLocal(2), state: "done" }], "all");
    expect(sections).toHaveLength(1);
    expect(sections[0].tasks).toHaveLength(0);
    expect(sections[0].actions.map((a) => a.id)).toEqual(["a1"]);
  });

  it("filters actions by chip state (tasks untouched by this helper's chip)", () => {
    const actions: MiniAction[] = [
      { id: "done", at: atLocal(0), state: "done" },
      { id: "failed", at: atLocal(0), state: "failed" },
      { id: "running", at: atLocal(0), state: "running" },
    ];
    expect(groupTasksAndActionsByDay([], actions, "all")[0].actions.map((a) => a.id)).toEqual(["done", "failed", "running"]);
    expect(groupTasksAndActionsByDay([], actions, "completed")[0].actions.map((a) => a.id)).toEqual(["done"]);
    expect(groupTasksAndActionsByDay([], actions, "failed")[0].actions.map((a) => a.id)).toEqual(["failed"]);
  });

  it("returns no sections for empty inputs", () => {
    expect(groupTasksAndActionsByDay([], [], "all")).toEqual([]);
  });
});

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_1",
    goal: "Today planned task",
    clientId: "client_1",
    browserSessionId: "browser_1",
    status: "done",
    steps: [
      {
        index: 0,
        tool: "tabs.list",
        inputSummary: "list tabs",
        state: "done",
        attempts: 1,
        outputSummary: "listed",
      },
    ],
    totalSteps: 1,
    doneSteps: [0],
    undoneSteps: [],
    totalBudgetMs: 600_000,
    correlationId: "corr_1",
    resultSummary: "",
    createdAt: atLocal(0, 9),
    updatedAt: atLocal(0, 10),
    completedAt: atLocal(0, 10),
    ...overrides,
  };
}

function actionRow(id: string, summary: string, state: "running" | "done" | "failed", at: number): ActivityRow {
  return { id, tool: "dom.click", summary, state, at };
}

describe("TasksPage date sections", () => {
  let root: HTMLElement | null = null;
  let sendMessage: ReturnType<typeof vi.fn>;
  let taskFixtures: Record<string, unknown>[];
  let historyFixtures: ActivityRow[];

  function mount(): HTMLElement {
    root = document.createElement("div");
    document.body.appendChild(root);
    render(h(ConfirmProvider, null, h(TasksPage, { busy: false })), root);
    return root;
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await act(async () => {});
  }

  function clickChip(label: string): void {
    const chip = [...(root as HTMLElement).querySelectorAll(".chip")].find((b) =>
      (b.textContent ?? "").startsWith(label),
    );
    expect(chip).not.toBeUndefined();
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function clickRow(partial: string): void {
    const row = [...(root as HTMLElement).querySelectorAll("button.row")].find((b) =>
      (b.textContent ?? "").includes(partial),
    );
    expect(row).not.toBeUndefined();
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function clickBack(): void {
    const back = [...(root as HTMLElement).querySelectorAll("button")].find((b) => b.textContent === "Back");
    expect(back).not.toBeUndefined();
    back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  beforeEach(() => {
    taskFixtures = [rawTask()];
    historyFixtures = [];
    sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === "muze/tasks.list") return { ok: true, tasks: taskFixtures };
      if (message.type === "muze/activity.history") return { ok: true, activityHistory: historyFixtures };
      return { ok: true };
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
  });

  afterEach(() => {
    if (root) {
      render(null, root);
      root.remove();
    }
    root = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("day list shows one row per day, newest first; day detail holds tasks before actions", async () => {
    taskFixtures = [
      rawTask({ id: "t-today", goal: "Today planned task", createdAt: atLocal(0, 9) }),
      rawTask({ id: "t-yesterday", goal: "Yesterday planned task", status: "done", createdAt: atLocal(1, 9) }),
    ];
    historyFixtures = [
      actionRow("a-today", "Clicked", "done", atLocal(0, 14)),
      actionRow("a-old", "Scrolled", "done", atLocal(3, 14)),
    ];
    const container = mount();
    await flush();
    await flush();
    const listText = container.textContent ?? "";
    expect(listText).toContain("Today");
    expect(listText).toContain("Yesterday");
    expect(listText).toContain(oldDateLabel(3));
    // Day rows newest first.
    expect(listText.indexOf("Today")).toBeLessThan(listText.indexOf("Yesterday"));
    expect(listText.indexOf("Yesterday")).toBeLessThan(listText.indexOf(oldDateLabel(3)));
    // The action-only older date renders even though it has no task,
    // with its first action summary as the preview.
    expect(listText).toContain("Scrolled");
    // Actions live in the day detail, not on the list.
    expect(listText).not.toContain("Clicked");

    clickRow("Today");
    await flush();
    const dayText = container.textContent ?? "";
    // Task rows come before that day's action rows.
    expect(dayText.indexOf("Today planned task")).toBeLessThan(dayText.indexOf("Clicked"));
  });

  it("orders actions newest first within a date", async () => {
    taskFixtures = [];
    historyFixtures = [
      actionRow("a-old", "Older action", "done", atLocal(0, 10)),
      actionRow("a-new", "Newer action", "done", atLocal(0, 15)),
    ];
    const container = mount();
    await flush();
    await flush();
    expect(container.textContent).toContain("Today");
    clickRow("Today");
    await flush();
    const text = container.textContent ?? "";
    expect(text.indexOf("Newer action")).toBeLessThan(text.indexOf("Older action"));
  });

  it("applies the chip to actions by state and keeps counts task-only", async () => {
    taskFixtures = [rawTask({ id: "t1", goal: "Only task", createdAt: atLocal(0, 9) })];
    historyFixtures = [
      actionRow("a-done", "Done action", "done", atLocal(0, 14)),
      actionRow("a-failed", "Failed action", "failed", atLocal(0, 15)),
      actionRow("a-running", "Running action", "running", atLocal(0, 16)),
    ];
    const container = mount();
    await flush();
    await flush();
    // Counts count tasks, not actions: 1 task + 3 actions still shows All (1).
    expect(container.textContent).toContain("All (1)");

    clickChip("Completed");
    await flush();
    clickRow("Today");
    await flush();
    expect(container.textContent).toContain("Done action");
    expect(container.textContent).not.toContain("Failed action");
    expect(container.textContent).not.toContain("Running action");

    clickBack();
    await flush();
    clickChip("Failed");
    await flush();
    clickRow("Today");
    await flush();
    expect(container.textContent).toContain("Failed action");
    expect(container.textContent).not.toContain("Done action");
    expect(container.textContent).not.toContain("Running action");
  });

  it("shows 'No tasks yet' only when both tasks and history are empty", async () => {
    taskFixtures = [];
    historyFixtures = [];
    const container = mount();
    await flush();
    await flush();
    expect(container.textContent).toContain("No tasks yet.");
  });

  it("never creates a task record for history actions", async () => {
    taskFixtures = [];
    historyFixtures = [actionRow("a1", "Clicked", "done", atLocal(0, 14))];
    const container = mount();
    await flush();
    await flush();
    expect(container.textContent).toContain("Clicked");
    expect(sendMessage.mock.calls.some((call) => String((call[0] as { type?: string }).type ?? "").includes("create"))).toBe(false);
  });
});
