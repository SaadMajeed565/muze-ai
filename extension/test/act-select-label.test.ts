import { describe, expect, it } from "vitest";
import { actTool } from "../libs/tool-contracts/index.js";

// Regression for retest3 dom.select label path: a label-only select step
// arriving via the gateway (dom.select -> act) must survive schema parsing
// and reach dom.select with its label intact, instead of being dropped and
// collapsing to value:"" (which previously returned selected:false).
describe("act select step label", () => {
  it("parses a label-only select step and keeps the label", () => {
    const parsed = actTool.input.parse({
      steps: [{ do: "select", target: { ref: "r1" }, label: "Three" }],
    }) as { steps: { do: string; label?: string; value?: string }[] };
    expect(parsed.steps[0].label).toBe("Three");
  });

  it("keeps both value and label when both are given", () => {
    const parsed = actTool.input.parse({
      steps: [{ do: "select", target: { ref: "r1" }, value: "2", label: "Three" }],
    }) as { steps: { do: string; label?: string; value?: string }[] };
    expect(parsed.steps[0].value).toBe("2");
    expect(parsed.steps[0].label).toBe("Three");
  });
});
