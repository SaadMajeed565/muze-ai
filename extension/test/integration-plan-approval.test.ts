import { describe, expect, it } from "vitest";
import { ToolErrorException, type ClientIdentity } from "../libs/tool-contracts/index.js";
import { ApprovalBroker } from "../libs/security/approvals.js";
import { createTestRuntime } from "../libs/testing/index.js";

/**
 * Coordinator integration tests for the all-phases build:
 * - ApprovalBroker.markUsed burns an approved token exactly once.
 * - Executor planApproved (internal only, set by the TaskRunner's
 *   service-worker executeStep after verifying an active in-bounds
 *   plan approval) satisfies the approval gate, but never overrides
 *   a policy denial. planApproved is not a tool-input field and is
 *   never forwarded from an MCP call.
 */
const client: ClientIdentity = { id: "c1", name: "Client", transport: "native" };

describe("plan-approval integration", () => {
  it("markUsed burns an approved token exactly once", () => {
    const broker = new ApprovalBroker({ ttlMs: 1000, now: () => 1000, idFactory: () => "apv_1" });
    const record = broker.create({ tool: "tasks.approvePlan", risk: "reversible", summary: "approve plan", client, input: { taskId: "t1" } });
    expect(broker.markUsed(record.id)).toBe(false); // still pending
    broker.approve(record.id);
    expect(broker.markUsed(record.id)).toBe(true);
    expect(broker.markUsed(record.id)).toBe(false); // already used
    expect(broker.get(record.id)?.status).toBe("used");
  });

  it("planApproved satisfies the approval gate for an in-bounds step", async () => {
    const rt = createTestRuntime({
      policy: {
        approvalMode: "risk",
        allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
        enabledGroups: { clipboard: true },
      },
      context: { clipboard: "secret" },
    });
    await expect(
      rt.executor.execute({ tool: "clipboard.read", input: {}, client, ctx: rt.ctx }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const result = await rt.executor.execute({
      tool: "clipboard.read",
      input: {},
      client,
      ctx: rt.ctx,
      planApproved: true,
    });
    expect((result.result as { text: string }).text).toBe("secret");
  });

  it("planApproved never overrides a policy denial", async () => {
    const rt = createTestRuntime({
      policy: { allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: false, restricted: true } },
    });
    await expect(
      rt.executor.execute({ tool: "forms.submit", input: { formRef: "r1" }, client, ctx: rt.ctx, planApproved: true }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(ToolErrorException.is(new ToolErrorException("PERMISSION_DENIED", "x"))).toBe(true);
  });
});
