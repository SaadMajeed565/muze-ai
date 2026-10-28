const SENSITIVE_KEY = /(pass(word|phrase)?|secret|token|api[_-]?key|authorization|cookie|credential|session[_-]?id|otp|pin|auth|bearer|jwt|cvv|cvc|card|iban|ssn|credit)/i;

const MAX_STRING = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

/**
 * Produce a log-safe copy of a value: sensitive keys are masked, strings are
 * truncated, and depth/breadth are bounded. Never throws.
 *
 * Logging decision: a value is NEVER logged by key name alone — any key
 * matching SENSITIVE_KEY is replaced with "[redacted]" before it can reach
 * storage or logs, and no token/secret value is ever written, even under an
 * innocuous key, because audit call sites pass reason/code only (see
 * audit.ts). If a new call site needs richer detail, it must go through
 * this function, not around it.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(val, depth + 1);
    }
    return out;
  }
  return String(value);
}
