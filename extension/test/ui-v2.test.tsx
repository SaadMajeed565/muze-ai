/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "../dashboard/pages/Auth.js";
import { ConnectionsPage } from "../dashboard/pages/Connections.js";
import { AddAppSheet, KebabMenu, PauseControl } from "../dashboard/components/shared.js";
import { HomePage } from "../dashboard/pages/Home.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";
import { AccountPage } from "../dashboard/pages/Account.js";
import { NAV_TABS } from "../dashboard/ui-logic.js";
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
  vi.restoreAllMocks();
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
    tools: [], gateway: { enabled: true, url: "https://gw.example.com", mcpUrl: "https://gw.example.com/mcp", signedIn: true, email: "a@example.com", sessionIdMasked: "••••wxyz", connected: true, authRequired: false },
    onboarding: { completed: true, step: 4 },
  } as unknown as DashboardState;
}

const browsers = {
  browsers: [
    { sessionId: "s1", name: "Laptop Chrome", connected: true, tabCount: 3, browser: "Chrome", os: "Linux", version: "130", createdAt: new Date(2026, 9, 15).getTime(), lastSeenAt: 2000, isDefault: true, isLocal: true },
    { sessionId: "s2", name: "Work Chrome", connected: false, tabCount: null, browser: "Chrome", os: "Windows", version: "130", createdAt: new Date(2026, 9, 15).getTime(), lastSeenAt: 2000, isDefault: false },
  ],
  defaultSessionId: "s1",
  currentSessionId: "s1",
  mcpClients: [
    { clientId: "oc_1", clientName: "ChatGPT", scope: "", sessionId: "s1", live: true, connectedSince: new Date(2026, 9, 14).getTime(), lastActivityAt: 1800, authorizedSince: null, lastRefreshedAt: null, expiresAt: null },
    { clientId: "oc_2", clientName: "ChatGPT", scope: "", sessionId: "s2", live: false, connectedSince: null, lastActivityAt: null, authorizedSince: new Date(2026, 9, 10).getTime(), lastRefreshedAt: null, expiresAt: null },
  ],
};

