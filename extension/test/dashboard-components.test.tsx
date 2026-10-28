/** @vitest-environment jsdom */
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestInfo, ToolDescriptor } from "../libs/tool-contracts/index.js";
import type { DashboardSnapshot } from "../src/messages.js";
import { ApprovalsBanner } from "../dashboard/ApprovalsBanner.js";
import { Onboarding } from "../dashboard/Onboarding.js";
import { PermissionLevelPicker } from "../dashboard/PermissionLevelPicker.js";
import { Switch } from "../dashboard/components/primitives.js";
import { ToolsPage } from "../dashboard/pages/Tools.js";

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

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  it("renders the three levels as radios and reports a change", async () => {
    const onChange = vi.fn();
    // Unrestricted switching confirms first; accept it for this test.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { queryAllByRole, getByText } = (getQueries(mount(
      <PermissionLevelPicker variant="cards" mode="default" onChange={onChange} />,
    )));

    const cards = queryAllByRole("radio");
    expect(cards).toHaveLength(3);
    expect(cards[1].getAttribute("aria-checked")).toBe("true");
    expect(getByText("Balanced")).toBeTruthy();

    await click(cards[2]);
    expect(onChange).toHaveBeenCalledWith("unrestricted");
    confirmSpy.mockRestore();
  });

  it("blocks the switch to Unrestricted when the confirmation is declined", async () => {
    const onChange = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { queryAllByRole } = (getQueries(mount(
      <PermissionLevelPicker variant="cards" mode="default" onChange={onChange} />,
    )));
    await click(queryAllByRole("radio")[2]);
    expect(onChange).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("ApprovalsBanner", () => {
  const approval = (id: string, tool: string): ApprovalRequestInfo => ({
    id,
    tool,
    title: "Start a download",
    summary: "Writes muze-report.pdf to your downloads folder",
    risk: "consequential",
    client: { id: "c1", name: "Claude", transport: "remote" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });

  it("renders nothing while nothing is pending", () => {
    const { container } = (getQueries(mount(<ApprovalsBanner approvals={[]} busy={false} onRespond={vi.fn()} onReview={vi.fn()} />)));
    expect(container.querySelector(".approval-banner")).toBeNull();
  });

  it("shows the pending request and answers it", async () => {
    const onRespond = vi.fn();
    const { container } = (getQueries(mount(
      <ApprovalsBanner approvals={[approval("a1", "downloads.start")]} busy={false} onRespond={onRespond} onReview={vi.fn()} />,
    )));

    expect(container.textContent).toContain("Start a download needs approval");
    expect(container.textContent).toContain("Claude");

    const buttons = [...container.querySelectorAll("button")];
    await click(buttons.find((b) => b.textContent === "Deny") ?? null);
    expect(onRespond).toHaveBeenCalledWith("a1", false);

    await click(buttons.find((b) => b.textContent === "Approve") ?? null);
    expect(onRespond).toHaveBeenCalledWith("a1", true);
  });

  it("routes a pile-up to the activity tab", async () => {
    const onReview = vi.fn();
    const { container } = (getQueries(mount(
      <ApprovalsBanner
        approvals={[approval("a1", "downloads.start"), approval("a2", "tabs.close")]}
        busy={false}
        onRespond={vi.fn()}
        onReview={onReview}
      />,
    )));

    expect(container.textContent).toContain("2 requests are waiting");
    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("All 2")) ?? null);
    expect(onReview).toHaveBeenCalled();
  });
});

describe("Onboarding", () => {
  const base = {
    busy: false,
    error: null,
    mode: "default" as const,
    signedIn: false,
    email: "",
    mcpUrl: "https://gateway.test/mcp",
    tokenMasked: "••••••••1234",
    toolCount: 129,
    onRevealToken: vi.fn(async () => null),
    connectedClients: 0,
    onStep: vi.fn(),
    onModeChange: vi.fn(),
    onSignIn: vi.fn(),
    onFinish: vi.fn(),
    onSkip: vi.fn(),
  };

  it("opens on the welcome step and advances", async () => {
    const onStep = vi.fn();
    const { getByRole, getByText } = (getQueries(mount(<Onboarding {...base} step={1} onStep={onStep} />)));

    expect(getByRole("heading").textContent).toContain("Your browser, under your control.");
    expect(getByText("129 browser tools")).toBeTruthy();

    await click(getByText("Continue"));
    expect(onStep).toHaveBeenCalledWith(2);
  });

  it("reaches the credential step and keeps the token masked", () => {
    const { getByText, queryByText } = (getQueries(mount(<Onboarding {...base} step={4} signedIn email="a@b.c" />)));

    expect(getByText("Point your AI client here.")).toBeTruthy();
    expect(queryByText("muze_live_abcdefgh1234")).toBeNull();
    expect(getByText("••••••••1234")).toBeTruthy();
    expect(getByText("MCP endpoint")).toBeTruthy();
    // The primary flow is sign-in authorisation, not a token paste.
    expect(getByText("Sign in and authorise the client when it asks — the client is approved through your account, not by pasting a token.")).toBeTruthy();
  });

  it("reveals the token only through the audited reveal callback", async () => {
    const onRevealToken = vi.fn(async () => "muze_live_abcdefgh1234");
    const { container, queryByText } = (getQueries(mount(
      <Onboarding {...base} step={4} signedIn email="a@b.c" onRevealToken={onRevealToken} />,
    )));
    expect(queryByText("muze_live_abcdefgh1234")).toBeNull();
    const reveal = [...container.querySelectorAll("button")].find((b) => b.textContent === "Reveal") ?? null;
    await click(reveal);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onRevealToken).toHaveBeenCalledTimes(1);
    expect(queryByText("muze_live_abcdefgh1234")).not.toBeNull();
  });

  it("clamps an out-of-range persisted step in render instead of crashing", () => {
    const { getByRole } = (getQueries(mount(<Onboarding {...base} step={99} />)));
    expect(getByRole("heading").textContent).toContain("Point your AI client here.");
  });

  it("asks for an account before showing credentials", () => {
    const { getByText } = (getQueries(mount(<Onboarding {...base} step={4} tokenMasked="" />)));
    expect(getByText("Connect an account first")).toBeTruthy();
  });

  it("offers a skip path on every step", async () => {
    const onSkip = vi.fn();
    const rootEl = mount(<Onboarding {...base} step={3} onSkip={onSkip} />);
    const buttons = Array.from(rootEl.querySelectorAll("button"));
    const skip = buttons.find((b) => /skip/i.test(b.textContent || ""));
    expect(skip).toBeTruthy();
    await click(skip ?? null);
    expect(onSkip).toHaveBeenCalled();
  });
});

