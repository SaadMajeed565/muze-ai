import { useMemo, useState } from "preact/hooks";
import type { ToolDescriptor } from "../../libs/tool-contracts/index.js";
import { UNIFIED_ACTION_RISK } from "../../libs/tool-contracts/index.js";
import { aggregateToolHealth, filterHealth, type ToolHealthAggregate } from "../../libs/tool-contracts/index.js";
import { deprecatedUnifiedAction } from "../../libs/tool-contracts/index.js";
import type { AuditEvent } from "../../libs/security/index.js";
import type { DashboardSnapshot } from "../../src/messages.js";
import type { ToolFilter } from "../logic.js";
import {
  EMPTY_TOOL_FILTER,
  RISK_LABEL,
  filterTools,
  groupTools,
  toolCategories,
  toolRisks,
} from "../logic.js";
import { Icon } from "../components/Icon.js";
import { Badge, Card, Chip, EmptyState, SearchInput, Switch } from "../components/primitives.js";

export interface ToolsPageProps {
  tools: ToolDescriptor[];
  snapshot: DashboardSnapshot;
  overrides: Record<string, { allowed?: boolean }>;
  busy: boolean;
  onToggle: (tool: string, allowed: boolean) => void;
  /** Audit events for the health view; omitted until the Activity audit loads. No inputs or page content are shown. */
  audit?: AuditEvent[] | null;
}

type HealthFilter = "all" | "high-timeout" | "high-error" | "high-denial" | "needs-attention";

