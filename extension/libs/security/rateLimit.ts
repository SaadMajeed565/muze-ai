export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  capacity: number;
  refillPerSecond: number;
  /**
   * Maximum distinct keys held. Default 10_000: without a bound, a
   * long-lived limiter grows one bucket per caller key forever.
   */
  maxKeys?: number;
  now?: () => number;
}

/** Default cap on distinct buckets; see RateLimiterOptions.maxKeys. */
export const RATE_LIMITER_DEFAULT_MAX_KEYS = 10_000;

/**
 * Token-bucket limiter keyed by an arbitrary string (client+tool).
 *
 * Guards (previously absent, each a live footgun):
 * - capacity must be finite and > 0, refillPerSecond finite and >= 0;
 *   anything else is a configuration error and throws at construction
 *   instead of silently never allowing (or always allowing) traffic.
 * - refillPerSecond = 0 is a legitimate "burst bucket that never
 *   refills", so it is allowed — but a denied take then reports
 *   retryAfterMs = Infinity, meaning "never becomes available", rather
 *   than a finite number a caller would sleep on. Callers that need a
 *   real wait must use a positive refill rate.
 * - take() with cost > capacity can never succeed, and cost <= 0 or
 *   non-finite is meaningless, so both throw instead of returning a
 *   denial the caller would retry forever.
 * - bucket count is capped (default 10_000 keys); when a new key would
 *   exceed the cap, the oldest bucket is evicted. Evicting a live
 *   bucket only resets that key to a full bucket — a fail-open on one
 *   key under extreme key churn, chosen over unbounded memory growth.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new RangeError(`RateLimiter capacity must be finite and > 0, got ${options.capacity}`);
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond < 0) {
      throw new RangeError(`RateLimiter refillPerSecond must be finite and >= 0, got ${options.refillPerSecond}`);
    }
    if (
      options.maxKeys !== undefined &&
      (!Number.isFinite(options.maxKeys) || options.maxKeys <= 0)
    ) {
      throw new RangeError(`RateLimiter maxKeys must be finite and > 0, got ${options.maxKeys}`);
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.maxKeys = Math.floor(options.maxKeys ?? RATE_LIMITER_DEFAULT_MAX_KEYS);
    this.now = options.now ?? (() => Date.now());
  }

  take(key: string, cost = 1): RateLimitResult {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError(`RateLimiter cost must be finite and > 0, got ${cost}`);
    }
    if (cost > this.capacity) {
      throw new RangeError(`RateLimiter cost ${cost} exceeds capacity ${this.capacity} and can never succeed`);
    }
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest bucket (Map iteration order is insertion
        // order) so key churn cannot grow memory without bound.
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.capacity, updatedAt: now };
    }
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }

    const deficit = cost - bucket.tokens;
    // refillPerSecond = 0 means the bucket never refills: Infinity is the
    // honest answer (callers must not sleep on it), not a computed wait.
    const retryAfterMs =
      this.refillPerSecond > 0 ? Math.ceil((deficit / this.refillPerSecond) * 1000) : Number.POSITIVE_INFINITY;
    this.buckets.set(key, bucket);
    return { allowed: false, retryAfterMs, remaining: Math.floor(bucket.tokens) };
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}
