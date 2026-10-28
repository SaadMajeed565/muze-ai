// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

beforeEach(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
});

/** A web component with an open shadow root, the shape modern sites use. */
function mountComponent(hostId: string): void {
  const host = document.createElement("div");
  host.id = hostId;
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<button id="inner">Deep</button><input id="innerInput" name="userPassword" type="password" />`;
}

describe("deep DOM access", () => {
  it("finds an element inside an open shadow root", async () => {
    document.body.innerHTML = "";
    mountComponent("host");
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#inner" }, client, ctx: rt.ctx });
    const elements = (found.result as { elements: { ref: string; text?: string }[] }).elements;
    expect(elements.length).toBe(1);
    expect(elements[0].text).toContain("Deep");
  });

  it("still finds ordinary elements", async () => {
    document.body.innerHTML = `<div id="plain">Plain</div>`;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#plain" }, client, ctx: rt.ctx });
    expect((found.result as { elements: unknown[] }).elements.length).toBe(1);
  });

  it("reads the text of an element inside a shadow root", async () => {
    document.body.innerHTML = "";
    mountComponent("host");
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#inner" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const read = await rt.executor.execute({ tool: "dom.read", input: { ref }, client, ctx: rt.ctx });
    expect((read.result as { text: string }).text).toContain("Deep");
  });

  it("never reads a password field inside a shadow root", async () => {
    document.body.innerHTML = "";
    mountComponent("host");
    const rt = createTestRuntime({ policy: { mode: "unrestricted" } });
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "#innerInput" }, client, ctx: rt.ctx });
    const ref = (found.result as { elements: { ref: string }[] }).elements[0].ref;
    const read = await rt.executor.execute({ tool: "dom.read", input: { ref }, client, ctx: rt.ctx });
    expect(JSON.stringify(read.result)).not.toContain("hunter");
  });

  it("lists the shadow roots it found", async () => {
    document.body.innerHTML = "";
    mountComponent("host");
    const rt = createTestRuntime();
    const result = await rt.executor.execute({ tool: "dom.shadow", input: { maxDepth: 3 }, client, ctx: rt.ctx });
    const text = JSON.stringify(result.result);
    expect(text).toContain("host");
  });

  it("walks every element of the document, not only the top level", async () => {
    document.body.innerHTML = `<section><div><span id="deep">x</span></div></section>`;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "selector", value: "span" }, client, ctx: rt.ctx });
    expect((found.result as { elements: unknown[] }).elements.length).toBe(1);
  });

  it("finds an element by its text across nesting levels", async () => {
    document.body.innerHTML = `<div><p><span>Unique label</span></p></div>`;
    const rt = createTestRuntime();
    const found = await rt.executor.execute({ tool: "dom.find", input: { by: "text", value: "unique label" }, client, ctx: rt.ctx });
    expect((found.result as { elements: unknown[] }).elements.length).toBeGreaterThan(0);
  });
});

describe("page agent regression fixes", () => {
  it("clicks exactly once: synthetic dispatch without a second el.click()", async () => {
    document.body.innerHTML = `<button id="hit">Hit</button>`;
    const { pageAgent } = await import("../libs/browser-engine/page/agent.js");
    let clicks = 0;
    document.getElementById("hit")!.addEventListener("click", () => clicks++);
    const found = pageAgent({ op: "findElements", by: "selector", value: "#hit", limit: 1 }) as {
      elements: { ref: string }[];
    };
    const ref = found.elements[0].ref;
    // The agent now stamps data-muze-ref, not the old prefix.
    expect(document.getElementById("hit")!.getAttribute("data-muze-ref")).toBe(ref);
    expect(document.getElementById("hit")!.hasAttribute("data-uabb-ref")).toBe(false);
    const clicked = pageAgent({ op: "click", ref, button: "left" }) as { clicked: boolean };
    expect(clicked.clicked).toBe(true);
    expect(clicks).toBe(1);
  });

  it("returns STALE_ELEMENT for a removed element even if a same-text element reappears", async () => {
    document.body.innerHTML = `<button id="one">Continue</button>`;
    const { pageAgent } = await import("../libs/browser-engine/page/agent.js");
    const found = pageAgent({ op: "findElements", by: "text", value: "Continue", limit: 1 }) as {
      elements: { ref: string }[];
    };
    const ref = found.elements[0].ref;
    document.body.innerHTML = `<button id="two">Continue</button>`;
    const result = pageAgent({ op: "click", ref, button: "left" }) as { error?: string };
    expect(result.error).toBe("STALE_ELEMENT");
  });

  it("never fills a text field whose name marks it as a credential", async () => {
    document.body.innerHTML = `<input id="card" name="cardNumber" type="text" />`;
    const { pageAgent } = await import("../libs/browser-engine/page/agent.js");
    const found = pageAgent({ op: "findElements", by: "selector", value: "#card", limit: 1 }) as {
      elements: { ref: string }[];
    };
    const report = pageAgent({
      op: "fillForm",
      fields: [{ ref: found.elements[0].ref, value: "4111111111111111" }],
    }) as { filled: unknown[]; skipped: { reason: string }[] };
    expect(report.filled).toHaveLength(0);
    expect(report.skipped[0].reason).toMatch(/sensitive/i);
    expect((document.getElementById("card") as HTMLInputElement).value).toBe("");
  });

  it("omits credential values from snapshot nodes", async () => {
    document.body.innerHTML = `<input id="card" name="cardNumber" type="text" value="4111111111111111" />`;
    const { pageAgent } = await import("../libs/browser-engine/page/agent.js");
    const snap = pageAgent({ op: "snapshot", maxNodes: 50, maxDepth: 5, interactiveOnly: true }) as {
      nodes: { value?: string }[];
    };
    expect(JSON.stringify(snap)).not.toContain("4111111111111111");
  });
});
