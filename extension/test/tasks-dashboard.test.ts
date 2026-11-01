/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveLoopStatus,
  handleTaskDashboardRequest,
  sanitizeTaskView,
  type TaskDashboardPort,
  type TaskDashboardRequest,
  type TaskView,
} from "../src/task-dashboard.js";
import { TasksPage } from "../dashboard/pages/Tasks.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";

/** A full TaskView, plus (deliberately) a raw step `input` the view must never carry. */
function rawTask(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "task_1",
    goal: "Research 10 pages and organise tabs",
    clientId: "client_1",
    browserSessionId: "browser_1",
    status: "running",
    steps: [
      {
        index: 0,
        tool: "tabs.list",
        input: { url: "https://secret.example/", password: "hunter2" },
        inputSummary: "list open tabs",
        state: "done",
        attempts: 1,
        outputSummary: "3 tabs listed",
      },
      {
        index: 1,
        tool: "pages.read",
        input: { ref: "r1" },
        inputSummary: "read first page",
        state: "running",
        attempts: 1,
        outputSummary: "",
      },
    ],
    totalSteps: 2,
    doneSteps: [0],
    undoneSteps: [1],
    totalBudgetMs: 600_000,
    correlationId: "corr_1",
    resultSummary: "",
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 0,
    ...overrides,
  };
}

function fakePort(): { port: TaskDashboardPort; calls: string[]; store: Record<string, unknown>[] } {
  const store = [rawTask(), rawTask({ id: "task_2", goal: "Fill the test form", status: "paused", pauseReason: "waiting on plan approval", createdAt: 3000 })];
  const calls: string[] = [];
  const find = (id: string): Record<string, unknown> => {
    const found = store.find((task) => task.id === id);
    if (!found) throw new Error(`task not found: ${id}`);
    return found;
  };
  const port: TaskDashboardPort = {
    listTasks: async () => {
      calls.push("list");
      return store as unknown as TaskView[];
    },
    getTask: async (id) => {
      calls.push(`get:${id}`);
      return find(id) as unknown as TaskView;
    },
    pauseTask: async (id) => {
      calls.push(`pause:${id}`);
      const task = find(id);
      task.status = "paused";
      return task as unknown as TaskView;
    },
    resumeTask: async (id) => {
      calls.push(`resume:${id}`);
      const task = find(id);
      task.status = "running";
      return task as unknown as TaskView;
    },
    cancelTask: async (id) => {
      calls.push(`cancel:${id}`);
      const task = find(id);
      task.status = "cancelled";
      return task as unknown as TaskView;
    },
  };
  return { port, calls, store };
}

function stepKeys(view: TaskView): string[][] {
  return view.steps.map((step) => Object.keys(step).sort());
}

