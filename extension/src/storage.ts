import { DEFAULT_POLICY, type PolicyConfig } from "../libs/security/index.js";

/**
 * Storage-key migration (v0.3.0): the internal prefix moved from "uabb" to
 * "muze". Every loader below reads the new "muze.*" key first and falls back
 * to the legacy "uabb.*" key; on first successful read or write the value is
 * copied to the new key and the legacy key is removed (best effort — a failed
 * cleanup never fails the read/write itself). Nothing is ever read from the
 * legacy key once the new key exists, so a downgrade cannot resurrect stale
 * state over newer state.
 */
export const POLICY_KEY = "muze.policy";
export const LEGACY_POLICY_KEY = "uabb.policy";
export const BRIDGE_KEY = "muze.bridge";
export const LEGACY_BRIDGE_KEY = "uabb.bridge";
export const OBSERVER_KEY = "muze.observer";
export const LEGACY_OBSERVER_KEY = "uabb.observer";
export const ONBOARDING_KEY = "muze.onboarding";
export const LEGACY_ONBOARDING_KEY = "uabb.onboarding";

/** The last wizard step the onboarding flow can land on. */
export const ONBOARDING_STEPS = 4;

declare const __MUZE_GATEWAY_URL__: string | undefined;

/**
 * Cloud gateway used by default. Production builds set `MUZE_GATEWAY_URL`
 * (see build.mjs); source builds fall back to the development worker.
 */
export const GATEWAY_URL =
  typeof __MUZE_GATEWAY_URL__ === "string" && __MUZE_GATEWAY_URL__
    ? __MUZE_GATEWAY_URL__
    : "https://muze-ai.saadmajeed-dev.workers.dev";

export interface BridgeSettings {
  gatewayEnabled: boolean;
  /** Email of the signed-in website account. */
  gatewayAccountEmail: string;
  /** The account/browser token, synced with the website. */
  gatewayToken: string;
  /** The gateway session id this token maps to (handy for display). */
  gatewaySessionId: string;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  gatewayEnabled: false,
  gatewayAccountEmail: "",
  gatewayToken: "",
  gatewaySessionId: "",
};

async function readStored<T>(key: string, legacyKey: string): Promise<{ value: T | undefined; fromLegacy: boolean }> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key] as T | undefined;
  if (value !== undefined) return { value, fromLegacy: false };
  const legacyStored = await chrome.storage.local.get(legacyKey);
  return { value: legacyStored[legacyKey] as T | undefined, fromLegacy: true };
}

async function migrateStored(key: string, legacyKey: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.local.set({ [key]: value });
    // `remove` may be absent in test doubles; its failure must not fail the
    // migration itself, and the new key already wins on every later read.
    await chrome.storage.local.remove?.([legacyKey]);
  } catch {
    // Best effort only: the value is already readable under the new key.
  }
}

async function writeStored(key: string, legacyKey: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
  try {
    await chrome.storage.local.remove?.([legacyKey]);
  } catch {
    // Legacy cleanup is best effort.
  }
}

/**
 * Load the persisted policy, preserving the user's gates verbatim.
 *
 * BREAKING CHANGE vs v0.2.0 (deliberate, security fix): the old loader
 * silently dropped `allowByRisk`, `approvalByRisk` and `enabledGroups` from
 * version-1 policies and forced version-1/2 policies to mode "unrestricted",
 * widening access on upgrade without the user ever choosing it. This loader
 * never does that. An older stored policy keeps its mode, its risk gates, its
 * approval gates and its permission groups exactly as stored; only the
 * version is bumped, and only fields that are entirely missing are filled
 * from the current defaults. A fresh install has nothing stored and falls
 * through to the defaults (the "default" level) via the policy engine.
 *
 * Note: the policy engine itself still clamps stored gates to the active
 * level's preset (see libs/security/policy.ts `mergePolicy`); that clamp can
 * only tighten, never widen, relative to the level.
 */
