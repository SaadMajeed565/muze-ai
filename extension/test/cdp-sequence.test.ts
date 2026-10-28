/**
 * Regression tests for the retest3 CDP mouse failures (dom.click,
 * dom.hover, dom.moveTo, dom.dragAt, dom.setRadio, dom.setChecked-uncheck
 * timing out at the 15s CDP bound while dom.clickAt, the act click step
 * and dom.setChecked-check passed via CDP in the same session).
 *
 * No live browser is touched: chrome.debugger is fully mocked. The
 * tests pin the fixed sequence, not the timeout: a single mouseMoved
 * per move (no 6-step interpolation from a tracked position), serial
 * per-tab sequences (a timed-out sequence cannot detach or interleave
 * with the next one), and a detach that hangs cannot wedge the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeCdpCapability } from "../src/cdp-controller.js";

type DebuggerMock = {
  attachCalls: number;
  detachCalls: number;
  order: string[];
  commands: { method: string; params: Record<string, unknown> }[];
  sendImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  detachImpl: () => Promise<void>;
};

function installDebugger(): DebuggerMock {
  const mock: DebuggerMock = {
    attachCalls: 0,
    detachCalls: 0,
    order: [],
    commands: [],
    sendImpl: async () => ({}),
    detachImpl: async () => undefined,
  };
  vi.stubGlobal("chrome", {
    debugger: {
      attach: vi.fn(async () => {
        mock.attachCalls++;
        mock.order.push("attach");
      }),
      detach: vi.fn(async () => {
        mock.detachCalls++;
        mock.order.push("detach");
        await mock.detachImpl();
      }),
      sendCommand: vi.fn(async (_target: unknown, method: string, params: Record<string, unknown>) => {
        mock.commands.push({ method, params });
        return mock.sendImpl(method, params);
      }),
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  });
  return mock;
}

const mouseMoves = (mock: DebuggerMock, type: string) =>
  mock.commands.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === type);

describe("CDP mouse sequence (retest3 failures)", () => {
  let mock: DebuggerMock;
  let cap: ChromeCdpCapability;

  beforeEach(() => {
    mock = installDebugger();
    cap = new ChromeCdpCapability();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("moves with a single mouseMoved even on the second move on the same tab (no interpolation)", async () => {
    await cap.move(7, 10, 20);
    await cap.move(7, 100, 200);
    // Old code: first move 1 mouseMoved, second move 6 interpolated
    // mouseMoved (7 total). Fixed code: exactly one per move.
    expect(mouseMoves(mock, "mouseMoved")).toHaveLength(2);
    expect(mouseMoves(mock, "mouseMoved")[1].params).toMatchObject({ x: 100, y: 200, buttons: 0 });
  });

  it("clicks with one move, a press with buttons set, and a release with buttons cleared", async () => {
    await cap.click(7, 50, 60, "left", 1);
    expect(mouseMoves(mock, "mouseMoved")).toHaveLength(1);
    expect(mouseMoves(mock, "mousePressed")).toHaveLength(1);
    expect(mouseMoves(mock, "mousePressed")[0].params).toMatchObject({ button: "left", buttons: 1, clickCount: 1 });
    expect(mouseMoves(mock, "mouseReleased")).toHaveLength(1);
    expect(mouseMoves(mock, "mouseReleased")[0].params).toMatchObject({ button: "left", buttons: 0, clickCount: 1 });
  });

  it("serialises sequences per tab: a second sequence does not start until the first has detached", async () => {
    let releasePress!: () => void;
    const pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    mock.sendImpl = async (_method, params) => {
      if (params.type === "mousePressed") await pressGate;
      return {};
    };
    const first = cap.click(7, 10, 20);
    // Let the first sequence reach its (gated) press: the click path
    // dwells 50ms after its move before pressing, so microtask flushes
    // alone do not get it there — poll on real timers.
    for (let i = 0; i < 100 && mouseMoves(mock, "mousePressed").length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(mouseMoves(mock, "mousePressed")).toHaveLength(1);
    const second = cap.move(7, 30, 40);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Still gated on the first sequence: no second-sequence mouseMoved yet.
    expect(mouseMoves(mock, "mouseMoved")).toHaveLength(1);
    releasePress();
    await first;
    await second;
    expect(mouseMoves(mock, "mouseMoved")).toHaveLength(2);
    expect(mock.order).toEqual(["attach", "detach", "attach", "detach"]);
  });

  it("a timed-out sequence detaches before the next sequence re-attaches, and the retry is not wedged", async () => {
    vi.useFakeTimers();
    mock.sendImpl = () => new Promise(() => undefined); // every command hangs
    const first = cap.click(7, 10, 20);
    // Attach a handler immediately: the 15s timer fires while this test
    // is still inside advanceTimersByTimeAsync, i.e. before the test
    // awaits `first` below, and Node would otherwise flag the interim
    // rejection as unhandled even though the test then observes it.
    void first.catch(() => undefined);
    await expect(
      (async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await first;
      })(),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(mock.detachCalls).toBe(1);
    const orderBeforeRetry = [...mock.order];
    mock.sendImpl = async () => ({});
    const retry = cap.click(7, 10, 20);
    await vi.advanceTimersByTimeAsync(5_000);
    await retry;
    // The retry re-attached after the timed-out sequence's detach, and
    // completed with a full press/release pair.
    expect(orderBeforeRetry).toEqual(["attach", "detach"]);
    expect(mock.attachCalls).toBe(2);
    expect(mouseMoves(mock, "mousePressed")).toHaveLength(1);
    expect(mouseMoves(mock, "mouseReleased")).toHaveLength(1);
  });

  it("a hanging detach is force-cleared after 2s and does not block the next sequence", async () => {
    vi.useFakeTimers();
    mock.detachImpl = () => new Promise(() => undefined); // detach hangs
    const first = cap.click(7, 10, 20);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(mock.detachCalls).toBe(1);
    const second = cap.click(7, 30, 40);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    // Force-cleared detach let the second sequence re-attach.
    expect(mock.attachCalls).toBe(2);
    expect(mouseMoves(mock, "mouseReleased")).toHaveLength(2);
  });

  it("drags with a button-down move stream and a settled release", async () => {
    await cap.drag(7, 0, 0, 30, 40);
    const moves = mouseMoves(mock, "mouseMoved");
    expect(moves[0].params).toMatchObject({ buttons: 0 });
    expect(moves.slice(1).every((m) => m.params.buttons === 1)).toBe(true);
    expect(mouseMoves(mock, "mousePressed")[0].params).toMatchObject({ button: "left", buttons: 1 });
    expect(mouseMoves(mock, "mouseReleased")[0].params).toMatchObject({ button: "left", buttons: 0 });
  });
});
