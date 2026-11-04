/**
 * Live activity feed: one event per real tool execution, from the
 * executor, whether the call comes from a direct tool call or a task
 * step. Events carry the tool name, a generic verb, and state — never
 * inputs, outputs, URLs, or page content.
 */
import { describe, expect, it } from "vitest";
import { ACTIVITY_FEED_CAP, ACTIVITY_TIMELINE_HEIGHT_PX, ACTIVITY_TIMELINE_ROW_HEIGHT_PX, ACTIVITY_TIMELINE_VISIBLE_ROWS, activityVerb, applyActivityEvent, mergeActivitySeed, type ActivityEvent, type ActivityRow } from "../libs/activity.js";
import { createTestRuntime } from "../libs/testing/index.js";
import { TaskRunner, createMemoryTaskStore, type PolicySnapshot } from "../libs/tasks/index.js";
import { ToolErrorException, type ClientIdentity } from "../libs/tool-contracts/index.js";

const readClient: ClientIdentity = { id: "c1", name: "Client", transport: "native" };

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(ToolErrorException.is(error)).toBe(true);
    expect((error as ToolErrorException).code).toBe(code);
  }
}

function event(tool: string, state: ActivityEvent["state"], id: string): ActivityEvent {
  return { kind: "activity", id, tool, summary: activityVerb(tool), state, at: 1 };
}

describe("activityVerb", () => {
  it("maps exact tools to plain verbs", () => {
    expect(activityVerb("dom.click")).toBe("Clicked");
    expect(activityVerb("dom.clickAt")).toBe("Clicked");
    expect(activityVerb("dom.hover")).toBe("Hovered");
    expect(activityVerb("dom.type")).toBe("Typed");
    expect(activityVerb("dom.typeAt")).toBe("Typed");
    expect(activityVerb("dom.scroll")).toBe("Scrolled");
    expect(activityVerb("dom.drag")).toBe("Dragged");
    expect(activityVerb("tabs.create")).toBe("Opened a tab");
    expect(activityVerb("tabs.close")).toBe("Closed a tab");
    expect(activityVerb("forms.upload")).toBe("Uploaded a file");
    expect(activityVerb("observe")).toBe("Read the page");
  });

  it("falls back by family and never echoes the tool name", () => {
    expect(activityVerb("screenshots.viewport")).toBe("Took a screenshot");
    expect(activityVerb("tabs.navigate")).toBe("Navigated");
    expect(activityVerb("navigation.open")).toBe("Navigated");
    expect(activityVerb("page.read")).toBe("Read the page");
    expect(activityVerb("tabs.group")).toBe("Changed tabs");
    expect(activityVerb("bookmarks.create")).toBe("Used bookmarks");
    expect(activityVerb("history.search")).toBe("Used history");
    expect(activityVerb("downloads.download")).toBe("Downloaded");
    expect(activityVerb("clipboard.write")).toBe("Used the clipboard");
    expect(activityVerb("browser.getInfo")).toBe("Checked the browser");
    expect(activityVerb("devtools.evaluate")).toBe("Checked diagnostics");
    expect(activityVerb("workflows.run")).toBe("Ran a workflow");
    expect(activityVerb("tasks.create")).toBe("Managed a task");
    expect(activityVerb("some.futureTool")).toBe("Worked");
  });
});

describe("applyActivityEvent", () => {
  it("keeps exactly the last 25 actions (user's ask: 20–25, top of range)", () => {
    expect(ACTIVITY_FEED_CAP).toBe(25);
  });
  it("appends rows in arrival order and resolves a start row by id", () => {
    let rows = applyActivityEvent([], event("dom.click", "running", "act_1"));
    rows = applyActivityEvent(rows, event("screenshots.viewport", "running", "act_2"));
    expect(rows.map((r) => r.summary)).toEqual(["Clicked", "Took a screenshot"]);
    expect(rows[0].state).toBe("running");
    rows = applyActivityEvent(rows, event("dom.click", "done", "act_1"));
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("done");
    expect(rows[1].state).toBe("running");
  });

  it("appends a completion for an unknown id instead of dropping it", () => {
    const rows = applyActivityEvent([], event("tabs.list", "done", "act_9"));
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("done");
  });

  it("caps the feed at the most recent rows", () => {
    let rows: ReturnType<typeof applyActivityEvent> = [];
    for (let i = 0; i < ACTIVITY_FEED_CAP + 10; i++) {
      rows = applyActivityEvent(rows, event("tabs.list", "running", `act_${i}`));
    }
    expect(rows).toHaveLength(ACTIVITY_FEED_CAP);
    expect(rows[0].id).toBe("act_10");
    expect(rows[rows.length - 1].id).toBe(`act_${ACTIVITY_FEED_CAP + 9}`);
  });
});

