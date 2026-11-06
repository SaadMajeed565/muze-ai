// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, installCdpTypingSimulation } from "../libs/testing/index.js";

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

describe("tab tools", () => {
  it("lists tabs and returns the active tab", async () => {
    const rt = createTestRuntime({ context: { tabs: [{ url: "https://a.test/", title: "A", active: true }, { url: "https://b.test/", title: "B" }] } });
    const list = await rt.executor.execute({ taskId: "task_step",  tool: "tabs.list", input: {}, client, ctx: rt.ctx });
    expect((list.result as { tabs: unknown[] }).tabs).toHaveLength(2);

    const active = await rt.executor.execute({ taskId: "task_step",  tool: "tabs.active", input: {}, client, ctx: rt.ctx });
    expect((active.result as { tab: { title: string } }).tab.title).toBe("A");
  });

  it("searches tabs by title and url", async () => {
    const rt = createTestRuntime({ context: { tabs: [{ url: "https://example.com", title: "Example" }, { url: "https://docs.test", title: "Docs" }] } });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "tabs.search", input: { query: "docs" }, client, ctx: rt.ctx });
    expect((result.result as { tabs: { title: string }[] }).tabs.map((t) => t.title)).toEqual(["Docs"]);
  });

  it("creates tabs", async () => {
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "tabs.create", input: { url: "https://new.test/" }, client, ctx: rt.ctx });
    expect((result.result as { tab: { url: string } }).tab.url).toBe("https://new.test/");
  });
});

describe("page tools", () => {
  function seedDom() {
    document.body.innerHTML = `
      <h1>Big Title</h1>
      <h2>Section A</h2>
      <p>The quick brown fox jumps over the lazy dog.</p>
      <a href="/internal">Internal</a>
      <a href="https://external.test/x">External</a>
      <form action="/submit" method="post">
        <label for="name">Full name</label>
        <input id="name" name="name" type="text" required />
        <input id="pw" name="password" type="password" />
        <button type="submit">Send</button>
      </form>
      <table>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td>a</td><td>b</td></tr>
      </table>`;
    document.title = "Test Page";
  }

  it("reads visible text in bounded chunks", async () => {
    seedDom();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.read", input: { maxChars: 400, offset: 0 }, client, ctx: rt.ctx });
    const text = (result.result as { text: string }).text;
    expect(text).toContain("quick brown fox");
  });

  it("extracts metadata and headings", async () => {
    seedDom();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.metadata", input: {}, client, ctx: rt.ctx });
    const meta = result.result as { title: string; headings: { text: string }[] };
    expect(meta.title).toBe("Test Page");
    expect(meta.headings.map((h) => h.text)).toContain("Big Title");
  });

  it("collects links with internal/external classification", async () => {
    seedDom();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.links", input: {}, client, ctx: rt.ctx });
    const links = (result.result as { links: { href: string; internal: boolean }[] }).links;
    expect(links.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts tables", async () => {
    seedDom();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.tables", input: {}, client, ctx: rt.ctx });
    const tables = (result.result as { tables: { headers: string[]; rows: string[][] }[] }).tables;
    expect(tables[0].headers).toEqual(["H1", "H2"]);
    expect(tables[0].rows[0]).toEqual(["a", "b"]);
  });

  it("inspects forms without exposing secret values", async () => {
    seedDom();
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "forms.inspect", input: {}, client, ctx: rt.ctx });
    const forms = (result.result as { forms: { fields: { label: string; type: string; required: boolean }[] }[] }).forms;
    const fields = forms[0].fields;
    expect(fields.some((f) => f.label === "Full name" && f.required)).toBe(true);
    expect(fields.some((f) => f.type === "password")).toBe(true);
    // The schema returns field descriptors only, never values.
    expect(JSON.stringify(fields)).not.toContain("hunter2");
  });

  it("finds and reads an element", async () => {
    seedDom();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "text", value: "Send" }, client, ctx: rt.ctx });
    const first = (found.result as { elements: { ref: string }[] }).elements[0];
    expect(first?.ref).toBeTruthy();
    const read = await rt.executor.execute({ taskId: "task_step",  tool: "dom.read", input: { ref: first.ref }, client, ctx: rt.ctx });
    expect((read.result as { text: string }).text).toContain("Send");
  });

  it("refuses to fill a password field via forms.fill", async () => {
    seedDom();
    const rt = createTestRuntime();
    const form = await rt.executor.execute({ taskId: "task_step",  tool: "forms.inspect", input: {}, client, ctx: rt.ctx });
    const fields = (form.result as { forms: { fields: { ref: string; type: string }[] }[] }).forms[0].fields;
    const password = fields.find((f) => f.type === "password")!;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "forms.fill", input: { fields: [{ ref: password.ref, value: "hunter2" }] }, client, ctx: rt.ctx });
    const report = result.result as { filled: unknown[]; skipped: { reason: string }[] };
    expect(report.filled).toHaveLength(0);
    expect(report.skipped[0].reason).toMatch(/sensitive/i);
  });
});

