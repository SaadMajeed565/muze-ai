/** @vitest-environment jsdom */
/**
 * Dashboard tests: the handler sanitises the structured final report
 * and outside-bounds reasons through, and the Tasks page shows the
 * current step, failed list, final report, and browser session —
 * with pause/resume/cancel only (no plan button).
 */
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleTaskDashboardRequest,
  sanitizeTaskView,
  type TaskDashboardPort,
  type TaskView,
} from "../src/task-dashboard.js";
import { TasksPage } from "../dashboard/pages/Tasks.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";

function cancelledTask(): Record<string, unknown> {
  return {
    id: "task_done",
    goal: "Organise tabs",
    clientId: "client_1",
    browserSessionId: "browser_9",
    status: "cancelled",
    steps: [
      { index: 0, tool: "tabs.list", inputSummary: "list", state: "done", attempts: 1, outputSummary: "listed" },
      { index: 1, tool: "dom.click", inputSummary: "click", state: "failed", attempts: 1, outputSummary: "" },
      { index: 2, tool: "tabs.list", inputSummary: "list", state: "pending", attempts: 0, outputSummary: "" },
    ],
    totalSteps: 3,
    doneSteps: [0],
    undoneSteps: [1, 2],
    totalBudgetMs: 600_000,
    correlationId: "corr_9",
    resultSummary: "Done steps: [0]. Undone steps: [1, 2].",
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 3000,
    finalReport: {
      done: [0],
      undone: [1, 2],
      failed: [1],
      compensations: ["Step 0 (tabs.list): close-tab — executed."],
      manualCleanup: ["Step 1 (dom.click) failed — manual cleanup may be required"],
    },
  };
}

function createdTask(): Record<string, unknown> {
  return {
    id: "task_new",
    goal: "Click the form",
    clientId: "client_1",
    browserSessionId: "browser_9",
    status: "created",
    steps: [
      { index: 0, tool: "dom.click", inputSummary: "click", state: "waiting_approval", attempts: 0, outputSummary: "", outsideBoundsReason: "domain other.com is not in the approved domains" },
    ],
    totalSteps: 1,
    doneSteps: [],
    undoneSteps: [0],
    totalBudgetMs: 600_000,
    correlationId: "corr_10",
    resultSummary: "",
    createdAt: 5000,
    updatedAt: 5000,
    completedAt: 0,
  };
}

describe("dashboard task handler", () => {
  it("routes pause/resume/cancel through the port with no approval flag on the request", async () => {
    const calls: string[] = [];
    const port: TaskDashboardPort = {
      listTasks: async () => [],
      getTask: async () => cancelledTask() as unknown as TaskView,
      pauseTask: async () => {
        calls.push("pause");
        return cancelledTask() as unknown as TaskView;
      },
      resumeTask: async () => cancelledTask() as unknown as TaskView,
      cancelTask: async () => cancelledTask() as unknown as TaskView,
    };
    const response = await handleTaskDashboardRequest({ type: "muze/tasks.pause", taskId: "task_done" }, port);
    expect(response.ok).toBe(true);
    expect(calls).toEqual(["pause"]);
  });

  it("rejects an unknown dashboard task request", async () => {
    const port: TaskDashboardPort = {
      listTasks: async () => [],
      getTask: async () => cancelledTask() as unknown as TaskView,
      pauseTask: async () => cancelledTask() as unknown as TaskView,
      resumeTask: async () => cancelledTask() as unknown as TaskView,
      cancelTask: async () => cancelledTask() as unknown as TaskView,
    };
    const response = await handleTaskDashboardRequest({ type: "muze/tasks.bogus", taskId: "task_done" }, port);
    expect(response.ok).toBe(false);
    expect(response.error).toBe("unknown task dashboard request");
  });

  it("sanitises the final report and outside-bounds reasons through, and never step inputs", async () => {
    const view = sanitizeTaskView({ ...cancelledTask(), steps: [...(cancelledTask().steps as unknown[]), { index: 3, tool: "x", input: { secret: 1 }, inputSummary: "x", state: "pending", attempts: 0, outputSummary: "" }] });
    expect(view.finalReport?.done).toEqual([0]);
    expect(view.finalReport?.manualCleanup).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("secret");
    const created = sanitizeTaskView(createdTask());
    expect(created.steps[0].outsideBoundsReason).toContain("other.com");
  });
});

describe("TasksPage Phase 2 rendering", () => {
  let root: HTMLElement | null = null;
  let sendMessage: ReturnType<typeof vi.fn>;

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

  beforeEach(() => {
    sendMessage = vi.fn(async (message: { type: string; taskId?: string }) => {
      const port: TaskDashboardPort = {
        listTasks: async () => [cancelledTask(), createdTask()] as unknown as TaskView[],
        getTask: async () => cancelledTask() as unknown as TaskView,
        pauseTask: async () => cancelledTask() as unknown as TaskView,
        resumeTask: async () => cancelledTask() as unknown as TaskView,
        cancelTask: async () => cancelledTask() as unknown as TaskView,
      };
      const response = await handleTaskDashboardRequest({ type: message.type, taskId: message.taskId }, port);
      return { ok: response.ok, error: response.error, tasks: response.tasks, task: response.task };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
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

  it("day detail lists goals and status; task detail keeps the final report but shows executed steps, not plan steps", async () => {
    const container = mount();
    await flush();
    await flush();
    // Drill-down list: one day row (date + earliest task title), not
    // the task rows — so only the day's first goal is on the list.
    expect(container.textContent).toContain("Organise tabs");
    expect(container.textContent).not.toContain("Click the form");
    expect(container.textContent).not.toContain("dom.click");

    const day = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Jan 1, 1970")) ?? null;
    expect(day).not.toBeNull();
    await act(() => {
      day!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("Click the form");

    const title = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Organise tabs")) ?? null;
    expect(title).not.toBeNull();
    await act(() => {
      title!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("1 step didn't finish");
    expect(container.textContent).not.toContain("browser_9");
    expect(container.textContent).toContain("Final report");
    expect(container.textContent).toContain("close-tab");
    expect(container.textContent).not.toContain("tabs.list");
    expect(container.textContent).toContain("Needs doing by hand:");
    expect(container.textContent).not.toContain("dom.click");
  });

  it("task detail no longer surfaces plan-step outside-bounds reasons (executed steps only)", async () => {
    const container = mount();
    await flush();
    await flush();
    const day = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Jan 1, 1970")) ?? null;
    expect(day).not.toBeNull();
    await act(() => {
      day!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Click the form")) ?? null;
    expect(row).not.toBeNull();
    await act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    // The reason lives on a plan step that never executed, so the
    // executed-steps timeline does not show it (the sanitiser still
    // carries it — see the handler test above).
    expect(container.textContent).not.toContain("domain other.com is not in the approved domains");
    expect(container.textContent).not.toContain("dom.click");
    expect(container.textContent).toContain("No steps recorded yet.");
  });

  it("task detail offers no plan button, only pause/resume/cancel", async () => {
    const container = mount();
    await flush();
    await flush();
    const day = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Jan 1, 1970")) ?? null;
    expect(day).not.toBeNull();
    await act(() => {
      day!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Click the form")) ?? null;
    expect(row).not.toBeNull();
    await act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).not.toContain("Approve plan");
  });
});
