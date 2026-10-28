import type { AuditEvent, PermissionMode, PolicyConfig } from "../libs/security/index.js";
import type { ApprovalRequestInfo, ClientIdentity, ToolDescriptor } from "../libs/tool-contracts/index.js";
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
   * Masked display forms only (bullet mask + last 4 characters, same
   * algorithm as the dashboard's `maskToken`). The full token and session id
   * are never included in dashboard state; use the audited
   * "muze/gateway/token" request for an explicit reveal.
   */
  tokenMasked: string;
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
  | { type: "muze/gateway/sign-out" }
  | { type: "muze/gateway/rotate" }
  | {
      type: "muze/gateway/token";
      /**
       * Explicit reveal request. The service worker returns the full token
       * ONLY for this request, and audits it. Masked display is the default
       * everywhere else; this exists for advanced users who need to paste a
       * token manually, not as the primary MCP-client flow (which is now
       * sign-in-and-authorise via the MCP URL).
       */
    }
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
  | { type: "muze/tasks.approvePlan"; taskId: string; bounds?: unknown };

/** Legacy "uabb/*" spelling of a dashboard request, accepted inbound only. */
export type LegacyDashboardRequestType = DashboardRequest["type"] extends `muze/${infer Rest}` ? `uabb/${Rest}` : never;

export interface DashboardResponse {
  ok: boolean;
  error?: string;
  state?: DashboardState;
  audit?: AuditEvent[];
  data?: unknown;
  /** Full device token, present ONLY in response to "muze/gateway/token". */
  token?: string;
  /** Task progress views, present ONLY in response to "muze/tasks.*". Sanitised views only, never step inputs. */
  tasks?: TaskView[];
  task?: TaskView;
}

export const OFFSCREEN_TARGET = "muze-offscreen";
/** Legacy offscreen target, accepted inbound by the offscreen document only. */
export const LEGACY_OFFSCREEN_TARGET = "uabb-offscreen";
