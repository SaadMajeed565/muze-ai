import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Dashboard sender guard, exercised through the real service-worker
 * onMessage listener (not just the guard helpers): a stubbed chrome
 * captures the listener at import time, then tests invoke it with
 * properly-identified, undefined, and foreign senders.
 *
 * The stub is deliberately minimal but complete enough for module load
 * + initialize(): gateway disabled by default, so no network is dialled.
 */

const EXTENSION_ID = "test-extension-id-abcdefghijklmnop";

type Listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

let capturedListener: Listener | null = null;
const storageSets: Array<Record<string, unknown>> = [];
let sendMessageCalls = 0;
let guardHelpers: {
  CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES: ReadonlySet<string>;
  READ_ONLY_DASHBOARD_REQUEST_TYPES: ReadonlySet<string>;
  isConsequentialDashboardRequestType: (type: string) => boolean;
  isTrustedDashboardSender: (senderId: string | undefined, runtimeId: string | undefined) => boolean;
  isDashboardSenderAllowedForRequest: (type: string, senderId: string | undefined, runtimeId: string | undefined) => boolean;
} | null = null;

beforeAll(async () => {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      onMessage: {
        addListener: (listener: Listener) => {
          capturedListener = listener;
        },
      },
      onInstalled: { addListener: () => undefined },
      sendMessage: async () => {
        sendMessageCalls += 1;
        return undefined;
      },
    },
    alarms: {
      onAlarm: { addListener: () => undefined },
      create: () => undefined,
      clear: async () => undefined,
    },
    tabs: {
      onActivated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      query: async () => [],
    },
    action: {
      setBadgeText: () => undefined,
      setBadgeBackgroundColor: () => undefined,
    },
    sidePanel: { setPanelBehavior: async () => undefined },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
          storageSets.push(values);
        },
        remove: async () => undefined,
      },
    },
    offscreen: { hasDocument: async () => true },
  });
  // Dynamic import AFTER the stub: the module registers its listeners
  // and runs initialize() at import time.
  const sw = await import("../src/service-worker.js");
  guardHelpers = {
    CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES: sw.CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES,
    READ_ONLY_DASHBOARD_REQUEST_TYPES: sw.READ_ONLY_DASHBOARD_REQUEST_TYPES,
    isConsequentialDashboardRequestType: sw.isConsequentialDashboardRequestType,
    isTrustedDashboardSender: sw.isTrustedDashboardSender,
    isDashboardSenderAllowedForRequest: sw.isDashboardSenderAllowedForRequest,
  };
  // Let initialize() settle (storage reads, keepalive, gateway no-op).
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(capturedListener).not.toBeNull();
});

function invoke(message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = capturedListener as Listener;
    const returned = listener(message, sender, (response: unknown) => resolve(response));
    // Listeners that return false without responding close the channel
    // with no response; resolve as undefined so the test can assert it.
    if (returned === false) {
      setTimeout(() => resolve(undefined), 10);
    }
  });
}

describe("dashboard sender guard through the service-worker listener", () => {
  it("lets a properly-identified dashboard sender run a consequential route", async () => {
    const before = storageSets.length;
    const response = (await invoke({ type: "muze/policy/mode", mode: "restricted" }, { id: EXTENSION_ID })) as {
      ok: boolean;
      state?: { snapshot?: { mode?: string } };
    };
    expect(response.ok).toBe(true);
    expect(response.state?.snapshot?.mode).toBe("restricted");
    // The policy change actually persisted: the handler ran, not just the guard.
    expect(storageSets.length).toBeGreaterThan(before);
  });

  it("rejects an undefined-sender attempt on a consequential route before any state change", async () => {
    const before = storageSets.length;
    const response = (await invoke({ type: "muze/policy/mode", mode: "unrestricted" }, {})) as {
      ok: boolean;
      error?: string;
    };
    expect(response).toEqual({ ok: false, error: "untrusted_sender" });
    expect(storageSets.length).toBe(before);
    // And the previously-set mode is untouched: the rejection happened
    // before handleRequest, not merely before persistence.
    const state = (await invoke({ type: "muze/state" }, { id: EXTENSION_ID })) as {
      ok: boolean;
      state?: { snapshot?: { mode?: string } };
    };
    expect(state.state?.snapshot?.mode).toBe("restricted");
  });

  it("rejects a foreign sender id on a consequential route (pre-existing behaviour, kept)", async () => {
    const before = storageSets.length;
    const response = await invoke({ type: "muze/policy/mode", mode: "unrestricted" }, { id: "other-extension-id" });
    expect(response).toBeUndefined();
    expect(storageSets.length).toBe(before);
  });

  it("still serves a read-only route to an undefined sender", async () => {
    const response = (await invoke({ type: "muze/state" }, {})) as { ok: boolean };
    expect(response.ok).toBe(true);
  });

  it("guards the legacy spelling of a consequential route identically", async () => {
    const before = storageSets.length;
    const response = (await invoke({ type: "uabb/killswitch", engaged: true }, {})) as {
      ok: boolean;
      error?: string;
    };
    expect(response).toEqual({ ok: false, error: "untrusted_sender" });
    expect(storageSets.length).toBe(before);
  });

  it("lets a properly-identified sender use the legacy spelling", async () => {
    const response = (await invoke({ type: "uabb/state" }, { id: EXTENSION_ID })) as { ok: boolean };
    expect(response.ok).toBe(true);
  });
});

