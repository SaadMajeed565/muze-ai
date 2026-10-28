/**
 * Frame targeting regression test (Facebook fbsbx case, 2026-10-28).
 *
 * The manifest loads the page agent in ALL frames, and
 * chrome.tabs.sendMessage with no frameId broadcasts to every frame,
 * so the first frame to answer wins. On Facebook a lightweight
 * fbsbx maw_proxy_page iframe answered before the main frame, so
 * observe returned that iframe's bootloader text instead of the
 * profile. A call with no frameId must therefore target frame 0
 * (the main frame) explicitly, never broadcast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeBrowserContext } from "../src/chrome-context.js";
import { pageAgent } from "../libs/browser-engine/page/agent.js";

describe("ChromeBrowserContext frame targeting", () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessage = vi.fn(async () => ({ ok: true, result: { title: "Facebook" } }));
    executeScript = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript },
      debugger: {},
      downloads: undefined,
      bookmarks: undefined,
      history: undefined,
      webNavigation: undefined,
    });
  });

  it("targets frame 0 when no frameId is given", async () => {
    const ctx = new ChromeBrowserContext();
    const result = await ctx.executeInPage(42, pageAgent, { op: "metadata" } as never);
    expect(result).toEqual({ title: "Facebook" });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: "muze/page-op" }),
      { frameId: 0 },
    );
    expect(sendMessage.mock.calls[0][2]).not.toEqual({});
  });

  it("still targets an explicit subframe when one is given", async () => {
    const ctx = new ChromeBrowserContext();
    const results = await ctx.executeInFrames(42, pageAgent, { op: "metadata" } as never, [3]);
    expect(results).toHaveLength(1);
    expect(results[0].frameId).toBe(3);
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: "muze/page-op" }),
      { frameId: 3 },
    );
  });

  it("injects into frame 0 on the fallback path, not into every frame", async () => {
    sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript },
      debugger: {},
      downloads: undefined,
      bookmarks: undefined,
      history: undefined,
      webNavigation: undefined,
    });
    // Second sendMessage call (after injection) succeeds.
    sendMessage.mockImplementationOnce(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    sendMessage.mockImplementation(async () => ({ ok: true, result: { title: "Facebook" } }));
    const ctx = new ChromeBrowserContext();
    await ctx.executeInPage(42, pageAgent, { op: "metadata" } as never);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42, frameIds: [0] } }),
    );
    const lastSend = sendMessage.mock.calls[sendMessage.mock.calls.length - 1];
    expect(lastSend[2]).toEqual({ frameId: 0 });
  });
});
