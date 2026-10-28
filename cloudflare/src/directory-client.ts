import type { GatewayEnv } from "./config.js";

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
