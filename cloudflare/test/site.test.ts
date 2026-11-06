import { describe, expect, test } from "vitest";
import { loginRedirect, parseBrowserInfo, safeNext } from "../src/site.js";

describe("site helpers", () => {
  test("safeNext allows same-site relative paths and rejects the rest", () => {
    expect(safeNext("/account")).toBe("/account");
    expect(safeNext("/login?next=/account")).toBe("/login?next=/account");
    expect(safeNext("https://evil.example/account")).toBe("/account");
    expect(safeNext("//evil.example/account")).toBe("/account");
    expect(safeNext("")).toBe("/account");
    expect(safeNext(null)).toBe("/account");
    expect(safeNext(undefined)).toBe("/account");
  });

  test("parseBrowserInfo keeps only the known browser fields, capped", () => {
    expect(
      parseBrowserInfo(
        JSON.stringify({ name: "Work", browser: "Chrome", os: "macOS", version: "140", extra: "drop" }),
      ),
    ).toEqual({ name: "Work", browser: "Chrome", os: "macOS", version: "140" });
    expect(parseBrowserInfo("not json")).toEqual({});
    expect(parseBrowserInfo(null)).toEqual({});
    expect(parseBrowserInfo("x".repeat(513))).toEqual({});
    expect(parseBrowserInfo(JSON.stringify({ name: "  " }))).toEqual({});
    expect(parseBrowserInfo(JSON.stringify({ name: 42 }))).toEqual({});
  });

  test("loginRedirect points at the login page with the destination", () => {
    const response = loginRedirect("/account");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2Faccount");
  });
});