export async function loadPolicy(): Promise<Partial<PolicyConfig>> {
  const { value: config, fromLegacy } = await readStored<Partial<PolicyConfig>>(POLICY_KEY, LEGACY_POLICY_KEY);
  if (!config) return {};

  if ((config.version ?? 1) >= DEFAULT_POLICY.version) {
    if (fromLegacy) await migrateStored(POLICY_KEY, LEGACY_POLICY_KEY, config);
    return config;
  }

  const migrated: Partial<PolicyConfig> = { ...config, version: DEFAULT_POLICY.version };
  // Fill ONLY missing fields from current defaults; never overwrite a stored
  // gate, mode, or override with a default.
  for (const [field, defaultValue] of Object.entries(DEFAULT_POLICY) as [keyof PolicyConfig, unknown][]) {
    if (field === "version") continue;
    if (migrated[field] === undefined) (migrated as Record<string, unknown>)[field] = defaultValue;
  }
  await migrateStored(POLICY_KEY, LEGACY_POLICY_KEY, migrated);
  return migrated;
}

export async function savePolicy(config: PolicyConfig): Promise<void> {
  await writeStored(POLICY_KEY, LEGACY_POLICY_KEY, config);
}

export async function loadBridgeSettings(): Promise<BridgeSettings> {
  const { value, fromLegacy } = await readStored<Partial<BridgeSettings>>(BRIDGE_KEY, LEGACY_BRIDGE_KEY);
  const merged = { ...DEFAULT_BRIDGE_SETTINGS, ...(value ?? {}) };
  if (fromLegacy && value !== undefined) await migrateStored(BRIDGE_KEY, LEGACY_BRIDGE_KEY, merged);
  return merged;
}

export async function saveBridgeSettings(settings: Partial<BridgeSettings>): Promise<BridgeSettings> {
  const merged = { ...(await loadBridgeSettings()), ...settings };
  await writeStored(BRIDGE_KEY, LEGACY_BRIDGE_KEY, merged);
  return merged;
}

/**
 * The page observer keeps running in pages the user already had open, so its
 * on/off state has to survive a service worker restart. Otherwise the
 * dashboard would show the observer as off while it is still recording.
 */
export async function loadObserverState(): Promise<{ enabled: boolean }> {
  const { value, fromLegacy } = await readStored<{ enabled?: boolean }>(OBSERVER_KEY, LEGACY_OBSERVER_KEY);
  const state = { enabled: value?.enabled === true };
  if (fromLegacy && value !== undefined) await migrateStored(OBSERVER_KEY, LEGACY_OBSERVER_KEY, state);
  return state;
}

export async function saveObserverState(enabled: boolean): Promise<void> {
  await writeStored(OBSERVER_KEY, LEGACY_OBSERVER_KEY, { enabled });
}

/**
 * Progress through the first-run setup wizard.
 *
 * `completed` means the wizard should not open itself again, whether the user
 * walked it to the end or skipped it. `step` is the resume point: it is kept
 * when the user skips so Overview can offer "finish setup" instead of starting
 * over from the welcome screen.
 */
export interface OnboardingState {
  completed: boolean;
  step: number;
}

export const DEFAULT_ONBOARDING: OnboardingState = { completed: false, step: 1 };

export async function loadOnboarding(): Promise<OnboardingState> {
  const { value, fromLegacy } = await readStored<Partial<OnboardingState>>(ONBOARDING_KEY, LEGACY_ONBOARDING_KEY);
  if (!value) return { ...DEFAULT_ONBOARDING };
  const state = {
    completed: value.completed === true,
    step: clampStep(value.step ?? DEFAULT_ONBOARDING.step),
  };
  if (fromLegacy) await migrateStored(ONBOARDING_KEY, LEGACY_ONBOARDING_KEY, state);
  return state;
}

export async function saveOnboarding(patch: Partial<OnboardingState>): Promise<OnboardingState> {
  const merged = { ...(await loadOnboarding()), ...patch };
  if (patch.step !== undefined) merged.step = clampStep(patch.step);
  await writeStored(ONBOARDING_KEY, LEGACY_ONBOARDING_KEY, merged);
  return merged;
}

function clampStep(step: number): number {
  if (!Number.isFinite(step)) return DEFAULT_ONBOARDING.step;
  return Math.min(ONBOARDING_STEPS, Math.max(1, Math.round(step)));
}
