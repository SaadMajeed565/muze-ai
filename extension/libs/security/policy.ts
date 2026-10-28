import {
  type ClientIdentity,
  type PermissionCategory,
  type RiskLevel,
  type ToolDefinition,
  OPTIONAL_PERMISSION_GROUPS,
  TOOL_SCHEMAS,
  optionalGroupForTool,
} from "../tool-contracts/index.js";
import { isRestrictedUrl } from "./url.js";

export interface ToolOverride {
  allowed?: boolean;
  requiresApproval?: boolean;
}

export interface ClientPolicy {
  readOnly?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  allowedCategories?: PermissionCategory[];
  deniedCategories?: PermissionCategory[];
}

/**
 * How approval is enforced.
 * - "never": every tool runs without a confirmation step.
 * - "risk":  risky tools require an explicit user approval.
 */
export type ApprovalMode = "never" | "risk";

/**
 * The three permission levels a user can switch between. A level is a preset
 * over the risk tiers; the user can always override individual tools on top of
 * whichever level is active.
 */
export const PERMISSION_MODES = ["restricted", "default", "unrestricted"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PolicyConfig {
  version: number;
  /** The active permission level. */
  mode: PermissionMode;
  readOnlyMode: boolean;
  killSwitch: boolean;
  approvalMode: ApprovalMode;
  allowByRisk: Record<RiskLevel, boolean>;
  approvalByRisk: Record<RiskLevel, boolean>;
  toolOverrides: Record<string, ToolOverride>;
  clients: Record<string, ClientPolicy>;
  blockedDomains: string[];
  enabledGroups: Record<string, boolean>;
  maxOutputChars: number;
  defaultTimeoutMs: number;
}

const ALL_RISK_ALLOWED: Record<RiskLevel, boolean> = {
  "read-only": true,
  reversible: true,
  "sensitive-read": true,
  consequential: true,
  restricted: true,
};

const NO_APPROVAL: Record<RiskLevel, boolean> = {
  "read-only": false,
  reversible: false,
  "sensitive-read": false,
  consequential: false,
  restricted: false,
};

/** The concrete permissions each level grants. */
export interface ModePreset {
  label: string;
  description: string;
  allowByRisk: Record<RiskLevel, boolean>;
  approvalByRisk: Record<RiskLevel, boolean>;
  approvalMode: ApprovalMode;
  readOnlyMode: boolean;
}

export const MODE_PRESETS: Record<PermissionMode, ModePreset> = {
  restricted: {
    label: "Restricted",
    description:
      "Read-only intelligence. The agent can read pages, the DOM, tabs and metadata, but it cannot click, type, navigate, capture the screen or reach personal data.",
    allowByRisk: {
      "read-only": true,
      reversible: false,
      "sensitive-read": false,
      consequential: false,
      restricted: false,
    },
    approvalByRisk: { ...NO_APPROVAL },
    approvalMode: "never",
    readOnlyMode: true,
  },
  default: {
    label: "Balanced",
    description:
      "Reading and reversible actions run freely. Consequential actions need a one-time approval from you.",
    allowByRisk: {
      "read-only": true,
      reversible: true,
      "sensitive-read": true,
      consequential: true,
      restricted: false,
    },
    approvalByRisk: {
      "read-only": false,
      reversible: false,
      "sensitive-read": true,
      consequential: true,
      restricted: true,
    },
    approvalMode: "risk",
    readOnlyMode: false,
  },
  unrestricted: {
    label: "Unrestricted",
    description:
      "Every tool runs with no confirmation step, including reads of your clipboard, history, bookmarks and downloads.",
    allowByRisk: { ...ALL_RISK_ALLOWED },
    approvalByRisk: { ...NO_APPROVAL },
    approvalMode: "never",
    readOnlyMode: false,
  },
};

/** Every optional permission group is enabled by default. */
const ALL_GROUPS_ENABLED: Record<string, boolean> = Object.fromEntries(
  Object.keys(OPTIONAL_PERMISSION_GROUPS).map((group) => [group, true]),
);

export const DEFAULT_POLICY: PolicyConfig = {
  version: 3,
  mode: "default",
  readOnlyMode: MODE_PRESETS.default.readOnlyMode,
  killSwitch: false,
  approvalMode: MODE_PRESETS.default.approvalMode,
  allowByRisk: { ...MODE_PRESETS.default.allowByRisk },
  approvalByRisk: { ...MODE_PRESETS.default.approvalByRisk },
  toolOverrides: {},
  clients: {},
  blockedDomains: [],
  enabledGroups: { ...ALL_GROUPS_ENABLED },
  maxOutputChars: 200_000,
  defaultTimeoutMs: 30_000,
};

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  risk: RiskLevel;
  reason: string;
}

export interface PolicyTarget {
  url?: string;
  domain?: string;
}

/**
 * Centralized authorization for every tool call. The same instance is used by
 * the extension executor and by the MCP server pre-checks, so a remote model
 * can never reach a tool that the local policy forbids.
 */
