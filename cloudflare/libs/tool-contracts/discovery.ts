/**
 * Smart discovery v2 (Tool Management Plan 2.3 / Phase 2). Deterministic,
 * no machine learning: scoring is auditable and testable.
 *
 * Scoring order, per query term (highest first):
 *   exact tool name match > tag match > category match >
 *   verb match in the action name (the part after the dot, or a unified
 *   action name from the action-risk table) > description match.
 * Permission/scope filtering runs FIRST: a caller-supplied `allowed`
 * predicate (gateway: OAuth scope + extension policy) removes tools the
 * client cannot call before any scoring, so discovery never surfaces a
 * tool the client cannot call.
 *
 * Deprecated actions are never returned first: a deprecated unified
 * action is returned only on an exact name match (the tool name itself),
 * with a warning + use-instead name. Deprecated tools still work.
 *
 * Return: up to 20 results, grouped by category, full input schema for
 * the top 5 only, a schema pointer for the rest (the client fetches the
 * full schema from its session's ListTools, which includes discovered
 * tools — see session-aware ListTools in cloudflare/src/mcp.ts).
 */
import { UNIFIED_ACTION_RISK } from "./action-risk.js";
import { deprecatedUnifiedAction, toolMetaFor, TASK_TYPE_RECOMMENDATIONS } from "./tool-meta.js";
import type { ToolDescriptor } from "./tools.js";

export const DISCOVERY_MAX_RESULTS = 20;
export const DISCOVERY_FULL_SCHEMA_COUNT = 5;

const STOPWORDS = new Set(["a", "an", "the", "to", "for", "of", "on", "in", "me", "my", "i", "please", "can", "you", "how", "do", "is", "it", "with", "and"]);

/** Spelling/alias normalisation applied to query terms AND tags/actions. */
export const QUERY_SYNONYMS: Record<string, string> = {
  organise: "organize",
  organised: "organize",
  organisation: "organize",
  summarise: "summarize",
  summarised: "summarize",
  screenshot: "screenshot",
  photo: "screenshot",
  picture: "screenshot",
  tab: "tabs",
  window: "windows",
  bookmark: "bookmarks",
  download: "downloads",
  clipboard: "clipboard",
  copy: "clipboard",
  paste: "clipboard",
};

function normalizeTerm(term: string): string {
  const lower = term.toLowerCase().replace(/[^a-z0-9]/g, "");
  return QUERY_SYNONYMS[lower] ?? lower;
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeTerm)
    .filter((term) => term.length > 0 && !STOPWORDS.has(term));
}

export interface DiscoveryRelated {
  name: string;
  note?: string;
}

export interface DiscoveryResult {
  name: string;
  title: string;
  description: string;
  category: string;
  risk: ToolDescriptor["risk"];
  requiresApproval: boolean;
  tags: string[];
  /** Matched unified action (e.g. organise) with its per-action risk, if any. */
  matchedAction?: string;
  matchedActionRisk?: ToolDescriptor["risk"];
  matchedActionApproval?: boolean;
  /** Full schema only for the top 5; otherwise a pointer (see header). */
  inputSchema?: unknown;
  inputSchemaPointer?: string;
  group: string;
  related: DiscoveryRelated[];
  prerequisites: string[];
  deprecatedWarning?: string;
  useInstead?: string;
  /** Telemetry suggestion, with its reason, when health data says so. */
  suggestion?: string;
  suggestionReason?: string;
  score: number;
}

export interface DiscoveryOptions {
  /** Permission/scope filter, applied before scoring. Omit = no filter. */
  allowed?: (descriptor: ToolDescriptor) => boolean;
  limit?: number;
  fullSchemaCount?: number;
  /** Per-tool health, for telemetry suggestions (Phase 4, suggestions only). */
  health?: Record<string, { timeoutRate: number; errorRate: number }>;
  /** Task type for recommendations (research/form/organise), suggestions only. */
  taskType?: string;
}

function unifiedActionsFor(toolName: string): string[] {
  return UNIFIED_ACTION_RISK.filter((e) => e.unifiedTool === toolName).map((e) => e.action);
}

