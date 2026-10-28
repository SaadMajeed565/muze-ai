/**
 * Controls the page observer.
 *
 * The observer itself is a MAIN world content script. The service worker
 * registers it, injects it into tabs that are already open, reads its state
 * and configures it. Everything happens through `chrome.scripting`, so no
 * messaging channel into the page is needed.
 */

import type { ObservedDialog, ObservedRequest, ObserverCapability, ObserverState } from "../libs/browser-engine/index.js";
import { loadObserverState, saveObserverState } from "./storage.js";

const OBSERVER_SCRIPT_ID = "muze-observer";
/** Legacy content-script id, unregistered on first register() so it cannot linger. */
const LEGACY_OBSERVER_SCRIPT_ID = "uabb-observer";
const OBSERVER_FILE = "observer.js";

interface RawObserverState {
  enabled: boolean;
  requests: ObservedRequest[];
  dialogs: ObservedDialog[];
  pendingRequests: number;
  defaultAnswer: "accept" | "dismiss";
  defaultText?: string;
  lastActivity: number;
}

/**
 * Reads the observer's state from the page. Runs in the MAIN world, so it
 * must not close over anything outside itself.
 *
 * NOTE: the page global is `__muzeObserver` (OBSERVER_GLOBAL_KEY in
 * libs/browser-engine/page/observer.ts, renamed together in 0.3.0).
 * The legacy `__uabbObserver` is checked as a fallback only, for pages
 * already open from a pre-0.3.0 install.
 */
function readObserverState(): RawObserverState | null {
  const w = window as unknown as Record<string, unknown>;
  const state = (w.__muzeObserver ?? w.__uabbObserver) as RawObserverState | undefined;
  return state ?? null;
}

/**
 * Configures the observer inside the page. Runs in the MAIN world, so it must
 * not close over anything outside itself.
 */
function configureObserver(config: { enabled: boolean; response?: "accept" | "dismiss"; text?: string }): boolean {
  const w = window as unknown as Record<string, unknown>;
  // Same page global as readObserverState; see the rename note there.
  const state = (w.__muzeObserver ?? w.__uabbObserver) as RawObserverState | undefined;
  if (!state) return false;
  state.enabled = config.enabled;
  if (config.response) state.defaultAnswer = config.response;
  if (config.text !== undefined) state.defaultText = config.text;
  return true;
}

export class ChromeObserverCapability implements ObserverCapability {
  private enabled = false;

  /**
   * Restores the persisted on/off state. The observer keeps running in pages
   * that were already open, so the flag has to be re-applied after a service
   * worker restart instead of silently reporting the wrong state.
   *
   * Disabling is explicit: a persisted `enabled: false` is now actively
   * pushed into already-open tabs (configureAll(false)), not just left as
   * "do nothing on restart" — otherwise a page that was observed before the
   * restart would keep answering dialogs with the old sticky default while
   * the dashboard reported the observer as off.
   */
  async restore(): Promise<{ enabled: boolean }> {
    const { enabled } = await loadObserverState();
    this.enabled = enabled;
    if (enabled) {
      await this.register();
    }
    await this.configureAll(enabled);
    return { enabled };
  }

