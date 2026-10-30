import type { PermissionMode } from "../libs/security/index.js";
import type { DashboardResponse } from "../src/messages.js";
import type { ToolDescriptor } from "../libs/tool-contracts/index.js";

export async function sendRequest(request: unknown): Promise<DashboardResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as DashboardResponse | undefined;
    return response ?? { ok: false, error: "The extension did not respond" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Names of the inline SVG icons in `components/Icon.tsx`. */
export type IconName =
  | "home"
  | "shield"
  | "grid"
  | "pulse"
  | "check"
  | "close"
  | "copy"
  | "eye"
  | "eye-off"
  | "search"
  | "refresh"
  | "alert"
  | "arrow-left"
  | "arrow-right"
  | "chevron-right"
  | "chevron-left"
  | "link"
  | "user"
  | "lock"
  | "external"
  | "sliders"
  | "clock"
  | "power"
  | "key"
  | "file"
  | "logo";

export type TabId = "overview" | "permissions" | "tools" | "files" | "activity" | "tasks" | "browsers";

export interface TabDefinition {
  id: TabId;
  label: string;
  icon: IconName;
}

export const TABS: TabDefinition[] = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "permissions", label: "Permissions", icon: "shield" },
  { id: "tools", label: "Tools", icon: "grid" },
  { id: "files", label: "Files", icon: "file" },
  { id: "activity", label: "Activity", icon: "pulse" },
  { id: "tasks", label: "Tasks", icon: "clock" },
  { id: "browsers", label: "Browsers", icon: "link" },
];

export function isTabId(value: unknown): value is TabId {
  return typeof value === "string" && TABS.some((tab) => tab.id === value);
}

export const ONBOARDING_STEP_COUNT = 4;

export interface OnboardingStepDefinition {
  id: string;
  title: string;
  caption: string;
}

export const ONBOARDING_STEPS: OnboardingStepDefinition[] = [
  { id: "welcome", title: "Welcome", caption: "What Muze AI can and cannot do" },
  { id: "level", title: "Permission level", caption: "How much the agent may do" },
  { id: "connect", title: "Connect browser", caption: "Link this browser to your account" },
  { id: "client", title: "Connect your client", caption: "Point Claude at this browser" },
];

export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 1;
  return Math.min(ONBOARDING_STEP_COUNT, Math.max(1, Math.round(step)));
}

export interface Progress {
  current: number;
  total: number;
  percent: number;
}

export function onboardingProgress(step: number): Progress {
  const current = clampStep(step);
  return {
    current,
    total: ONBOARDING_STEP_COUNT,
    percent: Math.round((current / ONBOARDING_STEP_COUNT) * 100),
  };
}

export interface SetupItem {
  id: "level" | "account" | "client";
  label: string;
  done: boolean;
}

export interface SetupInput {
  signedIn: boolean;
  connectedClients: number;
  onboardingStep: number;
}

export function setupChecklist(input: SetupInput): SetupItem[] {
  return [
    { id: "level", label: "Choose a permission level", done: input.onboardingStep >= 2 },
    { id: "account", label: "Connect your Muze account", done: input.signedIn },
    { id: "client", label: "Add the MCP endpoint to your AI client", done: input.connectedClients > 0 },
  ];
}

export function setupRemaining(input: SetupInput): number {
  return setupChecklist(input).filter((item) => !item.done).length;
}

/**
 * Show all but the last four characters of a token, so the value stays
 * recognisable in a support conversation without being usable as a credential.
 */
export function maskToken(token: string): string {
  const value = token.trim();
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${"•".repeat(8)}${value.slice(-4)}`;
}

export function formatRelativeTime(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatCountdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds <= 0) return "expiring";
  if (seconds < 60) return `expires in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `expires in ${minutes}m`;
}

export const RISK_ORDER = ["restricted", "consequential", "sensitive-read", "reversible", "read-only"] as const;

export const RISK_LABEL: Record<string, string> = {
  "read-only": "read-only",
  reversible: "reversible",
  "sensitive-read": "sensitive read",
  consequential: "consequential",
  restricted: "restricted",
};

export interface ToolFilter {
  query: string;
  category: string | null;
  risk: string | null;
  onlyOverrides: boolean;
}

export const EMPTY_TOOL_FILTER: ToolFilter = { query: "", category: null, risk: null, onlyOverrides: false };

export function toolCategories(tools: ToolDescriptor[]): string[] {
  return [...new Set(tools.map((tool) => tool.category))].sort();
}

export function toolRisks(tools: ToolDescriptor[]): string[] {
  const seen = new Set(tools.map((tool) => tool.risk));
  return RISK_ORDER.filter((risk) => seen.has(risk));
}

export function filterTools(
  tools: ToolDescriptor[],
  filter: ToolFilter,
  overrides: Record<string, { allowed?: boolean }>,
): ToolDescriptor[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter((tool) => {
    if (filter.category && tool.category !== filter.category) return false;
    if (filter.risk && tool.risk !== filter.risk) return false;
    if (filter.onlyOverrides && overrides[tool.name] === undefined) return false;
    if (words.length === 0) return true;
    const haystack = `${tool.name} ${tool.title} ${tool.description} ${tool.category} ${(tool.tags ?? []).join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function groupTools(tools: ToolDescriptor[]): [string, ToolDescriptor[]][] {
  const byCategory = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const bucket = byCategory.get(tool.category);
    if (bucket) bucket.push(tool);
    else byCategory.set(tool.category, [tool]);
  }
  for (const bucket of byCategory.values()) {
    bucket.sort((a, b) => {
      const risk = RISK_ORDER.indexOf(a.risk as (typeof RISK_ORDER)[number]) - RISK_ORDER.indexOf(b.risk as (typeof RISK_ORDER)[number]);
      if (risk !== 0) return risk;
      return a.name.localeCompare(b.name);
    });
  }
  return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export type Appearance = "system" | "light" | "dark";

/** Dashboard appearance key (v0.3.0 prefix); legacy key is a read fallback. */
export const APPEARANCE_KEY = "muze.appearance";
export const LEGACY_APPEARANCE_KEY = "uabb.appearance";

export function readAppearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export interface ModeOption {
  id: PermissionMode;
  label: string;
  summary: string;
  detail: string[];
}

export const MODE_OPTIONS: ModeOption[] = [
  {
    id: "restricted",
    label: "Restricted",
    summary: "The agent reads, nothing else.",
    detail: ["Read pages, DOM and tab metadata", "No clicks, typing or navigation", "No personal data"],
  },
  {
    id: "default",
    label: "Balanced",
    summary: "Reading and reversible actions run; sensitive work asks first.",
    detail: ["Reading and reversible actions run freely", "Sensitive reads and consequential actions ask once", "Recommended"],
  },
  {
    id: "unrestricted",
    label: "Unrestricted",
    summary: "Everything runs without a confirmation step.",
    detail: ["Every tool runs without approval", "Includes personal data reads", "Only on machines you trust"],
  },
];