export class PolicyEngine {
  private config: PolicyConfig;

  /**
   * Monotonic policy version. The executor caches policy decisions keyed by
   * this version, so it MUST increase on every mutation below (setMode,
   * setConfig, setToolAllowed, resetOverrides, setGroupEnabled,
   * setReadOnlyMode, kill-switch engage/release, and client policy changes,
   * which arrive through setConfig). Construction does not count as a
   * mutation: a fresh engine starts at 0 and its first mutation moves it to 1.
   */
  private policyVersion = 0;

  /** Current policy version; see the field comment for the increment contract. */
  getVersion(): number {
    return this.policyVersion;
  }

  private bumpVersion(): void {
    this.policyVersion += 1;
  }

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = mergePolicy(DEFAULT_POLICY, config);
    // A level given at construction time has to materialize its gates, the
    // same way switching levels does later on. This uses the internal
    // applyMode so construction does not bump the version (see getVersion).
    if (config.mode && config.mode !== DEFAULT_POLICY.mode) {
      this.applyMode(config.mode);
      const { mode: _mode, ...rest } = config;
      this.config = mergePolicy(this.config, rest);
    }
  }

  getConfig(): PolicyConfig {
    return structuredClone(this.config);
  }

  /** Materialize a level's gates without bumping the version (construction / internal use). */
  private applyMode(mode: PermissionMode): void {
    const preset = MODE_PRESETS[mode];
    this.config.mode = mode;
    this.config.allowByRisk = { ...preset.allowByRisk };
    this.config.approvalByRisk = { ...preset.approvalByRisk };
    this.config.approvalMode = preset.approvalMode;
    this.config.readOnlyMode = preset.readOnlyMode;
  }

  /**
   * Apply a permission level. This rewrites the risk gates, the approval mode
   * and the read-only flag. Manual per-tool overrides are deliberately left in
   * place so a choice the user made explicitly survives a level change.
   */
  setMode(mode: PermissionMode): PolicyConfig {
    this.applyMode(mode);
    this.bumpVersion();
    return this.getConfig();
  }

  /** The active permission level. */
  getMode(): PermissionMode {
    return this.config.mode;
  }

  setConfig(config: Partial<PolicyConfig>): PolicyConfig {
    // One setConfig call is one mutation, so it bumps exactly once even when
    // it also changes the level. Client policy changes (clients patch) arrive
    // here and therefore bump the version too.
    if (config.mode && config.mode !== this.config.mode) {
      // Changing level re-materializes the gates, then the rest of the patch
      // is applied on top of the new preset.
      this.applyMode(config.mode);
      const { mode: _mode, ...rest } = config;
      this.config = mergePolicy(this.config, rest);
    } else {
      this.config = mergePolicy(this.config, config);
    }
    this.bumpVersion();
    return this.getConfig();
  }

  setToolAllowed(tool: string, allowed: boolean): void {
    this.config.toolOverrides[tool] = { ...this.config.toolOverrides[tool], allowed };
    this.bumpVersion();
  }

  /**
   * Drop every manual override and put the permission level back to its
   * preset. The level itself and the kill switch are left alone, so a reset
   * never quietly re-enables a stopped extension.
   */
  resetOverrides(): PolicyConfig {
    const mode = this.config.mode;
    const killSwitch = this.config.killSwitch;
    const blockedDomains = [...this.config.blockedDomains];
    this.config = mergePolicy(DEFAULT_POLICY, { mode, killSwitch, blockedDomains });
    this.applyMode(mode);
    this.config.killSwitch = killSwitch;
    this.bumpVersion();
    return this.getConfig();
  }

  setGroupEnabled(group: string, enabled: boolean): void {
    this.config.enabledGroups[group] = enabled;
    this.bumpVersion();
  }

  setReadOnlyMode(enabled: boolean): void {
    this.config.readOnlyMode = enabled;
    this.bumpVersion();
  }

  engageKillSwitch(): void {
    this.config.killSwitch = true;
    this.bumpVersion();
  }

  releaseKillSwitch(): void {
    this.config.killSwitch = false;
    this.bumpVersion();
  }

  isKillSwitchEngaged(): boolean {
    return this.config.killSwitch;
  }

  /** False when the policy is configured to run every tool without a confirmation step. */
  approvalEnforced(): boolean {
    return this.config.approvalMode !== "never";
  }

  /**
   * Evaluate whether a tool call is allowed. Approval is reported separately so
   * the caller can drive the approval flow before execution.
   *
   * Precedence, strongest first:
   *   kill switch -> restricted page -> blocked domain -> client policy ->
   *   explicit manual denial -> read-only gate -> risk gate -> allowed.
   *
   * An explicit manual allow bypasses the read-only and risk gates, so the user
   * can hand a single tool back to the agent in any level. It never bypasses
   * the kill switch or a client policy.
   */
  decide(tool: ToolDefinition, client: ClientIdentity, target: PolicyTarget = {}): PolicyDecision {
    const canonical = TOOL_SCHEMAS.find((t) => t.name === tool.name);
    if (!canonical) {
      return { risk: tool.risk, requiresApproval: false, allowed: false, reason: `Unknown tool "${tool.name}"` };
    }
    const risk = canonical.risk;
    const category = canonical.category;
    const base = { risk, requiresApproval: false, allowed: false } as PolicyDecision;

    if (this.config.killSwitch) {
      return { ...base, reason: "Emergency stop is engaged" };
    }

    const toolExists = TOOL_SCHEMAS.some((t) => t.name === tool.name);
    if (!toolExists) {
      return { ...base, reason: `Unknown tool "${tool.name}"` };
    }

    if (target.url && isRestrictedUrl(target.url)) {
      return { ...base, reason: "Target is a restricted browser page" };
    }
    const domain = target.domain ?? (() => {
      try { return target.url ? new URL(target.url).hostname.toLowerCase() : undefined; } catch { return undefined; }
    })();
    if (domain && this.config.blockedDomains.some((d) => {
      const blocked = d.toLowerCase();
      return domain === blocked || domain.endsWith(`.${blocked}`);
    })) {
      return { ...base, reason: `Domain "${domain}" is blocked by policy` };
    }

    const clientPolicy = this.config.clients[client.id] ?? {};

    // Client policy always wins over a manual per-tool override.
    if (clientPolicy.deniedTools?.includes(tool.name)) {
      return { ...base, reason: `Tool "${tool.name}" is denied for this client` };
    }
    if (clientPolicy.deniedCategories?.includes(category)) {
      return { ...base, reason: `Category "${tool.category}" is denied for this client` };
    }
    if (clientPolicy.allowedTools && !clientPolicy.allowedTools.includes(tool.name)) {
      return { ...base, reason: `Tool "${tool.name}" is not in this client's allowlist` };
    }
    if (clientPolicy.allowedCategories && !clientPolicy.allowedCategories.includes(category)) {
      return { ...base, reason: `Category "${tool.category}" is not in this client's allowlist` };
    }

    const override = this.config.toolOverrides[tool.name] ?? {};
    if (override.allowed === false) {
      return { ...base, reason: `Tool "${tool.name}" is disabled by policy` };
    }

    // A manual allow re-enables the tool in any level, but still respects the
    // client policy and the permission groups above.
    const explicitAllow = override.allowed === true;

    const clientReadOnly = clientPolicy.readOnly === true;
    const readOnly = this.config.readOnlyMode || clientReadOnly;
    if (!explicitAllow && readOnly && risk !== "read-only") {
      return { ...base, reason: "Read-only mode is enabled" };
    }

    if (risk === "restricted" && !this.config.allowByRisk.restricted && !explicitAllow) {
      return { ...base, reason: "Restricted tools are not available" };
    }

    const group = optionalGroupForTool(tool.name);
    if (group && !this.config.enabledGroups[group]) {
      return { ...base, reason: `Permission group "${group}" is not enabled` };
    }

    const allowed = explicitAllow ? true : this.config.allowByRisk[risk];
    if (!allowed) {
      return { ...base, reason: `Risk level "${risk}" is not allowed in the "${this.config.mode}" level; enable it explicitly` };
    }

    const requiresApproval =
      override.requiresApproval ?? (this.config.approvalMode === "never" ? false : this.config.approvalByRisk[risk]);
    return { allowed: true, requiresApproval, risk, reason: requiresApproval ? "Requires user approval" : "Allowed" };
  }

  /** True when the tool may run at all for this client (approval aside). */
  allows(tool: ToolDefinition, client: ClientIdentity): boolean {
    return this.decide(tool, client).allowed;
  }
}

