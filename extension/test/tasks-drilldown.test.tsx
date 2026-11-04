/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayRowPreview, taskExecutedSteps } from "../dashboard/ui-logic.js";
import { TasksPage } from "../dashboard/pages/Tasks.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";
import type { ActivityRow } from "../libs/activity.js";

/** Local-calendar timestamp: `daysAgo` days before today at `hour` local (TZ-safe). */
function atLocal(daysAgo: number, hour = 12): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, 0, 0).getTime();
}

function oldDateLabel(daysAgo: number): string {
  const d = new Date();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo);
  return target.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_1",
    goal: "Early task",
    clientId: "client_1",
    browserSessionId: "browser_1",
    status: "done",
    steps: [
      {
        index: 0,
        tool: "tabs.list",
        inputSummary: "plan only input",
        state: "done",
        attempts: 1,
        outputSummary: "PLAN-ONLY-OUTPUT",
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

function actionRow(
  id: string,
  summary: string,
  state: "running" | "done" | "failed",
  at: number,
  taskId?: string,
): ActivityRow {
  return taskId === undefined
    ? { id, tool: "dom.click", summary, state, at }
    : { id, tool: "dom.click", summary, state, at, taskId };
}

describe("dayRowPreview", () => {
  it("shows the earliest-created task title, not the display order", () => {
    const tasks = [
      { createdAt: 3000, goal: "Late task" },
      { createdAt: 1000, goal: "Early task" },
      { createdAt: 2000, goal: "Middle task" },
    ];
    expect(dayRowPreview(tasks)).toBe("Early task");
  });

  it("returns empty when there are no tasks", () => {
    expect(dayRowPreview([])).toBe("");
  });
});

describe("taskExecutedSteps", () => {
  it("returns only that task's rows, chronological oldest-first, stable on ties", () => {
    const rows = [
      actionRow("other", "Other task step", "done", 500, "task_other"),
      actionRow("second", "Second taken", "done", 2000, "task_1"),
      actionRow("direct", "Direct action", "done", 1500),
      actionRow("first", "First taken", "done", 1000, "task_1"),
      actionRow("tie-a", "Tie A", "done", 3000, "task_1"),
      actionRow("tie-b", "Tie B", "done", 3000, "task_1"),
    ];
    expect(taskExecutedSteps(rows, "task_1").map((r) => r.id)).toEqual(["first", "second", "tie-a", "tie-b"]);
    expect(taskExecutedSteps(rows, "task_missing")).toEqual([]);
  });
});

describe("TasksPage drill-down", () => {
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

  function rowButton(partial: string): HTMLElement {
    const button = [...(root as HTMLElement).querySelectorAll("button.row")].find((b) =>
      (b.textContent ?? "").includes(partial),
    ) as HTMLElement | undefined;
    expect(button).not.toBeUndefined();
    return button as HTMLElement;
  }

  function clickRow(partial: string): void {
    rowButton(partial).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function clickChip(label: string): void {
    const chip = [...(root as HTMLElement).querySelectorAll(".chip")].find((b) =>
      (b.textContent ?? "").startsWith(label),
    );
    expect(chip).not.toBeUndefined();
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  function setQuery(text: string): void {
    const input = (root as HTMLElement).querySelector("input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    input!.value = text;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  beforeEach(() => {
    taskFixtures = [
      rawTask({ id: "t-early", goal: "Early task", createdAt: atLocal(0, 9) }),
      rawTask({ id: "t-late", goal: "Late task", createdAt: atLocal(0, 15) }),
      rawTask({ id: "t-yesterday", goal: "Yesterday task", createdAt: atLocal(1, 9) }),
    ];
    historyFixtures = [
      actionRow("a-standalone", "Standalone click", "done", atLocal(0, 14)),
      actionRow("a-first", "First taken", "done", atLocal(0, 10), "t-early"),
      actionRow("a-second", "Second taken", "done", atLocal(0, 11), "t-early"),
      actionRow("a-yday-step", "Yesterday step", "done", atLocal(1, 10), "t-yesterday"),
      actionRow("a-yday-direct", "Yesterday direct", "done", atLocal(1, 14)),
      actionRow("a-old", "Old direct", "done", atLocal(3, 14)),
    ];
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

  it("day list shows one row per day: date + earliest task title, no action-only day", async () => {
    const container = mount();
    await flush();
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Today");
    expect(text).toContain("Early task");
    expect(text).toContain("Yesterday");
    // The action-only older date produces no day row at all.
    expect(text).not.toContain(oldDateLabel(3));
    expect(text).not.toContain("Old direct");
    // Task titles other than the day's first are NOT on the list view.
    expect(text).not.toContain("Late task");
    // Standalone action summaries are NOT on the list view either.
    expect(text).not.toContain("Standalone click");
  });

  it("day detail lists that day's tasks only — no standalone rows, no task-attributed rows, no other day", async () => {
    const container = mount();
    await flush();
    await flush();
    clickRow("Today");
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Early task");
    expect(text).toContain("Late task");
    expect(text).not.toContain("Standalone click");
    // Task-attributed rows are not duplicated into the day detail.
    expect(text).not.toContain("First taken");
    expect(text).not.toContain("Second taken");
    // No other day's content leaks in.
    expect(text).not.toContain("Yesterday task");
    expect(text).not.toContain("Yesterday direct");
    expect(text).not.toContain("Old direct");
  });

  it("task detail shows exactly that task's executed steps, chronological, and no plan-only content", async () => {
    const container = mount();
    await flush();
    await flush();
    clickRow("Today");
    await flush();
    clickRow("Early task");
    await flush();
    const text = container.textContent ?? "";
    expect(text.indexOf("First taken")).toBeLessThan(text.indexOf("Second taken"));
    expect(text).not.toContain("Yesterday step");
    expect(text).not.toContain("Standalone click");
    expect(text).not.toContain("PLAN-ONLY-OUTPUT");
    expect(text).not.toContain("plan only input");
  });

  it("a plan step that never executed has no row, with a note when a step is done", async () => {
    const container = mount();
    await flush();
    await flush();
    clickRow("Today");
    await flush();
    clickRow("Late task");
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("No steps recorded yet.");
    expect(text).toContain("Steps taken before this update don't appear here.");
    expect(text).not.toContain("PLAN-ONLY-OUTPUT");
  });

  it("back navigation works: day detail Back returns to the list, task detail back returns to the day", async () => {
    const container = mount();
    await flush();
    await flush();
    clickRow("Today");
    await flush();
    expect(container.textContent).toContain("Late task");
    const back = [...container.querySelectorAll("button")].find((b) => b.textContent === "Back");
    expect(back).not.toBeUndefined();
    back!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    // Back on the list: task titles other than the day preview are gone.
    expect(container.textContent).not.toContain("Late task");
    expect(container.textContent).toContain("Today");

    // Day → task → back (simulating the AppBar back clearing the selection).
    clickRow("Today");
    await flush();
    clickRow("Early task");
    await flush();
    expect(container.textContent).toContain("First taken");
    render(h(ConfirmProvider, null, h(TasksPage, { busy: false, selectedId: null, onSelectTask: () => {} })), root as HTMLElement);
    await flush();
    const afterBack = container.textContent ?? "";
    expect(afterBack).toContain("Late task");
    expect(afterBack).not.toContain("First taken");
  });

  it("chips filter through the drill-down and counts stay task-only", async () => {
    taskFixtures = [rawTask({ id: "t1", goal: "Only task", createdAt: atLocal(0, 9) })];
    historyFixtures = [
      actionRow("a-done", "Done action", "done", atLocal(0, 14)),
      actionRow("a-failed", "Failed action", "failed", atLocal(0, 15)),
    ];
    const container = mount();
    await flush();
    await flush();
    expect(container.textContent).toContain("All (1)");
    clickChip("Failed");
    await flush();
    // The done task is filtered out, and standalone rows cannot keep
    // the day alive: no day row, no detail to open.
    expect(container.textContent).toContain("No tasks match your search.");
    expect(container.textContent).not.toContain("Failed action");
  });

  it("a day with only filtered-out content disappears under the chip", async () => {
    taskFixtures = [rawTask({ id: "t1", goal: "Only task", createdAt: atLocal(0, 9) })];
    historyFixtures = [actionRow("a-done", "Done action", "done", atLocal(0, 14))];
    const container = mount();
    await flush();
    await flush();
    clickChip("Failed");
    await flush();
    expect(container.textContent).toContain("No tasks match your search.");
  });

  it("search filters tasks only: a day with standalone actions disappears under a non-matching query", async () => {
    // Standalone rows no longer keep a day visible: only matching
    // tasks do. The default fixtures carry a standalone row today,
    // plus tasks today and yesterday.
    historyFixtures = [actionRow("a-standalone", "Standalone click", "done", atLocal(0, 14))];
    const container = mount();
    await flush();
    await flush();
    setQuery("Early");
    await flush();
    let text = container.textContent ?? "";
    expect(text).toContain("Today");
    expect(text).not.toContain("Yesterday");

    setQuery("zzz-no-match");
    await flush();
    text = container.textContent ?? "";
    expect(text).toContain("No tasks match your search.");
    expect(text).not.toContain("Standalone click");
  });
});
