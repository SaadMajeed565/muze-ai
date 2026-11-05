// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { TOOL_SCHEMAS } from "../libs/tool-contracts/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };
const open = { mode: "unrestricted" } as const;

beforeEach(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
  document.body.innerHTML = "";
});

describe("agentic observe/act loop", () => {
  it("registers snapshot and files tools", () => {
    const names = new Set(TOOL_SCHEMAS.map((tool) => tool.name));
    expect(names.has("page.snapshot")).toBe(true);
    expect(names.has("files.list")).toBe(true);
    expect(names.has("files.stat")).toBe(true);
  });

  it("returns interactive nodes and viewport without capturing the screen", async () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button><canvas id="board" width="40" height="40"></canvas>`;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "page.snapshot",
      input: { maxNodes: 50 },
      client,
      ctx: rt.ctx,
    });
    const payload = result.result as {
      nodes: { name: string; viewportX?: number }[];
      viewport: { width: number; devicePixelRatio: number };
      screenshot?: { mimeType: string; dataBase64: string };
      coordinateHint: string;
    };
    expect(payload.nodes.some((node) => node.name.includes("Go"))).toBe(true);
    expect(payload.viewport.devicePixelRatio).toBeGreaterThan(0);
    expect(payload.screenshot).toBeUndefined();
    expect(payload.coordinateHint).toContain("devicePixelRatio");
  });

  it("includes a JPEG screenshot in the same snapshot when requested", async () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "page.snapshot",
      input: { maxNodes: 50, includeScreenshot: true },
      client,
      ctx: rt.ctx,
    });
    const payload = result.result as {
      screenshot?: { dataUrl: string; format: string; width: number; height: number };
    };
    expect(payload.screenshot?.dataUrl).toMatch(/^data:image\//);
    expect(payload.screenshot?.format).toBe("jpeg");
    expect(payload.screenshot?.width).toBeGreaterThan(0);
  });

  it("requires approval for a snapshot screenshot, but not for the node snapshot", async () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const rt = createTestRuntime();
    const plain = await rt.executor.execute({ taskId: "task_step",
      tool: "page.snapshot",
      input: { maxNodes: 50 },
      client,
      ctx: rt.ctx,
    });
    expect((plain.result as { screenshot?: unknown }).screenshot).toBeUndefined();
    const dry = await rt.executor.execute({ taskId: "task_step",
      tool: "page.snapshot",
      input: { maxNodes: 50, includeScreenshot: true },
      client,
      ctx: rt.ctx,
      dryRun: true,
    });
    expect((dry.result as { requiresApproval?: boolean }).requiresApproval).toBe(true);
    let code: string | undefined;
    try {
      await rt.executor.execute({ taskId: "task_step",
        tool: "page.snapshot",
        input: { maxNodes: 50, includeScreenshot: true },
        client,
        ctx: rt.ctx,
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("APPROVAL_REQUIRED");
    const approval = rt.approvals.create({ tool: "page.snapshot", risk: "read-only", summary: "snapshot with screenshot", client, input: { maxNodes: 50, maxDepth: 8, includeScreenshot: true, screenshotFormat: "jpeg", screenshotQuality: 60 } });
    rt.approvals.approve(approval.id);
    const shot = await rt.executor.execute({ taskId: "task_step",
      tool: "page.snapshot",
      input: { maxNodes: 50, includeScreenshot: true },
      client,
      ctx: rt.ctx,
      approvalId: approval.id,
    });
    expect((shot.result as { screenshot?: { dataUrl: string } }).screenshot?.dataUrl).toMatch(/^data:image\//);
  });

  it("clicks canvas coordinates without requiring a DOM ref", async () => {
    const canvas = document.createElement("canvas");
    canvas.id = "paint";
    canvas.width = 80;
    canvas.height = 80;
    document.body.appendChild(canvas);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => canvas;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "act",
      input: { steps: [{ do: "click", target: { x: 50, y: 50, coordinateSpace: "css" } }] },
        client,
        ctx: rt.ctx,
      });
    const results = (result.result as { results: { ok: boolean }[] }).results;
    expect(results[0].ok).toBe(true);
    document.elementFromPoint = original;
  });

  it("inspects forms inside open shadow roots", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = `<form action="/save"><input name="email" /></form>`;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "forms.inspect", input: {}, client, ctx: rt.ctx });
    const forms = (result.result as { forms: { fields: unknown[] }[] }).forms;
    expect(forms.length).toBe(1);
    expect(forms[0].fields.length).toBe(1);
  });

  it("does NOT re-resolve a stale ref to a different re-rendered control", async () => {
    // A ref is bound to the exact element it was minted for. Re-rendering
    // the page with a new, same-text button must not make the old ref click
    // the new button: the caller must re-find and get a fresh ref.
    document.body.innerHTML = `<button id="one">Continue</button>`;
    const rt = createTestRuntime({ policy: open });
    const found = await rt.executor.execute({ taskId: "task_step", 
      tool: "dom.find",
      input: { by: "text", value: "Continue" },
      client,
      ctx: rt.ctx,
    });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    document.body.innerHTML = `<button id="two">Continue</button>`;
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "dom.click", input: { ref }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "STALE_ELEMENT" });
  });

  it("de-duplicates links collected across tabs", async () => {
    const rt = createTestRuntime({ policy: open });
    const a = rt.ctx.addTab({ url: "https://a.test/", active: true });
    const b = rt.ctx.addTab({ url: "https://b.test/" });
    document.body.innerHTML = `<a href="https://shared.test/x">Same</a><a href="https://a.test/only">A</a>`;
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "workflows.collectLinks",
      input: { tabIds: [a.id, b.id], limitPerTab: 20 },
      client,
      ctx: rt.ctx,
    });
    const links = (result.result as { links: { href: string }[] }).links;
    const hrefs = links.map((link) => link.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("unified observe", () => {
  it("reads metadata, text, and ast in one call", async () => {
    document.body.innerHTML = `<main><h1>Title</h1><p>Hello world</p></main>`;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "observe",
      input: { include: ["metadata", "text", "ast"], maxNodes: 50 },
      client,
      ctx: rt.ctx,
    });
    const payload = result.result as { metadata?: { title: string }; text?: string; ast?: { tag: string; children: unknown[] } };
    expect(payload.text).toContain("Hello world");
    expect(payload.ast?.tag).toBe("body");
    expect(payload.ast?.children.length).toBeGreaterThan(0);
  });
});

describe("act approval gating", () => {
  it("requires approval when act clicks a submit control", async () => {
    document.body.innerHTML = `<form><button type="submit">Save</button></form>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector("button")!;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "text", value: "Save" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "act", input: { steps: [{ do: "click", target: { ref } }] }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    document.elementFromPoint = original;
  });

  it("allows act click on a non-submit button without approval", async () => {
    document.body.innerHTML = `<div><button>Just a button</button></div>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector("button")!;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "text", value: "Just a button" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "act", input: { steps: [{ do: "click", target: { ref } }] }, client, ctx: rt.ctx });
    expect((result.result as { results: { ok: boolean }[] }).results[0].ok).toBe(true);
    document.elementFromPoint = original;
  });

  it("requires approval when act presses Enter in a form", async () => {
    document.body.innerHTML = `<form><input type="text" name="q" /></form>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector('input[name="q"]')!;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: 'input[name="q"]' }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    await expect(
      rt.executor.execute({ taskId: "task_step",  tool: "act", input: { steps: [{ do: "press", target: { ref }, key: "Enter" }] }, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    document.elementFromPoint = original;
  });

  it("allows act click on canvas (not consequential)", async () => {
    document.body.innerHTML = `<canvas id="board" width="100" height="100"></canvas>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector("canvas")!;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "selector", value: "#board" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "act", input: { steps: [{ do: "click", target: { ref } }] }, client, ctx: rt.ctx });
    expect((result.result as { results: { ok: boolean }[] }).results[0].ok).toBe(true);
    document.elementFromPoint = original;
  });

  it("requires approval when act clicks submit at coordinates", async () => {
    document.body.innerHTML = `<form><button type="submit">Buy now</button></form>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector("button")!;
    const rt = createTestRuntime();
    await expect(
      rt.executor.execute({ taskId: "task_step", 
        tool: "act",
        input: { steps: [{ do: "click", target: { x: 50, y: 10, coordinateSpace: "css" } }] },
        client,
        ctx: rt.ctx,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    document.elementFromPoint = original;
  });

  it("allows act click at coordinates on canvas", async () => {
    document.body.innerHTML = `<canvas id="board" width="100" height="100"></canvas>`;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => document.querySelector("canvas")!;
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ taskId: "task_step", 
      tool: "act",
      input: { steps: [{ do: "click", target: { x: 50, y: 50, coordinateSpace: "css" } }] },
      client,
      ctx: rt.ctx,
    });
    const results = (result.result as { results: { ok: boolean }[] }).results;
    expect(results[0].ok).toBe(true);
    document.elementFromPoint = original;
  });

  it("re-renders: act click succeeds after DOM re-renders between observe and act", async () => {
    document.body.innerHTML = `<button id="btn">Click me</button>`;
    const rt = createTestRuntime({ policy: open });
    const found = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "text", value: "Click me" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    // Re-render the DOM (simulates a page update between observe and act)
    document.body.innerHTML = `<button id="btn">Click me again</button>`;
    const foundAgain = await rt.executor.execute({ taskId: "task_step",  tool: "dom.find", input: { by: "text", value: "Click me again" }, client, ctx: rt.ctx });
    const refAgain = (foundAgain.result as { elements: { ref: string }[] }).elements[0].ref;
    expect(refAgain).not.toBe(ref);
    const result = await rt.executor.execute({ taskId: "task_step",  tool: "act", input: { steps: [{ do: "click", target: { ref: refAgain } }] }, client, ctx: rt.ctx });
    expect((result.result as { results: { ok: boolean }[] }).results[0].ok).toBe(true);
  });
});

describe("workflow partial-failure fixes", () => {
  // Workflow outputs gain new optional fields (errors / partial / totalTables
  // / ungrouped / skipped) that the contracts section must add to the output
  // schemas, so these tests call the handlers directly rather than through
  // the executor's strict output validation.
  async function runWorkflow(
    rt: ReturnType<typeof createTestRuntime>,
    tool: string,
    input: unknown,
    invoke?: (name: string, payload: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const handler = rt.registry.require(tool).handler as unknown as (input: unknown, exec: unknown) => Promise<unknown>;
    const execInvoke =
      invoke ??
      (async (name: string, payload: unknown) => (await rt.executor.execute({ taskId: "task_step",  tool: name, input: payload, client, ctx: rt.ctx })).result);
    return handler(input, {
      ctx: rt.ctx,
      client,
      approvalValidated: true,
      signal: new AbortController().signal,
      runtime: {},
      invoke: execInvoke,
    });
  }

  it("collectLinks returns per-tab errors instead of failing the pool", async () => {
    document.body.innerHTML = `<a href="https://shared.test/x">Same</a>`;
    const rt = createTestRuntime({ policy: open });
    const good = rt.ctx.addTab({ url: "https://good.test/", active: true });
    const result = (await runWorkflow(rt, "workflows.collectLinks", { tabIds: [good.id, 9999], limitPerTab: 20 })) as {
      links: { href: string }[];
      errors?: { tabId: number; error: string }[];
    };
    expect(result.links.map((l) => l.href)).toContain("https://shared.test/x");
    expect(result.errors?.map((e) => e.tabId)).toContain(9999);
  });

  it("openSequence returns opened tabs on a mid-sequence error", async () => {
    const rt = createTestRuntime({ policy: open });
    let creates = 0;
    const invoke = async (name: string, payload: unknown) => {
      if (name === "tabs.create") {
        creates += 1;
        if (creates > 1) throw new Error("boom creating tab");
      }
      return (await rt.executor.execute({ taskId: "task_step",  tool: name, input: payload, client, ctx: rt.ctx })).result;
    };
    const result = (await runWorkflow(rt, "workflows.openSequence", { urls: ["https://a.test/", "https://b.test/"], delayMs: 0, active: false }, invoke)) as {
      opened: { url: string }[];
      partial?: boolean;
      error?: string;
    };
    expect(result.opened).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.error).toContain("boom");
  });

  it("extractTable accepts tableIndex and reports totalTables", async () => {
    document.body.innerHTML = `
      <table><tr><th>A</th></tr><tr><td>1</td></tr></table>
      <table><tr><th>B</th></tr><tr><td>2</td></tr></table>`;
    const rt = createTestRuntime({ policy: open });
    const result = (await runWorkflow(rt, "workflows.extractTable", { tableIndex: 1, maxRows: 10 })) as {
      headers: string[];
      rows: string[][];
      totalTables: number;
    };
    expect(result.totalTables).toBe(2);
    expect(result.headers).toEqual(["B"]);
    expect(result.rows).toEqual([["2"]]);
  });

  it("organizeTabs reports small-bucket tabs as ungrouped instead of dropping them", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        tabs: [
          { url: "https://a.test/1", title: "Alpha one", active: true },
          { url: "https://b.test/2", title: "Alpha two" },
          { url: "https://c.test/3", title: "Solo" },
        ],
      },
    });
    const result = (await runWorkflow(rt, "workflows.organizeTabs", { strategy: "titlePrefix", maxGroups: 5 })) as {
      groups: { title: string; tabIds: number[] }[];
      ungrouped?: number[];
    };
    expect(result.groups.some((g) => g.title === "alpha" && g.tabIds.length === 2)).toBe(true);
    expect(result.ungrouped).toHaveLength(1);
  });

  it("saveSession reports tabs skipped for invalid URLs", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        tabs: [
          { url: "https://ok.test/", title: "OK", active: true },
          { url: "chrome://extensions/", title: "Extensions" },
        ],
      },
    });
    const result = (await runWorkflow(rt, "workflows.saveSession", { name: "s1" })) as {
      tabCount: number;
      skipped?: number;
    };
    expect(result.tabCount).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("restoreSession reports skipped URLs and partial tabs on error", async () => {
    const rt = createTestRuntime({ policy: open });
    const session = await rt.ctx.sessions.save("s1", [
      { url: "https://ok.test/", title: "OK" },
      { url: "chrome://extensions/", title: "Bad" },
    ]);
    const result = (await runWorkflow(rt, "workflows.restoreSession", { sessionId: session.id, active: false })) as {
      restored: number;
      skipped?: string[];
    };
    expect(result.restored).toBe(1);
    expect(result.skipped).toContain("chrome://extensions/");
  });
});
