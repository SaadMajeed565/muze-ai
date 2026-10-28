/**
 * Privacy guards applied to anything that leaves the browser.
 *
 * Two separate concerns live here:
 *
 *  1. Field level - is this form control holding a credential? Decided from the
 *     element's own attributes, so the value is never even read.
 *  2. Text level - does this string *look* like a credential? Used for text the
 *     page rendered itself, where the originating field is unknown.
 *
 * The page agent cannot import this module (it is serialized and injected), so
 * the agent reports the attributes it saw and the tool handlers make the call
 * here.
 *
 * CANONICAL LIST — KEEP IN SYNC: this file is the single source of truth for
 * sensitive-field detection (SENSITIVE_TOKENS, SENSITIVE_PHRASES,
 * SENSITIVE_AUTOCOMPLETE, and the type=password/hidden rule in
 * isSensitiveElement). The page agent carries its own narrower regex copy of
 * these lists for its in-page fill guard; that copy is NOT this file and must
 * be updated whenever these lists change, or the agent will fill fields this
 * module would refuse. A test asserting the two copies agree cannot import
 * the serialized agent, so that cross-check is a coordinator follow-up (see
 * the section report); the tests here pin the canonical lists themselves.
 */

/** Single tokens that unambiguously name a credential. Exported (read-only view) so tests and handlers pin the canonical list. */
export const SENSITIVE_TOKENS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "passcode",
  "secret",
  "credential",
  "credentials",
  "token",
  "otp",
  "cvv",
  "cvc",
  "csc",
  "cvv2",
  "cvc2",
  "ssn",
  "sin",
  "pin",
  "pincode",
  "iban",
  "swift",
  "bic",
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "sessionid",
  "secretkey",
  "privatekey",
  "card",
]);

/** Multi-word phrases that name a credential even when a token alone is not enough. Exported so tests pin the canonical list. */
export const SENSITIVE_PHRASES: readonly string[] = [
  "credit card",
  "debit card",
  "card number",
  "card no",
  "one time code",
  "verification code",
  "security code",
  "auth code",
  "otp code",
  "pass code",
  "api key",
  "api secret",
  "access token",
  "refresh token",
  "auth token",
  "session id",
  "social security",
  "routing number",
  "sort code",
  "account number",
  "account no",
  "bank code",
  "security token",
  "secret token",
];

/** `autocomplete` values that mark a credential field. Exported so tests pin the canonical list. */
export const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-name",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "transaction-password",
]);

/** Attribute names whose *value* is a live secret rather than page metadata. */
const BLOCKED_ATTRIBUTES = new Set(["value", "srcdoc", "nonce", "defaultvalue"]);

/**
 * Split an attribute value into comparable words. camelCase is expanded first
 * so "userPassword" and "user_password" and "user-password" all agree.
 */
function normalizeFieldName(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when a name, id, label or placeholder marks the value as a credential. */
export function isSensitiveFieldName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const normalized = normalizeFieldName(raw);
  if (!normalized) return false;
  if (SENSITIVE_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
  return normalized.split(" ").some((token) => SENSITIVE_TOKENS.has(token));
}

/** True when an `autocomplete` attribute marks the field as a credential. */
export function isSensitiveAutocomplete(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return SENSITIVE_AUTOCOMPLETE.has(raw.toLowerCase().trim());
}

/** The identifying attributes the page agent reports for a matched element. */
export interface ElementDescriptor {
  tagName?: string;
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  metaName?: string;
}

/**
 * Decide whether an element holds a credential, using the attributes the agent
 * reported. Covered, in order: type=password, type=hidden, a sensitive
 * autocomplete value, a sensitive meta name, and a sensitive name, id or
 * aria-label (checked against the token and phrase lists). A field is
 * sensitive if ANY of these matches; ordinary fields match none.
 */
export function isSensitiveElement(descriptor: ElementDescriptor | undefined): boolean {
  if (!descriptor) return false;
  const type = (descriptor.type ?? "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  if (isSensitiveAutocomplete(descriptor.autocomplete)) return true;
  if (descriptor.metaName && isSensitiveFieldName(descriptor.metaName)) return true;
  return (
    isSensitiveFieldName(descriptor.name) ||
    isSensitiveFieldName(descriptor.id) ||
    isSensitiveFieldName(descriptor.ariaLabel)
  );
}

/** The placeholder written in place of a value that was withheld. */
export const REDACTED = "[redacted]";

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|csrf[_-]?token|xsrf[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token|otp|pin|code)\b(\s*[=:]\s*)(["']?)([^\s"'&,;<>]{4,})\3/gi;
const LONG_HEX = /\b[a-fA-F0-9]{32,}\b/g;
const BASE64_BLOB = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/**
 * Mask secret-shaped substrings inside free text. This is a safety net for
 * values a page rendered into its own visible text, where no field boundary
 * exists to reason about. It is deliberately pattern based: it can miss a
 * secret that does not look like one.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT, REDACTED)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KEY_VALUE, (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}${REDACTED}${quote}`)
    .replace(LONG_HEX, REDACTED)
    .replace(BASE64_BLOB, REDACTED);
}

/**
 * Strip the query string and fragment from a URL. Query parameters routinely
 * carry session tokens, one-time codes and search terms.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split("#")[0].split("?")[0];
  }
}

/** True when the attribute name holds a live value rather than page metadata. */
export function isBlockedAttribute(name: string): boolean {
  return BLOCKED_ATTRIBUTES.has(name.toLowerCase());
}