function mergePolicy(base: PolicyConfig, patch: Partial<PolicyConfig>): PolicyConfig {
  const mode = patch.mode ?? base.mode;
  const preset = MODE_PRESETS[mode];
  const allowByRisk = { ...base.allowByRisk, ...patch.allowByRisk };
  const approvalByRisk = { ...base.approvalByRisk, ...patch.approvalByRisk };
  // Risk gates can only be tightened relative to the active level's preset:
  // a patch may not enable a risk tier the level disables, nor remove an
  // approval that the level requires, without changing the level itself.
  for (const risk of Object.keys(allowByRisk) as RiskLevel[]) {
    if (!preset.allowByRisk[risk]) allowByRisk[risk] = false;
    if (preset.approvalByRisk[risk]) approvalByRisk[risk] = true;
  }
  const approvalMode = patch.approvalMode ?? base.approvalMode;
  const readOnlyMode = patch.readOnlyMode ?? base.readOnlyMode;
  return {
    ...base,
    ...patch,
    mode,
    approvalMode,
    readOnlyMode,
    allowByRisk,
    approvalByRisk,
    toolOverrides: { ...base.toolOverrides, ...patch.toolOverrides },
    clients: { ...base.clients, ...patch.clients },
    enabledGroups: { ...base.enabledGroups, ...patch.enabledGroups },
    blockedDomains: patch.blockedDomains ?? base.blockedDomains,
  };
}
