import { describe, expect, it } from "vitest";
import { isRestrictedUrl, redactUrlForLog, registrableDomain, validateNavigableUrl } from "../libs/security/url.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";

describe("validateNavigableUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validateNavigableUrl("https://example.com/a?b=1").host).toBe("example.com");
    expect(validateNavigableUrl("http://localhost:3000/").protocol).toBe("http:");
  });

  it("rejects dangerous or non-navigable schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "chrome://settings",
      "view-source:https://example.com",
      "vbscript:msgbox(1)",
    ]) {
      expect(() => validateNavigableUrl(url), url).toThrow(ToolErrorException);
    }
  });

  it("rejects embedded credentials", () => {
    expect(() => validateNavigableUrl("https://user:pass@example.com")).toThrow(/credentials/);
  });

  it("allows about:blank only when explicitly permitted", () => {
    expect(() => validateNavigableUrl("about:blank")).toThrow();
    expect(validateNavigableUrl("about:blank", { allowAboutBlank: true }).href).toBe("about:blank");
  });
});

describe("isRestrictedUrl", () => {
  it("flags browser-internal and store pages", () => {
    expect(isRestrictedUrl("chrome://extensions")).toBe(true);
    expect(isRestrictedUrl("chrome-extension://abc/page.html")).toBe(true);
    expect(isRestrictedUrl("https://chromewebstore.google.com/detail/x")).toBe(true);
    expect(isRestrictedUrl("devtools://devtools/bundled/x")).toBe(true);
  });

  it("allows ordinary pages and about:blank", () => {
    expect(isRestrictedUrl("https://example.com")).toBe(false);
    expect(isRestrictedUrl("about:blank")).toBe(false);
  });
});

describe("registrableDomain", () => {
  it("handles common multi-part suffixes", () => {
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("localhost")).toBe("localhost");
  });

  it("handles hosting suffixes such as github.io", () => {
    expect(registrableDomain("www.foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("user.pages.dev")).toBe("user.pages.dev");
    expect(registrableDomain("app.herokuapp.com")).toBe("app.herokuapp.com");
  });

  it("applies the ccSLD heuristic for unlisted country suffixes", () => {
    expect(registrableDomain("deep.shop.example.com.br")).toBe("example.com.br");
    expect(registrableDomain("www.shop.co.za")).toBe("shop.co.za");
    expect(registrableDomain("a.example.com.mx")).toBe("example.com.mx");
    // Still an approximation, not a full public-suffix list: plain two-label
    // hosts and ordinary subdomains are unchanged.
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("sub.example.org")).toBe("example.org");
  });
});

describe("redactUrlForLog", () => {
  it("drops query strings and fragments", () => {
    expect(redactUrlForLog("https://example.com/search?token=secret#frag")).toBe("https://example.com/search");
  });
});