describe("ToolsPage", () => {
  const tools: ToolDescriptor[] = [
    {
      name: "tabs.list",
      title: "List open tabs",
      description: "Return every open tab with its title and URL",
      category: "navigation",
      risk: "read-only",
      requiresApproval: false,
      inputSchema: {},
      outputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "downloads.start",
      title: "Start a download",
      description: "Download a URL to the downloads folder",
      category: "downloads",
      risk: "consequential",
      requiresApproval: true,
      inputSchema: {},
      outputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];

  const snapshot: DashboardSnapshot = {
    toolCount: 2,
    categories: ["downloads", "navigation"],
    mode: "default",
    enabledGroups: {},
    readOnlyMode: false,
    killSwitch: false,
    bridgeConnected: true,
    bridgeStatus: "connected",
    connectedClients: 1,
    pendingApprovals: 0,
    auditEvents: 0,
    allowedTools: ["tabs.list", "downloads.start"],
    deniedTools: [],
  };

  it("lists every tool, then narrows to a search match", async () => {
    const { container, getByLabelText } = (getQueries(mount(
      <ToolsPage tools={tools} snapshot={snapshot} overrides={{}} busy={false} onToggle={vi.fn()} />,
    )));

    expect(container.querySelectorAll(".tool-row")).toHaveLength(2);
    expect(container.textContent).toContain("2 tools");

    await type(getByLabelText("Search tools") as HTMLInputElement, "download");

    expect(container.querySelectorAll(".tool-row")).toHaveLength(1);
    expect(container.textContent).toContain("1 of 2 tools");
  });

  it("marks blocked tools and flips them on", async () => {
    const onToggle = vi.fn();
    const blocked: DashboardSnapshot = { ...snapshot, allowedTools: ["tabs.list"], deniedTools: ["downloads.start"] };
    const { container, queryAllByRole } = (getQueries(mount(
      <ToolsPage tools={tools} snapshot={blocked} overrides={{}} busy={false} onToggle={onToggle} />,
    )));

    expect(container.textContent).toContain("blocked");
    const switches = queryAllByRole("switch");
    await click(switches[1]);
    expect(onToggle).toHaveBeenCalledWith("downloads.start", true);
  });
});