describe("handleTaskDashboardRequest", () => {
  it("returns list/get/pause/resume/cancel through the port", async () => {
    const { port, calls } = fakePort();

    const listed = await handleTaskDashboardRequest({ type: "muze/tasks.list" }, port);
    expect(listed.ok).toBe(true);
    expect(listed.tasks?.map((task) => task.id)).toEqual(["task_1", "task_2"]);

    const got = await handleTaskDashboardRequest({ type: "muze/tasks.get", taskId: "task_2" }, port);
    expect(got.ok).toBe(true);
    expect(got.task?.goal).toBe("Fill the test form");
    expect(got.task?.pauseReason).toBe("waiting on plan approval");

    const paused = await handleTaskDashboardRequest({ type: "muze/tasks.pause", taskId: "task_1" }, port);
    expect(paused.task?.status).toBe("paused");

    const resumed = await handleTaskDashboardRequest({ type: "muze/tasks.resume", taskId: "task_1" }, port);
    expect(resumed.task?.status).toBe("running");

    const cancelled = await handleTaskDashboardRequest({ type: "muze/tasks.cancel", taskId: "task_1" }, port);
    expect(cancelled.task?.status).toBe("cancelled");

    expect(calls).toEqual(["list", "get:task_2", "pause:task_1", "resume:task_1", "cancel:task_1"]);
  });

  it("accepts the legacy uabb/tasks.* spellings the same way", async () => {
    const { port } = fakePort();
    const listed = await handleTaskDashboardRequest({ type: "uabb/tasks.list" }, port);
    expect(listed.ok).toBe(true);
    expect(listed.tasks).toHaveLength(2);
    const paused = await handleTaskDashboardRequest({ type: "uabb/tasks.pause", taskId: "task_1" }, port);
    expect(paused.task?.status).toBe("paused");
  });

  it("errors cleanly on unknown types and missing task ids, never throwing", async () => {
    const { port } = fakePort();
    for (const request of [
      { type: "muze/tasks.explode", taskId: "task_1" },
      { type: "muze/state" },
      { type: "not-a-dashboard-message" },
      { type: "muze/tasks.get" },
      { type: "muze/tasks.cancel", taskId: "  " },
    ] as TaskDashboardRequest[]) {
      const response = await handleTaskDashboardRequest(request, port);
      expect(response.ok).toBe(false);
      expect(typeof response.error).toBe("string");
    }
    const unknown = await handleTaskDashboardRequest({ type: "muze/tasks.explode" }, port);
    expect(unknown.error).toBe("unknown task dashboard request");
  });

  it("converts a throwing port into an error response instead of throwing", async () => {
    const failing: TaskDashboardPort = {
      listTasks: async () => {
        throw new Error("store unavailable");
      },
      getTask: async () => {
        throw new Error("store unavailable");
      },
      pauseTask: async () => {
        throw new Error("store unavailable");
      },
      resumeTask: async () => {
        throw new Error("store unavailable");
      },
      cancelTask: async () => {
        throw new Error("store unavailable");
      },
    };
    const response = await handleTaskDashboardRequest({ type: "muze/tasks.list" }, failing);
    expect(response).toEqual({ ok: false, error: "store unavailable" });
  });

  it("sanitises views: no step ever carries an input key, and summaries survive", async () => {
    const { port } = fakePort();
    const listed = await handleTaskDashboardRequest({ type: "muze/tasks.list" }, port);
    expect(listed.ok).toBe(true);
    for (const task of listed.tasks ?? []) {
      for (const keys of stepKeys(task)) {
        expect(keys).not.toContain("input");
        expect(keys).toEqual(["attempts", "index", "inputSummary", "outputSummary", "state", "tool"]);
      }
      // Belt and braces: the serialised view has no `"input":` key at all
      // (inputSummary is `"inputSummary":`, which does not match).
      expect(JSON.stringify(task)).not.toContain('"input":');
    }
    const first = (listed.tasks ?? [])[0];
    expect(first.steps[0].tool).toBe("tabs.list");
    expect(first.steps[0].inputSummary).toBe("list open tabs");
    expect(first.steps[0].outputSummary).toBe("3 tabs listed");
    expect(first.goal).toBe("Research 10 pages and organise tabs");
  });

  it("sanitiseTaskView drops extra top-level fields too", () => {
    const view = sanitizeTaskView({ ...rawTask(), token: "muze_live_secret", screenshot: "data:image/png;base64,xx" });
    expect(Object.keys(view)).not.toContain("token");
    expect(Object.keys(view)).not.toContain("screenshot");
    expect(JSON.stringify(view)).not.toContain("hunter2");
  });

  it("cancel requires no MCP approval flag: the request type carries none", async () => {
    const { port, calls } = fakePort();
    // The request the dashboard sends for Cancel has exactly three
    // possible fields; there is no `confirmed`/`approved` flag to set,
    // and the handler must not require one.
    const request: TaskDashboardRequest = { type: "muze/tasks.cancel", taskId: "task_1" };
    expect("confirmed" in request).toBe(false);
    expect("approved" in request).toBe(false);
    const response = await handleTaskDashboardRequest(request, port);
    expect(response.ok).toBe(true);
    expect(response.task?.status).toBe("cancelled");
    expect(calls).toContain("cancel:task_1");
  });
});