describe("dashboard route classification (guard helpers)", () => {
  it("partitions the full dashboard route set with no overlap and no gap", () => {
    const helpers = guardHelpers as NonNullable<typeof guardHelpers>;
    const consequential = helpers.CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES;
    const readOnly = helpers.READ_ONLY_DASHBOARD_REQUEST_TYPES;
    expect(consequential.size).toBe(29);
    expect(readOnly.size).toBe(10);
    expect([...consequential].filter((type) => readOnly.has(type))).toEqual([]);
    // 39 = every type in DashboardRequest (messages.ts). A future route
    // added to handleRequest without a classification here must update
    // one of these sets, by design: classification is a decision, not a default.
    expect(new Set([...consequential, ...readOnly]).size).toBe(39);
    expect([...consequential, ...readOnly].sort()).toEqual([
      "muze/activity.history",
      "muze/activity.list",
      "muze/approval/respond",
      "muze/approvals/cancel-for-client",
      "muze/audit",
      "muze/bridge/reconnect",
      "muze/bridge/settings",
      "muze/browsers/disconnect",
      "muze/browsers/list",
      "muze/browsers/refresh",
      "muze/browsers/remove",
      "muze/browsers/rename",
      "muze/browsers/set-default",
      "muze/files/attach",
      "muze/files/get",
      "muze/files/list",
      "muze/files/remove",
      "muze/gateway/delete-account",
      "muze/gateway/rotate",
      "muze/gateway/sign-in",
      "muze/gateway/sign-in-email",
      "muze/gateway/sign-out",
      "muze/gateway/sign-up-email",
      "muze/killswitch",
      "muze/mcp-sessions/revoke",
      "muze/onboarding/set",
      "muze/policy/group",
      "muze/policy/mode",
      "muze/policy/readonly",
      "muze/policy/reset",
      "muze/policy/tool",
      "muze/policy/update",
      "muze/state",
      "muze/tasks.approvePlan",
      "muze/tasks.cancel",
      "muze/tasks.get",
      "muze/tasks.list",
      "muze/tasks.pause",
      "muze/tasks.resume",
    ]);
  });

  it("requires a positively identified sender for every consequential route and none for read-only routes", () => {
    const helpers = guardHelpers as NonNullable<typeof guardHelpers>;
    for (const type of helpers.CONSEQUENTIAL_DASHBOARD_REQUEST_TYPES) {
      expect(helpers.isConsequentialDashboardRequestType(type)).toBe(true);
      expect(helpers.isDashboardSenderAllowedForRequest(type, EXTENSION_ID, EXTENSION_ID)).toBe(true);
      expect(helpers.isDashboardSenderAllowedForRequest(type, undefined, EXTENSION_ID)).toBe(false);
      expect(helpers.isDashboardSenderAllowedForRequest(type, "other-extension-id", EXTENSION_ID)).toBe(false);
      // Fail-closed when the runtime id itself is unavailable: equality
      // cannot be established, so a consequential route must not run.
      expect(helpers.isDashboardSenderAllowedForRequest(type, EXTENSION_ID, undefined)).toBe(false);
    }
    for (const type of helpers.READ_ONLY_DASHBOARD_REQUEST_TYPES) {
      expect(helpers.isConsequentialDashboardRequestType(type)).toBe(false);
      expect(helpers.isDashboardSenderAllowedForRequest(type, undefined, EXTENSION_ID)).toBe(true);
      expect(helpers.isDashboardSenderAllowedForRequest(type, EXTENSION_ID, EXTENSION_ID)).toBe(true);
    }
    expect(helpers.isTrustedDashboardSender(EXTENSION_ID, EXTENSION_ID)).toBe(true);
    expect(helpers.isTrustedDashboardSender(undefined, EXTENSION_ID)).toBe(false);
    expect(helpers.isTrustedDashboardSender(EXTENSION_ID, undefined)).toBe(false);
    expect(helpers.isTrustedDashboardSender("other-extension-id", EXTENSION_ID)).toBe(false);
  });
});
