// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime } from "../libs/testing/index.js";
import { TOOL_SCHEMAS } from "../libs/tool-contracts/index.js";

const client = { id: "c1", name: "Test", transport: "native" as const };

/** The new tools are exercised at the unrestricted level so the approval flow
 *  does not get in the way of the behaviour under test. */
const open = { mode: "unrestricted" } as const;

beforeEach(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => {};
});

describe("the new tools are registered", () => {
  const expected = [
    "tabs.ungroup",
    "tabs.mute",
    "tabs.setZoom",
    "tabs.discard",
    "windows.close",
    "page.networkIdle",
    "page.accessibilityTree",
    "page.dialogs",
    "page.respondDialog",
    "dom.shadow",
    "forms.upload",
    "screenshots.fullPage",
    "browser.observer",
    "browser.search",
    "browser.captureTab",
    "devtools.network",
    "downloads.erase",
    "bookmarks.move",
    "bookmarks.createFolder",
    "history.add",
  ];

  it("registers all twenty of them", () => {
    const names = new Set(TOOL_SCHEMAS.map((t) => t.name));
    for (const name of expected) expect(names.has(name), name).toBe(true);
  });

  it("has a unique name for every one of them", () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every one of them a description and a schema", () => {
    for (const name of expected) {
      const tool = TOOL_SCHEMAS.find((t) => t.name === name)!;
      expect(tool.description.length, name).toBeGreaterThan(13);
      expect(tool.input, name).toBeDefined();
      expect(tool.output, name).toBeDefined();
    }
  });
});

describe("tab and window tools", () => {
  it("removes tabs from their group", async () => {
    const rt = createTestRuntime({ policy: open });
    const a = rt.ctx.addTab({ url: "https://a.test/" });
    const b = rt.ctx.addTab({ url: "https://b.test/" });
    await rt.ctx.groupTabs([a.id!, b.id!], { title: "Work" });

    const result = await rt.executor.execute({ tool: "tabs.ungroup", input: { tabIds: [a.id!] }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ ungrouped: [a.id] });
    expect((await rt.ctx.getTab(a.id!)).groupId).toBe(-1);
  });

  it("mutes and unmutes a tab", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    await rt.executor.execute({ tool: "tabs.mute", input: { tabId: tab.id!, muted: true }, client, ctx: rt.ctx });
    expect((await rt.ctx.getTab(tab.id!)).audible).toBe(false);
  });

  it("sets the zoom level of a tab", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ tool: "tabs.setZoom", input: { tabId: tab.id!, zoom: 1.5 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ tabId: tab.id!, zoom: 1.5 });
    expect((await rt.ctx.getTab(tab.id!)).zoom).toBe(1.5);
  });

  it("discards a tab", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/" });
    const result = await rt.executor.execute({ tool: "tabs.discard", input: { tabId: tab.id! }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ discarded: true, tabId: tab.id! });
    expect((await rt.ctx.getTab(tab.id!)).discarded).toBe(true);
  });

  it("closes a window and its tabs", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/", windowId: 1 });
    const result = await rt.executor.execute({ tool: "windows.close", input: { windowId: 1 }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ closed: true, windowId: 1 });
    expect(rt.ctx.tabs.has(tab.id!)).toBe(false);
  });
});

describe("bookmark and history tools", () => {
  it("moves a bookmark to another folder", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: { bookmarks: [{ id: "bm1", title: "Doc", url: "https://x.test/", folder: "Bookmarks bar" }] },
    });
    const result = await rt.executor.execute({ tool: "bookmarks.move", input: { id: "bm1", parentId: "folder2" }, client, ctx: rt.ctx });
    expect((result.result as { bookmark: { parentId?: string } }).bookmark.parentId).toBe("folder2");
  });

  it("creates a bookmark folder", async () => {
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ tool: "bookmarks.createFolder", input: { title: "Reading" }, client, ctx: rt.ctx });
    expect((result.result as { folder: { title: string } }).folder.title).toBe("Reading");
    expect(rt.ctx.createdFolders).toHaveLength(1);
  });

  it("adds a history entry", async () => {
    const rt = createTestRuntime({ policy: open });
    await rt.executor.execute({ tool: "history.add", input: { url: "https://x.test/", title: "X" }, client, ctx: rt.ctx });
    expect(rt.ctx.historyStore).toHaveLength(1);
    expect(rt.ctx.historyStore[0].url).toBe("https://x.test/");
  });

  it("erases downloads", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        downloads: [
          { id: 1, filename: "a.zip", url: "https://x.test/a.zip", state: "complete", bytesReceived: 1, paused: false, startTime: "" },
          { id: 2, filename: "b.zip", url: "https://x.test/b.zip", state: "complete", bytesReceived: 1, paused: false, startTime: "" },
        ],
      },
    });
    const result = await rt.executor.execute({ tool: "downloads.erase", input: { ids: [1] }, client, ctx: rt.ctx });
    expect(result.result).toEqual({ erased: 1 });
    expect(rt.ctx.downloadsStore).toHaveLength(1);
  });
});

