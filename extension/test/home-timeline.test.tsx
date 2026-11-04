/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "../dashboard/pages/Home.js";
import type { DashboardState } from "../src/messages.js";

let root: HTMLElement | null = null;

function mount(node: preact.VNode): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node, root);
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await act(async () => {});
}

const state = {
  snapshot: { bridgeStatus: "connected" },
  gateway: { signedIn: true, mcpUrl: "https://example.invalid/mcp" },
} as unknown as DashboardState;

function taskFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "t1",
    goal: "Summarize pricing page",
    clientId: "oc_1",
    browserSessionId: "s1",
    status: "running",
    steps: [],
    totalSteps: 0,
    doneSteps: [],
    undoneSteps: [],
    totalBudgetMs: 0,
    correlationId: "",
    resultSummary: "",
    createdAt: 1000,
    updatedAt: 2000,
    completedAt: 0,
    ...overrides,
  };
}

/** Captured chrome.runtime.onMessage listeners, so tests can deliver activity events. */
const messageListeners: Array<(message: unknown) => void> = [];

function emitActivity(event: { kind: "activity"; id: string; tool: string; summary: string; state: string; at: number }): void {
  for (const fn of [...messageListeners]) fn({ type: "muze/event", event });
}

function stubTasks(tasks: Record<string, unknown>[]): void {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: async (request: { type?: string }) => {
        if (request.type === "muze/tasks.list") return { ok: true, tasks };
        if (request.type === "muze/browsers/list" || request.type === "muze/browsers/refresh") {
          return { ok: true, browsers: { browsers: [], mcpClients: [], defaultSessionId: "" } };
        }
        return { ok: false, error: "unknown" };
      },
      onMessage: {
        addListener: (fn: (message: unknown) => void) => {
          messageListeners.push(fn);
        },
        removeListener: (fn: (message: unknown) => void) => {
          const index = messageListeners.indexOf(fn);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
    },
  });
}

function home(): HTMLElement {
  return mount(<HomePage state={state} busy={false} approvals={[]} onNavigate={() => {}} onRespond={() => {}} />);
}

describe("HomePage live activity feed", () => {
  afterEach(() => {
    if (root) render(null, root);
    root = null;
    messageListeners.length = 0;
    vi.unstubAllGlobals();
  });

  it("appends live activity rows in order and resolves running rows on completion", async () => {
    stubTasks([]);
    const container = home();
    await flush();
    emitActivity({ kind: "activity", id: "act_1", tool: "dom.click", summary: "Clicked", state: "running", at: 1 });
    emitActivity({ kind: "activity", id: "act_2", tool: "screenshots.viewport", summary: "Took a screenshot", state: "running", at: 2 });
    await flush();
    const timeline = container.querySelector("#browserTimeline");
    expect(timeline).toBeTruthy();
    expect(timeline!.querySelectorAll(".step").length).toBe(2);
    expect(timeline!.textContent).toContain("Clicked");
    expect(timeline!.textContent).toContain("Took a screenshot");
    expect(timeline!.querySelectorAll(".tmeta").length).toBe(2);
    emitActivity({ kind: "activity", id: "act_1", tool: "dom.click", summary: "Clicked", state: "done", at: 3 });
    await flush();
    expect(timeline!.querySelectorAll(".step").length).toBe(2);
    expect(timeline!.querySelectorAll(".tmeta").length).toBe(1);
    expect(timeline!.querySelectorAll(".tmeta")[0].textContent).toBe("In progress");
  });

  it("caps the feed at 50 rows, keeping the most recent", async () => {
    stubTasks([]);
    const container = home();
    await flush();
    for (let i = 0; i < 55; i++) {
      emitActivity({ kind: "activity", id: `act_${i}`, tool: "tabs.list", summary: `Action ${i}`, state: "running", at: i });
    }
    await flush();
    const verbs = [...container.querySelectorAll("#browserTimeline .step .verb")].map((el) => el.textContent);
    expect(verbs.length).toBe(50);
    expect(verbs[0]).toBe("Action 5");
    expect(verbs[verbs.length - 1]).toBe("Action 54");
  });

  it("plan steps no longer render in the Home card timeline", async () => {
    stubTasks([
      taskFixture({
        steps: [
          { index: 0, tool: "tabs.navigate", inputSummary: "Open pricing page", outputSummary: "Opened pricing page", state: "done", attempts: 1 },
          { index: 1, tool: "dom.click", inputSummary: "Click features", outputSummary: "Clicked Features", state: "running", attempts: 1 },
        ],
      }),
    ]);
    const container = home();
    await flush();
    // The header still surfaces the running task's goal.
    expect(container.textContent).toContain("Summarize pricing page");
    // But the card body is the activity feed, not the plan.
    expect(container.querySelector("#browserTimeline")).toBeNull();
    expect(container.textContent).toContain("Actions will appear here as Muze works");
    expect(container.textContent).not.toContain("Opened pricing page");
    expect(container.textContent).not.toContain("Clicked Features");
  });

  it("shows the activity empty state when nothing has happened", async () => {
    stubTasks([]);
    const container = home();
    await flush();
    expect(container.querySelector("#browserTimeline")).toBeNull();
    expect(container.textContent).toContain("Actions will appear here as Muze works");
  });

  it("does not surface paused tasks in the Home card (running/created only)", async () => {
    stubTasks([
      taskFixture({
        status: "paused",
        steps: [
          { index: 0, tool: "tabs.navigate", inputSummary: "Open pricing page", outputSummary: "Opened pricing page", state: "done", attempts: 1 },
        ],
      }),
    ]);
    const container = home();
    await flush();
    expect(container.querySelector("#browserTimeline")).toBeNull();
    expect(container.textContent).toContain("This browser");
    expect(container.textContent).toContain("Actions will appear here as Muze works");
  });

  it("a failed activity row shows the failed state word", async () => {
    stubTasks([]);
    const container = home();
    await flush();
    emitActivity({ kind: "activity", id: "act_1", tool: "dom.click", summary: "Clicked", state: "failed", at: 1 });
    await flush();
    const timeline = container.querySelector("#browserTimeline");
    expect(timeline).toBeTruthy();
    expect(timeline!.querySelectorAll(".step").length).toBe(1);
    expect(timeline!.textContent).toContain("Clicked");
    expect(timeline!.querySelectorAll(".tmeta")[0].textContent).toBe("Didn't finish");
  });
});