describe("TasksPage", () => {
  let root: HTMLElement | null = null;
  let sendMessage: ReturnType<typeof vi.fn>;

  function mount(): HTMLElement {
    root = document.createElement("div");
    document.body.appendChild(root);
    // No JSX here: this file is .ts (per the section spec), so mount via h().
    render(h(ConfirmProvider, null, h(TasksPage, { approvals: [] })), root);
    return root;
  }

  async function flush(): Promise<void> {
    // Plain wait, then an empty act to flush the render: the page's
    // useEffect load (and the reload after an action) resolves over
    // several promise turns, more than a single act tick covers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await act(async () => {});
  }

  beforeEach(() => {
    sendMessage = vi.fn(async (message: { type: string; taskId?: string }) => {
      const { port } = fakePort();
      // The page talks to the service worker; emulate the handler here
      // with the same fake port the handler tests use.
      const response = await handleTaskDashboardRequest(
        { type: message.type, taskId: message.taskId },
        port,
      );
      return { ok: response.ok, error: response.error, tasks: response.tasks, task: response.task };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
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

  it("lists tasks newest first with step X of Y progress and expands to steps", async () => {
    const container = mount();
    await flush();
    await flush();

    expect(container.textContent).toContain("Fill the test form");
    expect(container.textContent).toContain("Research 10 pages and organise tabs");
    // Newest first: the createdAt:3000 task renders before createdAt:1000.
    expect(container.textContent!.indexOf("Fill the test form")).toBeLessThan(
      container.textContent!.indexOf("Research 10 pages and organise tabs"),
    );
    expect(container.textContent).toContain("Step 1 of 2");
    expect(container.textContent).toContain("waiting on plan approval");
    // No step input ever renders, even though the fake record carries one.
    expect(container.textContent).not.toContain("hunter2");
    expect(container.textContent).not.toContain("secret.example");

    const title = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Research 10 pages and organise tabs")) ?? null;
    expect(title).not.toBeNull();
    await act(() => {
      title!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("3 tabs listed");
    expect(container.textContent).not.toContain("tabs.list");
    expect(container.textContent).toContain("Step 1 of 2");
    expect(container.textContent).toContain("read first page");
  });

  it("shows an empty state when no tasks exist", async () => {
    sendMessage.mockImplementation(async () => ({ ok: true, tasks: [] }));
    const container = mount();
    await flush();
    await flush();
    // v3: empty tasks = one muted line, not a tall illustrated state.
    expect(container.textContent).toContain("No tasks yet");
  });

  it("sends pause on Pause and confirms before Cancel", async () => {
    const container = mount();
    await flush();
    await flush();
    const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Research 10 pages and organise tabs")) ?? null;
    expect(row).not.toBeNull();
    await act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const buttons = [...container.querySelectorAll("button")];
    // The newest task is paused, so its Pause button is disabled; take
    // the enabled Pause (the running task's).
    const pause = buttons.find((b) => b.textContent === "Pause" && !(b as HTMLButtonElement).disabled) ?? null;
    await act(() => {
      pause!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "muze/tasks.pause" }));

    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel" && !(b as HTMLButtonElement).disabled) ?? null;
    await act(() => {
      cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const keep = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Keep")) ?? null;
    await act(() => {
      keep!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "muze/tasks.cancel" }));

    await act(() => {
      cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const confirmCancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel task") ?? null;
    await act(() => {
      confirmCancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "muze/tasks.cancel" }));
  });
});

describe("Phase D deriveLoopStatus", () => {
  // Views are built through the real sanitiser from runner-shaped
  // records, so the derivation is tested against what the runner
  // actually writes — never against a hand-set dashboard field.
  function view(overrides: Record<string, unknown> = {}) {
    return sanitizeTaskView(rawTask(overrides));
  }

  it("maps a running task to running with act as the default mode", () => {
    expect(deriveLoopStatus(view())).toEqual({ loop: "running", child: false, mode: "act" });
  });

  it("maps paused + verify-failed to verify-failed, and other pauses to paused", () => {
    expect(deriveLoopStatus(view({ status: "paused", pauseReason: "verify-failed" })).loop).toBe("verify-failed");
    expect(deriveLoopStatus(view({ status: "paused", pauseReason: "policy-changed" })).loop).toBe("paused");
  });

  it("maps terminal tasks with the runner's budget markers to budget-terminal only", () => {
    expect(
      deriveLoopStatus(view({ status: "partial", resultSummary: "Total budget exhausted." })).loop,
    ).toBe("budget-terminal");
    expect(
      deriveLoopStatus(
        view({
          status: "failed",
          finalReport: {
            done: [],
            undone: [0],
            failed: [],
            compensations: [],
            manualCleanup: ["Step 0 (tabs.list) not run: total budget exhausted — manual cleanup may be required"],
          },
        }),
      ).loop,
    ).toBe("budget-terminal");
    expect(deriveLoopStatus(view({ status: "partial", resultSummary: "Some steps failed." })).loop).toBe("partial");
  });

  it("marks a child task via the sanitiser boolean without exposing the parent id", () => {
    const child = view({ parentId: "task_parent", mode: "explore" });
    expect("parentId" in child).toBe(false);
    expect(deriveLoopStatus(child)).toEqual({ loop: "running", child: true, mode: "explore" });
  });

  it("maps waiting_approval through unchanged", () => {
    expect(deriveLoopStatus(view({ status: "waiting_approval" })).loop).toBe("waiting_approval");
  });
});

describe("Phase D TasksPage push reload", () => {
  let root: HTMLElement | null = null;

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await act(async () => {});
  }

  afterEach(() => {
    if (root) {
      render(null, root);
      root.remove();
    }
    root = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reloads on a muze/event push and ignores unrelated messages (poll stays as fallback)", async () => {
    const listeners: ((message: { type?: string }) => void)[] = [];
    const sendMessage = vi.fn(async (message: { type: string; taskId?: string }) => {
      const { port } = fakePort();
      const response = await handleTaskDashboardRequest(
        { type: message.type, taskId: message.taskId },
        port,
      );
      return { ok: response.ok, error: response.error, tasks: response.tasks, task: response.task };
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (fn: (message: { type?: string }) => void) => {
            listeners.push(fn);
          },
          removeListener: (fn: (message: { type?: string }) => void) => {
            const at = listeners.indexOf(fn);
            if (at >= 0) listeners.splice(at, 1);
          },
        },
      },
    });
    root = document.createElement("div");
    document.body.appendChild(root);
    render(h(ConfirmProvider, null, h(TasksPage, { approvals: [] })), root);
    await flush();
    await flush();
    expect(listeners.length).toBe(1);
    expect(root.textContent).toContain("Fill the test form");

    const baseline = sendMessage.mock.calls.length;
    listeners[0]!({ type: "muze/event" });
    await flush();
    expect(sendMessage.mock.calls.length).toBeGreaterThan(baseline);

    const afterPush = sendMessage.mock.calls.length;
    listeners[0]!({ type: "something-else" });
    await flush();
    expect(sendMessage.mock.calls.length).toBe(afterPush);
  });
});
