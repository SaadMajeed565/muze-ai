import type { PermissionMode } from "../libs/security/index.js";
import type { DashboardMcpClient } from "../src/messages.js";
import { TABS, type IconName, type TabId } from "./logic.js";

/**
 * Pure presentation helpers for the end-user dashboard. Nothing here
 * renders a developer field: tool names, ids, risk levels, audit
 * records and version numbers are stripped or mapped to plain words
 * before they ever reach a component. The underlying data is
 * unchanged — only what is shown changes.
 */

/**
 * Navigation (v3): exactly five destinations, in this order. Task
 * steps live inside task detail; browsers and apps live inside
 * Connections; permissions, appearance, privacy, help and the account
 * itself live inside Account. There is no sixth tab. Derived from the
 * single canonical definition in logic.ts (TABS) — never a second
 * literal list, so the two can never diverge.
 */
export const NAV_TABS: TabId[] = TABS.map((tab) => tab.id);

/**
 * Short date, or null when the value is unknown. Unknown values are
 * omitted by callers, never printed as "Unknown" and never guessed.
 * Example: "Oct 15".
 */
export function shortDate(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  try {
    return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return null;
  }
}

/**
 * Relative time, or null when the value is unknown. Short forms only:
 * "13s", "2m", "3h", "2d ago", falling back to shortDate() past a week.
 * Never a raw locale timestamp, never "Unknown".
 */
export function relativeTime(value: number | null | undefined, now: number): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const delta = Math.max(0, now - value);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(value);
}

/**
 * App-name resolution (dashboard layer only). The bridge hello client
 * is a single gateway identity ("Universal Browser Tools (remote
 * MCP)") shared by every MCP client on one socket, so it can never be
 * a per-app name — and one socket multiplexes many MCP clients, so
 * renaming it is not a fix. When an audit/approval actor carries that
 * constant, an id-like oc_… value, or no usable name at all, look the
 * actor up in the registered MCP clients by client id and use its
 * registered name. Nothing usable -> "AI app", never "Unknown".
 */
export const GATEWAY_CLIENT_NAMES = ["Universal Browser Tools (remote MCP)", "Universal Browser Tools"] as const;
export const GATEWAY_CLIENT_IDS = ["muze-gateway", "unknown"] as const;

export interface AppActor {
  id?: string;
  name?: string;
}

export function resolveAppName(
  client: AppActor | null | undefined,
  registeredClients: readonly { clientId: string; clientName: string }[],
): string {
  const lookup = (id: string | undefined): string | null => {
    if (!id) return null;
    const found = registeredClients.find((entry) => entry.clientId === id);
    const name = found?.clientName?.trim();
    return name ? name : null;
  };
  const name = client?.name?.trim() ?? "";
  const id = client?.id?.trim() ?? "";
  const isGatewayName = (GATEWAY_CLIENT_NAMES as readonly string[]).includes(name);
  const isGatewayId = (GATEWAY_CLIENT_IDS as readonly string[]).includes(id);
  const isIdLikeName = /^oc_[A-Za-z0-9_-]+$/.test(name);
  const isUnknownName = name === "" || name === "Unknown client";
  if (isGatewayName || isGatewayId || isIdLikeName || isUnknownName) {
    // For an id-like name, the name itself may be the client id.
    return lookup(id) ?? lookup(name) ?? "AI app";
  }
  return name;
}

/**
 * Presentation dedupe by app name (dashboard layer only). The gateway
 * creates a new ClientRow on every POST /register with no dedup by
 * name + redirect URIs, so one app can hold several oc_ ids; this
 * collapses them to one row per name for display. The underlying
 * authorisations are untouched — revoking a deduped row must revoke
 * every underlying clientId + sessionId (see Connections).
 */
export interface DedupedApp {
  name: string;
  clients: DashboardMcpClient[];
  live: boolean;
}

export function dedupeAppsByName(clients: readonly DashboardMcpClient[]): DedupedApp[] {
  const groups = new Map<string, DedupedApp>();
  for (const client of clients) {
    const key = client.clientName.trim().toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.clients.push(client);
      existing.live = existing.live || client.live;
    } else {
      groups.set(key, { name: client.clientName, clients: [client], live: client.live });
    }
  }
  return [...groups.values()];
}

/**
 * Tool names are never rendered. They map to one plain verb each;
 * anything unmapped falls back to the generic verb, never the raw name.
 * Families: read (tabs.list, page.snapshot, observe, dom.read/find),
 * navigation, input, tab/window management, everything else generic.
 */
