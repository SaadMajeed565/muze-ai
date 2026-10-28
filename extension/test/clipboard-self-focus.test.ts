// @vitest-environment jsdom
/**
 * Regression tests for clipboard self-focus (2026-10-28, user requirement:
 * "it should focus itself instead of me keeping focus for clipboard").
 * No live browser is touched: the offscreen clipboard is mocked to fail
 * with a focus error, the page-context read/write is simulated through a
 * mocked executeInPage, and window focus is tracked through the mock
 * context's updateWindow. The page ops themselves are unit-tested here
 * only via the handler path; the real pageAgent writeClipboard op is a
 * one-line writeText call next to the long-standing readClipboard op.
 */
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };
const open = { mode: "unrestricted" } as const;

type Ctx = Record<string, unknown> & {
  clipboard: { read: () => Promise<string>; write: (text: string) => Promise<void> };
  updateWindow: (windowId: number, properties: Record<string, unknown>) => Promise<unknown>;
  getActiveTab: () => Promise<{ id?: number; url?: string; active: boolean } | null>;
};

function makeRuntime(url: string) {
  const rt = createTestRuntime({
    policy: open,
    context: { tabs: [{ url, title: "Test", active: true }] },
  });
  const ctx = rt.ctx as unknown as Ctx;
  ctx.clipboard = {
    read: async () => {
      throw new Error("Document is not focused");
    },
    write: async () => {
      throw new Error("Document is not focused");
    },
  };
  return { rt, ctx };
}

async function expectErrorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("expected the call to throw");
  } catch (error) {
    return String((error as Error).message);
  }
}

describe("clipboard self-focus: read", () => {
  it("focuses the active window before the fallback read and retries the read after focus", async () => {
    const { rt, ctx } = makeRuntime("https://a.test/");
    const events: string[] = [];
    let pageReads = 0;
    const originalUpdateWindow = ctx.updateWindow.bind(rt.ctx);
    ctx.updateWindow = async (windowId: number, properties: Record<string, unknown>) => {
      events.push("focus");
      expect(properties.focused).toBe(true);
      expect(windowId).toBe(1);
      return originalUpdateWindow(windowId, properties);
    };
    (rt.ctx as unknown as Record<string, unknown>).executeInPage = async (
      _tabId: number,
      _fn: unknown,
      op: { op?: string },
    ) => {
      if (op?.op !== "readClipboard") throw new Error(`unexpected page op ${op?.op}`);
      events.push("pageRead");
      pageReads += 1;
      if (pageReads === 1) throw new Error("Document is not focused");
      return { text: "hello-self-focus", truncated: false };
    };

    const result = await rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx });
    expect(result.result).toEqual({ text: "hello-self-focus", truncated: false });
    // Focus was attempted before the first fallback read, and the read
    // was retried after a focus attempt (first read failed, second passed).
    expect(events[0]).toBe("focus");
    expect(events).toContain("pageRead");
    expect(pageReads).toBe(2);
    expect(events.filter((event) => event === "focus").length).toBeGreaterThanOrEqual(1);
  });

  it("still-unfocused returns the self-focus-attempted error and no fabricated text", async () => {
    const { rt, ctx } = makeRuntime("https://a.test/");
    (rt.ctx as unknown as Record<string, unknown>).executeInPage = async () => {
      throw new Error("Document is not focused");
    };
    const message = await expectErrorMessage(
      rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx }),
    );
    expect(message).toContain("own attempt to focus");
    expect(message).toContain("did not make");
    expect(message).not.toContain("hello-self-focus");
    // The old primary instruction is gone: the error no longer tells the
    // user to click a window and retry as the first resort.
    expect(message).not.toContain("click a browser window so a normal");
    expect(ctx).toBeDefined();
  });

  it("restricted active tab returns the restricted error and does not focus or switch tabs", async () => {
    const { rt, ctx } = makeRuntime("chrome://extensions/");
    let focusCalls = 0;
    const originalUpdateWindow = ctx.updateWindow.bind(rt.ctx);
    ctx.updateWindow = async (windowId: number, properties: Record<string, unknown>) => {
      focusCalls += 1;
      return originalUpdateWindow(windowId, properties);
    };
    const message = await expectErrorMessage(
      rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx }),
    );
    expect(message).toContain("restricted page");
    expect(focusCalls).toBe(0);
    const active = await ctx.getActiveTab();
    expect(active?.url).toBe("chrome://extensions/");
    expect(active?.active).toBe(true);
  });
});

describe("clipboard self-focus: write", () => {
  it("focuses itself and writes through the page-context fallback", async () => {
    const { rt, ctx } = makeRuntime("https://a.test/");
    const writes: string[] = [];
    let focusCalls = 0;
    const originalUpdateWindow = ctx.updateWindow.bind(rt.ctx);
    ctx.updateWindow = async (windowId: number, properties: Record<string, unknown>) => {
      focusCalls += 1;
      return originalUpdateWindow(windowId, properties);
    };
    (rt.ctx as unknown as Record<string, unknown>).executeInPage = async (
      _tabId: number,
      _fn: unknown,
      op: { op?: string; text?: string },
    ) => {
      if (op?.op !== "writeClipboard") throw new Error(`unexpected page op ${op?.op}`);
      writes.push(op.text ?? "");
      return { written: true };
    };

    const result = await rt.executor.execute({
      tool: "clipboard.write",
      input: { text: "write-via-page" },
      client,
      ctx: rt.ctx,
    });
    expect(result.result).toEqual({ written: true, chars: "write-via-page".length });
    expect(focusCalls).toBeGreaterThanOrEqual(1);
    expect(writes).toEqual(["write-via-page"]);
  });

  it("still-unfocused write returns the self-focus-attempted error and writes nothing", async () => {
    const { rt } = makeRuntime("https://a.test/");
    const writes: string[] = [];
    (rt.ctx as unknown as Record<string, unknown>).executeInPage = async (
      _tabId: number,
      _fn: unknown,
      op: { op?: string; text?: string },
    ) => {
      writes.push(op.text ?? "");
      throw new Error("Document is not focused");
    };
    const message = await expectErrorMessage(
      rt.executor.execute({ tool: "clipboard.write", input: { text: "must-not-write" }, client, ctx: rt.ctx }),
    );
    expect(message).toContain("own attempt to focus");
    // The page write was attempted (and failed on focus), but no write
    // succeeded: the simulated page op records attempts, not successes,
    // so assert on the error, not on the attempt log.
    expect(writes).toEqual(["must-not-write", "must-not-write"]);
  });

  it("restricted active tab write returns the restricted error without focusing", async () => {
    const { rt, ctx } = makeRuntime("chrome://extensions/");
    let focusCalls = 0;
    const originalUpdateWindow = ctx.updateWindow.bind(rt.ctx);
    ctx.updateWindow = async (windowId: number, properties: Record<string, unknown>) => {
      focusCalls += 1;
      return originalUpdateWindow(windowId, properties);
    };
    const message = await expectErrorMessage(
      rt.executor.execute({ tool: "clipboard.write", input: { text: "x" }, client, ctx: rt.ctx }),
    );
    expect(message).toContain("restricted page");
    expect(focusCalls).toBe(0);
  });
});
