import type { GatewayEnv } from "./config.js";
import type { BrowsersDelta, BrowsersDeltaBrowser, BrowsersDeltaClient } from "../libs/tool-contracts/protocol.js";

const DIRECTORY_INSTANCE = "directory";

/** Call an action on the singleton DirectoryDO. */
export async function dirCall<T = Record<string, any>>(
  env: GatewayEnv,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T & { ok?: boolean; error?: string; status?: number }> {
  const id = env.DIRECTORY_DO.idFromName(DIRECTORY_INSTANCE);
  const stub = env.DIRECTORY_DO.get(id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await stub.fetch("https://directory/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    return (await response.json()) as T & { ok?: boolean; error?: string; status?: number };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a browsers.delta browser row from a DirectoryDO browser record.
 * Field-for-field the same shape listAccountBrowsers returns for a browser
 * (minus tabCount, which the delta type does not carry and the dashboard
 * overlays locally): names default exactly as the list does, and
 * isDefault is derived from the account's default session id.
 */
export function browsersDeltaBrowser(
  entry: Record<string, unknown>,
  defaultSessionId: string,
  opts: { connected: boolean; lastSeenAt?: number | null },
): BrowsersDeltaBrowser {
  return {
    sessionId: String(entry.sessionId ?? ""),
    name: typeof entry.name === "string" && entry.name ? entry.name : "Browser",
    browser: typeof entry.browser === "string" ? entry.browser : "",
    os: typeof entry.os === "string" ? entry.os : "",
    version: typeof entry.version === "string" ? entry.version : "",
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : null,
    lastSeenAt: opts.lastSeenAt !== undefined ? opts.lastSeenAt : typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : null,
    isDefault: String(entry.sessionId ?? "") === defaultSessionId,
    connected: opts.connected,
  };
}

/**
 * Build a browsers.delta client row from a DirectoryDO clientsForUser entry.
 * Same shape and same live-timestamp rule as listAccountBrowsers: live
 * transports carry connectedSince/lastActivityAt, non-live rows report
 * null for both and keep authorizedSince/lastRefreshedAt/expiresAt from
 * the token record. `liveMeta` is the SessionDO's in-memory sessionClients
 * entry (createdAt/lastActivityAt) for this client, when it is live.
 */
export function browsersDeltaClient(
  entry: Record<string, unknown>,
  live: boolean,
  liveMeta?: { createdAt: number; lastActivityAt: number },
): BrowsersDeltaClient {
  return {
    clientId: String(entry.clientId ?? ""),
    clientName: typeof entry.clientName === "string" && entry.clientName ? entry.clientName : String(entry.clientId ?? ""),
    scope: typeof entry.scope === "string" ? entry.scope : "",
    sessionId: String(entry.sessionId ?? ""),
    live,
    connectedSince: live && liveMeta ? Number(liveMeta.createdAt ?? 0) || null : null,
    lastActivityAt: live && liveMeta ? Number(liveMeta.lastActivityAt ?? 0) || null : null,
    authorizedSince: typeof entry.createdAt === "number" ? entry.createdAt : null,
    lastRefreshedAt: typeof entry.lastRefreshedAt === "number" ? entry.lastRefreshedAt : null,
    expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : null,
  };
}

/**
 * Fan a browsers.delta out to a list of browser sessions. Each target gets
 * exactly one POST to its SessionDO's internal /push-browsers-delta route,
 * which delivers the delta to that session's own bridge socket only — it
 * never re-broadcasts, so fan-out cannot loop. Per-session failures
 * (offline browser, slow DO, thrown fetch) are swallowed individually and
 * never fail the other pushes or the mutation that triggered the fan-out;
 * each attempt is bounded by a 4s race so one hung target cannot stall
 * the rest. Resolves only after every attempt has settled.
 */
export async function pushBrowsersDelta(env: GatewayEnv, sessionIds: string[], delta: BrowsersDelta): Promise<void> {
  const targets = [...new Set(sessionIds.filter(Boolean))];
  await Promise.allSettled(
    targets.map(async (sessionId) => {
      try {
        const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
        await Promise.race([
          stub.fetch("https://session/push-browsers-delta", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ delta }),
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
      } catch {
        // Swallowed per session: an offline target must not fail the fan-out.
      }
    }),
  );
}
