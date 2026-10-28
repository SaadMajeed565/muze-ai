/**
 * Phase 3 session-eviction pinning: pure eviction-choice helper tests.
 * The helper is what both eviction loops in SessionDO call, so these
 * tests pin down the rule without driving 32 MCP sessions through the
 * DO: pinned clients' sessions are skipped, the bound is never broken
 * (all-pinned still evicts the oldest), and unpinned behaviour is
 * identical to the pre-pinning oldest-first rule.
 */
import { describe, expect, test } from "vitest";
import { chooseEvictionCandidate } from "../src/session-do.js";

describe("chooseEvictionCandidate (session pinning)", () => {
  test("evicts the oldest session when nothing is pinned", () => {
    expect(chooseEvictionCandidate(["s1", "s2", "s3"], new Map(), new Set())).toBe("s1");
  });

  test("skips sessions whose client owns a running task", () => {
    const bySession = new Map([
      ["s1", "client-pinned"],
      ["s2", "client-free"],
      ["s3", "client-pinned"],
    ]);
    expect(chooseEvictionCandidate(["s1", "s2", "s3"], bySession, new Set(["client-pinned"]))).toBe("s2");
  });

  test("skips sessions with an unknown client (fail-open for the bound, not for the task)", () => {
    // A session with no recorded client cannot be attributed to a
    // pinned task owner, so it is evictable like any unpinned session.
    const bySession = new Map<string, string>([["s2", "client-free"]]);
    expect(chooseEvictionCandidate(["s1", "s2"], bySession, new Set(["client-pinned"]))).toBe("s1");
  });

  test("still evicts the oldest when every session is pinned, so the cap is never broken", () => {
    const bySession = new Map([
      ["s1", "client-a"],
      ["s2", "client-b"],
    ]);
    expect(chooseEvictionCandidate(["s1", "s2"], bySession, new Set(["client-a", "client-b"]))).toBe("s1");
  });

  test("returns undefined when there is nothing to evict", () => {
    expect(chooseEvictionCandidate([], new Map(), new Set())).toBeUndefined();
  });
});