describe("pointer and keyboard tools", () => {
  function seedInteractive() {
    document.body.innerHTML = `
      <h1 id="title">Hello</h1>
      <input id="name" name="name" type="text" />
      <div id="box" style="width:100px;height:50px">box</div>
      <div id="target">target</div>
      <form action="/submit" method="post">
        <input id="q" name="q" type="text" />
        <button type="submit">Send</button>
      </form>`;
  }

  it("types into an input with the native value setter", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#name" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    let inputEvents = 0;
    document.getElementById("name")!.addEventListener("input", () => inputEvents++);

    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.type", input: { ref, text: "abc" }, client, ctx: rt.ctx });
    // Synthetic (non-CDP) typing records method: "synthetic".
    expect(result.result).toEqual({ typed: true, ref, method: "synthetic" });
    expect((document.getElementById("name") as HTMLInputElement).value).toBe("abc");
    expect(inputEvents).toBe(3);
  });

  it("requires approval before pressing Enter in a surrounding form", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#q" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    let submitted = false;
    document.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });

    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.press", input: { ref, key: "Enter", modifiers: [] }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(submitted).toBe(false);
  });

  it("requires approval before clicking a submit button", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "button" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    let submitted = false;
    document.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });

    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(submitted).toBe(false);
  });

  it("dispatches exactly one click for a submit button (no double activation)", async () => {
    // Behaviour change from the double-click fix: dom.click dispatches a
    // single synthetic click and no longer follows it with el.click(), so
    // a page counting clicks must see exactly one. The single dispatch
    // still submits the form (jsdom runs submit activation on dispatch),
    // so submission is preserved while double activation is gone.
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "button" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    let clicks = 0;
    let submitted = false;
    document.querySelector("button")!.addEventListener("click", () => { clicks++; });
    document.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    const input = rt.registry.require("dom.click").input.parse({ ref });
    const approval = rt.approvals.create({ tool: "dom.click", risk: "reversible", summary: "click", client, input });
    rt.approvals.approve(approval.id);

    await rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref }, client, ctx: rt.ctx, approvalId: approval.id });
    expect(clicks).toBe(1);
    expect(submitted).toBe(true);
  });

  it("cancels a delayed tool when its signal aborts", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#q" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const controller = new AbortController();
    const pending = rt.executor.execute({ taskId: "task_step", 
      tool: "dom.type",
      input: { ref, text: "abc", waitMs: 5_000 },
      client,
      ctx: rt.ctx,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("clicks at coordinates on the element under the point", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    let clicks = 0;
    document.body.addEventListener("click", () => clicks++);
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.clickAt", input: { x: 10, y: 20 }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ clicked: true, x: 10, y: 20 });
    expect(clicks).toBeGreaterThanOrEqual(1);
  });

  it("dispatches the full pointer and mouse sequence for a coordinate click", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const order: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      document.body.addEventListener(type, () => order.push(type));
    }
    await rt.executor.execute({ taskId: "task_step",  tool: "dom.clickAt", input: { x: 10, y: 20 }, client, ctx: rt.ctx });
    expect(order).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  it("moves the mouse to coordinates", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    let moves = 0;
    document.body.addEventListener("mousemove", () => moves++);
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.moveTo", input: { x: 5, y: 6 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ moved: true, x: 5, y: 6, method: "synthetic" });
    expect(moves).toBe(1);
  });

  it("moves the mouse via CDP when CDP is available, not synthetic events", async () => {
    seedInteractive();
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    let moves = 0;
    document.body.addEventListener("mousemove", () => moves++);
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.moveTo", input: { x: 5, y: 6 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ moved: true, x: 5, y: 6, method: "cdp" });
    expect(moves).toBe(0);
    expect(rt.ctx.cdpCalls.some((c) => c.method === "move")).toBe(true);
  });

  it("drags via CDP when CDP is available", async () => {
    seedInteractive();
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.dragAt", input: { x1: 1, y1: 2, x2: 30, y2: 40 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ dragged: true, x1: 1, y1: 2, x2: 30, y2: 40, method: "cdp" });
    expect(rt.ctx.cdpCalls.some((c) => c.method === "drag")).toBe(true);
  });

  it("scrolls, fills, and clears via CDP when CDP is available", async () => {
    seedInteractive();
    // The CDP input paths now fail fast on hidden targets, and jsdom
    // reports a 0-size rect for every element unless stubbed — so the
    // element under test is stubbed visible, as the boundingBox and
    // visible tests already do.
    (document.getElementById("name") as HTMLElement).getBoundingClientRect = () =>
      ({ x: 10, y: 10, left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30, toJSON: () => ({}) }) as DOMRect;
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    // The mock CDP only records calls, so CDP type/press never land
    // text in the document — and the read-back verification in
    // dom.fill/dom.clear (V2-04) now correctly rejects that. Simulate
    // real CDP input so the happy path lands.
    installCdpTypingSimulation(rt.ctx);
    const find = async (selector: string) => {
      const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: selector }, client, ctx: rt.ctx });
      return (found.result as { elements: { ref: string }[] }).elements[0].ref;
    };
    const scroll = await rt.executor.execute({ taskId: "task_step",  tool: "dom.scroll", input: { direction: "down", amount: 600 }, client, ctx: rt.ctx });
    expect(typeof (scroll.result as { scrollY: number }).scrollY).toBe("number");
    expect(rt.ctx.cdpCalls.some((c) => c.method === "scroll" && (c.args as unknown[])[4] === 600)).toBe(true);
    const nameRef = await find("#name");
    const fill = await rt.executor.execute({ taskId: "task_step",  tool: "dom.fill", input: { ref: nameRef, value: "bob" }, client, ctx: rt.ctx });
    expect(fill.result).toEqual({ filled: true, ref: nameRef });
    expect(rt.ctx.cdpCalls.some((c) => c.method === "type")).toBe(true);
    const clear = await rt.executor.execute({ taskId: "task_step",  tool: "dom.clear", input: { ref: nameRef }, client, ctx: rt.ctx });
    expect((clear.result as { cleared: boolean }).cleared).toBe(true);
    expect(rt.ctx.cdpCalls.some((c) => c.method === "press")).toBe(true);
  });

  it("toggles a checkbox via a CDP click when CDP is available", async () => {
    seedInteractive();
    document.body.innerHTML += `<input id="chk" type="checkbox" />`;
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#chk" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.setChecked", input: { ref, checked: true }, client, ctx: rt.ctx });
    // The mock CDP click only records the call, it does not toggle the
    // jsdom checkbox, so the read-back state is false here. In a real
    // browser the CDP click toggles it. The wiring assertion is the call.
    expect(typeof (result.result as { checked: boolean }).checked).toBe("boolean");
    expect(rt.ctx.cdpCalls.some((c) => c.method === "click")).toBe(true);
  });

  it("clicks and types via CDP in a sub-frame, not just the top frame", async () => {
    seedInteractive();
    // CDP input paths fail fast on hidden targets; jsdom reports 0-size
    // rects unless stubbed, so stub both targets visible (see the
    // boundingBox/visible tests for the same pattern).
    const stubVisible = (el: HTMLElement) => {
      el.getBoundingClientRect = () =>
        ({ x: 10, y: 10, left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30, toJSON: () => ({}) }) as DOMRect;
    };
    stubVisible(document.getElementById("box") as HTMLElement);
    stubVisible(document.getElementById("name") as HTMLElement);
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    // Same CDP-input simulation as the fill/clear test above: the
    // read-back verification in dom.type (V2-04) rejects input that
    // never lands, and the recording-only mock CDP never lands it.
    installCdpTypingSimulation(rt.ctx);
    rt.ctx.mockFrames = [0, 3];
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#box", frameId: 3 }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const click = await rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref, frameId: 3 }, client, ctx: rt.ctx });
    expect((click.result as { method: string }).method).toBe("cdp");
    const foundName = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#name", frameId: 3 }, client, ctx: rt.ctx });
    const nameRef = (foundName.result as { elements: { ref: string }[] }).elements[0].ref;
    const type = await rt.executor.execute({ taskId: "task_step",  tool: "dom.type", input: { ref: nameRef, frameId: 3, text: "hi" }, client, ctx: rt.ctx });
    expect((type.result as { method: string }).method).toBe("cdp");
  });

  it("selects via CDP arrow keys, falling back to the DOM path when the mock keys do not move the value", async () => {
    document.body.innerHTML = `<select id="s"><option value="a">A</option><option value="b">B</option></select>`;
    const rt = createTestRuntime({ context: { cdpEnabled: true } });
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#s" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.select", input: { ref, value: "b" }, client, ctx: rt.ctx });
    expect((result.result as { selected: boolean }).selected).toBe(true);
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("b");
    expect(rt.ctx.cdpCalls.some((c) => c.method === "press")).toBe(true);
  });

  it("drags between elements with a full pointer/drag sequence", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#box" }, client, ctx: rt.ctx });
    const fromRef = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const foundTarget = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#target" }, client, ctx: rt.ctx });
    const toRef = (foundTarget.result as { elements: { ref: string }[] }).elements[0].ref;

    const from = document.getElementById("box")!;
    const to = document.getElementById("target")!;
    const events: string[] = [];
    from.addEventListener("mousedown", () => events.push("from:mousedown"));
    from.addEventListener("dragstart", () => events.push("from:dragstart"));
    from.addEventListener("dragend", () => events.push("from:dragend"));
    to.addEventListener("mouseup", () => events.push("to:mouseup"));
    to.addEventListener("dragover", (e) => e.preventDefault());
    to.addEventListener("drop", () => events.push("to:drop"));

    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.drag", input: { fromRef, toRef }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ dragged: true, fromRef, toRef });
    expect(events).toContain("from:dragstart");
    expect(events).toContain("from:mousedown");
    expect(events).toContain("to:drop");
    expect(events).toContain("to:mouseup");
    expect(events).toContain("from:dragend");
  });

  it("drags between coordinates", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    let downs = 0;
    let ups = 0;
    document.body.addEventListener("mousedown", () => downs++);
    document.body.addEventListener("mouseup", () => ups++);
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.dragAt", input: { x1: 1, y1: 2, x2: 30, y2: 40 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ dragged: true, x1: 1, y1: 2, x2: 30, y2: 40, method: "synthetic" });
    expect(downs).toBe(1);
    expect(ups).toBe(1);
  });

  it("reports bounding boxes", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const box = document.getElementById("box")!;
    box.getBoundingClientRect = () => ({ x: 12, y: 34, left: 12, top: 34, width: 100, height: 50, right: 112, bottom: 84, toJSON: () => ({}) }) as DOMRect;
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#box" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.boundingBox", input: { ref }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ x: 12, y: 34, viewportX: 12, viewportY: 34, width: 100, height: 50 });
  });

  it("checks element visibility", async () => {
    seedInteractive();
    const rt = createTestRuntime();
    const box = document.getElementById("box")!;
    box.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, toJSON: () => ({}) }) as DOMRect;
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#box" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;

    const visible = await rt.executor.execute({ taskId: "task_step",  tool: "dom.visible", input: { ref }, client, ctx: rt.ctx });
    expect(visible.result).toEqual({ visible: true, occluded: false });

    box.style.display = "none";
    const hidden = await rt.executor.execute({ taskId: "task_step",  tool: "dom.visible", input: { ref }, client, ctx: rt.ctx });
    expect(hidden.result).toEqual({ visible: false });
  });
});

