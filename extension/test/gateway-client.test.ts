import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fetchGatewayStatus, gatewayMcpUrl, normalizeGatewayUrl, rotateDeviceToken, signInWithBrowser } from "../src/gateway-client.js";

let server: Server;
let origin = "";
let lastAuthUrl = "";

function installChromeMock(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    identity: {
      getRedirectURL: () => "https://test-extension.chromiumapp.org/",
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
        lastAuthUrl = url;
        const auth = new URL(url);
        const redirect = new URL(auth.searchParams.get("redirect_uri") ?? "");
        redirect.hash = new URLSearchParams({
          code: "handoff_code",
          state: auth.searchParams.get("state") ?? "",
        }).toString();
        return redirect.toString();
      }),
    },
  };
}

beforeAll(async () => {
  installChromeMock();
  server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (req.method === "GET" && req.url === "/session/status") {
      if (auth !== "Bearer acct_tok") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ connected: false, name: "Browser" }));
    }
    if (req.method === "POST" && req.url === "/session/rotate") {
      if (auth !== "Bearer device_tok_1") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ deviceToken: "tok_rotated", sessionId: "sess_2" }));
    }
    if (req.method === "POST" && req.url === "/extension/redeem") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { code?: string; redirect_uri?: string };
        if (parsed.code !== "handoff_code" || parsed.redirect_uri !== "https://test-extension.chromiumapp.org/") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid or expired code" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "acct_tok", email: "user@example.com", sessionId: "sess_1" }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("gateway-client", () => {
  test("normalizes URLs and derives the MCP endpoint", () => {
    expect(normalizeGatewayUrl("https://gw.example.com/")).toBe("https://gw.example.com");
    expect(normalizeGatewayUrl("gw.example.com")).toBe("https://gw.example.com");
    expect(gatewayMcpUrl("https://gw.example.com")).toBe("https://gw.example.com/mcp");
    expect(gatewayMcpUrl("")).toBe("");
  });

  test("signs in through the browser and returns the synced account token", async () => {
    const account = await signInWithBrowser(origin);
    expect(account.token).toBe("acct_tok");
    expect(account.email).toBe("user@example.com");
    expect(account.sessionId).toBe("sess_1");
    expect(lastAuthUrl).toContain("/extension/auth?redirect_uri=");
    expect(lastAuthUrl).toContain("state=");
    expect(lastAuthUrl).not.toContain("token=");

    const status = await fetchGatewayStatus(origin, account.token);
    expect(status.connected).toBe(false);
  });

  test("surfaces a server error for a rejected status check", async () => {
    await expect(fetchGatewayStatus(origin, "wrong")).rejects.toThrow(/unauthorized/);
  });

  test("rotates the device token with the current token as Bearer auth", async () => {
    const rotated = await rotateDeviceToken(origin, "device_tok_1");
    expect(rotated).toEqual({ deviceToken: "tok_rotated", sessionId: "sess_2" });
    await expect(rotateDeviceToken(origin, "wrong")).rejects.toThrow(/unauthorized/);
  });
});
