import { TOOL_SCHEMAS, ToolErrorException } from "../tool-contracts/index.js";
import { taskTools } from "../tool-contracts/schemas/tasks.js";
import { ToolRegistry, defineTool, type RegisteredTool } from "./registry.js";
import { tabsToolHandlers } from "./tools/tabs.js";
import { pageToolHandlers } from "./tools/page.js";
import { interactToolHandlers } from "./tools/interact.js";
import { systemToolHandlers } from "./tools/system.js";
import { dataToolHandlers } from "./tools/data.js";
import { workflowToolHandlers } from "./tools/workflows.js";
import { unifiedToolHandlers } from "./tools/unified.js";

/**
 * Task tools are runner-owned, not executor-owned: host dispatch
 * intercepts tasks.* before the executor and routes them to the task
 * runner, which executes each step through the executor itself. The
 * factory still needs exactly one handler per declared schema, so
 * tasks.* get a stub handler that throws UNSUPPORTED. A direct
 * executor call to tasks.* therefore fails cleanly instead of
 * silently executing a step, bypassing the runner's checkpoint /
 * idempotency / policy re-checks, or inventing approval. This stub is
 * never reached on the bridge path (host dispatch intercepts first)
 * or on the gateway path (gateway forwards to the bridge).
 */
export const taskToolHandlers: RegisteredTool[] = taskTools.map((tool) =>
  defineTool(tool, async () => {
    throw new ToolErrorException(
      "UNSUPPORTED",
      "tasks.* must be routed through the task runner via host dispatch, not executed directly",
    );
  }),
);

export const ALL_TOOL_HANDLERS: RegisteredTool[] = [
  ...tabsToolHandlers,
  ...pageToolHandlers,
  ...interactToolHandlers,
  ...systemToolHandlers,
  ...dataToolHandlers,
  ...workflowToolHandlers,
  ...unifiedToolHandlers,
  ...taskToolHandlers,
];

/**
 * Build the complete registry and verify that every declared schema has exactly
 * one handler and vice-versa. A mismatch throws at startup so the extension can
 * never silently expose a tool with no implementation.
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry(ALL_TOOL_HANDLERS);
  const registered = new Set(registry.names());
  const declared = new Set(TOOL_SCHEMAS.map((t) => t.name));

  const missingHandlers = [...declared].filter((name) => !registered.has(name));
  const orphanHandlers = [...registered].filter((name) => !declared.has(name));

  if (missingHandlers.length > 0) {
    throw new Error(`Tools declared with no handler: ${missingHandlers.join(", ")}`);
  }
  if (orphanHandlers.length > 0) {
    throw new Error(`Handlers registered with no schema: ${orphanHandlers.join(", ")}`);
  }
  return registry;
}
