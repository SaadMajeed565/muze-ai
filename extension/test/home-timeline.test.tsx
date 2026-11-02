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
    },
  });
}

describe("HomePage browser-card timeline", () => {
  afterEach(() => {
    if (root) render(null, root);
    root = null;
    vi.unstubAllGlobals();
  });

  it("renders a running task's steps in the Home card timeline", async () => {
    stubTasks([
      taskFixture({
        steps: [
          { index: 0, tool: "tabs.navigate", inputSummary: "Open pricing page", outputSummary: "Opened pricing page", state: "done", attempts: 1 },
          { index: 1, tool: "dom.click", inputSummary: "Click features", outputSummary: "Clicked Features", state: "running", attempts: 1 },
        ],
      }),
    ]);
    const container = mount(<HomePage state={state} busy={false} approvals={[]} onNavigate={() => {}} onRespond={() => {}} />);
    await flush();
    const timeline = container.querySelector("#browserTimeline");
    expect(timeline).toBeTruthy();
    expect(timeline!.querySelectorAll(".step").length).toBe(2);
    expect(timeline!.textContent).toContain("Opened pricing page");
    expect(timeline!.textContent).toContain("Clicked Features");
  });

  it("shows an honest empty state for a running task with no steps", async () => {
    stubTasks([taskFixture({ steps: [] })]);
    const container = mount(<HomePage state={state} busy={false} approvals={[]} onNavigate={() => {}} onRespond={() => {}} />);
    await flush();
    expect(container.querySelector("#browserTimeline")).toBeNull();
    expect(container.textContent).toContain("Steps will appear here as the task runs.");
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
    const container = mount(<HomePage state={state} busy={false} approvals={[]} onNavigate={() => {}} onRespond={() => {}} />);
    await flush();
    expect(container.querySelector("#browserTimeline")).toBeNull();
    expect(container.textContent).toContain("Nothing running right now");
  });
});