function actionRiskFor(toolName: string, action: string): { risk: ToolDescriptor["risk"]; approval: boolean } | null {
  const entry = UNIFIED_ACTION_RISK.find((e) => e.unifiedTool === toolName && e.action === action);
  if (!entry) return null;
  return { risk: entry.risk, approval: entry.requiresApproval === true || entry.requiresApproval === "granular" };
}

function scoreDescriptor(descriptor: ToolDescriptor, terms: string[]): { score: number; matchedTerms: number; matchedAction?: string } {
  const name = descriptor.name.toLowerCase();
  const nameParts = name.split(".");
  const verb = nameParts.length > 1 ? nameParts[1]!.toLowerCase() : name;
  const meta = toolMetaFor(descriptor.name);
  const tags = (meta?.tags ?? descriptor.tags ?? []).map((t) => normalizeTerm(t));
  const category = descriptor.category.toLowerCase();
  const description = descriptor.description.toLowerCase();
  const actions = unifiedActionsFor(descriptor.name).map((a) => normalizeTerm(a));
  let score = 0;
  let matchedTerms = 0;
  let matchedAction: string | undefined;
  const normalizedQuery = terms.join(" ");
  if (normalizedQuery === name || normalizedQuery === name.replace(".", " ") || normalizedQuery === verb) {
    score += 1000;
  }
  // Per term, take the BEST channel (exact name > name part > tag >
  // action verb > category > description), not the sum: stacking would
  // let a tool matching only the object term (tabs.* for "tabs") outrank
  // a tool matching both terms through tags (workflows.organizeTabs
  // for "organise tabs").
  for (const term of terms) {
    let best = 0;
    if (name === term) best = Math.max(best, 500);
    else if (nameParts.includes(term)) best = Math.max(best, 120);
    if (verb === term || (term.length >= 3 && verb.startsWith(term))) best = Math.max(best, 90);
    if (tags.includes(term)) best = Math.max(best, 100);
    else if (tags.some((t) => t.includes(term) || term.includes(t))) best = Math.max(best, 40);
    if (category === term) best = Math.max(best, 60);
    if (actions.includes(term)) {
      best = Math.max(best, 80);
      if (!matchedAction) {
        const original = unifiedActionsFor(descriptor.name).find((a) => normalizeTerm(a) === term);
        matchedAction = original ?? term;
      }
    } else if (actions.some((a) => a.includes(term))) {
      best = Math.max(best, 30);
      if (!matchedAction) matchedAction = unifiedActionsFor(descriptor.name).find((a) => normalizeTerm(a).includes(term));
    }
    if (description.includes(term)) best = Math.max(best, 10);
    if (best > 0) matchedTerms += 1;
    score += best;
  }
  // Object-match bonus: a tool whose category or name prefix is one of
  // the query terms outranks a tool matching only a shared verb (e.g.
  // tabs.* outranks downloads.list for "list open tabs").
  if (terms.some((term) => category === term || nameParts[0] === term)) score += 15;
  return { score, matchedTerms, matchedAction };
}

/**
 * Discover tools for a query. Exact-name queries return that tool (plus
 * its related tools) even if it is deprecated — deprecated tools are
 * never returned FIRST by a fuzzy query, only on exact name match.
 */
