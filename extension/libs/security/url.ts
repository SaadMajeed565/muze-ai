import { ToolErrorException } from "../tool-contracts/index.js";

const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);

export const DANGEROUS_SCHEMES = [
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "filesystem:",
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "devtools:",
  "view-source:",
];

const RESTRICTED_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "chrome-search://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com",
];

/** True when a tab URL cannot be scripted or read by extensions. */
export function isRestrictedUrl(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) return true;
  const lower = rawUrl.toLowerCase();
  if (lower === "about:blank") return false;
  return RESTRICTED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export interface ValidatedUrl {
  href: string;
  origin: string;
  host: string;
  protocol: string;
  /** Best-effort registrable domain (no public-suffix list; see docs). */
  domain: string;
}

/**
 * Validate a URL that will be navigated to or fetched. Only http/https URLs are
 * permitted. Credentials embedded in the URL are rejected.
 */
export function validateNavigableUrl(rawInput: string, options: { allowAboutBlank?: boolean } = {}): ValidatedUrl {
  const raw = rawInput.trim();
  if (options.allowAboutBlank && raw.toLowerCase() === "about:blank") {
    return { href: "about:blank", origin: "about:blank", host: "", protocol: "about:", domain: "" };
  }

  const lower = raw.toLowerCase();
  if (DANGEROUS_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    throw new ToolErrorException("INVALID_URL", `Blocked URL scheme in "${raw.slice(0, 40)}"`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolErrorException("INVALID_URL", `Malformed URL: "${raw.slice(0, 200)}"`);
  }

  if (!NAVIGABLE_PROTOCOLS.has(url.protocol)) {
    throw new ToolErrorException("INVALID_URL", `Only http/https URLs are allowed, got "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new ToolErrorException("INVALID_URL", "URLs with embedded credentials are not allowed");
  }

  return {
    href: url.toString(),
    origin: url.origin,
    host: url.hostname,
    protocol: url.protocol,
    domain: registrableDomain(url.hostname),
  };
}

/**
 * Approximate registrable domain (eTLD+1) WITHOUT a full public-suffix list.
 * This is still an approximation, not a public-suffix implementation, and it
 * is used only for blocked-domain matching and tab grouping — never as a
 * security boundary on its own. It works in three layers:
 *
 * 1. An explicit list of well-known multi-label suffixes, including hosting
 *    suffixes that the generic rules cannot see (github.io, pages.dev, …).
 * 2. An expanded explicit list of two-part country suffixes (co.uk, com.au…).
 * 3. A ccSLD heuristic: when the second-last label is one of
 *    co/com/org/net/gov/ac/edu/go/or/ne and the TLD is two letters, the
 *    suffix is three labels (e.g. example.com.br, shop.co.za). This covers
 *    country suffixes not listed explicitly, at the cost of occasionally
 *    treating a genuine `com.<cc>` registrable name as a suffix — an
 *    over-grouping error, documented here rather than hidden.
 *
 * Examples that now work: www.foo.github.io -> foo.github.io,
 * www.bbc.co.uk -> bbc.co.uk, deep.shop.example.com.br -> example.com.br,
 * a.b.example.com -> example.com.
 */
const MULTI_LABEL_SUFFIXES = [
  // Hosting / platform suffixes (last label alone gives no signal).
  "github.io",
  "gitlab.io",
  "pages.dev",
  "netlify.app",
  "vercel.app",
  "herokuapp.com",
  "azurewebsites.net",
  "appspot.com",
  "firebaseapp.com",
  "cloudfront.net",
  "workers.dev",
  "onrender.com",
  "fly.dev",
  "repl.co",
  "glitch.me",
  "s3.amazonaws.com",
];

const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk", "nhs.uk",
  "co.im", "co.gg", "co.je",
  "com.au", "org.au", "net.au", "gov.au", "edu.au",
  "co.nz", "org.nz", "gov.nz", "ac.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ac.kr", "go.kr",
  "com.br", "org.br", "net.br", "gov.br",
  "co.in", "org.in", "gov.in", "ac.in",
  "co.za", "com.mx", "com.ar", "com.co", "com.sg", "com.hk", "com.tw",
  "co.id", "com.id", "co.th", "com.tr", "com.pl", "com.ph", "co.il",
  "com.eg", "com.ng", "com.pk", "co.ke", "com.pe", "com.ve", "com.ua", "org.ua",
  "com.cn",
]);

const CCSLD_SECOND_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "go", "or", "ne"]);

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || /^\d+(\.\d+){3}$/.test(host) || host === "localhost" || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  for (const suffix of MULTI_LABEL_SUFFIXES) {
    const suffixParts = suffix.split(".");
    if (parts.length > suffixParts.length && host.endsWith(`.${suffix}`)) {
      return parts.slice(-(suffixParts.length + 1)).join(".");
    }
  }
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join(".");
  // ccSLD heuristic: <label>.co|com|org|….<2-letter TLD> implies a 3-label suffix.
  const secondLast = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (tld.length === 2 && CCSLD_SECOND_LABELS.has(secondLast)) return parts.slice(-3).join(".");
  return lastTwo;
}

/** Strip query/hash so audit logs and approval prompts do not leak parameters. */
export function redactUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.slice(0, 200);
  }
}
