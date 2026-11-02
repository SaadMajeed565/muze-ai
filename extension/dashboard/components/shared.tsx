import { useEffect, useRef, useState } from "preact/hooks";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import { formatCountdown } from "../logic.js";
import { Button } from "./primitives.js";
import { Icon } from "./Icon.js";
import { BrandIcon } from "./brand-icons.js";
import { useConfirm } from "./confirm.js";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * Kebab (three-dot) menu, like the reference Files menus: one floating
 * panel, right-aligned under the kebab, flipping above the row near
 * the viewport bottom. Closes on outside tap, on scroll, or after any
 * action. Used by file rows and by browser/app rows.
 */
export function KebabMenu({ items, ariaLabel = "More actions" }: { items: MenuItem[]; ariaLabel?: string }): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !menu.current || !opener.current) return;
    const rect = opener.current.getBoundingClientRect();
    const width = menu.current.offsetWidth;
    const height = menu.current.offsetHeight;
    let left = rect.right - width;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 4;
    if (top < 8) top = 8;
    setPosition({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (!(event.target as HTMLElement).closest?.(".ctxmenu") && !(event.target as HTMLElement).closest?.(".kebab")) {
        setOpen(false);
      }
    };
    const onScroll = (): void => setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open ]);

  return (
    <>
      <button
        type="button"
        class="kebab"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={opener}
        onClick={(event) => {
          event.stopPropagation();
          setPosition(null);
          setOpen((value) => !value);
        }}
      >
        <Icon name="dots" size={18} />
      </button>
      {open ? (
        <div
          class="ctxmenu"
          role="menu"
          aria-label={ariaLabel}
          ref={menu}
          style={position ? { left: `${position.left}px`, top: `${position.top}px` } : { visibility: "hidden", left: "0px", top: "0px" }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              class={"ctxItem" + (item.danger ? " danger" : "")}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export interface SheetProps {
  open: boolean;
  label: string;
  onClose: () => void;
  children?: preact.ComponentChildren;
}

/**
 * Bottom sheet in the reference pattern: scrim + panel sliding up.
 * Escape closes, body scroll locks, focus returns to the opener.
 * (The old centred-dialog markup is gone; the reference sheet is the
 * only sheet language now.)
 */
export function Sheet({ open, label, onClose, children }: SheetProps): preact.JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = (): HTMLElement[] =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])") ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    (focusables()[0] ?? panel.current)?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && current <= 0) {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (!event.shiftKey && current >= items.length - 1) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div class="sheet open" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="box" role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1}>
        <div class="between">
          <b>{label}</b>
          <button type="button" class="btn small" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Pause control, reused in Me > Permissions and safety. Every toggle
 * is confirmed through the app's own sheet, never window.confirm.
 */
export function PauseControl({
  paused,
  busy,
  onToggle,
}: {
  paused: boolean;
  busy?: boolean;
  onToggle: (engaged: boolean) => void;
}): preact.JSX.Element {
  const confirm = useConfirm();
  const toggle = async (engaged: boolean): Promise<void> => {
    const ok = await confirm({
      title: engaged ? "Stop all activity?" : "Turn activity back on?",
      body: engaged
        ? "Nothing the agent asks for will run until you turn this back on."
        : "The agent will be able to act again under your current permission level.",
      confirmLabel: engaged ? "Stop activity" : "Resume",
      tone: engaged ? "danger" : "primary",
    });
    if (ok) onToggle(engaged);
  };
  if (paused) {
    return (
      <span class="pause-control">
        <span class="pause-state">
          <span class="status-dot is-warn" aria-hidden="true" />
          <span>Paused</span>
        </span>
        <Button variant="secondary" size="sm" icon="play" disabled={busy} onClick={() => void toggle(false)}>
          Resume
        </Button>
      </span>
    );
  }
  return (
    <Button variant="secondary" size="sm" icon="pause" disabled={busy} onClick={() => void toggle(true)}>
      Pause
    </Button>
  );
}

/**
 * AddAppSheet: the ONLY place the connection URL renders. Opened from
 * Home and from Connect > Apps.
 */
export function AddAppSheet({ open, onClose, mcpUrl }: { open: boolean; onClose: () => void; mcpUrl: string }): preact.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Sheet open={open} label="Add an app" onClose={onClose}>
      <p class="muted">Paste this connection URL into your AI app. This sheet is the only place the URL is shown.</p>
      <div class="mono">{mcpUrl}</div>
      <Button variant="primary" block onClick={() => void copy()}>
        {copied ? "Copied" : "Copy URL"}
      </Button>
    </Sheet>
  );
}

export const BROWSER_CAP = 10;

/** Static plan row. Only "Free plan" and "N of 10 browsers" — no Upgrade. */
export function PlanCard({ browserCount }: { browserCount: number }): preact.JSX.Element {
  return (
    <div class="plan-row">
      <span class="plan-row-main">
        <span class="plan-row-plan">Free plan</span>
        <span class="plan-row-meta">
          {browserCount} of {BROWSER_CAP} browsers
        </span>
      </span>
    </div>
  );
}

/**
 * One approval card, used on Home: brand tile + plain verb + target +
 * Allow/Deny + small countdown text, like the reference.
 */
export function ApprovalCard({
  approval,
  appName,
  busy,
  onRespond,
}: {
  approval: ApprovalRequestInfo;
  appName: string;
  busy?: boolean;
  onRespond: (approvalId: string, approved: boolean) => void;
}): preact.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <article class="approval-card">
      <div class="flex">
        <BrandIcon name={appName} small />
        <div style={{ flex: 1 }}>
          <b style={{ fontSize: "14px" }}>{approval.title}</b>
          <div class="muted" style={{ fontSize: "12px" }}>
            {approval.summary} · <span style={{ color: "var(--amber)" }}>{formatCountdown(approval.expiresAt, now)}</span>
          </div>
        </div>
      </div>
      <div class="mt12" style={{ display: "flex", gap: "8px" }}>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, true)}>
          Allow
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, false)}>
          Deny
        </Button>
      </div>
    </article>
  );
}
