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
});