describe("browser search", () => {
  it("searches history, bookmarks and open tabs", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        history: [{ id: "h1", url: "https://history.test/", title: "History hit", lastVisitTime: "", visitCount: 2 }],
        bookmarks: [{ id: "bm1", title: "Bookmark hit", url: "https://bookmark.test/", folder: "Bookmarks bar" }],
        tabs: [{ url: "https://tab.test/", title: "Tab hit" }],
      },
    });
    const result = await rt.executor.execute({
      tool: "browser.search",
      input: { query: "hit", includeHistory: true, includeBookmarks: true, includeTabs: true },
      client,
      ctx: rt.ctx,
    });
    const sources = (result.result as { results: { source: string }[] }).results.map((r) => r.source).sort();
    expect(sources).toEqual(["bookmark", "history", "tab"]);
  });

  it("skips a source whose permission group is switched off", async () => {
    const rt = createTestRuntime({
      policy: { mode: "unrestricted", enabledGroups: { history: false } },
      context: {
        history: [{ id: "h1", url: "https://history.test/", title: "History hit", lastVisitTime: "", visitCount: 2 }],
        bookmarks: [{ id: "bm1", title: "Bookmark hit", url: "https://bookmark.test/", folder: "Bookmarks bar" }],
      },
    });
    const result = await rt.executor.execute({
      tool: "browser.search",
      input: { query: "hit", includeHistory: true, includeBookmarks: true, includeTabs: false },
      client,
      ctx: rt.ctx,
    });
    const sources = (result.result as { results: { source: string }[] }).results.map((r) => r.source);
    expect(sources).toEqual(["bookmark"]);
  });
});

describe("page and dom tools", () => {
  it("lists the shadow roots of the page", async () => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    host.id = "host";
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = "<span>x</span>";

    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ tool: "dom.shadow", input: { maxDepth: 3 }, client, ctx: rt.ctx });
    expect(JSON.stringify(result.result)).toContain("host");
  });

  it("builds an accessibility tree of the page", async () => {
    document.body.innerHTML = `<button aria-label="Send">Send</button><a href="https://x.test/">Link</a>`;
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({
      tool: "page.accessibilityTree",
      input: { maxNodes: 50, maxDepth: 5, interactiveOnly: true },
      client,
      ctx: rt.ctx,
    });
    expect(JSON.stringify(result.result)).toContain("Send");
  });

  it("nests the frames of a tab", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        frameTree: [
          { frameId: 0, parentFrameId: -1, url: "https://top.test/", errorOccurred: false },
          { frameId: 1, parentFrameId: 0, url: "https://child.test/", errorOccurred: false },
          { frameId: 2, parentFrameId: 1, url: "https://grandchild.test/", errorOccurred: false },
        ],
      },
    });
    const tab = rt.ctx.addTab({ url: "https://top.test/", active: true });
    rt.ctx.executeInFrames = (async () => [
      { frameId: 0, result: { url: "https://top.test/", title: "Top" } },
      { frameId: 1, result: { url: "https://child.test/", title: "Child" } },
      { frameId: 2, result: { url: "https://grandchild.test/", title: "Grandchild" } },
    ]) as unknown as typeof rt.ctx.executeInFrames;

    const result = await rt.executor.execute({ tool: "frames.list", input: { tabId: tab.id }, client, ctx: rt.ctx });
    const frames = (result.result as { frames: { frameId: number; parentFrameId: number; depth: number }[] }).frames;
    expect(frames.map((f) => f.depth)).toEqual([0, 1, 2]);
    expect(frames.map((f) => f.parentFrameId)).toEqual([-1, 0, 1]);
  });

  it("reports the browser capabilities that are available", async () => {
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ tool: "browser.capabilities", input: {}, client, ctx: rt.ctx });
    const capabilities = (result.result as { capabilities: string[] }).capabilities;
    expect(capabilities).toContain("tabs");
    expect(capabilities).toContain("downloads");
    expect(capabilities).toContain("observer");
  });

  it("reports the browser version and locale", async () => {
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute({ tool: "browser.info", input: {}, client, ctx: rt.ctx });
    const info = result.result as { browserVersion: string; locale: string; timeZone: string };
    expect(info.browserVersion).toBe("120.0.0");
    expect(info.locale).toBe("en-GB");
  });

  it("keeps a download inside the download folder", async () => {
    const rt = createTestRuntime({ policy: open });
    const result = await rt.executor.execute(
      { tool: "downloads.start", input: { url: "https://x.test/a.zip", filename: "report.zip", directory: "reports" }, client, ctx: rt.ctx },
    );
    expect(result.result).toMatchObject({ filename: "reports/report.zip" });
  });

  it("refuses a download that tries to escape the download folder", async () => {
    const rt = createTestRuntime({ policy: open });
    await expect(
      rt.executor.execute(
        { tool: "downloads.start", input: { url: "https://x.test/a.zip", filename: "../escape.zip" }, client, ctx: rt.ctx },
      ),
    ).rejects.toThrow(/download folder/);
  });

  it("refuses an absolute download path", async () => {
    const rt = createTestRuntime({ policy: open });
    await expect(
      rt.executor.execute(
        { tool: "downloads.start", input: { url: "https://x.test/a.zip", filename: "/etc/passwd" }, client, ctx: rt.ctx },
      ),
    ).rejects.toThrow(/download folder/);
  });

  it("lists the dialogs the observer has seen", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/", active: true });
    rt.ctx.attachObserver(tab.id!, {
      dialogs: [{ id: "d1", type: "confirm", message: "Delete it?", at: new Date().toISOString(), answered: "dismiss" }],
    });

    const result = await rt.executor.execute({ tool: "page.dialogs", input: { tabId: tab.id, limit: 5 }, client, ctx: rt.ctx });
    const out = result.result as { attached: boolean; dialogs: { id: string; message: string }[] };
    expect(out.attached).toBe(true);
    expect(out.dialogs).toHaveLength(1);
    expect(out.dialogs[0].message).toBe("Delete it?");
  });

  it("answers a pending dialog", async () => {
    const rt = createTestRuntime({ policy: open });
    const tab = rt.ctx.addTab({ url: "https://a.test/", active: true });
    rt.ctx.attachObserver(tab.id!, {
      dialogs: [{ id: "d1", type: "confirm", message: "Delete it?", at: new Date().toISOString(), answered: "dismiss" }],
    });

    const result = await rt.executor.execute(
      { tool: "page.respondDialog", input: { tabId: tab.id, response: "accept" }, client, ctx: rt.ctx },
    );
    expect(result.result).toMatchObject({ applied: true, response: "accept" });
    expect(rt.ctx.observerStore.get(tab.id!)!.dialogs[0].answered).toBe("accept");
  });
});