export function discoverTools(
  descriptors: ToolDescriptor[],
  query: string,
  options: DiscoveryOptions = {},
): { results: DiscoveryResult[]; grouped: Record<string, DiscoveryResult[]>; totalAvailable: number } {
  const terms = tokenizeQuery(query);
  const limit = Math.max(1, Math.min(options.limit ?? DISCOVERY_MAX_RESULTS, DISCOVERY_MAX_RESULTS));
  const fullSchemaCount = options.fullSchemaCount ?? DISCOVERY_FULL_SCHEMA_COUNT;
  const filtered = options.allowed ? descriptors.filter(options.allowed) : [...descriptors];
  const totalAvailable = filtered.length;

  const scored: Array<{ descriptor: ToolDescriptor; score: number; matchedTerms: number; matchedAction?: string }> = [];
  for (const descriptor of filtered) {
    // Deprecated unified actions: the tool itself is not hidden, but a
    // fuzzy query must not surface it first. Only an exact name match
    // returns a deprecated tool at all (handled below via the exact path).
    const { score, matchedTerms, matchedAction } = scoreDescriptor(descriptor, terms);
    if (terms.length === 0) {
      scored.push({ descriptor, score: 1, matchedTerms: 0, matchedAction });
      continue;
    }
    if (score <= 0) continue;
    scored.push({ descriptor, score, matchedTerms, matchedAction });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedTerms !== a.matchedTerms) return b.matchedTerms - a.matchedTerms;
    return a.descriptor.name.localeCompare(b.descriptor.name);
  });

  const exactName = terms.length > 0 ? filtered.find((d) => d.name.toLowerCase() === terms.join(" ") || d.name.toLowerCase() === terms.join(".")) : undefined;
  // If the query is an exact tool name, that tool leads even if its fuzzy
  // score was low, and deprecated tools are reachable this way.
  if (exactName && scored[0]?.descriptor.name !== exactName.name) {
    const idx = scored.findIndex((s) => s.descriptor.name === exactName.name);
    if (idx > 0) {
      const [entry] = scored.splice(idx, 1);
      scored.unshift(entry!);
    } else if (idx < 0) {
      scored.unshift({ descriptor: exactName, score: 1000, matchedTerms: terms.length });
    }
  }

  const sliced = scored.slice(0, limit);
  const results: DiscoveryResult[] = sliced.map((entry, index) => {
    const descriptor = entry.descriptor;
    const meta = toolMetaFor(descriptor.name);
    const tags = meta?.tags ?? descriptor.tags ?? [];
    let matchedAction = entry.matchedAction;
    let matchedRisk: ToolDescriptor["risk"] | undefined;
    let matchedApproval: boolean | undefined;
    if (matchedAction) {
      const resolved = actionRiskFor(descriptor.name, matchedAction);
      if (resolved) {
        matchedRisk = resolved.risk;
        matchedApproval = resolved.approval;
      }
    }
    // Prerequisites + related: from metadata, plus the action-risk table's
    // canonical target for a matched unified action.
    const related: DiscoveryRelated[] = [];
    const seenRelated = new Set<string>();
    for (const rel of meta?.related ?? descriptor.related ?? []) {
      if (!seenRelated.has(rel)) {
        seenRelated.add(rel);
        related.push({ name: rel });
      }
    }
    if (descriptor.name === "form" && matchedAction === "submit") {
      if (!seenRelated.has("form.preview")) related.push({ name: "form.preview", note: "Preview is required before submit." });
      if (!seenRelated.has("form.fill")) related.push({ name: "form.fill", note: "Fill the form before previewing/submitting." });
    }
    if (descriptor.name === "tabs" && matchedAction === "organize") {
      if (!seenRelated.has("workflows.organizeTabs")) related.push({ name: "workflows.organizeTabs", note: "Granular organise implementation; tabs organise dispatches to it." });
      if (!seenRelated.has("tabs.group")) related.push({ name: "tabs.group", note: "Group tabs manually instead of auto-organising." });
    }
    const prerequisites: string[] = [];
    if (meta?.requiresNote) prerequisites.push(meta.requiresNote);
    for (const req of meta?.requires ?? descriptor.requires ?? []) prerequisites.push(`Use ${req} first.`);
    if (descriptor.name === "form" && matchedAction === "submit" && !prerequisites.some((p) => p.includes("Preview"))) {
      prerequisites.push("Preview is required before submit (form.preview).");
    }

    // Telemetry suggestion (Phase 4, suggestions only, reason stated).
    let suggestion: string | undefined;
    let suggestionReason: string | undefined;
    const health = options.health?.[descriptor.name];
    if (health && health.timeoutRate >= 0.2) {
      suggestion = "Consider splitting this step into smaller steps, or using a more specific granular tool.";
      suggestionReason = `This tool timed out in ${Math.round(health.timeoutRate * 100)}% of recent calls (threshold 20%).`;
    } else if (health && health.errorRate >= 0.2) {
      suggestion = "Consider re-observing first, or using a more specific granular tool.";
      suggestionReason = `This tool errored in ${Math.round(health.errorRate * 100)}% of recent calls (threshold 20%).`;
    }

    const deprecated = descriptor.deprecated ? { warning: `Deprecated: use ${descriptor.useInstead ?? "the replacement tool"} instead; this tool still works in 2.x and will be removed in registry 3.0.`, useInstead: descriptor.useInstead } : undefined;
    // Deprecated unified ACTIONS (Phase 3): a matched deprecated action
    // carries its warning + use-instead even when the tool itself is not
    // deprecated. It still works; the warning is the deprecation notice.
    let actionDeprecation: { warning: string; useInstead: string } | undefined;
    if (matchedAction) {
      const depDomain =
        descriptor.name === "navigate" ? "tab"
        : descriptor.name === "data" && terms.includes("devtools") ? "devtools"
        : descriptor.name === "data" && terms.includes("clipboard") ? "clipboard"
        : undefined;
      const dep = deprecatedUnifiedAction(descriptor.name, matchedAction, depDomain);
      if (dep) actionDeprecation = { warning: dep.note, useInstead: dep.useInstead };
    }

    return {
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      category: descriptor.category,
      risk: matchedRisk ?? descriptor.risk,
      requiresApproval: matchedApproval ?? descriptor.requiresApproval,
      tags,
      ...(matchedAction ? { matchedAction } : {}),
      ...(matchedRisk ? { matchedActionRisk: matchedRisk } : {}),
      ...(matchedApproval !== undefined ? { matchedActionApproval: matchedApproval } : {}),
      ...(index < fullSchemaCount ? { inputSchema: descriptor.inputSchema } : { inputSchemaPointer: `Full schema is in this session's ListTools (discovered tools persist for the session).` }),
      group: descriptor.category,
      related,
      prerequisites,
      ...(deprecated ? { deprecatedWarning: deprecated.warning, useInstead: deprecated.useInstead } : {}),
      ...(actionDeprecation ? { deprecatedWarning: actionDeprecation.warning, useInstead: actionDeprecation.useInstead } : {}),
      ...(suggestion ? { suggestion, suggestionReason } : {}),
      score: entry.score,
    };
  });

  // Task-type recommendations are appended as suggestions only, after the
  // scored results, never replacing them or restricting the list.
  if (options.taskType) {
    const rec = TASK_TYPE_RECOMMENDATIONS[options.taskType.toLowerCase()];
    if (rec) {
      for (const name of rec.tools) {
        if (results.some((r) => r.name === name)) continue;
        const descriptor = filtered.find((d) => d.name === name);
        if (!descriptor) continue;
        results.push({
          name: descriptor.name,
          title: descriptor.title,
          description: descriptor.description,
          category: descriptor.category,
          risk: descriptor.risk,
          requiresApproval: descriptor.requiresApproval,
          tags: toolMetaFor(descriptor.name)?.tags ?? descriptor.tags ?? [],
          inputSchemaPointer: `Suggested for task type "${options.taskType}": ${rec.note}`,
          group: descriptor.category,
          related: [],
          prerequisites: [],
          suggestion: rec.note,
          suggestionReason: `Task-type recommendation for "${options.taskType}" (suggestion only, not a restriction).`,
          score: 0,
        });
      }
    }
  }

  const grouped: Record<string, DiscoveryResult[]> = {};
  for (const result of results) {
    (grouped[result.group] ??= []).push(result);
  }
  return { results, grouped, totalAvailable };
}

/** Tools a task plan needs, resolved to existing registry names (gateway use). */
export function taskPlanToolNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const step of steps) {
    if (step && typeof step === "object" && typeof (step as { tool?: unknown }).tool === "string") {
      const name = (step as { tool: string }).tool.trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** A deprecated unified action is discoverable only by exact tool name. */
export function isDeprecatedDiscoveryMatch(tool: string, action: string, domain?: string): boolean {
  return deprecatedUnifiedAction(tool, action, domain) !== null;
}
