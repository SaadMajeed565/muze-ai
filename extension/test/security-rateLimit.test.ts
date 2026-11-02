import { describe, expect, it } from "vitest";
import { RateLimiter } from "../libs/security/rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to capacity then rejects", () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0, now: () => 0 });
    expect(limiter.take("k").allowed).toBe(true);
    expect(limiter.take("k").allowed).toBe(true);
    const blocked = limiter.take("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
    expect(limiter.take("k").allowed).toBe(true);
    expect(limiter.take("k").allowed).toBe(false);
    now += 1000;
    expect(limiter.take("k").allowed).toBe(true);
  });

  it("isolates keys", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("b").allowed).toBe(true);
  });

  it("rejects invalid configuration and impossible costs instead of failing silently", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ capacity: -1, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: -1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ capacity: Number.NaN, refillPerSecond: 1 })).toThrow(RangeError);
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => 0 });
    expect(() => limiter.take("k", 3)).toThrow(RangeError);
    expect(() => limiter.take("k", 0)).toThrow(RangeError);
  });

  it("reports Infinity (never) for a never-refilling bucket, not a finite wait", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 });
    expect(limiter.take("k").allowed).toBe(true);
    const blocked = limiter.take("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("caps bucket count by evicting the oldest bucket", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0, maxKeys: 2, now: () => 0 });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("b").allowed).toBe(true);
    // A third key evicts the oldest ("a"), which then starts full again.
    expect(limiter.take("c").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(true);
  });
});
