// @vitest-environment jsdom
/**
 * Regression tests for the browser-engine + tasks fix batch:
 * consequential tool names, multi-frame ref routing, act summaries,
 * CDP key codes / char events / timeout generation guard, captureTab
 * windowId, screenshots.viewport capture, coordinate typing
 * (dom.typeAt/dom.pressAt), dom.click TIMEOUT-only fallback, batch
 * bounds re-check, and approval-response broker errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIsConsequential } from "../libs/tasks/types.js";
import { runPageOp } from "../libs/browser-engine/tools/helpers.js";
import { describeOperation } from "../libs/browser-engine/summaries.js";
import { ChromeCdpCapability } from "../src/cdp-controller.js";
import { systemToolHandlers } from "../libs/browser-engine/tools/system.js";
import { interactToolHandlers } from "../libs/browser-engine/tools/interact.js";
import { createTestRuntime } from "../libs/testing/index.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskStep,
} from "../libs/tasks/index.js";
import { HostProtocolHandler, type BridgeTransport } from "../src/host-protocol.js";
import { PROTOCOL_VERSION } from "../libs/tool-contracts/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

// jsdom does not implement the pointer/drag/geometry APIs the agent dispatches.
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? false;
  }
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).PointerEvent = TestPointerEvent;
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
  if (typeof document.elementFromPoint !== "function") {
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element }).elementFromPoint = () => document.body;
  }
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubRect(el: Element, x: number, y: number, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
}

describe("consequential tool names", () => {
  it("treats the real delete tools as consequential (and keeps the legacy chrome-API names)", () => {
    expect(defaultIsConsequential("bookmarks.delete")).toBe(true);
    expect(defaultIsConsequential("history.delete")).toBe(true);
    expect(defaultIsConsequential("bookmarks.remove")).toBe(true);
    expect(defaultIsConsequential("history.deleteUrl")).toBe(true);
  });
});

describe("multi-frame ref routing", () => {
  it("errors on refs from two different frames instead of routing to the highest", async () => {
    const ctx = { executeInPage: async () => { throw new Error("must not be called"); } };
    await expect(
      runPageOp(ctx as never, 1, { op: "topViewportBoxes", refs: ["f1.a", "f2.b"] } as never),
    ).rejects.toThrow("different frames");
  });

  it("still routes single-frame refs and keeps the explicit-frameId contradiction", async () => {
    const seen: { op: unknown; frameIds: number[] | "all" }[] = [];
    const ctx = {
      executeInFrames: async (_tabId: number, _fn: unknown, op: unknown, frameIds: number[] | "all") => {
        seen.push({ op, frameIds });
        return [{ frameId: 3, result: { boxes: [] } }];
      },
    };
    const result = await runPageOp(ctx as never, 1, { op: "topViewportBoxes", refs: ["f3.a"] } as never);
    expect(result).toEqual({ boxes: [] });
    expect(seen[0].frameIds).toEqual([3]);
    expect((seen[0].op as { refs: string[] }).refs).toEqual(["a"]);
    await expect(
      runPageOp(ctx as never, 1, { op: "topViewportBoxes", refs: ["f3.a"] } as never, 5),
    ).rejects.toThrow("does not match");
  });
});

describe("act summaries describe every step", () => {
  it("lists fills, clicks, and the submit instead of only the first click", () => {
    const summary = describeOperation("act", {
      steps: [
        { do: "fill", target: { ref: "r1" } },
        { do: "type", target: { ref: "r2" } },
        { do: "click", target: { ref: "r3" } },
        { do: "press", target: { ref: "r3" }, key: "Enter" },
      ],
    }, { domain: "example.com" });
    expect(summary).toContain("Fill r1");
    expect(summary).toContain("Type into r2");
    expect(summary).toContain("Click r3");
    expect(summary).toContain("Submit/Press Enter");
  });
});

describe("CDP key codes, char events, and timeout generation guard", () => {
  function installDebugger(sendImpl?: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    const commands: { method: string; params: Record<string, unknown> }[] = [];
    vi.stubGlobal("chrome", {
      debugger: {
        attach: vi.fn(async () => undefined),
        detach: vi.fn(async () => undefined),
        sendCommand: vi.fn(async (_target: unknown, method: string, params: Record<string, unknown>) => {
          commands.push({ method, params });
          return sendImpl ? sendImpl(method, params) : {};
        }),
        onDetach: { addListener: vi.fn() },
      },
      tabs: { onRemoved: { addListener: vi.fn() } },
    });
    return commands;
  }

  const keyEvents = (commands: { method: string; params: Record<string, unknown> }[]) =>
    commands.filter((c) => c.method === "Input.dispatchKeyEvent");

  it("maps named keys to real virtual-key codes and emits a char event for printable keys", async () => {
    const commands = installDebugger();
    const cap = new ChromeCdpCapability();
    await cap.press(7, "F5");
    await cap.press(7, "Control");
    await cap.press(7, "a");
    await cap.press(7, "a", 2);
    const events = keyEvents(commands);
    const f5 = events.filter((e) => e.params.key === "F5");
    expect(f5[0].params.windowsVirtualKeyCode).toBe(116);
    expect(f5.some((e) => e.params.type === "char")).toBe(false);
    const ctrl = events.filter((e) => e.params.key === "Control");
    expect(ctrl[0].params.windowsVirtualKeyCode).toBe(17);
    const a = events.filter((e) => e.params.key === "a" && e.params.modifiers === 0);
    expect(a.map((e) => e.params.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(a[0].params.windowsVirtualKeyCode).toBe(97);
    expect(a[1].params.text).toBe("a");
    const ctrlA = events.filter((e) => e.params.key === "a" && e.params.modifiers === 2);
    expect(ctrlA.some((e) => e.params.type === "char")).toBe(false);
  });

  it("refuses late commands from a timed-out sequence and leaves the next sequence working", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstKeySent = false;
    const commands = installDebugger(async (method, params) => {
      if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && !firstKeySent) {
        firstKeySent = true;
        await gate;
      }
      return {};
    });
    const cap = new ChromeCdpCapability();
    const pending = cap.press(7, "a");
    // Attach the rejection assertion BEFORE advancing timers: the
    // TIMEOUT rejection must have a handler by the time the timer
    // fires, or the runtime flags it unhandled before the test awaits it.
    const pendingAssertion = expect(pending).rejects.toThrow("did not complete within");
    // Let attach + the first key dispatch happen, then trip the 15s bound.
    await vi.advanceTimersByTimeAsync(0);
    expect(keyEvents(commands)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await pendingAssertion;
    // The orphaned sequence continues only now: its char/keyUp must
    // never be dispatched into the next sequence's session.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(keyEvents(commands)).toHaveLength(1);
    // And a fresh sequence on the same tab works normally.
    await cap.press(7, "x");
    expect(keyEvents(commands).filter((e) => e.params.key === "x").map((e) => e.params.type)).toEqual([
      "rawKeyDown",
      "char",
      "keyUp",
    ]);
  });
});

describe("browser.captureTab honours windowId", () => {
  it("captures the given window's active tab, not the last-focused window's", async () => {
    const captured: number[] = [];
    const fakeCtx = {
      listTabs: async () => [
        { id: 11, windowId: 9, active: false },
        { id: 12, windowId: 9, active: true },
      ],
      getActiveTab: async () => ({ id: 99, windowId: 1, active: true }),
      captureVisibleTab: async (tabId: number) => {
        captured.push(tabId);
        return { dataUrl: "data:image/png;base64,AAAA", width: 10, height: 10 };
      },
    };
    const tool = systemToolHandlers.find((t) => t.name === "browser.captureTab")!;
    const result = await tool.handler(
      { windowId: 9, format: "png", quality: 80 },
      { ctx: fakeCtx, signal: new AbortController().signal } as never,
    );
    expect(captured).toEqual([12]);
    expect((result as { dataUrl: string }).dataUrl).toContain("AAAA");
    const fallback = await tool.handler(
      { format: "png", quality: 80 },
      { ctx: fakeCtx, signal: new AbortController().signal } as never,
    );
    expect(captured).toEqual([12, 99]);
    expect(fallback).toBeTruthy();
  });
});

describe("screenshots.viewport returns a real screenshot", () => {
  it("captures via the tabs path and keeps viewport dimensions", async () => {
    const fakeCtx = {
      getActiveTab: async () => ({ id: 1, url: "https://example.com", active: true }),
      getTab: async () => ({ id: 1, url: "https://example.com", active: true }),
      executeInPage: async (_tabId: number, fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
      captureVisibleTab: async () => ({ dataUrl: "data:image/png;base64,AAAA", width: 1280, height: 720 }),
    };
    const tool = interactToolHandlers.find((t) => t.name === "screenshots.viewport")!;
    const result = await tool.handler(
      { format: "png", quality: 80 },
      { ctx: fakeCtx, signal: new AbortController().signal } as never,
    ) as { dataUrl: string; width: number; devicePixelRatio: number; scrollY: number };
    expect(result.dataUrl).toContain("AAAA");
    expect(result.width).toBeGreaterThan(0);
    expect(result.devicePixelRatio).toBeGreaterThan(0);
    expect(result.scrollY).toBe(0);
  });
});

describe("coordinate typing (dom.typeAt / dom.pressAt)", () => {
  function seedInput(hidden = false): HTMLInputElement {
    document.body.innerHTML = `<input id="to" type="text" />`;
    const input = document.getElementById("to") as HTMLInputElement;
    if (hidden) input.style.display = "none";
    stubRect(input, 10, 20, 100, 20);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element }).elementFromPoint = () => input;
    return input;
  }

  it("types into the visible element at the point and verifies the text landed", async () => {
    const input = seedInput();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ tool: "dom.typeAt", input: { x: 20, y: 30, text: "hello" }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ typed: true, method: "synthetic" });
    expect(input.value).toBe("hello");
  });

  it("fails fast with 'target is hidden' instead of reporting typed:true for a hidden element", async () => {
    seedInput(true);
    const rt = createTestRuntime();
    await expect(
      rt.executor.execute({ tool: "dom.typeAt", input: { x: 20, y: 30, text: "hello" }, client, ctx: rt.ctx }),
    ).rejects.toThrow("target is hidden");
  });

  it("presses a key on the element at the point without a ref", async () => {
    seedInput();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ tool: "dom.pressAt", input: { x: 20, y: 30, key: "Escape" }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ pressed: true, method: "synthetic" });
  });
});

describe("dom.click TIMEOUT-only synthetic fallback", () => {
  function seedButton(): HTMLButtonElement {
    document.body.innerHTML = `<button id="b" type="button">Go</button>`;
    const button = document.getElementById("b") as HTMLButtonElement;
    stubRect(button, 10, 20, 100, 20);
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element }).elementFromPoint = () => button;
    return button;
  }

  it("falls back to synthetic on a CDP TIMEOUT and reports method synthetic", async () => {
    seedButton();
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#b" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    (rt.ctx.cdp as unknown as Record<string, unknown>).click = async () => {
      throw new ToolErrorException("TIMEOUT", "CDP input sequence did not complete within 15000ms");
    };
    const result = await rt.executor.execute({ tool: "dom.click", input: { ref, button: "left" }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ clicked: true, method: "synthetic" });
  });

  it("still throws non-timeout CDP failures instead of masking them", async () => {
    seedButton();
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#b" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    (rt.ctx.cdp as unknown as Record<string, unknown>).click = async () => {
      throw new ToolErrorException("INTERNAL", "debugger detached");
    };
    await expect(
      rt.executor.execute({ tool: "dom.click", input: { ref, button: "left" }, client, ctx: rt.ctx }),
    ).rejects.toThrow("debugger detached");
  });
});

describe("batch bounds re-check", () => {
  it("pauses before launch when the plan approval expires during pre-flight, without running any member", async () => {
    let nowVal = 1_000_000;
    let idCounter = 0;
    const snapshot: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: "client-a", scope: "call:tools" };
    const calls: string[] = [];
    const runner = new TaskRunner({
      store: createMemoryTaskStore(),
      executeStep: async (tool: string) => {
        calls.push(tool);
        return { outputSummary: "ok" };
      },
      audit: () => undefined,
      progress: () => undefined,
      policySnapshot: () => ({ ...snapshot }),
      captureSnapshot: async (_step: TaskStep) => {
        // The approval expires while snapshots are being captured.
        nowVal = 10_000_000_000;
        return { url: null, a11ySummary: "", formSummary: "" };
      },
      now: () => nowVal,
      generateId: () => `task_${(++idCounter).toString(16).padStart(32, "0")}`,
      isConsequential: () => true,
    });
    const created = await runner.createTask({
      goal: "parallel clicks",
      clientId: "client-a",
      browserSessionId: "browser-session-1",
      steps: [
        { tool: "dom.click", input: { ref: "r1" }, independent: true, parallelGroup: 1 },
        { tool: "dom.click", input: { ref: "r2" }, independent: true, parallelGroup: 1 },
      ],
    }, snapshot);
    await runner.approvePlan(created.id, "client-a", { source: "dashboard", bounds: {} });
    const view = await runner.runTask(created.id, "client-a");
    expect(view.status).toBe("paused");
    expect(view.pauseReason).toBe("plan-approval-expired");
    expect(calls).toEqual([]);
    expect(view.steps.every((s) => s.state === "pending")).toBe(true);
  });
});

describe("approval.respond does not claim a broker-rejected approval", () => {
  it("posts the broker record's actual status when the broker rejects the response", async () => {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
      context: { clipboard: "secret-value" },
    });
    const messages: { type: string; id?: string; approvalId?: string; approved?: boolean }[] = [];
    const transport: BridgeTransport = { post: (message) => { messages.push(message as never); } };
    const handler = new HostProtocolHandler({
      registry: rt.registry,
      executor: rt.executor,
      policy: rt.policy,
      approvals: rt.approvals,
      transport,
      getContext: () => rt.ctx,
      server: { name: "test-host", version: "1.0.0" },
      legacyTools: true,
    });
    await handler.handle({ type: "hello", id: "h", protocolVersion: PROTOCOL_VERSION, client: { id: "c", name: "C", transport: "native" } });
    await handler.handle({ type: "approval.request", id: "a1", tool: "clipboard.read", input: {} });
    const requested = messages.find((m) => m.type === "approval.requested") as unknown as { approval: { id: string } };
    const approvalId = requested.approval.id;
    // Decide it once (deny), then answer again asking for approval:
    // the broker rejects the second decision, so the post must report
    // the recorded denial, not the requested approval.
    await handler.handle({ type: "approval.respond", id: "a2", approvalId, approved: false });
    await handler.handle({ type: "approval.respond", id: "a3", approvalId, approved: true });
    const last = messages.filter((m) => m.type === "approval.resolved").at(-1)!;
    expect(last).toMatchObject({ id: "a3", approvalId, approved: false });
  });
});
