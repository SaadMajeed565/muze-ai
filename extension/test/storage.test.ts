import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../libs/security/index.js";
import {
  BRIDGE_KEY,
  LEGACY_BRIDGE_KEY,
  LEGACY_OBSERVER_KEY,
  LEGACY_ONBOARDING_KEY,
  LEGACY_POLICY_KEY,
  ONBOARDING_STEPS,
  POLICY_KEY,
  loadBridgeSettings,
  loadObserverState,
  loadOnboarding,
  loadPolicy,
  saveBridgeSettings,
  saveObserverState,
  saveOnboarding,
} from "../src/storage.js";

type Store = Record<string, unknown>;

let store: Store;

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Store) => Object.assign(store, items),
        remove: async (keys: string[]) => {
          for (const key of keys) delete store[key];
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPolicy", () => {
  it("returns the current defaults when nothing is stored", async () => {
    const policy = await loadPolicy();
    expect(policy.allowByRisk).toBeUndefined();
    expect(policy.approvalByRisk).toBeUndefined();
    expect(policy.enabledGroups).toBeUndefined();
  });

  it("preserves the restrictive gates written by policy version 1 (no silent widening)", async () => {
    store[LEGACY_POLICY_KEY] = {
      version: 1,
      readOnlyMode: false,
      killSwitch: false,
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": false, consequential: false, restricted: false },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true },
      enabledGroups: {},
      blockedDomains: ["bank.com"],
    };

    const policy = await loadPolicy();
    // BREAKING CHANGE vs v0.2.0, deliberate: gates are kept verbatim, not dropped.
    expect(policy.allowByRisk).toEqual({ "read-only": true, reversible: true, "sensitive-read": false, consequential: false, restricted: false });
    expect(policy.approvalByRisk).toEqual({ "read-only": false, reversible: false, "sensitive-read": true, consequential: true, restricted: true });
    expect(policy.enabledGroups).toEqual({});
    expect(policy.version).toBe(DEFAULT_POLICY.version);
    expect(policy.blockedDomains).toEqual(["bank.com"]);
    // ...and the value is migrated to the new key, legacy key removed.
    expect(store[POLICY_KEY]).toEqual(policy);
    expect(store[LEGACY_POLICY_KEY]).toBeUndefined();
  });

  it("keeps a policy stored under the current version untouched", async () => {
    store[POLICY_KEY] = {
      version: DEFAULT_POLICY.version,
      mode: "default",
      allowByRisk: { "read-only": true, reversible: true, "sensitive-read": true, consequential: true, restricted: true },
      approvalByRisk: { "read-only": false, reversible: false, "sensitive-read": false, consequential: false, restricted: false },
      enabledGroups: { clipboard: true },
    };

    const policy = await loadPolicy();
    expect(policy.approvalByRisk?.["sensitive-read"]).toBe(false);
    expect(policy.enabledGroups).toEqual({ clipboard: true });
    expect(policy.mode).toBe("default");
  });

  it("does NOT migrate an older install to the unrestricted level", async () => {
    store[POLICY_KEY] = { version: 2, readOnlyMode: false, killSwitch: false };

    const policy = await loadPolicy();
    expect(policy.version).toBe(DEFAULT_POLICY.version);
    // The old loader forced "unrestricted" here. The new loader only fills
    // fields that are entirely missing from the current defaults — so a
    // mode-less old policy lands on the default level, never unrestricted.
    expect(policy.mode).toBe("default");
    expect(policy.maxOutputChars).toBe(DEFAULT_POLICY.maxOutputChars);
  });

  it("prefers the new key over the legacy key when both exist", async () => {
    store[POLICY_KEY] = { version: DEFAULT_POLICY.version, mode: "restricted" };
    store[LEGACY_POLICY_KEY] = { version: DEFAULT_POLICY.version, mode: "unrestricted" };
    expect((await loadPolicy()).mode).toBe("restricted");
  });
});

describe("storage key migration (muze.* / uabb.*)", () => {
  it("migrates bridge settings from the legacy key on read", async () => {
    store[LEGACY_BRIDGE_KEY] = { gatewayEnabled: true, gatewayAccountEmail: "a@b.c", gatewayToken: "tok", gatewaySessionId: "s1" };
    const settings = await loadBridgeSettings();
    expect(settings.gatewayToken).toBe("tok");
    expect(store[BRIDGE_KEY]).toEqual(settings);
    expect(store[LEGACY_BRIDGE_KEY]).toBeUndefined();
  });

  it("migrates observer and onboarding state from legacy keys", async () => {
    store[LEGACY_OBSERVER_KEY] = { enabled: true };
    store[LEGACY_ONBOARDING_KEY] = { completed: true, step: 3 };
    expect((await loadObserverState()).enabled).toBe(true);
    expect(await loadOnboarding()).toEqual({ completed: true, step: 3 });
    expect(store[LEGACY_OBSERVER_KEY]).toBeUndefined();
    expect(store[LEGACY_ONBOARDING_KEY]).toBeUndefined();
  });

  it("writes bridge settings to the new key only", async () => {
    store[LEGACY_BRIDGE_KEY] = { gatewayToken: "old" };
    const settings = await saveBridgeSettings({ gatewayToken: "new" });
    expect(settings.gatewayToken).toBe("new");
    expect((store[BRIDGE_KEY] as { gatewayToken?: string } | undefined)?.gatewayToken).toBe("new");
    expect(store[LEGACY_BRIDGE_KEY]).toBeUndefined();
  });
});

describe("observer state", () => {
  it("is off when nothing is stored", async () => {
    expect((await loadObserverState()).enabled).toBe(false);
  });

  it("survives a service worker restart", async () => {
    await saveObserverState(true);
    expect((await loadObserverState()).enabled).toBe(true);
    await saveObserverState(false);
    expect((await loadObserverState()).enabled).toBe(false);
  });
});

describe("onboarding state", () => {
  it("starts unfinished on the welcome step", async () => {
    expect(await loadOnboarding()).toEqual({ completed: false, step: 1 });
  });

  it("records progress through the wizard", async () => {
    await saveOnboarding({ step: 3 });
    expect(await loadOnboarding()).toEqual({ completed: false, step: 3 });
  });

  it("keeps the resume point when the wizard is skipped", async () => {
    await saveOnboarding({ step: 2 });
    await saveOnboarding({ completed: true });
    expect(await loadOnboarding()).toEqual({ completed: true, step: 2 });
  });

  it("clamps a step stored outside the wizard range", async () => {
    await saveOnboarding({ step: 99 });
    expect((await loadOnboarding()).step).toBe(ONBOARDING_STEPS);

    await saveOnboarding({ step: -4 });
    expect((await loadOnboarding()).step).toBe(1);
  });

  it("clamps a non-finite legacy step while keeping completion", async () => {
    // Separate test: the new key wins over legacy by design, so a legacy-only
    // read needs a fresh store (beforeEach) with no new-key write first.
    store["uabb.onboarding"] = { completed: true, step: Number.NaN };
    expect(await loadOnboarding()).toEqual({ completed: true, step: 1 });
  });
});
