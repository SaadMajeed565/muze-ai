/**
 * Registry-generated MCP tool-selection instructions (Phase 2).
 *
 * Only the tool-names / actions / risks portion is generated, from the
 * registry + the per-action risk table, so it cannot drift from the
 * registry. Hand-written safety guidance (approvals, elicitation, never
 * sending a confirmation flag) lives separately in cloudflare/src/mcp.ts
 * and is NOT generated here.
 */
import { UNIFIED_ACTION_RISK } from "./action-risk.js";
import type { ToolDescriptor } from "./tools.js";

function riskGroups(toolName: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const entry of UNIFIED_ACTION_RISK.filter((e) => e.unifiedTool === toolName)) {
    const key = entry.domain ? `${entry.action} (${entry.domain})` : entry.action;
    (groups[entry.risk] ??= []).push(key);
  }
  for (const list of Object.values(groups)) list.sort();
  return groups;
}

/**
 * Phase A: this generator renders ONLY the descriptors it is given.
 * Callers must pass the mode-visible set, never the full registry, when
 * the text is for a mode-filtered client — otherwise a read-mode client
 * would pay context for, and be told about, tools it cannot see in
 * ListTools. The core line, the unified lines, and the suggestions are
 * all filtered to the given set, so the text cannot leak a hidden tool.
 */
export function generateToolSelectionInstructions(descriptors: ToolDescriptor[]): string {
  const byName = new Map(descriptors.map((d) => [d.name, d]));
  const core = ["observe", "act", "navigate", "form", "data", "tools.batch", "tools.discover", "tasks.create", "tasks.complete", "tasks.get", "tasks.list", "tasks.pause", "tasks.resume", "tasks.cancel"];
  const corePresent = core.filter((name) => byName.has(name));
  const lines: string[] = [];
  lines.push("## GENERATED TOOL SELECTION (from the registry; this section is generated, not hand-written)");
  lines.push(`Visible tools: ${descriptors.length}. Visible core set: ${corePresent.length ? corePresent.join(", ") : "(none)"}.`);
  lines.push("Prefer tools.batch for independent reads. Prefer a unified tool for simple actions and the granular tool for a precise action. Always re-observe after navigation. Always preview before submit (form.preview before form.submit).");
  if (byName.has("navigate") || byName.has("data")) {
    lines.push("Deprecated actions (still working in 2.x, removed in registry 3.0): navigate tab/window actions — use tabs.* / windows.* instead; data devtools/clipboard domains — use devtools.* / clipboard.* instead. Never use a deprecated action for a new flow.");
  }
  const unified = ["browser", "tabs", "windows", "navigate", "observe", "act", "wait", "form", "submit", "devtools", "data", "clipboard", "files"];
  for (const name of unified) {
    const descriptor = byName.get(name);
    if (!descriptor) continue;
    const groups = riskGroups(name);
    const parts: string[] = [];
    for (const risk of ["read-only", "reversible", "sensitive-read", "consequential", "restricted"]) {
      if (groups[risk]?.length) parts.push(`${risk}: ${groups[risk]!.join(", ")}`);
    }
    lines.push(`- \`${name}\` (${descriptor.category}, unified risk ${descriptor.risk}): ${parts.join(" | ")}`);
  }
  const suggestions: string[] = [];
  if (byName.has("observe") || byName.has("tools.batch")) suggestions.push("research → observe, tools.batch");
  if (byName.has("form")) suggestions.push("form → form inspect, fill, preview, submit");
  if (byName.has("tabs")) suggestions.push("organise → tabs, workflows.organizeTabs, tabs.group");
  if (suggestions.length) lines.push(`Task-type suggestions (suggestions only, never restrictions): ${suggestions.join("; ")}.`);
  return lines.join("\n");
}
