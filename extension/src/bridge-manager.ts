import type { BridgeClientMessage, BridgeEvent, BridgeHostMessage, ClientIdentity, ToolDescriptor } from "../libs/tool-contracts/index.js";
import type { ApprovalBroker, PolicyEngine } from "../libs/security/index.js";
import type { BrowserContext, ToolExecutor, ToolRegistry } from "../libs/browser-engine/index.js";
import { HostProtocolHandler, type BridgeTransport, type TaskRunnerPort } from "./host-protocol.js";
import type { PolicySnapshot } from "../libs/tasks/index.js";
import { GatewaySocketTransport } from "./transports.js";

export interface BridgeManagerDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  executor: ToolExecutor;
  getContext: () => BrowserContext;
  server: { name: string; version: string };
  onEvent?: (event: BridgeEvent) => void;
  onConnectionsChanged?: () => void;
  onAuthFailure?: (reason: string) => void;
  legacyTools?: boolean;
  /** Phase 0 task runner, wired by the service worker; absent = tasks.* fail with "task engine not wired". */
  tasks?: TaskRunnerPort;
  getBrowserSessionId?: () => string | undefined;
  getTaskPolicySnapshot?: () => PolicySnapshot;
}

interface Connection {
  id: string;
  transport: BridgeTransport;
  handler: HostProtocolHandler;
}

let counter = 0;

/**
 * Owns the bridge connection to the cloud gateway. All remote models are routed
 * through the same executor and policy/approval store, so every caller is
 * governed by identical rules.
 */
export class BridgeManager {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly deps: BridgeManagerDeps) {}

  connectGateway(url: string, token: string): void {
    this.disposeAll();
    const id = `gateway_${++counter}`;
    const transport = new GatewaySocketTransport(url, token, {
      onMessage: (message) => this.dispatch(id, message),
      onConnect: () => this.deps.onConnectionsChanged?.(),
      // The transport reconnects on its own, so the connection must stay
      // registered. Dropping it here would strand the socket: reconnection would
      // succeed but the manager would still report "disconnected" and drop every
      // inbound frame (including the gateway's `hello`).
      onDisconnect: () => {
        this.connections.get(id)?.handler.dispose();
        this.deps.onConnectionsChanged?.();
      },
      onAuthFailure: (reason) => this.deps.onAuthFailure?.(reason),
    });
    this.register({ id, transport });
    transport.connect();
  }

  isConnected(): boolean {
    return [...this.connections.values()].some((connection) => isTransportConnected(connection.transport));
  }

  clientCount(): number {
    return this.connections.size;
  }

  clients(): ClientIdentity[] {
    return [...this.connections.values()].map((connection) => connection.handler.getClient());
  }

  descriptors(): ToolDescriptor[] {
    const first = [...this.connections.values()].find((connection) => isTransportConnected(connection.transport));
    return first ? first.handler.visibleDescriptors() : this.deps.registry.descriptors();
  }

  broadcast(message: BridgeHostMessage): void {
    for (const connection of this.connections.values()) {
      if (isTransportConnected(connection.transport)) connection.transport.post(message);
    }
  }

  disposeAll(): void {
    for (const connection of this.connections.values()) {
      connection.handler.dispose();
      if ("dispose" in connection.transport) (connection.transport as { dispose: () => void }).dispose();
    }
    this.connections.clear();
  }

  private register(connection: { id: string; transport: BridgeTransport }): void {
    const handler = new HostProtocolHandler({
      registry: this.deps.registry,
      executor: this.deps.executor,
      policy: this.deps.policy,
      approvals: this.deps.approvals,
      transport: connection.transport,
      getContext: this.deps.getContext,
      server: this.deps.server,
      legacyTools: this.deps.legacyTools,
      onEvent: (event) => this.deps.onEvent?.(event),
      ...(this.deps.tasks ? { tasks: this.deps.tasks } : {}),
      ...(this.deps.getBrowserSessionId ? { getBrowserSessionId: this.deps.getBrowserSessionId } : {}),
      ...(this.deps.getTaskPolicySnapshot ? { getTaskPolicySnapshot: this.deps.getTaskPolicySnapshot } : {}),
    });
    this.connections.set(connection.id, { ...connection, handler });
    this.deps.onConnectionsChanged?.();
  }

  private dispatch(id: string, message: BridgeClientMessage): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    if (message.type === "hello") this.deps.onEvent?.({ kind: "client.connected", client: message.client });
    void connection.handler.handle(message);
  }

}

function isTransportConnected(transport: BridgeTransport): boolean {
  return "isConnected" in transport && typeof (transport as { isConnected: () => boolean }).isConnected === "function"
    ? (transport as { isConnected: () => boolean }).isConnected()
    : true;
}