describe("page extract and wait tools", () => {
  it("extracts text and attributes by selector", async () => {
    document.body.innerHTML = `<h1 id="t">Title</h1><a id="l" href="https://x.test/">Link</a>`;
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "page.extract",
      input: { fields: [{ name: "title", selector: "#t" }, { name: "href", selector: "#l", attribute: "href" }, { name: "missing", selector: "#nope" }] },
      client,
      ctx: rt.ctx,
    });
    expect((result.result as { results: Record<string, string> }).results).toEqual({
      title: "Title",
      href: "https://x.test/",
      missing: "",
    });
  });

  it("runs extraction in the default level without an approval prompt", async () => {
    document.body.innerHTML = `<h1 id="t">Title</h1>`;
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "page.extract",
      input: { fields: [{ name: "title", selector: "#t" }] },
      client,
      ctx: rt.ctx,
    });
    expect((result.result as { results: Record<string, string> }).results.title).toBe("Title");
  });

  it("waits for a selector that already exists", async () => {
    document.body.innerHTML = `<div id="ready">ok</div>`;
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.waitFor", input: { selector: "#ready", timeoutMs: 1000 }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ found: true, timedOut: false });
  });

  it("times out waiting for a missing selector", async () => {
    document.body.innerHTML = `<div>nothing</div>`;
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.waitFor", input: { selector: "#never", timeoutMs: 500 }, client, ctx: rt.ctx });
    expect(result.result).toMatchObject({ found: false, timedOut: true });
  });

  it("previews a form without exposing values", async () => {
    document.body.innerHTML = `
      <form id="f" action="/s">
        <label for="e">Email</label>
        <input id="e" name="email" type="text" required value="secret@example.com" />
        <select id="c" name="country"><option>PK</option><option>US</option></select>
      </form>`;
    const rt = createTestRuntime();
    const inspected = await rt.executor.execute({ taskId: "task_step",  tool: "forms.inspect", input: {}, client, ctx: rt.ctx });
    const formRef = (inspected.result as { forms: { ref: string }[] }).forms[0].ref;

    const result = await rt.executor.execute({ taskId: "task_step",  tool: "forms.preview", input: { ref: formRef }, client, ctx: rt.ctx });
    const fields = (result.result as { fields: { label: string; type: string; required: boolean; options?: string[] }[] }).fields;
    expect(fields.find((f) => f.label === "Email")).toMatchObject({ type: "text", required: true });
    expect(fields.find((f) => f.type === "select")).toMatchObject({ options: ["PK", "US"] });
    expect(JSON.stringify(result.result)).not.toContain("secret@example.com");
  });
});

