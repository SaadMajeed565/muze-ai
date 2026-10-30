import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./primitives.js";
import { Field } from "./layout.js";
import { Icon } from "./Icon.js";

/**
 * Shared v3 components. All styling reuses existing styles.css tokens
 * only — no new colours, spacing, or radii. Status is always dot +
 * word, never colour alone.
 */

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** Accessible "..." overflow menu: aria-haspopup, Escape closes, arrow keys move, focus returns to the button. */
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
 * Bottom sheet on narrow windows, centred panel on wide ones. Focus
 * trap inside, Escape closes, focus returns to the opener.
 */
export function Sheet({ open, label, onClose, children }: SheetProps): preact.JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const focusables = (): HTMLElement[] =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])") ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    const first = focusables()[0];
    first?.focus();
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
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={label} ref={panel}>
        <div class="sheet-head">
          <h2 class="sheet-title">{label}</h2>
          <Button variant="ghost" size="sm" icon="close" ariaLabel="Close" onClick={onClose} />
        </div>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** Count badge for a tab / rail item, with an accessible label. */
export function NavBadge({ count, label }: { count: number; label: string }): preact.JSX.Element {
  return (
    <span class="nav-badge" role="status" aria-label={`${count} ${label}`}>
      {count > 9 ? "9+" : count}
    </span>
  );
}

/**
 * Pause control, reused on Home and in Account > Permissions and
 * safety. It uses the existing kill-switch policy message and
 * semantics (confirm wording unchanged); it is never a bare "Off"
 * toggle. Active: a "Pause" button. Paused: an amber "Paused" word
 * plus a "Resume" button.
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
  const toggle = (engaged: boolean): void => {
    const ok = confirm(
      engaged
        ? "Stop all agent activity? Nothing the agent asks for will run until you turn this off again."
        : "Turn activity back on? The agent will be able to act again under the current permission level.",
    );
    if (ok) onToggle(engaged);
  };
  if (paused) {
    return (
      <span class="pause-control">
        <span class="pause-state">
          <span class="status-dot is-warn" aria-hidden="true" />
          <span>Paused</span>
        </span>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(false)}>
          Resume
        </Button>
      </span>
    );
  }
  return (
    <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(true)}>
      Pause
    </Button>
  );
}

/**
 * AddAppSheet: the ONLY place the connection URL renders (v3). Opened
 * from Home and from Connections > Apps. One plain instruction, the
 * URL as a field with Copy, and a Close action — nothing else.
 */
export function AddAppSheet({ open, onClose, mcpUrl }: { open: boolean; onClose: () => void; mcpUrl: string }): preact.JSX.Element | null {
  return (
    <Sheet open={open} label="Add an app" onClose={onClose}>
      <p class="ui-row-meta">Add this to your AI app, then approve it when it asks.</p>
      <Field label="Connection" value={mcpUrl} copyable />
      <Button variant="primary" onClick={onClose}>
        Close
      </Button>
    </Sheet>
  );
}

export const BROWSER_CAP = 10;

/**
 * Static plan card. Only "Free plan" and "N of 10 browsers" — no usage
 * numbers, no meter, no Upgrade button anywhere.
 */
export function PlanCard({ browserCount, onSelect }: { browserCount: number; onSelect?: () => void }): preact.JSX.Element {
  const inner = (
    <>
      <span class="plan-card-main">
        <span class="plan-card-plan">Free plan</span>
        <span class="plan-card-meta">
          {browserCount} of {BROWSER_CAP} browsers
        </span>
      </span>
      {onSelect ? <Icon name="chevron-right" size={16} class="plan-card-chevron" /> : null}
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