export function activityVerb(tool: string | undefined): string {
  if (!tool) return "acted in the browser";
  const name = tool.toLowerCase();
  if (
    name === "tabs.list" ||
    name === "page.snapshot" ||
    name === "observe" ||
    name === "dom.read" ||
    name === "dom.find" ||
    name.startsWith("page.read") ||
    name.startsWith("dom.read")
  ) {
    return "read a page";
  }
  if (name === "tabs.navigate" || name === "tabs.create" || name.startsWith("page.navigate") || name === "tabs.go-back" || name === "tabs.go-forward") {
    return "opened a page";
  }
  if (name === "dom.click" || name === "dom.type" || name === "dom.fill" || name === "dom.press" || name === "act") {
    return "used the page";
  }
  if (name.startsWith("tabs.") || name.startsWith("window.") || name.startsWith("tab.")) {
    return "organised tabs";
  }
  return "acted in the browser";
}

/** Map an audit event / tool to a plain action icon. Never exposes the tool name. */
export function activityIcon(tool: string | undefined, kind?: string): IconName {
  if (kind === "policy.change") return "sliders";
  if (kind === "client.connect" || kind === "client.disconnect") return "plug";
  if (kind === "approval") return "check";
  if (kind === "kill-switch") return "power";
  if (kind === "token.rotate") return "key";
  if (!tool) return "activity";
  const name = tool.toLowerCase();
  if (
    name === "tabs.list" ||
    name === "page.snapshot" ||
    name === "observe" ||
    name === "dom.read" ||
    name === "dom.find" ||
    name.startsWith("page.read") ||
    name.startsWith("dom.read")
  ) return "read";
  if (name === "tabs.navigate" || name === "tabs.create" || name.startsWith("page.navigate") || name === "tabs.go-back" || name === "tabs.go-forward" || name === "workflows.openSequence") return "navigate";
  if (name === "dom.click" || name === "dom.clickAt" || name === "act") return "click";
  if (name === "dom.type" || name === "dom.fill" || name === "dom.press" || name === "dom.clear" || name === "dom.select" || name === "dom.setChecked" || name === "dom.setRadio" || name === "forms.fill" || name === "form") return "type";
  if (name === "downloads.start") return "download";
  if (name === "clipboard.read" || name === "clipboard.write" || name.startsWith("clipboard.")) return "clipboard";
  if (name === "history.delete" || name.startsWith("history.")) return "history";
  if (name.startsWith("bookmarks.")) return "bookmark";
  if (name === "dom.submit" || name === "forms.submit" || name === "forms.upload" || name === "forms.setFile" || name === "submit") return "upload";
  if (name === "workflows.organizeTabs" || name.startsWith("tabs.") || name.startsWith("window.") || name.startsWith("tab.")) return "tab";
  if (name === "workflows.saveSession") return "bookmark";
  if (name === "workflows.restoreSession") return "navigate";
  return "activity";
}

/** Truncate to at most maxChars characters, keeping whole words where possible. */
export function truncateText(text: string, maxChars = 160): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  const cut = cleaned.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Remove parenthesised dotted tool tokens such as "(tabs.list)" from a
 * user-facing sentence, leaving the sentence itself intact. Domains in
 * running text are not parenthesised this way, so they survive.
 */
export function stripToolTokens(text: string): string {
  return text.replace(/\s*\([a-z][\w]*\.[a-z][\w.]*\)/g, "").replace(/\s+/g, " ").trim();
}

/** Task status in plain words, never the runner's status key. */
export function plainTaskStatus(status: string): string {
  switch (status) {
    case "running":
      return "In progress";
    case "created":
      return "Starting";
    case "paused":
      return "Paused";
    case "waiting_approval":
      return "Waiting for you";
    case "done":
      return "Done";
    case "failed":
      return "Didn't finish";
    case "cancelled":
      return "Cancelled";
    case "partial":
      return "Partly done";
    default:
      return "In progress";
  }
}

/** Step state in plain words. */
export function plainStepState(state: string): string {
  switch (state) {
    case "done":
      return "Done";
    case "failed":
      return "Didn't finish";
    case "waiting_approval":
      return "Waiting for you";
    case "running":
      return "In progress";
    case "skipped":
      return "Skipped";
    default:
      return "In progress";
  }
}

/** A task step as the user sees it: number, status word, short summary. Never the tool name. */
export interface PlainStep {
  number: number;
  state: string;
  summary: string;
}

export function plainStep(step: { index: number; state: string; outputSummary?: string; inputSummary?: string }): PlainStep {
  const raw = (step.outputSummary ?? "").trim() || (step.inputSummary ?? "").trim();
  return {
    number: step.index + 1,
    state: plainStepState(step.state),
    summary: raw ? truncateText(stripToolTokens(raw), 160) : "Working on this step.",
  };
}