export function ToolsPage({ tools, snapshot, overrides, busy, onToggle, audit }: ToolsPageProps): preact.JSX.Element {
  const [filter, setFilter] = useState<ToolFilter>(EMPTY_TOOL_FILTER);
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const denied = useMemo(() => new Set(snapshot.deniedTools), [snapshot.deniedTools]);
  const categories = useMemo(() => toolCategories(tools), [tools]);
  const risks = useMemo(() => toolRisks(tools), [tools]);

  const filtered = useMemo(() => filterTools(tools, filter, overrides), [tools, filter, overrides]);
  const grouped = useMemo(() => groupTools(filtered), [filtered]);

  const health = useMemo<ToolHealthAggregate[]>(() => (audit ? aggregateToolHealth(audit) : []), [audit]);
  const healthByTool = useMemo(() => new Map(health.map((h) => [h.tool, h])), [health]);
  const visibleHealth = useMemo(() => filterHealth(health, healthFilter), [health, healthFilter]);

  const allowedCount = tools.length - denied.size;
  const patch = (next: Partial<ToolFilter>): void => setFilter((current) => ({ ...current, ...next }));
  const toggleExpanded = (name: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div class="stack">
      <Card
        title="Tool registry"
        description="Every tool the agent can call, with the state your current level produces."
        actions={
          <span class={"pill" + (allowedCount < tools.length ? " pill--warn" : "")}>
            {allowedCount}/{tools.length} allowed
          </span>
        }
      >
        <SearchInput
          ariaLabel="Search tools"
          placeholder="Search by name, description or category"
          value={filter.query}
          onChange={(query) => patch({ query })}
        />

        <div class="chip-scroll" role="group" aria-label="Filter by category">
          <Chip active={filter.category === null} onClick={() => patch({ category: null })}>
            All categories
          </Chip>
          {categories.map((name) => (
            <Chip key={name} active={filter.category === name} onClick={() => patch({ category: name })}>
              {name}
            </Chip>
          ))}
        </div>

        <div class="filter-row">
          <div class="chip-scroll" role="group" aria-label="Filter by risk">
            <Chip active={filter.risk === null} onClick={() => patch({ risk: null })}>
              Any risk
            </Chip>
            {risks.map((risk) => (
              <Chip key={risk} active={filter.risk === risk} onClick={() => patch({ risk: risk })}>
                {RISK_LABEL[risk] ?? risk}
              </Chip>
            ))}
          </div>
          <Switch
            checked={filter.onlyOverrides}
            label="Only overrides"
            onToggle={(next) => patch({ onlyOverrides: next })}
          />
        </div>

        <p class="result-count" aria-live="polite">
          {filtered.length === tools.length
            ? `${tools.length} tools`
            : `${filtered.length} of ${tools.length} tools`}
        </p>
      </Card>

      {grouped.length === 0 ? (
        <Card>
          <EmptyState
            icon="search"
            title="No tools match"
            description="Try a different search term or clear the filters."
            action={
              <Chip active onClick={() => setFilter(EMPTY_TOOL_FILTER)}>
                Clear filters
              </Chip>
            }
          />
        </Card>
      ) : (
        <div class="tool-groups">
          {grouped.map(([name, bucket]) => (
            <Card key={name} title={name} description={`${bucket.length} tool${bucket.length === 1 ? "" : "s"}`}>
              <ul class="tool-list">
                {bucket.map((tool) => {
                  const isDenied = denied.has(tool.name);
                  const overridden = overrides[tool.name] !== undefined;
                  const actions = UNIFIED_ACTION_RISK.filter((entry) => entry.unifiedTool === tool.name);
                  const toolHealth = healthByTool.get(tool.name);
                  return (
                    <li class="tool-row" key={tool.name}>
                      <div class="tool-main">
                        <span class="tool-name">{tool.name}</span>
                        <span class="tool-title">{tool.title}</span>
                        <span class="tool-tags">
                          <span class={"badge risk risk--" + riskTone(tool.risk)}>{RISK_LABEL[tool.risk] ?? tool.risk}</span>
                          <Badge tone={isDenied ? "danger" : "success"}>{isDenied ? "blocked" : "allowed"}</Badge>
                          {overridden ? <Badge tone="info">override</Badge> : null}
                          {tool.requiresApproval ? <Badge tone="warning">approval</Badge> : null}
                          {toolHealth?.needsAttention ? <Badge tone="danger">needs attention</Badge> : null}
                        </span>
                      </div>
                      <Switch
                        checked={!isDenied}
                        disabled={busy}
                        onToggle={() => onToggle(tool.name, isDenied)}
                      />
                      <span class="sr-only">{isDenied ? `${tool.name} is blocked` : `${tool.name} is allowed`}</span>
                      {tool.description ? <p class="tool-description">{tool.description}</p> : null}
                      {tool.tags?.length ? <p class="tool-description">Tags: {tool.tags.join(", ")}</p> : null}
                      {tool.whenNotToUse ? <p class="tool-description">Do not use for: {tool.whenNotToUse}</p> : null}
                      {toolHealth ? (
                        <p class="tool-description">
                          Health: {toolHealth.calls} calls, {Math.round(toolHealth.successRate * 100)}% success
                          {toolHealth.avgLatencyMs !== null ? `, avg ${Math.round(toolHealth.avgLatencyMs)}ms` : ""}
                          {toolHealth.truncatedRate !== null ? `, truncated ${Math.round(toolHealth.truncatedRate * 100)}%` : ""}
                          {toolHealth.attentionReasons.length ? ` — ${toolHealth.attentionReasons.join("; ")}` : ""}
                        </p>
                      ) : null}
                      {actions.length > 0 ? (
                        <div>
                          <button type="button" onClick={() => toggleExpanded(tool.name)}>
                            {expanded.has(tool.name) ? "Hide per-action risk" : "Show per-action risk"}
                          </button>
                          {expanded.has(tool.name) ? (
                            <ul>
                              {actions.map((entry) => {
                                const dep =
                                  tool.name === "navigate"
                                    ? deprecatedUnifiedAction("navigate", entry.action, "tab")
                                    : tool.name === "data" && entry.domain
                                      ? deprecatedUnifiedAction("data", entry.action, entry.domain)
                                      : null;
                                return (
                                  <li key={`${entry.action}:${entry.domain ?? ""}`}>
                                    <span>{entry.domain ? `${entry.action} (${entry.domain})` : entry.action}</span>
                                    {": "}
                                    <span>{entry.granularTool}</span>
                                    {", "}
                                    <span>{RISK_LABEL[entry.risk] ?? entry.risk}</span>
                                    {entry.requiresApproval === true || entry.requiresApproval === "granular" ? ", approval" : ""}
                                    {dep ? ` — deprecated, use ${dep.useInstead} instead (still works in 2.x)` : ""}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}

      <Card title="Tool health" description="Aggregates from audit events only: counts, rates and averages. No inputs, page content or screenshots are shown, and no tool is auto-disabled.">
        {audit === undefined || audit === null ? (
          <p class="tool-description">Health appears once audit events load (open Activity, then return here).</p>
        ) : (
          <div>
            <div class="chip-scroll" role="group" aria-label="Filter health">
              <Chip active={healthFilter === "all"} onClick={() => setHealthFilter("all")}>All</Chip>
              <Chip active={healthFilter === "high-timeout"} onClick={() => setHealthFilter("high-timeout")}>High timeout</Chip>
              <Chip active={healthFilter === "high-error"} onClick={() => setHealthFilter("high-error")}>High error</Chip>
              <Chip active={healthFilter === "high-denial"} onClick={() => setHealthFilter("high-denial")}>High denial</Chip>
              <Chip active={healthFilter === "needs-attention"} onClick={() => setHealthFilter("needs-attention")}>Needs attention</Chip>
            </div>
            {visibleHealth.length === 0 ? (
              <p class="tool-description">No tools match this health filter.</p>
            ) : (
              <ul>
                {visibleHealth.map((h) => (
                  <li key={h.tool}>
                    {h.tool}: {h.calls} calls, {Math.round(h.successRate * 100)}% success, timeout {Math.round(h.timeoutRate * 100)}%, error {Math.round(h.errorRate * 100)}%, denial {Math.round(h.denialRate * 100)}%
                    {h.avgLatencyMs !== null ? `, avg ${Math.round(h.avgLatencyMs)}ms` : ""}
                    {h.avgOutputSize !== null ? `, avg output ${Math.round(h.avgOutputSize)} chars` : ""}
                    {h.attentionReasons.length ? ` — ${h.attentionReasons.join("; ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <p class="page-foot">
        <Icon name="shield" size={13} />
        <span>Switching a tool off stores an explicit override; switching it back on forces it on at any level.</span>
      </p>
    </div>
  );
}

function riskTone(risk: string): "danger" | "warning" | "neutral" {
  if (risk === "consequential" || risk === "restricted") return "danger";
  if (risk === "sensitive-read") return "warning";
  return "neutral";
}
