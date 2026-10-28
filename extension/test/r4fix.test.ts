// @vitest-environment jsdom
/**
 * Regression tests for the retest4 last-6 batch (2026-10-28):
 * dom.drag/dom.dragAt CDP timeout, screenshots.fullPage quota/timeout,
 * clipboard partial (focus), and WindowInfo tabCount always 0.
 * No live browser is touched: CDP is mocked, page ops run in jsdom,
 * and window/tab counts run against the mock context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { ChromeCdpCapability } from "../src/cdp-controller.js";
import { isCaptureQuotaError } from "../src/chrome-context.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";
import { toWindowInfo } from "../libs/browser-engine/tools/helpers.js";

const client = { id: "c1", name: "Test", transport: "native" as const };
const open = { mode: "unrestricted" } as const;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? false;
  }
}
class TestDragEvent extends MouseEvent {
  readonly dataTransfer: DataTransfer | null;
  constructor(type: string, init: DragEventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}
class TestDataTransfer {
  setData(): void {}
  getData(): string {
    return "";
  }
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).PointerEvent = TestPointerEvent;
  (globalThis as Record<string, unknown>).DragEvent = TestDragEvent;
  (globalThis as Record<string, unknown>).DataTransfer = TestDataTransfer;
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
  if (typeof document.elementFromPoint !== "function") {
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element }).elementFromPoint = () => document.body;
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type DebuggerMock = {
  commands: { method: string; params: Record<string, unknown> }[];
};

function installDebugger(): DebuggerMock {
  const mock: DebuggerMock = { commands: [] };
  vi.stubGlobal("chrome", {
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string, params: Record<string, unknown>) => {
        mock.commands.push({ method, params });
        return {};
      }),
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  });
  return mock;
}

describe("r4fix: CDP drag is a single move, not an interpolated stream", () => {
  it("drag sends exactly one buttons:1 mouseMoved, straight to the destination", async () => {
    const mock = installDebugger();
    const cap = new ChromeCdpCapability();
    await cap.drag(7, 10, 20, 100, 200);
    const moves = mock.commands.filter(
      (c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseMoved",
    );
    // Old code: move to from (buttons 0) + 5 interpolated moves
    // (buttons 1) = 6 mouseMoved. Fixed code: 2 total, and the only
    // pressed move goes straight to the destination.
    expect(moves).toHaveLength(2);
    expect(moves[0].params).toMatchObject({ x: 10, y: 20, buttons: 0 });
    expect(moves[1].params).toMatchObject({ x: 100, y: 200, buttons: 1 });
    const pressed = mock.commands.find((c) => c.params.type === "mousePressed");
    const released = mock.commands.find((c) => c.params.type === "mouseReleased");
    expect(pressed?.params).toMatchObject({ buttons: 1 });
    expect(released?.params).toMatchObject({ buttons: 0 });
  });
});

describe("r4fix: dom.dragAt falls back to synthetic only on CDP TIMEOUT", () => {
  it("returns method synthetic when the CDP drag times out, and the synthetic drag actually runs", async () => {
    const rt = createTestRuntime({ policy: open, context: { cdpEnabled: true, tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
    const cdp = rt.ctx.cdp!;
    cdp.drag = async () => {
      throw new ToolErrorException("TIMEOUT", "CDP input sequence did not complete within 15000ms");
    };
    const result = await rt.executor.execute({ tool: "dom.dragAt", input: { x1: 1, y1: 2, x2: 30, y2: 40 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ dragged: true, x1: 1, y1: 2, x2: 30, y2: 40, method: "synthetic" });
  });

  it("does not mask a non-timeout CDP drag error as a synthetic success", async () => {
    const rt = createTestRuntime({ policy: open, context: { cdpEnabled: true, tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
    const cdp = rt.ctx.cdp!;
    cdp.drag = async () => {
      throw new ToolErrorException("NOT_FOUND", "No such tab");
    };
    await expect(
      rt.executor.execute({ tool: "dom.dragAt", input: { x1: 1, y1: 2, x2: 30, y2: 40 }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("r4fix: fullPage quota detection", () => {
  it("recognises the Chrome capture quota error and does not treat other errors as quota", () => {
    expect(isCaptureQuotaError(new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota"))).toBe(true);
    expect(isCaptureQuotaError(new Error("Operation timed out after 30000ms"))).toBe(false);
    expect(isCaptureQuotaError(new Error("boom"))).toBe(false);
  });
});

describe("r4fix: WindowInfo tabCount", () => {
  it("counts populated tabs instead of reporting 0", () => {
    const info = toWindowInfo({
      id: 5,
      focused: true,
      state: "normal",
      type: "normal",
      tabs: [
        { id: 1, index: 0, windowId: 5, active: true, pinned: false, highlighted: true, title: "A", url: "https://a.test/", status: "complete", groupId: -1, audible: false, discarded: false, incognito: false },
        { id: 2, index: 1, windowId: 5, active: false, pinned: false, highlighted: false, title: "B", url: "https://b.test/", status: "complete", groupId: -1, audible: false, discarded: false, incognito: false },
        { id: 3, index: 2, windowId: 5, active: false, pinned: false, highlighted: false, title: "C", url: "https://c.test/", status: "complete", groupId: -1, audible: false, discarded: false, incognito: false },
      ],
    });
    expect(info.tabCount).toBe(3);
  });

  it("windows.list counts tabs via listTabs when the window arrives unpopulated (the retest4 bug)", async () => {
    const rt = createTestRuntime({ policy: open, context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
    // Simulate the real chrome-context bug: listWindows returns a
    // window with NO tabs array at all, even though tabs exist.
    (rt.ctx as unknown as { listWindows: () => Promise<unknown[]> }).listWindows = async () => [
      { id: 42, focused: true, state: "normal", type: "normal" },
    ];
    (rt.ctx as unknown as { listTabs: (query: unknown) => Promise<unknown[]> }).listTabs = async () => [
      { id: 1, index: 0, windowId: 42, active: true, pinned: false, highlighted: true, title: "A", url: "https://a.test/", status: "complete", groupId: -1, audible: false, discarded: false, incognito: false },
      { id: 2, index: 1, windowId: 42, active: false, pinned: false, highlighted: false, title: "B", url: "https://b.test/", status: "complete", groupId: -1, audible: false, discarded: false, incognito: false },
    ];
    const result = await rt.executor.execute({ tool: "windows.list", input: {}, client, ctx: rt.ctx });
    expect((result.result as { windows: { tabCount: number }[] }).windows[0].tabCount).toBe(2);
  });
});

describe("r4fix: clipboard restricted active tab gets its own error", () => {
  it("names the restricted active tab instead of the generic focus error", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "chrome://extensions/", title: "Extensions", active: true }] },
    });
    (rt.ctx as unknown as { clipboard: { read: () => Promise<string>; write: (text: string) => Promise<void> } }).clipboard = {
      read: async () => {
        throw new Error("Document is not focused");
      },
      write: async () => undefined,
    };
    let message = "";
    try {
      await rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx });
      throw new Error("expected clipboard.read to throw");
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("restricted page");
    expect(message).toContain("active tab");
    expect(message).not.toContain("offscreen document is never focused, and the active tab's page context could not read it either");
  });
});
