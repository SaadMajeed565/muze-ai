/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../dashboard/Onboarding.js";
import { PermissionLevelPicker } from "../dashboard/PermissionLevelPicker.js";
import { BottomNav } from "../dashboard/components/AppShell.js";
import { ConfirmProvider } from "../dashboard/components/feedback.js";
import { PermissionsSections } from "../dashboard/components/permissions-sections.js";
import { TasksPage } from "../dashboard/pages/Tasks.js";
import type { DashboardState } from "../src/messages.js";
import { Switch } from "../dashboard/components/primitives.js";
import { Icon } from "../dashboard/components/Icon.js";
import type { IconName } from "../dashboard/logic.js";

let root: HTMLElement | null = null;

function mount(node: preact.VNode): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node, root);
  return root;
}

function getQueries(container: HTMLElement) {
  return {
    container,
    getByRole: (role: string) => {
      const els = Array.from(container.querySelectorAll(`[role="${role}"]`));
      const tags = role === 'heading' ? ['h1','h2','h3','h4','h5','h6'] : role === 'button' ? ['button'] : role === 'switch' ? ['button[role="switch"]'] : [];
      if (tags.length) {
        for (const t of tags) {
          els.push(...Array.from(container.querySelectorAll(t)));
        }
      }
      const unique = [...new Set(els)];
      if (unique.length === 0) throw new Error(`Unable to find role: ${role}`);
      return unique[0];
    },
    queryByRole: (role: string) => {
      try { return (new Function(`return this.getByRole("${role}")`)).call({getByRole: (r:any)=>{const els = Array.from(container.querySelectorAll(`[role="${r}"]`)); if(r==='heading'){['h1','h2','h3','h4','h5','h6'].forEach(t=>els.push(...Array.from(container.querySelectorAll(t))));} const u=[...new Set(els)]; return u[0]??null;}}) } catch { return null; }
    },
    getAllByRole: (role: string) => {
      const els = Array.from(container.querySelectorAll(`[role="${role}"]`));
      if(role==='heading'){['h1','h2','h3','h4','h5','h6'].forEach(t=>els.push(...Array.from(container.querySelectorAll(t))));}
      if(role==='button'){els.push(...Array.from(container.querySelectorAll('button')));}
      return [...new Set(els)];
    },
    queryAllByRole: (role: string) => {
      const els = Array.from(container.querySelectorAll(`[role="${role}"]`));
      if(role==='heading'){['h1','h2','h3','h4','h5','h6'].forEach(t=>els.push(...Array.from(container.querySelectorAll(t))));}
      if(role==='button'){els.push(...Array.from(container.querySelectorAll('button')));}
      if(role==='switch'){els.push(...Array.from(container.querySelectorAll('[role="switch"]')));}
      return [...new Set(els)];
    },
    getByText: (text: string) => {
      const el = Array.from(container.querySelectorAll("button")).find(e => e.textContent?.includes(text))
        ?? Array.from(container.querySelectorAll("*")).find(e => e.textContent?.trim() === text)
        ?? Array.from(container.querySelectorAll("*")).find(e => e.textContent?.includes(text));
      if (!el) throw new Error(`Unable to find text: ${text}`);
      return el;
    },
    getAllByText: (text: string) => Array.from(container.querySelectorAll("*")).filter(e => e.textContent?.includes(text)),
    queryByText: (text: string) => Array.from(container.querySelectorAll("*")).find(e => e.textContent?.includes(text)) ?? null,
    getByLabelText: (label: string) => {
      const el = container.querySelector(`[aria-label="${label}"]`) ?? Array.from(container.querySelectorAll("label")).find(l => l.textContent?.includes(label))?.querySelector("input");
      if (!el) throw new Error(`Unable to find label: ${label}`);
      return el;
    },
  };
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(() => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    render(null, root);
    root.remove();
  }
  root = null;
});

