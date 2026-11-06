export const GATEWAY_NAME = "Universal Browser Tools Gateway";
export const GATEWAY_VERSION = "0.6.0";

export interface GatewayEnv {
  /** Per-browser-session Durable Object: holds the extension WebSocket + MCP bridge. */
  SESSION_DO: DurableObjectNamespace;
  /** Central auth/session registry Durable Object. */
  DIRECTORY_DO: DurableObjectNamespace;
  /** Durable fixed-window rate limiter, one object per key. */
  RATE_LIMIT_DO: DurableObjectNamespace;
  /** Optional human-readable deployment name shown in pairing UI. Declared
   * for completeness; no gateway code currently renders it. */
  GATEWAY_LABEL?: string;
  /**
   * Comma-separated Chrome extension IDs allowed to receive the browser sign-in
   * handoff. Required in production; unset means extension sign-in is disabled.
   */
  EXTENSION_IDS?: string;
  /**
   * Token served verbatim at `/.well-known/openai-apps-challenge` so a plugin
   * directory submission can verify this domain owns the MCP endpoint.
   */
  OPENAI_APPS_CHALLENGE?: string;
  /**
   * When truthy ("1"/"true"/"yes"/"on"), the MCP server advertises the full
   * tool registry instead of the curated core set. Read by mcp.ts via the
   * SessionDO environment (see session-do.ts buildTransport).
   */
  MCP_SHOW_ALL_TOOLS?: string;
}
