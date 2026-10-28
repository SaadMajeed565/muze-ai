/** Small WebCrypto/HTTP helpers shared across the gateway. No Node built-ins. */

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store, no-cache, must-revalidate",
      pragma: "no-cache",
      ...headers,
    },
  });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const body = await request.text();
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}

/** Hex-encoded cryptographically random token. */
export function randomHex(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** PBKDF2-SHA256. Kept modest so it stays within Worker CPU budgets. */
const PBKDF2_ITERATIONS = 50_000;

export async function hashPassword(password: string, saltB64?: string): Promise<{ salt: string; hash: string }> {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
}

export async function verifyPassword(password: string, saltB64: string, expectedHashB64: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltB64);
  return constantTimeEqual(hash, expectedHashB64);
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    // Never throw on a malformed percent-escape: skip that cookie and
    // continue parsing the rest, so one bad cookie cannot break sign-in.
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return cookies;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** RFC 7636 S256 PKCE verification. */
export async function verifyPkce(verifier: string, challenge: string, method: string): Promise<boolean> {
  // `plain` is not accepted: the metadata advertises S256 only, and a code
  // challenge must not degrade to the verifier being sent in clear.
  if (method !== "S256") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return constantTimeEqual(base64UrlEncode(new Uint8Array(digest)), challenge);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function nowMs(): number {
  return Date.now();
}