describe("mergeActivitySeed", () => {
  const row = (id: string, at: number, state: ActivityRow["state"] = "done"): ActivityRow => ({
    id,
    tool: "dom.click",
    summary: `Action ${id}`,
    state,
    at,
  });

  it("unions seed and live rows by id, live wins, ordered by time, capped", () => {
    const merged = mergeActivitySeed(
      [row("act_live", 5, "running")],
      [row("act_seed", 1), row("act_live", 2, "done")],
    );
    expect(merged.map((r) => r.id)).toEqual(["act_seed", "act_live"]);
    // The live row wins the conflict: its newer state and time survive.
    expect(merged[1].state).toBe("running");
    expect(merged[1].at).toBe(5);
  });

  it("caps the merged list to the most recent rows", () => {
    const seed = Array.from({ length: 30 }, (_, i) => row(`act_${i}`, i));
    const merged = mergeActivitySeed([], seed);
    expect(merged).toHaveLength(25);
    expect(merged[0].id).toBe("act_5");
    expect(merged[24].id).toBe("act_29");
  });
});

describe("timeline geometry", () => {
  it("container height is exactly 5 standard rows, from the stylesheet measurements", () => {
    // Verb 13px × body line-height 1.5 = 19.5px + step padding-bottom 18px.
    expect(ACTIVITY_TIMELINE_ROW_HEIGHT_PX).toBe(37.5);
    expect(ACTIVITY_TIMELINE_VISIBLE_ROWS).toBe(5);
    expect(ACTIVITY_TIMELINE_HEIGHT_PX).toBe(187.5);
    expect(ACTIVITY_TIMELINE_HEIGHT_PX).toBe(ACTIVITY_TIMELINE_VISIBLE_ROWS * ACTIVITY_TIMELINE_ROW_HEIGHT_PX);
  });
});

describe("executor activity emission", () => {
  it("a direct tool call emits start + done with a redacted shape", async () => {
    const SECRET = "activity-secret-7f3a9c";
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({
      policy: { mode: "unrestricted" },
      onActivity: (e) => events.push(e),
    });
    const result = await rt.executor.execute({
      tool: "clipboard.write",
      input: { text: SECRET },
      client: readClient,
      ctx: rt.ctx,
    });
    expect(result.dryRun).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0].state).toBe("running");
    expect(events[1].state).toBe("done");
    expect(events[0].id).toBe(events[1].id);
    expect(events[0].tool).toBe("clipboard.write");
    expect(events[0].summary).toBe("Used the clipboard");
    // Exact event shape: nothing but what a timeline row needs.
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(["at", "id", "kind", "state", "summary", "tool"]);
    }
    expect(events[0].kind).toBe("activity");
    // No input or output data anywhere in the events.
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("input");
    expect(JSON.stringify(events)).not.toContain("output");
  });

  it("a failed tool call resolves the same row to failed", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({
      policy: { defaultTimeoutMs: 30 },
      context: { tabs: [{ url: "https://slow.test/", title: "Slow", active: true, status: "loading" }] },
      onActivity: (e) => events.push(e),
    });
    await expectCode(
      rt.executor.execute({ tool: "navigation.wait", input: { timeoutMs: 60_000 }, client: readClient, ctx: rt.ctx }),
      "TIMEOUT",
    );
    expect(events).toHaveLength(2);
    expect(events[0].state).toBe("running");
    expect(events[1].state).toBe("failed");
    expect(events[0].id).toBe(events[1].id);
    expect(events[0].tool).toBe("navigation.wait");
  });

  it("a call rejected before execution emits nothing", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({
      policy: { allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: false, restricted: true } },
      onActivity: (e) => events.push(e),
    });
    await expectCode(
      rt.executor.execute({ tool: "forms.submit", input: { formRef: "r1" }, client: readClient, ctx: rt.ctx }),
      "PERMISSION_DENIED",
    );
    expect(events).toHaveLength(0);
  });

  it("dry runs and nested invokes emit nothing", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
    await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx, dryRun: true });
    await rt.executor.execute({ tool: "tabs.list", input: {}, client: readClient, ctx: rt.ctx, nested: true });
    expect(events).toHaveLength(0);
  });

  it("a task step emits start + completion through the real executor", async () => {
    const events: ActivityEvent[] = [];
    const rt = createTestRuntime({ onActivity: (e) => events.push(e) });
    const SNAPSHOT: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: "client-a", scope: "call:tools" };
    let idCounter = 0;
    const runner = new TaskRunner({
      store: createMemoryTaskStore(),
      executeStep: async (tool, input, ctx) => {
        const r = await rt.executor.execute({
          tool,
          input,
          client: { id: ctx.clientId, name: ctx.clientId, transport: "remote" },
          ctx: rt.ctx,
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
        });
        const raw = r.result;
        return { outputSummary: typeof raw === "string" ? raw : JSON.stringify(raw) ?? "" };
      },
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...SNAPSHOT }),
      now: () => 1_000_000,
      generateId: () => {
        idCounter += 1;
        return `task_${idCounter.toString(16).padStart(32, "0")}`;
      },
    });
    const created = await runner.createTask(
      { goal: "list tabs", clientId: "client-a", browserSessionId: "browser-session-1", steps: [{ tool: "tabs.list", input: {} }] },
      SNAPSHOT,
    );
    const done = await runner.runTask(created.id, "client-a");
    expect(done.status).toBe("done");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: "tabs.list", state: "running" });
    expect(events[1]).toMatchObject({ tool: "tabs.list", state: "done" });
    expect(events[0].id).toBe(events[1].id);
  });
});
