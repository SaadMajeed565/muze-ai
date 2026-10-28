import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../libs/tool-contracts/index.js";
import {
  EMPTY_TOOL_FILTER,
  ONBOARDING_STEPS,
  TABS,
  clampStep,
  filterTools,
  formatCountdown,
  formatRelativeTime,
  groupTools,
  isTabId,
  maskToken,
  onboardingProgress,
  readAppearance,
  setupChecklist,
  setupRemaining,
  toolCategories,
  toolRisks,
} from "../dashboard/logic.js";

function tool(partial: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return {
    title: partial.name,
    description: "",
    category: "navigation",
    risk: "read-only",
    requiresApproval: false,
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    ...partial,
  } as ToolDescriptor;
}

describe("onboarding progress", () => {
  it("keeps steps inside the wizard range", () => {
    expect(clampStep(0)).toBe(1);
    expect(clampStep(99)).toBe(ONBOARDING_STEPS.length);
    expect(clampStep(2.4)).toBe(2);
    expect(clampStep(Number.NaN)).toBe(1);
  });

  it("reports the current step, total and percentage", () => {
    expect(onboardingProgress(2)).toEqual({ current: 2, total: 4, percent: 50 });
    expect(onboardingProgress(4)).toEqual({ current: 4, total: 4, percent: 100 });
  });
});

describe("setup checklist", () => {
  it("marks every item as outstanding on a fresh install", () => {
    const items = setupChecklist({ signedIn: false, connectedClients: 0, onboardingStep: 1 });
    expect(items.map((item) => item.done)).toEqual([false, false, false]);
    expect(setupRemaining({ signedIn: false, connectedClients: 0, onboardingStep: 1 })).toBe(3);
  });

  it("ticks items off as the level, account and client arrive", () => {
    const items = setupChecklist({ signedIn: true, connectedClients: 2, onboardingStep: 4 });
    expect(items.every((item) => item.done)).toBe(true);
    expect(setupRemaining({ signedIn: true, connectedClients: 2, onboardingStep: 4 })).toBe(0);
  });

  it("counts a client only once one is actually connected", () => {
    expect(setupRemaining({ signedIn: true, connectedClients: 0, onboardingStep: 4 })).toBe(1);
  });
});

describe("maskToken", () => {
  it("keeps only the last four characters", () => {
    expect(maskToken("muze_live_abcdefgh1234")).toBe("••••••••1234");
  });

  it("masks short values entirely", () => {
    expect(maskToken("short")).toBe("•••••");
  });

  it("returns nothing for an empty token", () => {
    expect(maskToken("   ")).toBe("");
  });
});

describe("time formatting", () => {
  const now = 1_700_000_000_000;

  it("formats relative timestamps", () => {
    expect(formatRelativeTime(now - 1000, now)).toBe("just now");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("counts down to approval expiry", () => {
    expect(formatCountdown(now + 47_000, now)).toBe("expires in 47s");
    expect(formatCountdown(now + 180_000, now)).toBe("expires in 3m");
    expect(formatCountdown(now - 1000, now)).toBe("expiring");
  });
});

describe("tool filtering", () => {
  const tools = [
    tool({ name: "tabs.list", title: "List tabs", category: "navigation", risk: "read-only" }),
    tool({ name: "tabs.activate", title: "Activate a tab", category: "navigation", risk: "reversible" }),
    tool({ name: "downloads.start", title: "Start a download", category: "downloads", risk: "consequential" }),
    tool({ name: "cookies.list", title: "List cookies", category: "browser", risk: "sensitive-read" }),
  ];

  it("returns everything for an empty filter", () => {
    expect(filterTools(tools, EMPTY_TOOL_FILTER, {})).toHaveLength(4);
  });

  it("matches name, title, description and category", () => {
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, query: "activate" }, {}).map((t) => t.name)).toEqual(["tabs.activate"]);
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, query: "downloads" }, {}).map((t) => t.name)).toEqual(["downloads.start"]);
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, query: "cookie list" }, {}).map((t) => t.name)).toEqual(["cookies.list"]);
  });

  it("combines category and risk filters", () => {
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, category: "navigation" }, {})).toHaveLength(2);
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, category: "navigation", risk: "reversible" }, {}).map((t) => t.name)).toEqual([
      "tabs.activate",
    ]);
  });

  it("restricts to tools with a manual override", () => {
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, onlyOverrides: true }, {})).toHaveLength(0);
    expect(filterTools(tools, { ...EMPTY_TOOL_FILTER, onlyOverrides: true }, { "tabs.list": { allowed: false } }).map((t) => t.name)).toEqual([
      "tabs.list",
    ]);
  });

  it("sorts categories alphabetically and tools by risk then name", () => {
    expect(toolCategories(tools)).toEqual(["browser", "downloads", "navigation"]);
    expect(toolRisks(tools)).toEqual(["consequential", "sensitive-read", "reversible", "read-only"]);

    const grouped = groupTools(filterTools(tools, { ...EMPTY_TOOL_FILTER, category: "navigation" }, {}));
    expect(grouped.map(([name]) => name)).toEqual(["navigation"]);
    expect(grouped[0][1].map((t) => t.name)).toEqual(["tabs.activate", "tabs.list"]);
  });
});

describe("appearance", () => {
  it("falls back to the system theme for anything unexpected", () => {
    expect(readAppearance("light")).toBe("light");
    expect(readAppearance("dark")).toBe("dark");
    expect(readAppearance("sepia")).toBe("system");
    expect(readAppearance(undefined)).toBe("system");
  });
});

describe("tabs", () => {
  it("exposes the dashboard sections", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["overview", "permissions", "tools", "files", "activity", "tasks"]);
    expect(isTabId("files")).toBe(true);
    expect(isTabId("activity")).toBe(true);
    expect(isTabId("tasks")).toBe(true);
    expect(isTabId("nope")).toBe(false);
  });
});
