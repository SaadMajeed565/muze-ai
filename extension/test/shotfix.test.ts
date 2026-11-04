// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { formsSetFile } from "../libs/tool-contracts/schemas/interact.js";
import { capFullPageCapture } from "../libs/browser-engine/page/stitch.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };
/** Unrestricted policy so the approval gate does not mask handler behaviour. */
const open = { mode: "unrestricted" } as const;

const INLINE = [{ name: "a.txt", mimeType: "text/plain", dataBase64: "aGVsbG8=" }];

/**
 * Stub the page-agent transport on a test runtime: record every page op
 * and answer setFile/setFileByRef/getViewport from canned data, so the
 * routing (which op, which target) is asserted without depending on
 * jsdom's DataTransfer/File support.
 */
function stubPageOps(rt: ReturnType<typeof createTestRuntime>, seen: unknown[]) {
  (rt.ctx as unknown as Record<string, unknown>).executeInPage = async (_tabId: unknown, _fn: unknown, op: unknown) => {
    seen.push(op);
    const o = op as { op?: string; ref?: string };
    if (o.op === "getViewport") return { width: 800, height: 600, devicePixelRatio: 2, scrollY: 0 };
    if (o.op === "setFile" || o.op === "setFileByRef") {
      if (o.ref === "r-gone") return { error: "STALE_ELEMENT" };
      return { set: true, files: [{ name: "a.txt", mimeType: "text/plain", size: 5 }] };
    }
    return {};
  };
}

describe("shotfix: forms.setFile target (selector vs ref)", () => {
  it("accepts a ref-only target with inline files, and a selector-only target with a fileId", () => {
    expect(() => formsSetFile.input.parse({ ref: "r1", files: INLINE })).not.toThrow();
    expect(() => formsSetFile.input.parse({ selector: "input[type=file]", fileId: "f1" })).not.toThrow();
  });

  it("rejects a call with neither selector nor ref, and one with neither fileId nor files", () => {
    expect(() => formsSetFile.input.parse({ files: INLINE })).toThrow(/Either selector or ref/);
    expect(() => formsSetFile.input.parse({ selector: "input[type=file]" })).toThrow(/Either fileId or files/);
  });

  it("routes a ref-only granular call to setFileByRef, not to querySelector with the ref", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "forms.setFile", input: { tabId: tab.id, ref: "r1", files: INLINE }, client, ctx: rt.ctx });
    expect((result.result as { set: boolean }).set).toBe(true);
    const op = seen.find((o) => (o as { op?: string }).op === "setFileByRef") as { op: string; ref: string } | undefined;
    expect(op).toBeDefined();
    expect(op!.ref).toBe("r1");
    expect(seen.some((o) => (o as { op?: string }).op === "setFile")).toBe(false);
  });

  it("keeps the selector path when a selector is given", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    await rt.executor.execute({ taskId: "task_step",  tool: "forms.setFile", input: { tabId: tab.id, selector: "input[type=file]", files: INLINE }, client, ctx: rt.ctx });
    const op = seen.find((o) => (o as { op?: string }).op === "setFile") as { selector: string } | undefined;
    expect(op?.selector).toBe("input[type=file]");
  });

  it("keeps a precise STALE_ELEMENT for a genuinely stale ref, never a silent re-resolve", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "forms.setFile", input: { tabId: tab.id, ref: "r-gone", files: INLINE }, client, ctx: rt.ctx }),
    ).rejects.toThrow(/STALE_ELEMENT/);
    // The stale ref was presented as-is to the registry lookup; it was
    // never rewritten into a selector query for a different element.
    expect(seen.every((o) => (o as { ref?: string }).ref !== "input[type=file]")).toBe(true);
  });
});

describe("shotfix: inline files through unified form / submit (the dropped-files bug)", () => {
  it("form set_file with inline files passes the approval dry-run gate (was: 'Either fileId or files must be provided')", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "form",
      input: { phase: "set_file", tabId: tab.id, selector: "input[type=file]", files: INLINE },
      client,
      ctx: rt.ctx,
    });
    expect((result.result as { set: boolean }).set).toBe(true);
  });

  it("submit set_file with a fresh ref + inline files resolves the ref (was: STALE_ELEMENT on fresh refs)", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    // No planApproved token: the handler's dry-run approval gate must run
    // (this is the live path for auto-approved sessions), and it must not
    // fail validation on the inline files it is supposed to gate.
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "submit",
      input: { action: "set_file", tabId: tab.id, ref: "r1", files: INLINE },
      client,
      ctx: rt.ctx,
    });
    expect((result.result as { set: boolean }).set).toBe(true);
    const op = seen.find((o) => (o as { op?: string }).op === "setFileByRef") as { ref: string } | undefined;
    expect(op?.ref).toBe("r1");
    // The ref must never reach the selector path, where querySelector
    // would match nothing and misreport the live element as stale.
    expect(seen.some((o) => (o as { op?: string }).op === "setFile" && (o as { selector?: string }).selector === "r1")).toBe(false);
  });

  it("submit set_file with inline files also passes the gate (was: dropped in the dry-run input)", async () => {
    const rt = createTestRuntime({ policy: open });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "submit",
      input: { action: "set_file", tabId: tab.id, selector: "input[type=file]", files: INLINE },
      client,
      ctx: rt.ctx,
    });
    expect((result.result as { set: boolean }).set).toBe(true);
  });
});

