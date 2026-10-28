/**
 * Regression tests for the 2026-10-28 live retest failures (extension side).
 * No live browser is touched: the test runtime runs page ops in jsdom and
 * the chrome-context test stubs chrome.scripting.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { formTool } from "../libs/tool-contracts/schemas/unified.js";
import { ChromeBrowserContext } from "../src/chrome-context.js";
import { pageAgent } from "../libs/browser-engine/page/agent.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

describe("retest fixes: unified actions and schemas", () => {
  it("accepts form phase set_file (was rejected: phase not in inspect/preview/fill/upload/submit)", () => {
    const parsed = formTool.input.parse({ phase: "set_file", ref: "r1", fileId: "f1" }) as { phase: string };
    expect(parsed.phase).toBe("set_file");
  });

  it("tabs reload is a unified action", async () => {
    const rt = createTestRuntime({ context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
    const result = await rt.executor.execute({ tool: "tabs", input: { action: "reload", tabId: 1 }, client, ctx: rt.ctx });
    expect(result.result).toBeDefined();
  });

  it("data history list is dispatched (was: Unknown history action)", async () => {
    // approvalMode never: the point here is dispatch, not the policy gate
    // (history.search is sensitive-read and otherwise needs approval).
    const rt = createTestRuntime({ policy: { approvalMode: "never" } });
    const result = await rt.executor.execute({ tool: "data", input: { domain: "history", action: "list" }, client, ctx: rt.ctx });
    expect(result.result).toBeDefined();
    expect(JSON.stringify(result.result)).not.toContain("Unknown history action");
  });

  it("wait for=networkIdle is accepted as an alias for network_idle", async () => {
    const rt = createTestRuntime({ context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] } });
    rt.ctx.attachObserver(1);
    const result = await rt.executor.execute(
      { tool: "wait", input: { for: "networkIdle", timeoutMs: 1000, quietMs: 100 }, client, ctx: rt.ctx },
    );
    expect(result.result).toBeDefined();
  });

  it("dom.select on a non-select element fails clearly, never 'undefined is not iterable'", async () => {
    document.body.innerHTML = `<input id="q" type="text" />`;
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#q" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    await expect(
      rt.executor.execute({ tool: "dom.select", input: { ref, value: "x" }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    try {
      await rt.executor.execute({ tool: "dom.select", input: { ref, value: "x" }, client, ctx: rt.ctx });
      throw new Error("expected dom.select to throw");
    } catch (error) {
      expect(String((error as Error).message)).toContain("only works on a <select> element");
      expect(String((error as Error).message)).not.toContain("undefined is not iterable");
    }
  });

  it("forms.fill reports a stale ref as a re-observe instruction, never silently re-resolving it", async () => {
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const result = await rt.executor.execute(
      { tool: "forms.fill", input: { fields: [{ ref: "rDoesNotExist", value: "x" }] }, client, ctx: rt.ctx },
    );
    const skipped = (result.result as { skipped: { field: string; reason: string }[] }).skipped;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("re-observe");
    expect(skipped[0].reason).toContain("never silently re-resolved");
  });
});

describe("retest fixes: executeScript serialisation", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: { sendMessage: vi.fn(async () => ({ ok: true, result: {} })) },
      scripting: {
        // Faithful stub: run the injected function with its args, so a
        // test can tell whether args were passed at all.
        executeScript: vi.fn(async (call: { func?: (...args: unknown[]) => unknown; args?: unknown[] }) => [
          { result: call.func ? call.func(...(call.args ?? [])) : undefined },
        ]),
      },
      debugger: {},
      downloads: undefined,
      bookmarks: undefined,
      history: undefined,
      webNavigation: undefined,
    });
  });

  it("omits args entirely for a no-argument function instead of passing [undefined]", async () => {
    const ctx = new ChromeBrowserContext();
    const probe = function frameProbeNoArgs(): number { return 42; };
    const result = await ctx.executeInPage(7, probe as never, undefined);
    expect(result).toBe(42);
    const executeScript = (globalThis as unknown as { chrome: { scripting: { executeScript: ReturnType<typeof vi.fn> } } }).chrome.scripting.executeScript;
    const call = executeScript.mock.calls[0][0] as Record<string, unknown>;
    expect("args" in call).toBe(false);
  });

  it("still passes args when an argument is given", async () => {
    const ctx = new ChromeBrowserContext();
    const fn = function echo(arg: { x: number }): number { return arg.x; };
    const result = await ctx.executeInPage(7, fn as never, { x: 3 });
    expect(result).toBe(3);
    const executeScript = (globalThis as unknown as { chrome: { scripting: { executeScript: ReturnType<typeof vi.fn> } } }).chrome.scripting.executeScript;
    const call = executeScript.mock.calls[0][0] as Record<string, unknown>;
    expect(call.args).toEqual([{ x: 3 }]);
  });

  it("keeps the frame-0 targeting fix: a page-agent call still targets frame 0", async () => {
    const ctx = new ChromeBrowserContext();
    await ctx.executeInPage(7, pageAgent, { op: "metadata" } as never);
    const sendMessage = (globalThis as unknown as { chrome: { tabs: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome.tabs.sendMessage;
    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: "muze/page-op" }), { frameId: 0 });
  });
});
