/**
 * Regression tests for the 2026-10-28 retest3 failures in the observe /
 * page.find / devtools / clipboard area. No live browser is touched: the
 * test runtime runs page ops in jsdom and stubs chrome.scripting where
 * the real injection path is needed.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { pageAgent } from "../libs/browser-engine/page/agent.js";
import { diagnosticsHook, readDiagnosticsLog } from "../libs/browser-engine/page/diagnostics.js";
import { observeTool } from "../libs/tool-contracts/schemas/unified.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

function stubNavigatorClipboard(readText: () => Promise<string>): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
  return () => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  };
}


const open = { mode: "unrestricted" } as const;

describe("obsfix: observe defaults no longer exceed granular maxima", () => {
  it("observe schema has no limit/maxDepth default to forward (granular defaults apply)", () => {
    const parsed = observeTool.input.parse({ include: ["find", "outline"] }) as { limit?: number; maxDepth?: number };
    expect(parsed.limit).toBeUndefined();
    expect(parsed.maxDepth).toBeUndefined();
  });

  it("observe find + outline with NO limit/maxDepth succeed (retest3: Invalid input for page.find / page.outline)", async () => {
    document.body.innerHTML = `<main><h1>Albert Einstein</h1><h2>Life</h2><p>Albert Einstein was a physicist.</p></main>`;
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    const result = await rt.executor.execute({
      tool: "observe",
      input: { include: ["find", "outline"], query: "Albert" },
      client,
      ctx: rt.ctx,
    });
    const out = result.result as { find?: unknown; outline?: unknown; errors?: { include: string; error: string }[] };
    expect(out.errors ?? []).toEqual([]);
    expect(Array.isArray(out.outline)).toBe(true);
    expect((out.outline as { text: string }[]).some((h) => h.text.includes("Albert Einstein"))).toBe(true);
    expect(Array.isArray(out.find)).toBe(true);
    expect((out.find as { text: string }[]).length).toBeGreaterThan(0);
  });

  it("observe with explicit small limit=10 / maxDepth=3 still works", async () => {
    document.body.innerHTML = `<main><h1>Albert Einstein</h1><h2>Life</h2><p>Albert Einstein was a physicist.</p></main>`;
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    const result = await rt.executor.execute({
      tool: "observe",
      input: { include: ["find", "outline"], query: "Albert", limit: 10, maxDepth: 3 },
      client,
      ctx: rt.ctx,
    });
    const out = result.result as { find?: unknown; outline?: unknown; errors?: unknown[] };
    expect(out.errors ?? []).toEqual([]);
    expect(Array.isArray(out.find)).toBe(true);
    expect(Array.isArray(out.outline)).toBe(true);
  });

  it("observe explicit over-max limit is NOT silently truncated: it fails loudly at granular validation", async () => {
    document.body.innerHTML = `<main><p>Albert</p></main>`;
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    // page.find caps limit at 50, so observe(limit=100) for find must surface
    // a per-include error, never a silently truncated 50-match result.
    const result = await rt.executor.execute({
      tool: "observe",
      input: { include: ["find"], query: "Albert", limit: 100 },
      client,
      ctx: rt.ctx,
    });
    const out = result.result as { find?: unknown; errors?: { include: string; error: string }[] };
    expect(out.find).toBeUndefined();
    expect(out.errors?.some((e) => e.include === "find")).toBe(true);
  });
});

describe("obsfix: page.find query path conforms to its declared output schema", () => {
  it("page agent findText returns {matches:[{index,text,context}], total} (not excerpt/totalMatches)", () => {
    document.body.innerHTML = `<p>Albert Einstein and Albert again</p>`;
    const result = pageAgent({ op: "findText", query: "Albert", caseSensitive: false, limit: 5, contextChars: 10 }) as {
      matches: { index: number; text: string; context: string }[];
      total: number;
    };
    expect(result.total).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].text).toBe("Albert");
    expect(result.matches[0].context).toContain("Albert");
    expect("excerpt" in result.matches[0]).toBe(false);
    expect("totalMatches" in result).toBe(false);
  });

  it("page.find via the executor passes output validation (retest3: output failed its schema)", async () => {
    document.body.innerHTML = `<main><h1>Albert Einstein</h1><p>Einstein was born in Ulm.</p></main>`;
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    for (const query of ["Albert", "Einstein"]) {
      const result = await rt.executor.execute({
        tool: "page.find",
        input: { query, limit: 5 },
        client,
        ctx: rt.ctx,
      });
      const out = result.result as { matches: { index: number; text: string; context?: string }[]; total: number };
      expect(typeof out.total).toBe("number");
      expect(out.matches.length).toBeGreaterThan(0);
      expect(out.matches.every((m) => typeof m.text === "string" && typeof m.index === "number")).toBe(true);
    }
  });
});

describe("obsfix: devtools console/errors never crash on a null diagnostics log", () => {
  it("diagnostics hook + reader are self-contained (same literal key, no module-scope free variable)", () => {
    // A serialised MAIN-world injection loses module scope; assert the two
    // functions do not reference a shared module constant in their source.
    expect(diagnosticsHook.toString()).toContain("__muzeDiagnostics");
    expect(readDiagnosticsLog.toString()).toContain("__muzeDiagnostics");
    expect(diagnosticsHook.toString()).not.toContain("GLOBAL_KEY");
    expect(readDiagnosticsLog.toString()).not.toContain("GLOBAL_KEY");
  });

  it("devtools.console returns an empty log (not a crash) when the hook is installed in jsdom", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    const result = await rt.executor.execute({ tool: "devtools.console", input: {}, client, ctx: rt.ctx });
    expect((result.result as { messages: unknown[] }).messages).toEqual([]);
    const errors = await rt.executor.execute({ tool: "devtools.pageErrors", input: {}, client, ctx: rt.ctx });
    expect((errors.result as { errors: unknown[] }).errors).toEqual([]);
  });

  it("devtools.console/errors throw a clear diagnostics-unavailable error, never 'Cannot read properties of null', when the read-back is null", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    // Simulate the live null read-back: the hook installs, but the reader
    // returns null (page navigated / MAIN-world injection did not stick).
    const original = rt.ctx.executeInPage.bind(rt.ctx);
    rt.ctx.executeInPage = (async (tabId: number, fn: never, arg: never, options?: never) => {
      if (fn === (readDiagnosticsLog as never)) return null as never;
      return original(tabId, fn, arg, options);
    }) as typeof rt.ctx.executeInPage;
    for (const tool of ["devtools.console", "devtools.pageErrors"]) {
      await expect(rt.executor.execute({ tool, input: {}, client, ctx: rt.ctx })).rejects.toMatchObject({ code: "INTERNAL" });
      try {
        await rt.executor.execute({ tool, input: {}, client, ctx: rt.ctx });
        throw new Error("expected devtools call to throw");
      } catch (error) {
        const message = String((error as Error).message);
        expect(message).toContain("diagnostics");
        expect(message).not.toContain("Cannot read properties of null");
      }
    }
  });
});

describe("obsfix: clipboard read falls back to the focused page context", () => {
  it("offscreen not-focused failure falls back to a page-context read and returns real content", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    // Offscreen path always fails with the focus error (it is never focused).
    (rt.ctx as unknown as { clipboard: { read: () => Promise<string>; write: (text: string) => Promise<void> } }).clipboard = {
      read: async () => { throw new Error("Document is not focused"); },
      write: async () => undefined,
    };
    // Page-context path: jsdom navigator.clipboard stubbed to return text.
    const restore = stubNavigatorClipboard(async () => "page-context clipboard text");
    try {
      const result = await rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx });
      expect((result.result as { text: string }).text).toBe("page-context clipboard text");
    } finally {
      restore();
    }
  });

  it("when both paths fail, clipboard.read fails with a clear focus-required error and reads nothing", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    (rt.ctx as unknown as { clipboard: { read: () => Promise<string>; write: (text: string) => Promise<void> } }).clipboard = {
      read: async () => { throw new Error("Document is not focused"); },
      write: async () => undefined,
    };
    // No page-context clipboard available in this run: readText rejects.
    const restore = stubNavigatorClipboard(async () => { throw new Error("Document is not focused"); });
    try {
      await expect(rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx })).rejects.toMatchObject({ code: "INTERNAL" });
      try {
        await rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx });
        throw new Error("expected clipboard.read to throw");
      } catch (error) {
        const message = String((error as Error).message);
        expect(message).toContain("focused");
        expect(message).toContain("No clipboard content was read");
      }
    } finally {
      restore();
    }
  });

  it("a non-focus clipboard failure is NOT masked as a focus error", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { tabs: [{ url: "https://a.test/", title: "A", active: true }] },
    });
    (rt.ctx as unknown as { clipboard: { read: () => Promise<string>; write: (text: string) => Promise<void> } }).clipboard = {
      read: async () => { throw new Error("Permission denied"); },
      write: async () => undefined,
    };
    try {
      await rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx });
      throw new Error("expected clipboard.read to throw");
    } catch (error) {
      expect(String((error as Error).message)).toContain("Permission denied");
      expect(String((error as Error).message)).not.toContain("No clipboard content was read");
    }
  });
});
