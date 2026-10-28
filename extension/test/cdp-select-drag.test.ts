// @vitest-environment jsdom
/**
 * Regression tests for the retest3 dom.select label failure and the
 * dom.drag STALE_ELEMENT failure, at the executor level (page agent +
 * interact handlers, jsdom page, mocked CDP). No live browser.
 *
 * dom.select: value "2" passed while label "Three" returned
 * selected:false with the value left at "2". The label lookup now
 * matches visible option text, an empty value never shadows a label,
 * and a value miss falls back to the label.
 *
 * dom.drag: STALE_ELEMENT (topViewportBox) on fresh h1/searchbox refs.
 * Both boxes are now measured in one page op, and a stale ref fails
 * naming exactly which ref went stale — never silently re-resolved.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

async function findRef(rt: ReturnType<typeof createTestRuntime>, selector: string): Promise<string> {
  const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: selector }, client, ctx: rt.ctx });
  return (found.result as { elements: { ref: string }[] }).elements[0].ref;
}

describe("dom.select label path (retest3)", () => {
  beforeEach(() => {
    if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
  });

  function seedSelect(): void {
    // Mirrors the selenium web-form select: values 1/2/3, visible
    // text One/Two/Three, starting on Two (value "2").
    document.body.innerHTML = `<select id="s"><option value="1">One</option><option value="2" selected>Two</option><option value="3">Three</option></select>`;
  }

  it("selects by visible label on the DOM path", async () => {
    seedSelect();
    const rt = createTestRuntime();
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, label: "Three" }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ selected: true, value: "3" });
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("3");
  });

  it("selects by visible label on the CDP path even when mock arrow keys do not move the value", async () => {
    seedSelect();
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, label: "Three" }, client, ctx: rt.ctx });
    // The CDP stepping lookup must find "Three" (optionIndex 2, not
    // -1); the mock keys do not move jsdom selection, so the DOM
    // fallback lands it. Either way the label selects.
    expect(result.result).toEqual({ selected: true, value: "3" });
    expect(rt.ctx.cdpCalls.some((c) => c.method === "press")).toBe(true);
  });

  it("an empty value does not shadow a label", async () => {
    seedSelect();
    const rt = createTestRuntime();
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, value: "", label: "Three" }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ selected: true, value: "3" });
  });

  it("a value that matches nothing falls back to the label", async () => {
    seedSelect();
    const rt = createTestRuntime();
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, value: "9", label: "Three" }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ selected: true, value: "3" });
  });

  it("an unfindable label still reports selected:false with the value unchanged", async () => {
    seedSelect();
    const rt = createTestRuntime();
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, label: "Nope" }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ selected: false, value: "2" });
  });

  it("label matching ignores surrounding whitespace and case", async () => {
    seedSelect();
    const rt = createTestRuntime();
    const ref = await findRef(rt, "#s");
    const result = await rt.executor.execute({ tool: "dom.select", input: { ref, label: "  three " }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ selected: true, value: "3" });
  });
});

describe("dom.drag stale refs (retest3)", () => {
  beforeEach(() => {
    if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
    document.body.innerHTML = `<h1 id="title">Hello</h1><div id="box">box</div><div id="target">target</div>`;
  });

  it("drags between fresh refs via CDP with one atomic box measurement", async () => {
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const fromRef = await findRef(rt, "#box");
    const toRef = await findRef(rt, "#target");
    const result = await rt.executor.execute({ tool: "dom.drag", input: { fromRef, toRef }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ dragged: true, fromRef, toRef });
    expect(rt.ctx.cdpCalls.filter((c) => c.method === "drag")).toHaveLength(1);
  });

  it("a replaced to element fails naming toRef, never silently re-resolving it", async () => {
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const fromRef = await findRef(rt, "#box");
    const toRef = await findRef(rt, "#target");
    // Simulate a component re-render replacing the target node.
    const replacement = document.createElement("div");
    replacement.id = "target";
    replacement.textContent = "target";
    document.getElementById("target")!.replaceWith(replacement);
    await expect(
      rt.executor.execute({ tool: "dom.drag", input: { fromRef, toRef }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "STALE_ELEMENT" });
    try {
      await rt.executor.execute({ tool: "dom.drag", input: { fromRef, toRef }, client, ctx: rt.ctx });
      throw new Error("expected dom.drag to throw");
    } catch (error) {
      expect(String((error as Error).message)).toContain("toRef");
      expect(String((error as Error).message)).toContain(toRef);
      expect(String((error as Error).message)).toContain("re-observe");
    }
    expect(rt.ctx.cdpCalls.some((c) => c.method === "drag")).toBe(false);
  });

  it("a replaced from element fails naming fromRef", async () => {
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const fromRef = await findRef(rt, "#box");
    const toRef = await findRef(rt, "#target");
    const replacement = document.createElement("div");
    replacement.id = "box";
    replacement.textContent = "box";
    document.getElementById("box")!.replaceWith(replacement);
    try {
      await rt.executor.execute({ tool: "dom.drag", input: { fromRef, toRef }, client, ctx: rt.ctx });
      throw new Error("expected dom.drag to throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("STALE_ELEMENT");
      expect(String((error as Error).message)).toContain("fromRef");
      expect(String((error as Error).message)).toContain(fromRef);
    }
  });
});