describe("shotfix: screenshots.visible uses one CDP clip path for active and background tabs", () => {
  it("captures via a CDP viewport clip (same path as element) and reports device pixels", async () => {
    const rt = createTestRuntime({ policy: open, context: { cdpEnabled: true } });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "screenshots.visible", input: { tabId: tab.id, format: "png", quality: 80 }, client, ctx: rt.ctx });
    expect((result.result as { dataUrl: string }).dataUrl).toContain("mockcdp");
    expect(result.result).toMatchObject({ width: 1600, height: 1200 });
    const clipCall = rt.ctx.cdpCalls.find((c) => c.method === "captureScreenshot");
    expect(clipCall).toBeDefined();
    expect((clipCall!.args[1] as { scale: number }).scale).toBe(2);
  });

  it("falls back to the tabs capture only on a CDP timeout, and throws other CDP errors", async () => {
    const rt = createTestRuntime({ policy: open, context: { cdpEnabled: true } });
    const seen: unknown[] = [];
    stubPageOps(rt, seen);
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    (rt.ctx.cdp as unknown as Record<string, unknown>).captureScreenshot = async () => {
      throw new ToolErrorException("TIMEOUT", "CDP input sequence did not complete within 15000ms");
    };
    const fallback = await rt.executor.execute({ taskId: "task_step",  tool: "screenshots.visible", input: { tabId: tab.id, format: "png", quality: 80 }, client, ctx: rt.ctx });
    expect((fallback.result as { dataUrl: string }).dataUrl).toContain("AAAA");
    expect(rt.ctx.capturedScreenshots).toBe(1);

    const rt2 = createTestRuntime({ policy: open, context: { cdpEnabled: true } });
    stubPageOps(rt2, []);
    const tab2 = rt2.ctx.addTab({ url: "https://a.test/" });
    (rt2.ctx.cdp as unknown as Record<string, unknown>).captureScreenshot = async () => {
      throw new Error("debugger attach failed");
    };
    await expect(
      rt2.executor.execute({ taskId: "task_step",  tool: "screenshots.visible", input: { tabId: tab2.id, format: "png", quality: 80 }, client, ctx: rt2.ctx }),
    ).rejects.toThrow(/debugger attach failed/);
    expect(rt2.ctx.capturedScreenshots).toBe(0);
  });
});

describe("shotfix: full-page capture is bounded before any slice is taken", () => {
  it("captures a short page in full, not partial", () => {
    const capped = capFullPageCapture(2000, 689, 1310, 1, 12_000);
    expect(capped).toMatchObject({ totalHeight: 2000, pages: 3, partial: false, partialReason: undefined });
  });

  it("caps a 2x-DPR tall page below the 16,384 device-px canvas limit and reports it partial", () => {
    // Old code attempted a 24,000 device-px canvas here (12,000 CSS px at
    // 2x DPR) and timed out; the cap must bite before any capture.
    const capped = capFullPageCapture(30_000, 689, 1310, 2, 12_000);
    expect(capped.partial).toBe(true);
    expect(capped.totalHeight * 2).toBeLessThanOrEqual(16_384);
    expect(capped.totalHeight * 2 * 2620).toBeLessThanOrEqual(16_777_216);
    expect(capped.pages).toBeLessThanOrEqual(40);
    expect(capped.partialReason).toMatch(/capped at/);
  });

  it("caps by slice count on a tiny viewport instead of throwing", () => {
    const capped = capFullPageCapture(30_000, 100, 800, 1, 30_000);
    expect(capped.pages).toBe(40);
    expect(capped.partial).toBe(true);
  });

  it("fullPage handler surfaces the partial flag from the capture", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    (rt.ctx as unknown as Record<string, unknown>).captureFullPage = async () => ({
      dataUrl: "data:image/png;base64,AAAA",
      width: 1310,
      height: 6400,
      pages: 10,
      partial: true,
      partialReason: "Full-page capture capped at 6400 of 30000 CSS px",
    });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "screenshots.fullPage", input: { tabId: tab.id, maxHeight: 12_000, format: "png", quality: 80 }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ partial: true, pages: 10 });
    expect((result.result as { partialReason: string }).partialReason).toMatch(/capped/);
  });
});