function stubBrowsers(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (request: { type?: string }) => {
        // Pages mount through the refresh route and re-read via the
        // cache-only list after a `browsers.changed` event; both serve
        // the same fixture here (the service worker's cache semantics
        // are covered by browsers-cache.test.ts, not by this stub).
        if (request.type === "muze/browsers/list" || request.type === "muze/browsers/refresh") return { ok: true, browsers };
        if (request.type === "muze/tasks.list") return { ok: true, tasks: [] };
        if (request.type === "muze/audit") return { ok: true, audit: [] };
        return { ok: false, error: "unknown" };
      }),
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await act(async () => {});
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AuthPage (v2 in-extension sign-in, unchanged in v3)", () => {
  it("renders a sign-in form, toggles to sign-up, and submits email + password", async () => {
    const onSubmit = vi.fn(async () => true);
    const container = mount(<AuthPage busy={false} error={null} onSubmit={onSubmit} />);
    expect(container.textContent).toContain("Sign in");
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();
    expect(container.textContent).toContain("Password reset isn't available yet.");
    expect(container.textContent).not.toContain("Forgot password");

    await setInput(email, "a@example.com");
    await setInput(password, "correct horse battery staple");
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).toBeTruthy();
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledWith("sign-in", "a@example.com", "correct horse battery staple");

    const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Create account");
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
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ConnectionsPage browsers/apps separation (v3)", () => {
  // Stateful wrapper, as in App: the segment lives in the caller and
  // survives while the panel is open.
  function Wrapper(): preact.JSX.Element {
    const [segment, setSegment] = useState<"browsers" | "apps">("browsers");
    return <ConnectionsPage state={state()} busy={false} segment={segment} onSegment={setSegment} onNavigate={vi.fn()} />;
  }

  it("never lists apps in browser rows; apps dedupe by name; no ids, tokens, or Unknown render", async () => {
    stubBrowsers();
    const container = mount(<ConfirmProvider><Wrapper /></ConfirmProvider>);
    await flush();
    expect(container.textContent).toContain("Laptop Chrome");
    expect(container.textContent).toContain("Work Chrome");
    expect(container.textContent).toContain("Online");
    expect(container.textContent).not.toContain("Unknown");
    expect(container.textContent).not.toContain("s1");
    expect(container.textContent).not.toContain("••••wxyz");
    expect(container.textContent).not.toContain("token");

    // Switch to the Apps segment: ChatGPT appears exactly once despite
    // two underlying authorisations, with one Uses meta line.
    const appsTab = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").startsWith("Apps ("));
    expect(appsTab).toBeTruthy();
    await act(async () => {
      appsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const occurrences = (container.textContent ?? "").match(/ChatGPT/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(container.textContent).toContain("Uses: Laptop Chrome");
    expect(container.textContent).not.toContain("Apps:");

    // Revoke is neutral until confirmation: no Revoke button while the
    // menu is closed; opening the menu then Revoke shows the red
    // confirmation button with the all-authorisations wording.
    expect(container.textContent).not.toContain("Revoke");
    const menuButton = Array.from(container.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Actions for"));
    expect(menuButton).toBeTruthy();
    await act(async () => {
      menuButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const revoke = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Revoke access");
    expect(revoke).toBeTruthy();
    await act(async () => {
      revoke!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("All authorisations for this app are revoked");
    const confirm = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Revoke access" && b.className.includes("btn--danger"));
    expect(confirm).toBeTruthy();
  });

  it("renders the connection URL only inside AddAppSheet", async () => {
    stubBrowsers();
    const container = mount(<ConfirmProvider><Wrapper /></ConfirmProvider>);
    await flush();
    expect(container.textContent).not.toContain("https://gw.example.com/mcp");
    const appsTab = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").startsWith("Apps ("));
    await act(async () => {
      appsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const addApp = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "+ Add app");
    expect(addApp).toBeTruthy();
    await act(async () => {
      addApp!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("https://gw.example.com/mcp");
    expect(container.textContent).toContain("Paste this connection URL into your AI app. This sheet is the only place the URL is shown.");
  });
});

describe("shared v3 components", () => {
  it("AddAppSheet is a dialog that closes on Escape", async () => {
    const onClose = vi.fn();
    const container = mount(<AddAppSheet open onClose={onClose} mcpUrl="https://gw.example.com/mcp" />);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("https://gw.example.com/mcp");
    // Let the sheet's effect (Escape listener) attach first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await act(async () => {});
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("KebabMenu opens on click, selects an item, and closes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const container = mount(<KebabMenu items={[{ label: "First", onSelect: first }, { label: "Second", onSelect: second }]} />);
    const opener = Array.from(container.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "More actions");
    expect(opener).toBeTruthy();
    await act(async () => {
      opener!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const items = Array.from(container.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
    expect(items).toHaveLength(2);
    await act(async () => {
      items[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });

  it("PauseControl shows Pause when active and amber Paused + Resume when paused", async () => {
    const onToggle = vi.fn();
    const active = mount(<PauseControl paused={false} onToggle={onToggle} />);
    expect(active.textContent).toContain("Pause");
    render(null, root!);
    root!.remove();
    const paused = mount(<PauseControl paused onToggle={onToggle} />);
    expect(paused.textContent).toContain("Paused");
    expect(paused.textContent).toContain("Resume");
  });
});

describe("HomePage (reference)", () => {
  it("shows no inline URL, no Unknown, no gateway wording, no metric cards; approvals section absent when none; no Pause on Home", async () => {
    stubBrowsers();
    const container = mount(
      <ConfirmProvider>
        <HomePage
          state={state()} busy={false} approvals={[]}
          onNavigate={vi.fn()} onRespond={vi.fn()}
        />
      </ConfirmProvider>,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).not.toContain("https://gw.example.com/mcp");
    expect(text).not.toContain("Unknown");
    expect(text.toLowerCase()).not.toContain("gateway");
    expect(text).not.toContain("Apps connected");
    expect(text).not.toContain("Requests waiting");
    expect(text).not.toContain("Needs your OK");
    expect(text).toContain("This browser");
    expect(text).toContain("Laptop Chrome");
    expect(text).toContain("Online");
    expect(text).toContain("3 tabs");
    expect(text).toContain("Nothing running right now");
    expect(text).not.toContain("Upgrade");
    // The kill switch lives in Me > Permissions and safety, not on Home.
    expect(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Pause")).toBeUndefined();
  });
});

describe("AccountPage (reference)", () => {
  it("shows avatar letter + email only, plan card without Upgrade, delete only in Profile, no Security/Notifications/Help rows", async () => {
    stubBrowsers();
    const container = mount(
      <AccountPage
        state={state()} busy={false} appearance="system" onAppearance={vi.fn()} onModeChange={vi.fn()}
        onKillSwitch={vi.fn()} onGroupToggle={vi.fn()} onReset={vi.fn()}
        onSignOut={vi.fn()} onDeleteAccount={vi.fn()}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("a@example.com");
    expect(text).toContain("Free plan");
    expect(text).toContain("2 of 10 browsers");
    expect(text).not.toContain("Upgrade");
    expect(text).not.toContain("Security");
    expect(text).not.toContain("Notifications");
    expect(text).not.toContain("Help and feedback");
    expect(text).toContain("Profile");
    expect(text).not.toContain("Sign out");
    expect(text).not.toContain("Delete account");
  });
});

describe("tabbar never wraps (v3 five-destination fix)", () => {
  it("uses a column count equal to NAV_TABS.length", () => {
    const css = readFileSync(join(process.cwd(), "dashboard", "styles.css"), "utf8");
    const match = /\.tabbar\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),\s*1fr\)/.exec(css);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(NAV_TABS.length);
    expect(NAV_TABS.length).toBe(5);
    expect(css).not.toContain("repeat(4, 1fr)");
    expect(css).not.toContain("repeat(6, 1fr)");
  });
});
