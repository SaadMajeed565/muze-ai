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
  now?: () => number;
}

/** Token-bucket limiter keyed by an arbitrary string (client+tool). */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? (() => Date.now());
  }

  take(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
    this.buckets.set(key, bucket);
    return { allowed: false, retryAfterMs, remaining: Math.floor(bucket.tokens) };
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}
