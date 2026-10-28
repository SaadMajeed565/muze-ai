import {
  ToolErrorException,
  toToolDescriptor,
  type ClientIdentity,
  type ToolDefinition,
  type ToolDescriptor,
} from "../tool-contracts/index.js";
import type { BrowserContext } from "./context.js";

export interface RuntimeSnapshot {
  toolCount: number;
  categories: string[];
  enabledGroups: Record<string, boolean>;
  readOnlyMode: boolean;
  killSwitch: boolean;
  bridgeStatus: "connected" | "disconnected";
  connectedClients: number;
  pendingApprovals: number;
  auditEvents: number;
  allowedTools: string[];
  deniedTools: string[];
}

export interface ToolExecutionContext {
  ctx: BrowserContext;
  client: ClientIdentity;
  /** Tab id resolved for the calling surface, when applicable. */
  resolvedTabId?: number;
  /** Approval token supplied by the gateway, when the call required one. */
  approvalId?: string;
  /** True when the executor consumed a valid approval for this exact call. */
  approvalValidated: boolean;
  signal: AbortSignal;
  runtime: RuntimeSnapshot;
  /** Invoke another registered tool through the full policy/approval pipeline. */
  invoke: <T = unknown>(tool: string, input: unknown, options?: { dryRun?: boolean }) => Promise<T>;
}

export type ToolHandler = (input: unknown, exec: ToolExecutionContext) => Promise<unknown>;

export interface RegisteredTool extends ToolDefinition<unknown, unknown> {
  handler: ToolHandler;
}

export function defineTool(tool: ToolDefinition, handler: ToolHandler): RegisteredTool {
  return { ...tool, handler };
}

/**
 * The central, discoverable tool registry. Every tool is registered exactly
 * once and every call path (MCP, dashboard, extension messaging) resolves tools
 * through this registry.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(tools: RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  require(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolErrorException("TOOL_NOT_FOUND", `Unknown tool "${name}"`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((tool) => toToolDescriptor(tool));
  }
}
