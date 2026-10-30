/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "../dashboard/pages/Auth.js";
import { ProfilePage } from "../dashboard/pages/Profile.js";
import type { DashboardState } from "../src/messages.js";

let root: HTMLElement | null = null;

function mount(node: preact.VNode): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node, root);
  return root;
}

afterEach(() => {
  if (root) {
    render(null, root);
    root.remove();
  }
  root = null;
  vi.unstubAllGlobals();
});

function state(): DashboardState {
  return {
    snapshot: {
      toolCount: 136, categories: [], mode: "default", enabledGroups: {},
      readOnlyMode: false, killSwitch: false, bridgeConnected: true,
      bridgeStatus: "connected", connectedClients: 0, pendingApprovals: 0,
      auditEvents: 0, allowedTools: [], deniedTools: [],
    },
    policy: {
      version: 3, mode: "default", readOnlyMode: false, killSwitch: false,
      approvalMode: "risk", allowByRisk: {}, approvalByRisk: {}, toolOverrides: {},
      clients: {}, blockedDomains: [], enabledGroups: { bookmarks: true, history: true },
      maxOutputChars: 200_000, defaultTimeoutMs: 30_000,
    },
    approvals: [], clients: [], settings: { gatewayEnabled: true, gatewayAccountEmail: "a@example.com" },
    tools: [], gateway: { enabled: true, url: "", mcpUrl: "https://gw.example.com/mcp", signedIn: true, email: "a@example.com", sessionIdMasked: "••••wxyz", connected: true, authRequired: false },
    onboarding: { completed: true, step: 4 },
  } as unknown as DashboardState;
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AuthPage (v2 in-extension sign-in)", () => {
  it("renders a sign-in form, toggles to sign-up, and submits email + password", async () => {
    const onSubmit = vi.fn(async () => true);
    const container = mount(<AuthPage busy={false} error={null} onSubmit={onSubmit} />);
    expect(container.textContent).toContain("Sign in");
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();
    // No fake password reset: the honest note, not a link that goes nowhere.
    expect(container.textContent).toContain("Password reset isn't available yet.");
    expect(container.textContent).not.toContain("Forgot password");

    await setInput(email, "a@example.com");
    await setInput(password, "correct horse battery staple");
    const submit = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Sign in");
    expect(submit).toBeTruthy();
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("sign-in", "a@example.com", "correct horse battery staple");

    const toggle = Array.from(container.querySelectorAll("button")).find((b) => /Create one/.test(b.textContent ?? ""));
    expect(toggle).toBeTruthy();
    await act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Create account");
  });

  it("shows a plain error and validates locally before submitting", async () => {
    const onSubmit = vi.fn(async () => true);
    const container = mount(<AuthPage busy={false} error="Wrong email or password." onSubmit={onSubmit} />);
    expect(container.textContent).toContain("Wrong email or password.");
    expect(container.textContent).not.toContain("401");
    const submit = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Sign in");
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ProfilePage browsers/apps separation (v2)", () => {
  it("never lists apps in browser rows; app rows carry only the Uses meta line; no ids or tokens render", async () => {
    const browsers = {
      browsers: [
        { sessionId: "s1", name: "Laptop Chrome", connected: true, tabCount: 3, browser: "Chrome", os: "Linux", version: "130", addedAt: 1000, lastSeenAt: 2000 },
        { sessionId: "s2", name: "Work Chrome", connected: false, tabCount: null, browser: "Chrome", os: "Windows", version: "130", addedAt: 1000, lastSeenAt: 2000 },
      ],
      defaultSessionId: "s1",
      currentSessionId: "s1",
      mcpClients: [
        { clientId: "c1", clientName: "ChatGPT", scope: "", sessionId: "s1", live: true, connectedSince: 1500, lastActivityAt: 1800, authorizedSince: null, lastRefreshedAt: null, expiresAt: null },
      ],
    };
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(async (request: { type?: string }) => {
          if (request.type === "muze/browsers/list") return { ok: true, browsers };
          return { ok: false, error: "unknown" };
        }),
      },
    });
    const container = mount(
      <ProfilePage
        state={state()} busy={false} appearance="system" onAppearance={vi.fn()} onModeChange={vi.fn()}
        onPolicyPatch={vi.fn()} onReadOnly={vi.fn()} onKillSwitch={vi.fn()} onGroupToggle={vi.fn()}
        onSignOut={vi.fn()} onReconnect={vi.fn()} onDeleteAccount={vi.fn()}
      />,
    );
    // Same flush pattern as the TasksPage tests: the browsers fetch
    // resolves over several promise turns, more than one act tick covers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await act(async () => {});
    expect(container.textContent).toContain("Laptop Chrome");
    expect(container.textContent).toContain("Work Chrome");
    expect(container.textContent).toContain("Uses: Laptop Chrome");
    // The app name must appear exactly once: in its own row, never inside
    // a browser row's meta line.
    const occurrences = (container.textContent ?? "").match(/ChatGPT/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(container.textContent).not.toContain("Apps:");
    expect(container.textContent).not.toContain("s1");
    expect(container.textContent).not.toContain("s2");
    expect(container.textContent).not.toContain("••••wxyz");
    expect(container.textContent).not.toContain("token");
  });
});

describe("tabbar never wraps (v2 small-breakpoint fix)", () => {
  it("uses a four-column grid and no longer hardcodes five or six columns", () => {
    const css = readFileSync(join(process.cwd(), "dashboard", "styles.css"), "utf8");
    expect(css).toContain("repeat(4, 1fr)");
    expect(css).not.toContain("repeat(5, 1fr)");
    expect(css).not.toContain("repeat(6, 1fr)");
  });
});
