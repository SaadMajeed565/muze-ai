import type { AuditEvent, PermissionMode, PolicyConfig } from "../libs/security/index.js";
import type { ApprovalRequestInfo, ClientIdentity, ToolDescriptor } from "../libs/tool-contracts/index.js";
import type { ActivityRow } from "../libs/activity.js";
import type { BridgeSettings, OnboardingState } from "./storage.js";
import type { TaskView } from "./task-dashboard.js";

export interface DashboardSnapshot {
  toolCount: number;
  categories: string[];
  /** The active permission level. */
  mode: PermissionMode;
  enabledGroups: Record<string, boolean>;
  readOnlyMode: boolean;
  killSwitch: boolean;
  bridgeConnected: boolean;
  bridgeStatus: "connected" | "disconnected";
  connectedClients: number;
  pendingApprovals: number;
  auditEvents: number;
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * Bridge settings as the dashboard is allowed to see them. The full device
 * token and session id are NEVER sent to the dashboard (see GatewayInfo):
 * this view carries only the on/off flag and the account email.
 */
export interface DashboardBridgeSettings {
  gatewayEnabled: boolean;
  gatewayAccountEmail: string;
}

export interface DashboardState {
  snapshot: DashboardSnapshot;
  policy: PolicyConfig;
  approvals: ApprovalRequestInfo[];
  clients: ClientIdentity[];
  settings: DashboardBridgeSettings;
  tools: ToolDescriptor[];
  gateway: GatewayInfo;
  onboarding: OnboardingState;
}

export interface GatewayInfo {
  enabled: boolean;
  url: string;
  mcpUrl: string;
  signedIn: boolean;
  email: string;
  /**
   * Masked session id only (bullet mask + last 4 characters). No device
   * token value, masked or otherwise, is ever sent to the dashboard:
   * the token stays inside the service worker and is only used for
   * bridge authentication. There is no dashboard route that reveals it.
   */
  sessionIdMasked: string;
  connected: boolean;
  /** The stored token was rejected and must be replaced by signing in again. */
  authRequired: boolean;
}

/**
 * Dashboard -> service-worker requests, canonical "muze/*" form (v0.3.0).
 * The service worker accepts the legacy "uabb/*" spelling of every one of
 * these and normalises it to the canonical form before dispatch, so older
 * dashboard builds keep working; the dashboard itself only ever emits
 * "muze/*". See `normalizeDashboardRequest` in service-worker.ts.
 */
export type DashboardRequest =
  | { type: "muze/state" }
  | { type: "muze/audit"; limit?: number }
  | { type: "muze/policy/update"; patch: Partial<PolicyConfig> }
  | { type: "muze/policy/mode"; mode: PermissionMode }
  | { type: "muze/policy/tool"; tool: string; allowed: boolean }
  | { type: "muze/policy/group"; group: string; enabled: boolean }
  | { type: "muze/policy/reset" }
  | { type: "muze/policy/readonly"; enabled: boolean }
  | { type: "muze/killswitch"; engaged: boolean }
  | { type: "muze/approval/respond"; approvalId: string; approved: boolean; reason?: string }
  | { type: "muze/approvals/cancel-for-client"; clientId: string }
  | { type: "muze/bridge/settings"; patch: Partial<BridgeSettings> }
  | { type: "muze/bridge/reconnect" }
  | { type: "muze/gateway/sign-in" }
  | { type: "muze/gateway/sign-in-email"; email: string; password: string }
  | { type: "muze/gateway/sign-up-email"; email: string; password: string }
  | { type: "muze/gateway/delete-account" }
  | { type: "muze/gateway/sign-out" }
  | { type: "muze/gateway/rotate" }
  | { type: "muze/onboarding/set"; patch: Partial<OnboardingState> }
  | { type: "muze/files/attach"; file: { name: string; mimeType: string; dataBase64: string } }
  | { type: "muze/files/list" }
  | { type: "muze/files/get"; id: string }
  | { type: "muze/files/remove"; id: string }
  | { type: "muze/tasks.list" }
  | { type: "muze/tasks.get"; taskId: string }
  | { type: "muze/tasks.pause"; taskId: string; reason?: string }
  | { type: "muze/tasks.resume"; taskId: string }
  | { type: "muze/tasks.cancel"; taskId: string }
  | { type: "muze/tasks.approvePlan"; taskId: string; bounds?: unknown }
  | { type: "muze/activity.list" }
  | { type: "muze/browsers/list" }
  | { type: "muze/browsers/refresh" }
  | { type: "muze/browsers/set-default"; sessionId: string }
  | { type: "muze/browsers/rename"; sessionId: string; name: string }
  | { type: "muze/browsers/disconnect"; sessionId: string }
  | { type: "muze/browsers/remove"; sessionId: string }
  | { type: "muze/mcp-sessions/revoke"; clientId: string; sessionId?: string };

/** One browser row for the dashboard. Never carries a device token. */
export interface DashboardBrowser {
  sessionId: string;
  name: string;
  browser: string;
  os: string;
  version: string;
  createdAt: number | null;
  lastSeenAt: number | null;
  isDefault: boolean;
  connected: boolean;
  /** Tab count when connected and known; null means unknown, never a guess. */
  tabCount: number | null;
  /** True when this row is the browser running this dashboard. */
  isLocal?: boolean;
}

/** One MCP client row for the dashboard. No tokens, no transport ids. */
export interface DashboardMcpClient {
  clientId: string;
  clientName: string;
  scope: string;
  sessionId: string;
  live: boolean;
  connectedSince: number | null;
  lastActivityAt: number | null;
  authorizedSince: number | null;
  lastRefreshedAt: number | null;
  expiresAt: number | null;
}

export interface BrowsersDashboard {
  browsers: DashboardBrowser[];
  defaultSessionId: string;
  currentSessionId?: string;
  mcpClients: DashboardMcpClient[];
}

/** Legacy "uabb/*" spelling of a dashboard request, accepted inbound only. */
export type LegacyDashboardRequestType = DashboardRequest["type"] extends `muze/${infer Rest}` ? `uabb/${Rest}` : never;

export interface DashboardResponse {
  ok: boolean;
  error?: string;
  state?: DashboardState;
  audit?: AuditEvent[];
  data?: unknown;
  /** Task progress views, present ONLY in response to "muze/tasks.*". Sanitised views only, never step inputs. */
  tasks?: TaskView[];
  task?: TaskView;
  /** Persisted live-activity rows, present ONLY in response to "muze/activity.list". Tool-name-only summaries, never inputs/outputs. */
  activity?: ActivityRow[];
  /** Present ONLY in response to "muze/browsers/list". */
  browsers?: BrowsersDashboard;
  /**
   * Present on browsers list/refresh responses. `browsersStale` is true
   * when the cached dashboard is served while the last full refresh
   * failed; `browsersCachedAt` is when the served cache was written.
   * No UI marker is attached to these fields (see the parent's
   * follow-up); they are exposed so the flag is accurate.
   */
  browsersStale?: boolean;
  browsersCachedAt?: number;
}

export const OFFSCREEN_TARGET = "muze-offscreen";
/** Legacy offscreen target, accepted inbound by the offscreen document only. */
export const LEGACY_OFFSCREEN_TARGET = "uabb-offscreen";
