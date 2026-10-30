import type { PermissionMode } from "../libs/security/index.js";
import type { TabId } from "./logic.js";

/**
 * Pure presentation helpers for the end-user dashboard. Nothing here
 * renders a developer field: tool names, ids, risk levels, audit
 * records and version numbers are stripped or mapped to plain words
 * before they ever reach a component. The underlying data is
 * unchanged — only what is shown changes.
 */

/**
 * Navigation (v2): exactly four tabs, the same on every breakpoint.
 * No group headings are needed for four items. Activity lives inside
 * Tasks; browsers, apps, and permissions live inside Profile.
 */
export const NAV_TABS: TabId[] = ["overview", "tasks", "files", "profile"];

export function navGroupTabs(): TabId[] {
  return [...NAV_TABS];
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

/** Audit decision in plain words. */
export function plainDecision(decision: string): string {
  switch (decision) {
    case "allowed":
      return "Allowed";
    case "denied":
      return "Denied";
    case "error":
      return "Failed";
    case "approval-required":
      return "Waiting for approval";
    case "preflight-unavailable":
      return "Needs a check first";
    default:
      return "Recorded";
  }
}

/** Audit kind in plain words. The tool, if any, is never included. */
export function plainActivityKind(kind: string): string {
  switch (kind) {
    case "tool.call":
      return "Agent acted";
    case "tool.result":
      return "Agent finished an action";
    case "policy.change":
      return "Permissions changed";
    case "client.connect":
      return "AI app connected";
    case "client.disconnect":
      return "AI app disconnected";
    case "approval":
      return "Approval answered";
    case "kill-switch":
      return "All activity stopped";
    case "token.rotate":
      return "Connection refreshed";
    default:
      return "Activity";
  }
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

/** The single next action on Home, by priority: sign in, finish setup, review requests, manage browsers. */
export type HomeNextAction = "sign-in" | "setup" | "approvals" | "browsers";

export function homeNextAction(input: {
  signedIn: boolean;
  setupRemaining: number;
  pendingApprovals: number;
}): HomeNextAction {
  if (!input.signedIn) return "sign-in";
  if (input.setupRemaining > 0) return "setup";
  if (input.pendingApprovals > 0) return "approvals";
  return "browsers";
}
