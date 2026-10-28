import { describe, expect, it } from "vitest";
import { UNIFIED_ACTION_RISK } from "../libs/tool-contracts/action-risk.js";
import { TOOL_META, TOOL_SCHEMAS, toToolDescriptor } from "../libs/tool-contracts/index.js";
import { dataTool, FORM_SET_FILE_MAX_BASE64_CHARS, FORM_UPLOAD_MAX_BASE64_CHARS } from "../libs/tool-contracts/schemas/unified.js";

const byName = new Map(TOOL_SCHEMAS.map((t) => [t.name, t]));

function defType(schema: unknown): string {
  const def = (schema as { _def?: { typeName?: string } } | undefined)?._def;
  return def?.typeName ?? "unknown";
}

describe("tool governance (Phase 1)", () => {
  it("every unified action entry maps to an existing granular tool with matching risk, except flagged local sentinels", () => {
    for (const entry of UNIFIED_ACTION_RISK) {
      if (entry.granularTool.startsWith("local:")) {
        expect(entry.risk).toBe("restricted");
        expect(entry.requiresApproval).toBe(true);
        continue;
      }
      const granular = byName.get(entry.granularTool);
      expect(granular, `granular tool for ${entry.unifiedTool}/${entry.action}`).toBeDefined();
      expect(granular!.risk).toBe(entry.risk);
      expect(["none", "browser-state", "external-visible", "destructive"]).toContain(entry.sideEffect);
    }
  });

  it("no unified entry hides a restricted real tool", () => {
    const restricted = UNIFIED_ACTION_RISK.filter(
      (e) => e.risk === "restricted" && !e.granularTool.startsWith("local:"),
    );
    expect(restricted).toEqual([]);
  });

  it("no tool output schema is z.any() and no input schema is z.any()", () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(defType(tool.output)).not.toBe("ZodAny");
      expect(defType(tool.input)).not.toBe("ZodAny");
    }
  });

  it("unified data output accepts both bookmark-delete (boolean) and history-delete (number) shapes", () => {
    expect(dataTool.output.safeParse({ deleted: true, id: "abc" }).success).toBe(true);
    expect(dataTool.output.safeParse({ deleted: 3 }).success).toBe(true);
  });

  it("inline file caps are stated as constants matching the granular caps", () => {
    expect(FORM_UPLOAD_MAX_BASE64_CHARS).toBe(15_000_000);
    expect(FORM_SET_FILE_MAX_BASE64_CHARS).toBe(35_000_000);
  });

  it("tasks tools stay granular and unchanged in risk", () => {
    expect(byName.get("tasks.create")?.risk).toBe("reversible");
    expect(byName.get("tasks.get")?.risk).toBe("read-only");
    expect(byName.get("tasks.list")?.risk).toBe("read-only");
    expect(byName.get("tasks.pause")?.risk).toBe("reversible");
    expect(byName.get("tasks.resume")?.risk).toBe("reversible");
    expect(byName.get("tasks.cancel")?.risk).toBe("reversible");
  });

  it("every registry tool carries real intent tags via its descriptor (Phase 2 closes the gap)", () => {
    // Tags live in tool-meta.ts and are merged by toToolDescriptor, so
    // descriptors — the MCP/dashboard surface — are the right place to check.
    for (const tool of TOOL_SCHEMAS) {
      const descriptor = toToolDescriptor(tool);
      expect(descriptor.tags, tool.name).toBeDefined();
      expect(descriptor.tags!.length, tool.name).toBeGreaterThanOrEqual(2);
      // Not vacuous category-only filler: at least one tag is not the category.
      expect(descriptor.tags!.some((tag) => tag !== tool.category), tool.name).toBe(true);
    }
    // Metadata covers exactly the registry, plus the two gateway meta
    // tools (tools.batch / tools.discover) that are served by a fallback
    // descriptor rather than TOOL_SCHEMAS.
    expect(Object.keys(TOOL_META).sort()).toEqual(
      [...TOOL_SCHEMAS.map((t) => t.name), "tools.batch", "tools.discover"].sort(),
    );
  });
});
