import { json } from "./util.js";

interface Bucket {
  count: number;
  resetAt: number;
}

interface LimitRequest {
  max: number;
  windowMs: number;
}

/**
 * One Durable Object instance per rate-limit key (IP + route). Keeping the
 * counter in storage makes the fixed window shared across Worker isolates and
 * colo restarts instead of resetting with the isolate.
 */
export class RateLimitDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const { max, windowMs } = (await request.json()) as LimitRequest;
    if (!Number.isFinite(max) || !Number.isFinite(windowMs) || max <= 0 || windowMs <= 0) {
      return json({ error: "invalid_limit" }, 400);
    }

    const now = Date.now();
    const bucket = await this.state.storage.transaction<Bucket>(async (txn) => {
      const existing = await txn.get<Bucket>("bucket");
      const next =
        !existing || existing.resetAt <= now
          ? { count: 1, resetAt: now + windowMs }
          : { count: existing.count + 1, resetAt: existing.resetAt };
      await txn.put("bucket", next);
      return next;
    });

    return json({
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterMs: bucket.count <= max ? 0 : Math.max(0, bucket.resetAt - now),
    });
  }
}
