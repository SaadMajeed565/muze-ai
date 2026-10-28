import { AuditLog, ApprovalBroker, PolicyEngine, RateLimiter, type PolicyConfig } from "../security/index.js";
import { ToolExecutor, createToolRegistry, type RuntimeSnapshot } from "../browser-engine/index.js";
import type { ClientIdentity } from "../tool-contracts/index.js";
import { MockBrowserContext, type MockContextOptions } from "./mock-context.js";

export const TEST_CLIENT: ClientIdentity = { id: "client_test", name: "Test Client", transport: "native", version: "1.0.0" };

export interface TestRuntimeOptions {
  policy?: Partial<PolicyConfig>;
  context?: MockContextOptions;
  runtime?: Partial<RuntimeSnapshot>;
  rateLimit?: { capacity: number; refillPerSecond: number };
  now?: () => number;
  approvalTtlMs?: number;
}

export interface TestRuntime {
  registry: ReturnType<typeof createToolRegistry>;
  policy: PolicyEngine;
  approvals: ApprovalBroker;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  executor: ToolExecutor;
  ctx: MockBrowserContext;
  client: ClientIdentity;
}

/** Wire a full executor pipeline backed by the mock browser context. */
export function createTestRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const registry = createToolRegistry();
  const policy = new PolicyEngine(options.policy);
  const approvals = new ApprovalBroker({ ttlMs: options.approvalTtlMs ?? 120_000, now: options.now });
  const audit = new AuditLog({ now: options.now });
  // Intentional test-only looseness, documented: production wires the
  // limiter at capacity 120 / 20 per second (service worker), but the test
  // harness deliberately uses 1000/1000 so ordinary executor-pipeline tests
  // are not rate-limited by accident. Rate-limit behaviour itself is covered
  // directly in security-rateLimit.test.ts with explicit capacities, and any
  // test that needs production-like limits passes rateLimit explicitly.
  const rateLimiter = new RateLimiter({
    capacity: options.rateLimit?.capacity ?? 1000,
    refillPerSecond: options.rateLimit?.refillPerSecond ?? 1000,
    now: options.now,
  });
  const ctx = new MockBrowserContext(options.context);
  const executor = new ToolExecutor({ registry, policy, approvals, audit, rateLimiter, runtime: options.runtime });
  return { registry, policy, approvals, audit, rateLimiter, executor, ctx, client: TEST_CLIENT };
}