describe("browser search and file cap regressions", () => {
  it("reports a failed browser.search source instead of swallowing it", async () => {
    const rt = createTestRuntime({
      policy: open,
      context: {
        tabs: [{ url: "https://example.com/", title: "Example", active: true }],
        bookmarks: [{ id: "b1", title: "Example bookmark", url: "https://example.com/bm", folder: "Bar" }],
      },
    });
    // Direct handler call: the errors field needs the contracts output
    // schema delta before executor-level calls can carry it.
    const handler = rt.registry.require("browser.search").handler as unknown as (input: unknown, exec: unknown) => Promise<unknown>;
    const invoke = async (name: string, payload: unknown) => {
      if (name === "history.search") throw new Error("history denied");
      return (await rt.executor.execute({ tool: name, input: payload, client, ctx: rt.ctx })).result;
    };
    const result = (await handler(
      { query: "example", limit: 20, includeHistory: true, includeBookmarks: true, includeTabs: true },
      { ctx: rt.ctx, client, approvalValidated: true, signal: new AbortController().signal, runtime: {}, invoke },
    )) as { results: { source: string }[]; errors?: { source: string; error: string }[] };
    expect(result.results.map((r) => r.source)).toContain("bookmark");
    expect(result.errors?.map((e) => e.source)).toContain("history");
    expect(result.errors?.find((e) => e.source === "history")?.error).toContain("history denied");
  });

  it("states the forms.upload cap in base64 characters, not a mismatched MB figure", async () => {
    const rt = createTestRuntime({ policy: open });
    await expect(
      rt.executor.execute({
        tool: "forms.upload",
        input: {
          ref: "r1",
          files: [
            { name: "a.bin", mimeType: "application/octet-stream", dataBase64: "a".repeat(8_000_000) },
            { name: "b.bin", mimeType: "application/octet-stream", dataBase64: "b".repeat(8_000_000) },
          ],
        },
        client,
        ctx: rt.ctx,
      }),
    ).rejects.toThrow(/15,000,000 base64 character/);
  });

  it("enforces the forms.setFile inline cap in base64 characters", async () => {
    const rt = createTestRuntime({ policy: open });
    const handler = rt.registry.require("forms.setFile").handler as unknown as (input: unknown, exec: unknown) => Promise<unknown>;
    await expect(
      handler(
        { selector: "input[type=file]", files: [{ name: "big.bin", mimeType: "application/octet-stream", dataBase64: "x".repeat(35_000_001) }] },
        { ctx: rt.ctx, client, approvalValidated: true, signal: new AbortController().signal, runtime: {}, invoke: async () => ({}) },
      ),
    ).rejects.toThrow(/35,000,000 base64 character/);
  });
});
