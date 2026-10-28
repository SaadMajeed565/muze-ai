import { describe, expect, it } from "vitest";
import { resolveUnifiedAction } from "../libs/tool-contracts/action-risk.js";
import { resolveUnifiedToolForScope } from "../src/mcp.js";

describe("gateway resolver agrees with the shared action-risk table", () => {
  it("tabs.list is read-only via unified, tabs.close resolves to tabs.close", () => {
    expect(resolveUnifiedToolForScope("tabs", { action: "list" })?.granular).toBe("tabs.list");
    expect(resolveUnifiedToolForScope("tabs", { action: "close" })?.granular).toBe("tabs.close");
    expect(resolveUnifiedAction("tabs", "list")?.granularTool).toBe("tabs.list");
    expect(resolveUnifiedAction("tabs", "close")?.granularTool).toBe("tabs.close");
  });

  it("data bookmarks.delete resolves to bookmarks.delete in both layers", () => {
    expect(resolveUnifiedToolForScope("data", { domain: "bookmarks", action: "delete" })?.granular).toBe(
      "bookmarks.delete",
    );
    expect(resolveUnifiedAction("data", "delete", "bookmarks")?.granularTool).toBe("bookmarks.delete");
  });

  it("navigate tab-before-window precedence agrees in both layers", () => {
    expect(resolveUnifiedToolForScope("navigate", { category: "window", action: "close" })?.granular).toBe(
      "tabs.close",
    );
    expect(resolveUnifiedAction("navigate", "close", "window")?.granularTool).toBe("tabs.close");
  });

  it("local delay waits stay unresolvable in both layers", () => {
    expect(resolveUnifiedToolForScope("wait", { for: "delay" })).toBeNull();
    expect(resolveUnifiedAction("wait", "delay")?.granularTool).toBe("local:abortableDelay");
  });

  it("observe and act stay multi-target and unresolvable to a single granular tool", () => {
    expect(resolveUnifiedToolForScope("observe", { include: ["text"] })).toBeNull();
    expect(resolveUnifiedToolForScope("act", { steps: [{ do: "click" }] })).toBeNull();
  });
});
