import { describe, expect, it } from "vitest";
import {
  isBlockedAttribute,
  isSensitiveAutocomplete,
  isSensitiveElement,
  isSensitiveFieldName,
  redactSecrets,
  redactUrl,
  REDACTED,
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_PHRASES,
  SENSITIVE_TOKENS,
} from "../libs/security/privacy.js";

describe("field level privacy", () => {
  it("recognises credential names in every casing", () => {
    for (const name of ["password", "Password", "userPassword", "user_password", "user-password", "PWD", "passwd"]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
  });

  it("recognises multi word credential names", () => {
    for (const name of ["card number", "Card Number", "cardNumber", "api key", "apiKey", "verification code"]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
  });

  it("leaves ordinary field names alone", () => {
    for (const name of ["email", "firstName", "search", "quantity", "country", "message"]) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });

  it("recognises credential autocomplete values", () => {
    expect(isSensitiveAutocomplete("current-password")).toBe(true);
    expect(isSensitiveAutocomplete("cc-number")).toBe(true);
    expect(isSensitiveAutocomplete("one-time-code")).toBe(true);
    expect(isSensitiveAutocomplete("email")).toBe(false);
    expect(isSensitiveAutocomplete(undefined)).toBe(false);
  });

  it("treats password and hidden inputs as credentials", () => {
    expect(isSensitiveElement({ tagName: "input", type: "password" })).toBe(true);
    expect(isSensitiveElement({ tagName: "input", type: "hidden" })).toBe(true);
  });

  it("uses the name, id, label and meta name to spot a credential", () => {
    expect(isSensitiveElement({ tagName: "input", name: "userPassword" })).toBe(true);
    expect(isSensitiveElement({ tagName: "input", id: "api-key" })).toBe(true);
    expect(isSensitiveElement({ tagName: "input", ariaLabel: "Card number" })).toBe(true);
    expect(isSensitiveElement({ tagName: "meta", metaName: "csrf-token" })).toBe(true);
  });

  it("does not flag an ordinary element", () => {
    expect(isSensitiveElement({ tagName: "input", name: "email", type: "email" })).toBe(false);
    expect(isSensitiveElement(undefined)).toBe(false);
  });

  it("pins the canonical lists every channel of isSensitiveElement draws on", () => {
    // privacy.ts is the single source of truth; the page agent carries a
    // narrower copy that must be kept in sync (coordinator follow-up: the
    // serialized agent cannot be imported into this test, so the cross-file
    // agreement check lives outside it). These assertions pin this side.
    for (const token of ["password", "token", "secret", "apikey", "cvv", "ssn", "pin", "card"]) {
      expect(SENSITIVE_TOKENS.has(token), token).toBe(true);
    }
    for (const phrase of ["credit card", "api key", "access token", "account number"]) {
      expect(SENSITIVE_PHRASES).toContain(phrase);
    }
    for (const value of ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"]) {
      expect(SENSITIVE_AUTOCOMPLETE.has(value), value).toBe(true);
    }
    // Every channel: type, autocomplete, meta name, name, id, aria-label.
    expect(isSensitiveElement({ type: "password" })).toBe(true);
    expect(isSensitiveElement({ type: "hidden" })).toBe(true);
    expect(isSensitiveElement({ autocomplete: "new-password" })).toBe(true);
    expect(isSensitiveElement({ metaName: "api-key" })).toBe(true);
    expect(isSensitiveElement({ name: "token" })).toBe(true);
    expect(isSensitiveElement({ id: "secret-key" })).toBe(true);
    expect(isSensitiveElement({ ariaLabel: "Social security number" })).toBe(true);
  });

  it("blocks attributes whose value is a live secret", () => {
    expect(isBlockedAttribute("value")).toBe(true);
    expect(isBlockedAttribute("srcdoc")).toBe(true);
    expect(isBlockedAttribute("nonce")).toBe(true);
    expect(isBlockedAttribute("href")).toBe(false);
  });
});

describe("text level privacy", () => {
  it("masks a key/value pair that names a credential", () => {
    expect(redactSecrets("api_key=abcd1234")).toBe(`api_key=${REDACTED}`);
    expect(redactSecrets("password: hunter2")).toBe(`password: ${REDACTED}`);
    expect(redactSecrets('token="abc12345"')).toBe(`token="${REDACTED}"`);
  });

  it("masks a bearer token and a jwt", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).toContain(REDACTED);
    expect(redactSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe(REDACTED);
  });

  it("masks a long hex or base64 blob", () => {
    expect(redactSecrets("hash: 0123456789abcdef0123456789abcdef")).toContain(REDACTED);
    expect(redactSecrets("blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdA")).toContain(REDACTED);
  });

  it("leaves ordinary prose alone", () => {
    const text = "The quick brown fox jumps over the lazy dog near the river bank.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("strips the query string and the fragment from a url", () => {
    expect(redactUrl("https://example.com/a/b?token=secret#frag")).toBe("https://example.com/a/b");
    expect(redactUrl("not a url?x=1")).toBe("not a url");
  });
});