  async setEnabled(enabled: boolean, tabId?: number): Promise<{ enabled: boolean; tabs: number }> {
    this.enabled = enabled;
    await saveObserverState(enabled);
    if (enabled) await this.register();
    else await this.unregister();

    const tabs = await this.tabsToTouch(tabId);
    let touched = 0;
    for (const id of tabs) {
      try {
        if (enabled) {
          // The script only installs itself once, so re-injecting is safe.
          await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: [OBSERVER_FILE], world: "MAIN" });
          await this.configure(id, { enabled: true });
        } else {
          await this.configure(id, { enabled: false });
        }
        touched += 1;
      } catch {
        // A tab that cannot be scripted (chrome:// page, sandboxed frame) is
        // simply skipped.
      }
    }
    return { enabled, tabs: touched };
  }

  async read(tabId: number): Promise<ObserverState> {
    const state = await this.readState(tabId);
    if (!state) {
      return { attached: false, requests: [], dialogs: [], pendingRequests: 0, defaultAnswer: "dismiss" };
    }
    return {
      attached: true,
      requests: state.requests ?? [],
      dialogs: state.dialogs ?? [],
      pendingRequests: state.pendingRequests ?? 0,
      defaultAnswer: state.defaultAnswer ?? "dismiss",
    };
  }

  /**
   * Set the tab's dialog answer.
   *
   * STICKY, not per-dialog: the page observer has no per-dialog queue. This
   * call sets the tab's default answer, which then applies to EVERY dialog
   * the page opens from now on — it is not an acknowledgement of one
   * specific dialog, even when a dialogId is supplied (the id is echoed
   * back for correlation only, and the default id is literally "sticky").
   * Callers must present it that way in any UI-facing summary; presenting
   * it as "dialog X was answered" would misdescribe what happened.
   */
  async respond(input: { tabId: number; dialogId?: string; response: "accept" | "dismiss"; text?: string }): Promise<{ dialogId: string; response: string }> {
    const applied = await this.configure(input.tabId, { enabled: true, response: input.response, text: input.text });
    if (!applied) {
      throw new Error("The page observer is not attached to this tab");
    }
    // "sticky" is the honest label: no dialogId was answered individually.
    // Even with a dialogId, the effect is the sticky default (see above).
    return { dialogId: input.dialogId ?? "sticky", response: `sticky:${input.response}` };
  }

  /** True when the observer is currently switched on. */
  isEnabled(): boolean {
    return this.enabled;
  }

  private async register(): Promise<void> {
    // Drop a legacy "uabb-observer" registration from a pre-0.3.0 install
    // before registering the new id, so the old script cannot keep running
    // alongside the new one.
    const legacy = await chrome.scripting.getRegisteredContentScripts({ ids: [LEGACY_OBSERVER_SCRIPT_ID] });
    if (legacy.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [LEGACY_OBSERVER_SCRIPT_ID] }).catch(() => undefined);
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [OBSERVER_SCRIPT_ID] });
    if (existing.length > 0) return;
    await chrome.scripting.registerContentScripts([
      {
        id: OBSERVER_SCRIPT_ID,
        matches: ["<all_urls>"],
        js: [OBSERVER_FILE],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
  }

  private async unregister(): Promise<void> {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [OBSERVER_SCRIPT_ID, LEGACY_OBSERVER_SCRIPT_ID] });
    if (existing.length === 0) return;
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  }

  /** Applies the enabled flag to every tab that is currently open. */
  private async configureAll(enabled: boolean): Promise<void> {
    for (const id of await this.tabsToTouch()) {
      try {
        if (enabled) {
          await chrome.scripting.executeScript({
            target: { tabId: id, allFrames: true },
            files: [OBSERVER_FILE],
            world: "MAIN",
          });
        }
        await this.configure(id, { enabled });
      } catch {
        // Tabs that cannot be scripted are skipped.
      }
    }
  }

  private async tabsToTouch(tabId?: number): Promise<number[]> {
    if (typeof tabId === "number") return [tabId];
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => t.id).filter((id): id is number => typeof id === "number");
  }

  private async readState(tabId: number): Promise<RawObserverState | null> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: readObserverState,
      });
      const first = results[0] as { result?: RawObserverState | null } | undefined;
      return first?.result ?? null;
    } catch {
      return null;
    }
  }

  private async configure(tabId: number, config: { enabled: boolean; response?: "accept" | "dismiss"; text?: string }): Promise<boolean> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: configureObserver,
        args: [config],
      });
      return results.some((r) => (r as { result?: boolean }).result === true);
    } catch {
      return false;
    }
  }
}