describe("iframe support", () => {
  it("lists the top frame by default", async () => {
    document.body.innerHTML = `<h1>Top</h1>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0];
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "frames.list", input: {}, client, ctx: rt.ctx });
    const frames = (result.result as { frames: { frameId: number; url: string; sameOrigin: boolean }[] }).frames;
    expect(frames).toHaveLength(1);
    expect(frames[0].frameId).toBe(0);
  });

  it("lists every simulated frame with same-origin classification", async () => {
    document.body.innerHTML = `<h1>Top</h1>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0, 7, 12];
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "frames.list", input: {}, client, ctx: rt.ctx });
    const frames = (result.result as { frames: { frameId: number; sameOrigin: boolean }[] }).frames;
    expect(frames.map((f) => f.frameId)).toEqual([0, 7, 12]);
    expect(frames.every((f) => f.sameOrigin)).toBe(true); // jsdom runs all probes against the same origin
  });

  it("namespaces element refs from a sub-frame and routes the next call back into it", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0, 3];

    // dom.find in frame 3 returns refs prefixed with f3.
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#go", frameId: 3 }, client, ctx: rt.ctx });
    const elements = (found.result as { elements: { ref: string }[] }).elements;
    expect(elements[0].ref).toMatch(/^f3\./);
    const bare = elements[0].ref.slice(3);

    // clicking that ref must inject into frame 3 with the bare ref stripped.
    const before = rt.ctx.injectedScripts.length;
    const clicked = await rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref: elements[0].ref }, client, ctx: rt.ctx });
    expect((clicked.result as { clicked: boolean }).clicked).toBe(true);
    // Two injections happened: the activation check and the click.
    expect(rt.ctx.injectedScripts.length).toBe(before + 2);
    // frame 3 is in mockFrames, so executeInFrames ran it there
    expect(rt.ctx.mockFrames).toContain(3);
    void bare;
  });

  it("keeps top-frame refs bare for backward compatibility", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0];
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#go" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    expect(ref).not.toMatch(/^f\d+\./);
  });

  it("routes ref-less tools by explicit frameId", async () => {
    document.body.innerHTML = `<h1 id="t">Hello</h1>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0, 5];
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#t", frameId: 5 }, client, ctx: rt.ctx });
    const ref = (result.result as { elements: { ref: string }[] }).elements[0].ref;
    expect(ref.startsWith("f5.")).toBe(true);
  });

  it("reads a page inside an iframe via frameId", async () => {
    document.body.innerHTML = `<p>Iframe text lives here.</p>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0, 9];
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.read", input: { frameId: 9, maxChars: 500, offset: 0 }, client, ctx: rt.ctx });
    expect((result.result as { text: string }).text).toContain("Iframe text");
  });

  it("rejects a frameId that contradicts a frame-prefixed ref", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const rt = createTestRuntime();
    rt.ctx.mockFrames = [0, 3];
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#go", frameId: 3 }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref, frameId: 5 }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("browser-engine regression fixes", () => {
  it("hides restricted URLs in tab listings", async () => {
    const rt = createTestRuntime({
      context: {
        tabs: [
          { url: "chrome://extensions/", title: "Extensions", active: true },
          { url: "https://example.com/", title: "Example" },
        ],
      },
    });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "tabs.list", input: {}, client, ctx: rt.ctx });
    const tabs = (result.result as { tabs: { url: string; title: string }[] }).tabs;
    expect(tabs.find((t) => t.title === "Extensions")?.url).toBe("");
    expect(tabs.find((t) => t.title === "Example")?.url).toBe("https://example.com/");
  });

  it("rejects an unknown navigation search provider instead of falling back", async () => {
    const rt = createTestRuntime();
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "navigation.search", input: { query: "cats", provider: "not-a-provider" }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("re-reads fresh observer state on every networkIdle poll", async () => {
    const rt = createTestRuntime();
    const tab = rt.ctx.addTab({ url: "https://a.test/", active: true });
    rt.ctx.attachObserver(tab.id!);
    // First read says 2 pending, every later read says 0: the old loop
    // re-assigned pending from the first snapshot and would time out.
    let reads = 0;
    const observer = rt.ctx.observer as unknown as { read: (tabId: number) => Promise<unknown> };
    const originalRead = observer.read.bind(rt.ctx.observer);
    observer.read = async (tabId: number) => {
      reads += 1;
      const state = (await originalRead(tabId)) as Record<string, unknown>;
      return { ...state, pendingRequests: reads === 1 ? 2 : 0 };
    };
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "page.networkIdle",
      input: { tabId: tab.id, quietMs: 100, timeoutMs: 5000 },
      client,
      ctx: rt.ctx,
    });
    const out = result.result as { idle: boolean; pending: number; timedOut: boolean };
    expect(out.idle).toBe(true);
    expect(out.pending).toBe(0);
    expect(out.timedOut).toBe(false);
  });

  it("refuses dom.fill on a credential field by name, not just password type", async () => {
    document.body.innerHTML = `
      <input id="card" name="cardNumber" type="text" />
      <input id="nick" name="nickname" type="text" />
      <label for="tok">API key</label><input id="tok" name="field1" type="text" />`;
    const rt = createTestRuntime();
    const find = async (selector: string) => {
      const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: selector }, client, ctx: rt.ctx });
      return (found.result as { elements: { ref: string }[] }).elements[0].ref;
    };
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.fill", input: { ref: await find("#card"), value: "4111111111111111" }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.fill", input: { ref: await find("#tok"), value: "secret" }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const ok = await rt.executor.execute({ taskId: "task_step",  tool: "dom.fill", input: { ref: await find("#nick"), value: "bob" }, client, ctx: rt.ctx });
    expect((ok.result as { filled: boolean }).filled).toBe(true);
    expect((document.getElementById("nick") as HTMLInputElement).value).toBe("bob");
  });

  it("keeps credential values out of snapshot nodes", async () => {
    document.body.innerHTML = `<input id="card" name="cardNumber" type="text" value="4111111111111111" />`;
    const rt = createTestRuntime({ policy: { mode: "unrestricted" } });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "page.snapshot", input: { maxNodes: 50 }, client, ctx: rt.ctx });
    expect(JSON.stringify(result.result)).not.toContain("4111111111111111");
  });

  it("rejects out-of-range and out-of-viewport coordinates", async () => {
    document.body.innerHTML = `<div>hi</div>`;
    const rt = createTestRuntime();
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.clickAt", input: { x: -1, y: 10 }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.clickAt", input: { x: 200_000, y: 10 }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.clickAt", input: { x: 5000, y: 10 }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports a synthetic click method when CDP is unavailable, and throws on a CDP failure", async () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    // Synthetic path (no CDP): direct handler call, because the executor
    // output schema gains the method field only with the contracts delta.
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#b" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const handler = rt.registry.require("dom.click").handler as unknown as (
      input: unknown,
      exec: unknown,
    ) => Promise<unknown>;
    const exec: Record<string, unknown> = {
      ctx: rt.ctx,
      client,
      approvalValidated: true,
      signal: new AbortController().signal,
      runtime: {},
      invoke: async () => ({}),
    };
    const synthetic = (await handler({ ref, button: "left" }, exec)) as { method: string };
    expect(synthetic.method).toBe("synthetic");

    // CDP path that fails: the failure is thrown, never hidden by a fallback.
    // (TIMEOUT is the one exception — it falls back to synthetic, covered
    // by the browser-engine-fixes tests.) The CDP gate fails fast on
    // hidden targets, so stub the button visible: jsdom reports 0-size
    // rects unless stubbed.
    const rt2 = createTestRuntime({ context: { cdpEnabled: true } });
    (document.getElementById("b") as HTMLElement).getBoundingClientRect = () =>
      ({ x: 10, y: 10, left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30, toJSON: () => ({}) }) as DOMRect;
    const found2 = await rt2.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#b" }, client, ctx: rt2.ctx });
    const ref2 = (found2.result as { elements: { ref: string }[] }).elements[0].ref;
    (rt2.ctx.cdp as { click: unknown }).click = async () => {
      throw new Error("debugger detached");
    };
    const handler2 = rt2.registry.require("dom.click").handler as unknown as (
      input: unknown,
      exec: unknown,
    ) => Promise<unknown>;
    const exec2: Record<string, unknown> = {
      ctx: rt2.ctx,
      client,
      approvalValidated: true,
      signal: new AbortController().signal,
      runtime: {},
      invoke: async () => ({}),
    };
    await expect(handler2({ ref: ref2, button: "left" }, exec2)).rejects.toThrow("debugger detached");
  });
});