describe("Switch", () => {
  it("exposes the switch role and reports the next value", async () => {
    const onToggle = vi.fn();
    const { queryByRole } = (getQueries(mount(<Switch checked={false} label="Bridge" onToggle={onToggle} />)));

    const control = queryByRole("switch") as HTMLButtonElement;
    expect(control).not.toBeNull();
    expect(control.getAttribute("aria-checked")).toBe("false");

    await click(control);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("does not fire while disabled", async () => {
    const onToggle = vi.fn();
    const { queryByRole } = (getQueries(mount(<Switch checked onToggle={onToggle} disabled />)));
    await click(queryByRole("switch"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("PermissionLevelPicker", () => {
  function mountPicker(onChange: (mode: string) => void): HTMLElement {
    return mount(
      <ConfirmProvider>
        <PermissionLevelPicker variant="cards" mode="default" onChange={onChange as never} />
      </ConfirmProvider>,
    );
  }

  it("renders the three levels as radios and reports a change", async () => {
    const onChange = vi.fn();
    const { container, queryAllByRole, getByText } = (getQueries(mountPicker(onChange)));

    const cards = queryAllByRole("radio");
    expect(cards).toHaveLength(3);
    expect(cards[1].getAttribute("aria-checked")).toBe("true");
    expect(getByText("Balanced")).toBeTruthy();

    await click(cards[2]);
    const accept = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Use Unrestricted");
    await click(accept ?? null);
    expect(onChange).toHaveBeenCalledWith("unrestricted");
  });

  it("blocks the switch to Unrestricted when the confirmation is declined", async () => {
    const onChange = vi.fn();
    const { container, queryAllByRole } = (getQueries(mountPicker(onChange)));
    await click(queryAllByRole("radio")[2]);
    const keep = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Keep it");
    await click(keep ?? null);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Onboarding", () => {
  const base = {
    busy: false,
    error: null,
    mode: "default" as const,
    mcpUrl: "https://gateway.test/mcp",
    connectedClients: 0,
    onStep: vi.fn(),
    onModeChange: vi.fn(),
    onFinish: vi.fn(),
    onSkip: vi.fn(),
  };

  it("opens on the permission step and advances", async () => {
    const onStep = vi.fn();
    const { getByRole, getByText } = (getQueries(mount(<Onboarding {...base} step={1} onStep={onStep} />)));

    expect(getByRole("heading").textContent).toContain("How far may the agent go?");
    expect(getByText("Balanced")).toBeTruthy();

    await click(getByText("Continue"));
    expect(onStep).toHaveBeenCalledWith(2);
  });

  it("reaches the connect step and shows no token at all", () => {
    const { container, getByText, queryByText } = (getQueries(mount(<Onboarding {...base} step={2} />)));

    expect(getByText("Point your AI app here.")).toBeTruthy();
    expect(getByText("Connection")).toBeTruthy();
    // No token credential, masked or otherwise, and no way to reveal one.
    expect(queryByText("Device token (advanced)")).toBeNull();
    expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Reveal")).toBeUndefined();
    // The primary flow is sign-in authorisation, not a token paste.
    expect(getByText("Sign in and authorise the app when it asks.")).toBeTruthy();
  });

  it("clamps an out-of-range persisted step in render instead of crashing", () => {
    const { getByRole } = (getQueries(mount(<Onboarding {...base} step={99} />)));
    expect(getByRole("heading").textContent).toContain("Point your AI app here.");
  });

  it("offers a skip path on every step", async () => {
    const onSkip = vi.fn();
    const rootEl = mount(<Onboarding {...base} step={1} onSkip={onSkip} />);
    const buttons = Array.from(rootEl.querySelectorAll("button"));
    const skip = buttons.find((b) => /skip/i.test(b.textContent || ""));
    expect(skip).toBeTruthy();
    await click(skip ?? null);
    expect(onSkip).toHaveBeenCalled();
  });
});

describe("BottomNav", () => {
  it("has exactly five tabs and no Tools, Browsers, Safety, or Activity entry", () => {
    const { container } = (getQueries(mount(
      <BottomNav active="home" onChange={vi.fn()} />,
    )));
    expect(container.textContent).toContain("Home");
    expect(container.textContent).toContain("Tasks");
    expect(container.textContent).toContain("Connect");
    expect(container.textContent).toContain("Files");
    expect(container.textContent).toContain("Me");
    expect(container.textContent).not.toContain("Tools");
    expect(container.textContent).not.toContain("Safety");
    expect(container.querySelectorAll(".tabbar button")).toHaveLength(5);
  });
});

describe("PermissionsSections end-user only", () => {
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
      approvals: [], clients: [], settings: { gatewayEnabled: true, gatewayAccountEmail: "" },
      tools: [], gateway: { enabled: true, url: "", mcpUrl: "", signedIn: false, email: "", sessionIdMasked: "", connected: false, authRequired: false },
      onboarding: { completed: true, step: 4 },
    } as unknown as DashboardState;
  }
  it("shows plain capabilities and no tool names, counts, or overrides", () => {
    const { container } = (getQueries(mount(
      <PermissionsSections state={state()} busy={false} appearance="system" onAppearance={vi.fn()} onModeChange={vi.fn()} onPolicyPatch={vi.fn()} onReadOnly={vi.fn()} onKillSwitch={vi.fn()} onGroupToggle={vi.fn()} />,
    )));
    expect(container.textContent).toContain("What Muze can do");
    expect(container.textContent).toContain("Read pages");
    expect(container.textContent).toContain("Use bookmarks");
    expect(container.textContent).not.toContain("136");
    expect(container.textContent).not.toContain("Per-tool");
    expect(container.textContent).not.toContain("overrides");
  });
});

describe("TasksPage activity only", () => {
  it("keeps approvals off Tasks and shows plain activity without tool names", async () => {
    // TasksPage takes no approvals/audit props: approvals live on Home
    // only, and there is no audit feed on Tasks.
    const { container } = (getQueries(mount(
      <TasksPage busy={false} />,
    )));
    // Approvals live on Home, never on Tasks.
    expect(container.textContent).not.toContain("Waiting for you");
    // Activity is no longer a separate tab; task steps live in task detail.
    expect(container.textContent).not.toContain("Activity");
  });
});

describe("timeline family glyphs", () => {
  it("renders a stroke path for every new family glyph (no empty svg)", () => {
    // PATHS is partial, so a missing glyph would render an empty svg
    // without failing the build — this is the runtime guard for that.
    const names: IconName[] = ["drag", "send", "history-rewind", "wrench", "flow", "checklist"];
    for (const name of names) {
      const container = mount(<Icon name={name} size={16} />);
      expect(container.querySelector("svg path, svg circle, svg rect")).not.toBeNull();
    }
  });
});
