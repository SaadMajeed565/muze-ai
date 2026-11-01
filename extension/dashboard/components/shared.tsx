import { useEffect, useRef, useState } from "preact/hooks";
import type { ApprovalRequestInfo } from "../../libs/tool-contracts/index.js";
import { formatCountdown } from "../logic.js";
import { Button } from "./primitives.js";
import { Field } from "./layout.js";
import { Icon } from "./Icon.js";
import { useConfirm } from "./confirm.js";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Accessible "..." overflow menu retained for compact desktop surfaces. */
export function MenuButton({ items, ariaLabel = "More actions" }: { items: MenuItem[]; ariaLabel?: string }): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest?.(".ui-menu")) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    opener.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = Array.from(list.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <div class="ui-menu">
      <Button
        variant="ghost"
        size="sm"
        ariaLabel={ariaLabel}
        ariaHasPopup="menu"
        ariaExpanded={open}
        title={ariaLabel}
        onClick={(event) => {
          opener.current = event.currentTarget as unknown as HTMLElement;
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">…</span>
      </Button>
      {open ? (
        <div class="ui-menu-list" role="menu" aria-label={ariaLabel} ref={list} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              class={"ui-menu-item" + (item.danger ? " ui-menu-item--danger" : "")}
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
    </div>
  );
}

export interface SheetProps {
  open: boolean;
  label: string;
  onClose: () => void;
  children?: preact.ComponentChildren;
}

/**
 * Mobile bottom sheet. Focus-trapped, Escape closes, body scroll locks,
 * focus returns to the opener, and the panel becomes a centred dialog on
 * wide option pages.
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
    <div class="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1}>
        <div class="sheet-grabber" aria-hidden="true" />
        <div class="sheet-head">
          <h2 class="sheet-title">{label}</h2>
          <Button variant="ghost" size="sm" icon="close" ariaLabel="Close" onClick={onClose} />
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export interface ActionSheetItem {
  label: string;
  icon?: "pencil" | "browser" | "plug" | "trash" | "check" | "logout";
  danger?: boolean;
  onSelect: () => void;
}

export function ActionSheet({
  open,
  title,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  items: ActionSheetItem[];
  onClose: () => void;
}): preact.JSX.Element {
  return (
    <Sheet open={open} label={title} onClose={onClose}>
      <div class="action-list">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            class={"action-item" + (item.danger ? " action-item--danger" : "")}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={18} /> : null}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <Button variant="secondary" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

/** Count badge for a tab, with an accessible label. */
export function NavBadge({ count, label }: { count: number; label: string }): preact.JSX.Element {
  return (
    <span class="nav-badge" role="status" aria-label={`${count} ${label}`}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Pause control, reused on Home and in Me > Permissions and safety. Every
 * toggle is confirmed through the app's own sheet, never window.confirm.
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
  return (
    <Sheet open={open} label="Add an app" onClose={onClose}>
      <p class="ui-row-meta">Add this to your AI app, then approve it when it asks.</p>
      <Field label="Connection" value={mcpUrl} copyable />
      <Button variant="primary" block onClick={onClose}>
        Close
      </Button>
    </Sheet>
  );
}

export const BROWSER_CAP = 10;

/** Static plan row. Only "Free plan" and "N of 10 browsers" — no Upgrade. */
export function PlanCard({ browserCount, onSelect }: { browserCount: number; onSelect?: () => void }): preact.JSX.Element {
  const inner = (
    <>
      <span class="plan-icon" aria-hidden="true">
        <Icon name="shield" size={18} />
      </span>
      <span class="plan-card-main">
        <span class="plan-card-plan">Free plan</span>
        <span class="plan-card-meta">
          {browserCount} of {BROWSER_CAP} browsers
        </span>
      </span>
      {onSelect ? <Icon name="chevron-right" size={17} class="plan-card-chevron" /> : null}
    </>
  );
  if (onSelect) {
    return (
      <button type="button" class="plan-card plan-card--action" onClick={onSelect} aria-label="Open account">
        {inner}
      </button>
    );
  }
  return <div class="plan-card">{inner}</div>;
}

/**
 * One approval card, used on Home and in the app-bar approvals sheet.
 * Expiry updates every second.
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
      <header class="approval-head">
        <span class="approval-app">
          <Icon name="plug" size={15} />
          {appName}
        </span>
        <span class="approval-expiry">{formatCountdown(approval.expiresAt, now)}</span>
      </header>
      <h3 class="approval-title">{approval.title}</h3>
      <p class="approval-summary">{approval.summary}</p>
      <div class="approval-actions">
        <Button variant="secondary" disabled={busy} onClick={() => onRespond(approval.id, false)}>
          Deny
        </Button>
        <Button variant="primary" icon="check" disabled={busy} onClick={() => onRespond(approval.id, true)}>
          Allow
        </Button>
      </div>
    </article>
  );
}