/** Runner pause reasons in plain words. Unknown reasons are humanised, never shown raw. */
export function plainPauseReason(reason: string | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case "verify-failed":
      return "A check didn't pass, so the task paused.";
    case "policy-changed":
      return "Your permissions changed, so the task paused.";
    case "budget-exhausted":
    case "total-budget-exhausted":
      return "The task ran out of time, so it stopped.";
    case "user-paused":
      return "You paused this task.";
    default:
      return `${reason.replace(/[-_]+/g, " ")}.`;
  }
}

/** Plain words for a task's final report: counts, never step-index lists. */
export function plainFinalSummary(done: number, undone: number, failed: number): string {
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} step${done === 1 ? "" : "s"} done`);
  if (undone > 0) parts.push(`${undone} step${undone === 1 ? "" : "s"} left`);
  if (failed > 0) parts.push(`${failed} step${failed === 1 ? "" : "s"} didn't finish`);
  return parts.length > 0 ? parts.join(" · ") : "No steps recorded.";
}

/** A permission-group key in plain words (bookmarks, history, downloads, clipboard). */
export function plainGroupName(group: string): string {
  switch (group) {
    case "bookmarks":
      return "Bookmarks";
    case "history":
      return "Browsing history";
    case "downloads":
      return "Downloads";
    case "clipboard":
      return "Clipboard";
    default:
      return group.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/**
 * Task status in the reference's words for rows and detail headers:
 * Running / Completed / Failed. (plainTaskStatus above keeps the older
 * "In progress / Done / Didn't finish" wording used elsewhere.)
 */
export function taskStatusWord(status: string): string {
  switch (status) {
    case "running":
    case "created":
      return "Running";
    case "done":
      return "Completed";
    case "failed":
      return "Failed";
    case "paused":
      return "Paused";
    case "waiting_approval":
      return "Waiting for you";
    case "cancelled":
      return "Cancelled";
    case "partial":
      return "Partly done";
    default:
      return "Running";
  }
}

/**
 * Honest task progress text, per the reference rule: fixed plans show
 * "Step X of N" with a percentage bar; a task with no known total never
 * invents one — "N steps done so far · total unknown" with an
 * indeterminate bar.
 */
export interface TaskProgress {
  text: string;
  percent: number;
  indeterminate: boolean;
}

export function taskProgress(doneCount: number, totalSteps: number, stepsDone: number): TaskProgress {
  if (totalSteps > 0) {
    return {
      text: `Step ${doneCount} of ${totalSteps}`,
      percent: Math.round((doneCount / totalSteps) * 100),
      indeterminate: false,
    };
  }
  return {
    text: `${stepsDone} steps done so far · total unknown`,
    percent: 0,
    indeterminate: true,
  };
}

/**
 * A task step's timeline icon from the reference's single monochrome
 * stroke set: one icon per interaction family, not per tool — pointer =
 * click / hover / move / focus, keyboard = typing, camera = screenshot,
 * mouse = scroll, nav-arrow = navigation, drag, eye = read / observe,
 * tab = tab & window management, send = submit, upload, folder = files
 * & data, bookmark, history-rewind, download, clipboard, info = browser
 * info, wrench = devtools, flow = workflows, clock = wait, checklist =
 * task management, check = done with no family, X = failed. The tool
 * name itself is never rendered — only the icon and the plain summary
 * reach the screen. Branch order matters: failed overrides everything,
 * family matches precede done → check, and pointer is only the fallback
 * for genuinely unknown future tools.
 */
export function timelineIconForStep(tool: string | undefined, state: string): IconName {
  if (state === "failed") return "fail";
  const name = (tool ?? "").toLowerCase();
  // Pointer-device actions: click plus hover / move / focus, which have
  // no more specific glyph.
  if (
    name === "dom.click" ||
    name === "dom.clickat" ||
    name === "act" ||
    name === "dom.hover" ||
    name === "dom.moveto" ||
    name === "dom.focus"
  ) return "pointer";
  // Typing and field edits. dom.pressat belongs here (it used to fall
  // through to pointer); dom.typeat is caught by the dom.type prefix.
  if (
    name === "dom.type" ||
    name === "dom.fill" ||
    name === "dom.press" ||
    name === "dom.pressat" ||
    name === "dom.clear" ||
    name === "dom.select" ||
    name === "dom.setchecked" ||
    name === "dom.setradio" ||
    name === "forms.fill" ||
    name === "form" ||
    name.startsWith("dom.type")
  ) return "keyboard";
  // Screenshots. This branch precedes the browser.* branch below so
  // browser.capturetab keeps the camera, not the info glyph.
  if (name.startsWith("screenshot") || name.includes("capture")) return "camera";
  if (name.includes("scroll")) return "mouse";
  // Navigation. navigation.* belongs here (it used to fall through to
  // pointer); navigation.wait stays here and never reaches the clock
  // branch below. The tabs.go-back / page.navigate checks are legacy
  // names kept for old step records.
  if (
    name === "tabs.navigate" ||
    name === "tabs.create" ||
    name === "tabs.reload" ||
    name === "navigation.open" ||
    name === "navigation.back" ||
    name === "navigation.forward" ||
    name === "navigation.reload" ||
    name === "navigation.search" ||
    name === "navigation.wait" ||
    name === "navigate" ||
    name.startsWith("page.navigate") ||
    name === "tabs.go-back" ||
    name === "tabs.go-forward" ||
    name === "workflows.opensequence" ||
    name === "workflows.restoresession"
  ) return "nav-arrow";
  if (name === "dom.drag" || name === "dom.dragat") return "drag";
  // Read / observe: page content reads, element inspection, and the
  // unified observe action. Reuses the existing eye glyph.
  if (
    name === "dom.find" ||
    name === "dom.read" ||
    name === "dom.boundingbox" ||
    name === "dom.visible" ||
    name === "dom.shadow" ||
    name === "page.read" ||
    name === "page.metadata" ||
    name === "page.outline" ||
    name === "page.links" ||
    name === "page.selectedtext" ||
    name === "page.find" ||
    name === "page.extract" ||
    name === "page.tables" ||
    name === "page.snapshot" ||
    name === "page.accessibilitytree" ||
    name === "page.networkidle" ||
    name === "page.waitfor" ||
    name === "page.dialogs" ||
    name === "page.responddialog" ||
    name === "observe" ||
    name === "frames.list" ||
    name === "forms.inspect" ||
    name === "forms.preview"
  ) return "eye";
  // Tab and window management. Safe after the nav-arrow branch above,
  // which already claimed tabs.navigate / tabs.create / tabs.reload.
  // Reuses the existing tab glyph.
  if (
    name.startsWith("tabs.") ||
    name.startsWith("windows.") ||
    name === "tabs" ||
    name === "windows"
  ) return "tab";
  if (name === "dom.submit" || name === "forms.submit" || name === "submit") return "send";
  // Uploads reuse the existing upload glyph.
  if (name === "forms.upload" || name === "forms.setfile") return "upload";
  // Files and data reuse the existing folder glyph.
  if (name.startsWith("files.") || name === "files" || name === "data") return "folder";
  // Bookmarks reuse the existing bookmark glyph.
  if (name.startsWith("bookmarks.")) return "bookmark";
  // History gets its own rewind glyph, distinct from the plain clock
  // used for waits.
  if (name.startsWith("history.")) return "history-rewind";
  // Downloads reuse the existing download glyph.
  if (name.startsWith("downloads.")) return "download";
  // Clipboard reuses the existing clipboard glyph.
  if (name.startsWith("clipboard.") || name === "clipboard") return "clipboard";
  // Browser info / diagnostics reuse the existing info glyph. The
  // camera branch above already claimed browser.capturetab.
  if (name.startsWith("browser.") || name === "browser") return "info";
  if (name.startsWith("devtools.") || name === "devtools") return "wrench";
  // Remaining workflows. openSequence / restoreSession were already
  // claimed by the nav-arrow branch above.
  if (name.startsWith("workflows.")) return "flow";
  // Waits reuse the existing clock glyph. navigation.wait never reaches
  // here (nav-arrow branch above); dom.waitfor and the unified wait do.
  if (name === "dom.waitfor" || name === "wait") return "clock";
  // Task management (rarely a timeline step, but complete).
  if (name.startsWith("tasks.")) return "checklist";
  // A done step with a family above already returned that family's icon;
  // only a done step from a genuinely unknown tool lands here.
  if (state === "done") return "check";
  // Ultimate fallback, for genuinely unknown future tools only: after
  // the branches above, no known registry tool reaches this line.
  return "pointer";
}

/**
 * What the agent may do, in plain words, from the permission level and
 * the enabled groups only. Never a tool name, category, or risk level.
 */
export function plainCapabilities(mode: PermissionMode, enabledGroups: Record<string, boolean>): string[] {
  const out: string[] = [];
  if (mode === "restricted") {
    out.push("Read pages");
  } else if (mode === "unrestricted") {
    out.push("Read pages", "Make changes", "Act without asking first");
  } else {
    out.push("Read pages", "Make changes that can be undone", "Ask before sensitive or consequential actions");
  }
  for (const [group, enabled] of Object.entries(enabledGroups)) {
    if (!enabled) continue;
    if (group === "bookmarks") out.push("Use bookmarks");
    else if (group === "history") out.push("Use browsing history");
    else if (group === "downloads") out.push("Manage downloads");
    else if (group === "clipboard") out.push("Read and write the clipboard");
    else out.push(`Use ${plainGroupName(group).toLowerCase()}`);
  }
  return out;
}
