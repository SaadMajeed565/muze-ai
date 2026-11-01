import type { RiskLevel, ToolDescriptor } from "./tools.js";
import type { ToolError } from "./errors.js";

export type ClientTransport = "native" | "remote";

export interface ClientIdentity {
  /** Stable, non-secret identifier for the client application. */
  id: string;
  /** Human-friendly name shown in approval prompts and audit logs. */
  name: string;
  version?: string;
  transport: ClientTransport;
}

export interface CallTargetHint {
  tabId?: number;
  url?: string;
  domain?: string;
}

export interface ApprovalRequestInfo {
  id: string;
  tool: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  target?: CallTargetHint;
  client: ClientIdentity;
  createdAt: number;
  expiresAt: number;
}

export interface ToolCallMessage {
  type: "tool.call";
  id: string;
  tool: string;
  input: unknown;
  clientOpId?: string;
  /** Verified remote caller identity supplied by the gateway (remote transport only). */
  client?: ClientIdentity;
  /** Pre-obtained approval token, if the client already requested approval. */
  approvalId?: string;
  /** When true, side-effecting tools validate and describe but do not mutate. */
  dryRun?: boolean;
}

/** One independent read in a batch. The host refuses anything not risked read-only. */
export interface ToolCallBatchItem {
  tool: string;
  input: unknown;
  clientOpId?: string;
  approvalId?: string;
  dryRun?: boolean;
}

export interface ToolCallBatchMessage {
  type: "tool.call.batch";
  id: string;
  calls: ToolCallBatchItem[];
  client?: ClientIdentity;
}

export interface ToolBatchItemResult {
  tool: string;
  ok: boolean;
  result?: unknown;
  dryRun?: boolean;
  durationMs?: number;
  error?: ToolError;
}

export interface ApprovalDecisionMessage {
  type: "approval.respond";
  id: string;
  approvalId: string;
  approved: boolean;
  /** Optional one-time scope allows; never persisted. */
  reason?: string;
}

export interface CancelMessage {
  type: "cancel";
  id: string;
  targetId: string;
}

/** Wait for the user to decide (in the extension dashboard) when the MCP client cannot elicit. */
export interface ApprovalWaitMessage {
  type: "approval.wait";
  id: string;
  approvalId: string;
  timeoutMs?: number;
}

export type BridgeClientMessage =
  | { type: "hello"; id: string; protocolVersion: string; client: ClientIdentity }
  | { type: "registry.list"; id: string }
  | { type: "approval.request"; id: string; tool: string; input: unknown; clientOpId?: string; client?: ClientIdentity }
  | ApprovalWaitMessage
  | ToolCallMessage
  | ToolCallBatchMessage
  | ApprovalDecisionMessage
  | CancelMessage
  | { type: "ping"; id: string };

export type BridgeHostMessage =
  | { type: "hello.ok"; id: string; protocolVersion: string; registryVersion: string; server: { name: string; version: string } }
  | { type: "hello.error"; id: string; error: ToolError }
  | { type: "registry.result"; id: string; tools: ToolDescriptor[] }
  | { type: "tool.result"; id: string; result: unknown; dryRun: boolean; durationMs: number }
  | { type: "tool.batch.result"; id: string; results: ToolBatchItemResult[] }
  | { type: "tool.error"; id: string; error: ToolError }
  | { type: "approval.requested"; id: string; approval: ApprovalRequestInfo }
  | { type: "approval.resolved"; id: string; approvalId: string; approved: boolean }
  | { type: "cancelled"; id: string; targetId: string }
  | { type: "event"; event: BridgeEvent }
  | { type: "pong"; id: string };

export type BridgeEvent =
  | { kind: "client.connected"; client: ClientIdentity }
  | { kind: "client.disconnected"; client: ClientIdentity }
  | { kind: "approval.pending"; approval: ApprovalRequestInfo }
  | { kind: "policy.changed" }
  | { kind: "audit" }
  | { kind: "kill-switch"; engaged: boolean }
  | {
      kind: "task.progress";
      taskId: string;
      status: string;
      stepIndex: number;
      totalSteps: number;
    };
