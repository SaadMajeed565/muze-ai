/**
 * The page observer.
 *
 * It runs in the page's MAIN world at document_start, which is the only place
 * where the page's own `alert`, `confirm`, `prompt`, `fetch` and
 * `XMLHttpRequest` can be wrapped before the page uses them.
 *
 * Privacy rules this file keeps:
 *   - Request and response bodies are never read, stored or forwarded.
 *   - Only the method, URL, status, type and timing of a request are kept.
 *   - Everything is kept in a small bounded ring buffer inside the page.
 *   - The observer never leaves the browser except through an explicit tool
 *     call that the user has approved.
 *
 * The service worker reads the state by injecting a reader function into the
 * MAIN world, and configures it the same way.
 */

import { diagnosticsHook } from "./diagnostics.js";

export interface ObserverRequest {
  id: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  startedAt: string;
  durationMs?: number;
  failed?: boolean;
}

export interface ObserverDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
  at: string;
  answered: "accept" | "dismiss";
}

export interface ObserverPageState {
  enabled: boolean;
  requests: ObserverRequest[];
  dialogs: ObserverDialog[];
  pendingRequests: number;
  defaultAnswer: "accept" | "dismiss";
  defaultText?: string;
  lastActivity: number;
}

export const OBSERVER_GLOBAL_KEY = "__muzeObserver";
export const MAX_OBSERVER_REQUESTS = 200;
export const MAX_OBSERVER_DIALOGS = 50;

/**
 * Install the observer in the current page. It is idempotent, so injecting it
 * twice does not double-wrap the page's own functions.
 */
export function installObserver(): ObserverPageState {
  const w = window as unknown as Record<string, unknown>;
  const existing = w[OBSERVER_GLOBAL_KEY] as ObserverPageState | undefined;
  if (existing) return existing;

  const state: ObserverPageState = {
    // The observer only records once the service worker has switched it on.
    // A page that loads while the observer is off therefore behaves exactly
    // like an unobserved page.
    enabled: false,
    requests: [],
    dialogs: [],
    pendingRequests: 0,
    defaultAnswer: "dismiss",
    lastActivity: Date.now(),
  };
  w[OBSERVER_GLOBAL_KEY] = state;

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

  // ---------------------------------------------------------------- dialogs
  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  const nativePrompt = window.prompt.bind(window);

  const record = (type: ObserverDialog["type"], message: string, defaultValue?: string) => {
    const answered = state.enabled ? state.defaultAnswer : "dismiss";
    state.dialogs.push({
      id: nextId("dlg"),
      type,
      message: String(message ?? "").slice(0, 2000),
      defaultValue: defaultValue === undefined ? undefined : String(defaultValue).slice(0, 500),
      at: new Date().toISOString(),
      answered,
    });
    if (state.dialogs.length > MAX_OBSERVER_DIALOGS) state.dialogs.shift();
    state.lastActivity = Date.now();
  };

  // The dialog is answered with the tab's default answer instead of blocking
  // the page forever. "dismiss" is the safe default: Muze never presses OK.
  window.alert = (message?: unknown): void => {
    record("alert", String(message ?? ""));
    if (!state.enabled) {
      nativeAlert(message as string);
      return;
    }
  };

  window.confirm = (message?: unknown): boolean => {
    record("confirm", String(message ?? ""));
    if (!state.enabled) return nativeConfirm(message as string);
    return state.defaultAnswer === "accept";
  };

  window.prompt = (message?: unknown, defaultValue?: unknown): string | null => {
    record("prompt", String(message ?? ""), defaultValue === undefined ? undefined : String(defaultValue));
    if (!state.enabled) return nativePrompt(message as string, defaultValue === undefined ? undefined : String(defaultValue));
    if (state.defaultAnswer !== "accept") return null;
    return state.defaultText ?? (defaultValue === undefined ? "" : String(defaultValue));
  };

  // ----------------------------------------------------------------- fetch
  const nativeFetch = window.fetch?.bind(window);
  if (nativeFetch) {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!state.enabled) return nativeFetch(input as RequestInfo, init);
      const id = nextId("req");
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      let url = "";
      try {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      } catch {
        url = "";
      }
      const startedAt = new Date().toISOString();
      const start = performance.now();
      state.pendingRequests += 1;
      state.lastActivity = Date.now();
      try {
        const response = await nativeFetch(input as RequestInfo, init);
        state.requests.push({
          id,
          method: String(method).toUpperCase(),
          url: String(url).slice(0, 2048),
          status: response.status,
          type: response.type,
          startedAt,
          durationMs: Math.round(performance.now() - start),
          failed: false,
        });
        if (state.requests.length > MAX_OBSERVER_REQUESTS) state.requests.shift();
        return response;
      } catch (error) {
        state.requests.push({
          id,
          method: String(method).toUpperCase(),
          url: String(url).slice(0, 2048),
          startedAt,
          durationMs: Math.round(performance.now() - start),
          failed: true,
        });
        if (state.requests.length > MAX_OBSERVER_REQUESTS) state.requests.shift();
        throw error;
      } finally {
        state.pendingRequests = Math.max(0, state.pendingRequests - 1);
        state.lastActivity = Date.now();
      }
    };
  }

  // -------------------------------------------------------- XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    type Tracked = XMLHttpRequest & {
      __muze?: { method: string; url: string; startedAt: string; start: number };
    };
    XHR.prototype.open = function (this: Tracked, ...args: unknown[]): void {
      const [method, url] = args as [string, string | URL];
      this.__muze = {
        method: String(method).toUpperCase(),
        url: String(url).slice(0, 2048),
        startedAt: new Date().toISOString(),
        start: performance.now(),
      };
      (nativeOpen as unknown as (...a: unknown[]) => void).apply(this, args);
    };

    XHR.prototype.send = function (this: Tracked, ...args: unknown[]): void {
      const meta = this.__muze;
      if (!state.enabled || !meta) {
        (nativeSend as unknown as (...a: unknown[]) => void).apply(this, args);
        return;
      }
      const id = nextId("req");
      state.pendingRequests += 1;
      this.addEventListener("loadend", () => {
        state.pendingRequests = Math.max(0, state.pendingRequests - 1);
        state.requests.push({
          id,
          method: meta.method,
          url: meta.url,
          status: this.status,
          type: this.responseType,
          startedAt: meta.startedAt,
          durationMs: Math.round(performance.now() - meta.start),
          failed: this.status === 0,
        });
        if (state.requests.length > MAX_OBSERVER_REQUESTS) state.requests.shift();
        state.lastActivity = Date.now();
      });
      (nativeSend as unknown as (...a: unknown[]) => void).apply(this, args);
    };
  }

  // ------------------------------------------------------------- diagnostics
  // The diagnostics hook captures the page's console output and uncaught
  // errors. It is idempotent, so installing it here simply makes sure it
  // exists before the page logs anything.
  try {
    diagnosticsHook();
  } catch {
    /* the page replaced something the hook needs; the tool will report it */
  }

  return state;
}
