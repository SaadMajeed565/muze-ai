/**
 * Live activity feed: one row per real tool execution, as it happens.
 *
 * This is NOT the task plan. Tasks are the plan (what should be done);
 * this feed is what Muze is actually doing in the moment — every tool
 * execution, whether it comes from a task step or a direct tool call.
 *
 * Redaction by construction: a row's summary is derived from the tool
 * name ONLY, via activityVerb(). Inputs, outputs, URLs, and page content
 * never reach a row, matching the audit redaction rules exactly.
 *
 * Family fallbacks mirror the timelineIconForStep families in
 * dashboard/ui-logic.ts (same tool, same icon family, matching verb).
 * If a family mapping changes there, update the fallbacks here too.
 */

export type ActivityState = "running" | "done" | "failed";

export interface ActivityRow {
  id: string;
  tool: string;
  summary: string;
  state: ActivityState;
  at: number;
}

export interface ActivityEvent extends ActivityRow {
  kind: "activity";
}

/** Visible cap: the feed keeps the most recent rows only. */
export const ACTIVITY_FEED_CAP = 50;

/** Precise verbs for the tools users see most; everything else falls back by family. */
const EXACT_VERBS: Record<string, string> = {
  "dom.click": "Clicked",
  "dom.clickat": "Clicked",
  act: "Clicked",
  "dom.hover": "Hovered",
  "dom.moveto": "Moved the pointer",
  "dom.focus": "Focused an element",
  "dom.type": "Typed",
  "dom.typeat": "Typed",
  "dom.fill": "Filled a field",
  "forms.fill": "Filled a field",
  form: "Filled a form",
  "dom.press": "Pressed a key",
  "dom.pressat": "Pressed a key",
  "dom.clear": "Cleared a field",
  "dom.select": "Changed a selection",
  "dom.setchecked": "Changed a setting",
  "dom.setradio": "Changed a setting",
  "dom.submit": "Submitted",
  "forms.submit": "Submitted",
  submit: "Submitted",
  "dom.scroll": "Scrolled",
  "dom.scrollto": "Scrolled",
  "dom.drag": "Dragged",
  "dom.dragat": "Dragged",
  "dom.waitfor": "Waited",
  wait: "Waited",
  "dom.find": "Searched the page",
  "dom.read": "Read the page",
  observe: "Read the page",
  "tabs.create": "Opened a tab",
  "tabs.close": "Closed a tab",
  "tabs.activate": "Switched tabs",
  "tabs.reload": "Reloaded the tab",
  "tabs.duplicate": "Duplicated a tab",
  "windows.create": "Opened a window",
  "windows.close": "Closed a window",
  "forms.upload": "Uploaded a file",
  "forms.setfile": "Attached a file",
  browser: "Checked the browser",
  tabs: "Changed tabs",
  windows: "Changed windows",
  navigate: "Navigated",
  devtools: "Checked diagnostics",
  data: "Opened files",
  clipboard: "Used the clipboard",
  files: "Opened files",
};

/**
 * Plain verb for a tool execution, from the tool name alone. Never
 * returns a tool name, URL, or page content — only a generic verb.
 */
export function activityVerb(tool: string): string {
  const name = (tool ?? "").toLowerCase();
  const exact = EXACT_VERBS[name];
  if (exact !== undefined) return exact;
  if (name.startsWith("screenshot") || name.includes("capture")) return "Took a screenshot";
  if (name.includes("scroll")) return "Scrolled";
  if (
    name === "tabs.navigate" ||
    name.startsWith("page.navigate") ||
    name === "tabs.go-back" ||
    name === "tabs.go-forward" ||
    name.startsWith("navigation") ||
    name === "workflows.opensequence" ||
    name === "workflows.restoresession"
  ) {
    return "Navigated";
  }
  if (name === "dom.drag" || name === "dom.dragat") return "Dragged";
  if (
    name === "dom.find" ||
    name === "dom.read" ||
    name === "dom.boundingbox" ||
    name === "dom.visible" ||
    name === "dom.shadow" ||
    name.startsWith("page.") ||
    name === "frames.list" ||
    name === "forms.inspect" ||
    name === "forms.preview"
  ) {
    return "Read the page";
  }
  if (name.startsWith("tabs.") || name.startsWith("windows.")) return "Changed tabs";
  if (name === "dom.submit" || name === "forms.submit") return "Submitted";
  if (name === "forms.upload" || name === "forms.setfile") return "Uploaded a file";
  if (name === "files.list" || name === "files.stat") return "Opened files";
  if (name.startsWith("bookmarks.")) return "Used bookmarks";
  if (name.startsWith("history.")) return "Used history";
  if (name.startsWith("downloads.")) return "Downloaded";
  if (name.startsWith("clipboard")) return "Used the clipboard";
  if (name.startsWith("browser.")) return "Checked the browser";
  if (name.startsWith("devtools")) return "Checked diagnostics";
  if (name.startsWith("workflows.")) return "Ran a workflow";
  if (name === "dom.waitfor") return "Waited";
  if (name.startsWith("tasks.")) return "Managed a task";
  if (
    name === "dom.click" ||
    name === "dom.clickat" ||
    name === "dom.hover" ||
    name === "dom.moveto" ||
    name === "dom.focus"
  ) {
    return "Clicked";
  }
  if (
    name === "dom.type" ||
    name === "dom.fill" ||
    name === "dom.press" ||
    name === "dom.clear" ||
    name === "dom.select" ||
    name === "dom.setchecked" ||
    name === "dom.setradio" ||
    name === "forms.fill" ||
    name.startsWith("dom.type")
  ) {
    return "Typed";
  }
  return "Worked";
}

/**
 * Fold one activity event into the feed, in arrival order. A completion
 * resolves its start row by id; a completion for an unknown id (the
 * dashboard opened mid-execution) appends as a completed row instead of
 * dropping. The list is capped to the most recent rows.
 */
export function applyActivityEvent(
  rows: ActivityRow[],
  event: ActivityEvent,
  cap: number = ACTIVITY_FEED_CAP,
): ActivityRow[] {
  const row: ActivityRow = {
    id: event.id,
    tool: event.tool,
    summary: event.summary,
    state: event.state,
    at: event.at,
  };
  const index = rows.findIndex((r) => r.id === row.id);
  const next = index >= 0 ? rows.map((r, i) => (i === index ? row : r)) : [...rows, row];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
