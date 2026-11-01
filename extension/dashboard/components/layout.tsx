import { useState } from "preact/hooks";
import type { IconName } from "../logic.js";
import { Button, Callout, Skeleton } from "./primitives.js";
import { Icon } from "./Icon.js";

/**
 * The dashboard's mobile layout system: Page, Section, ListRow, Field,
 * and per-section states. Every page renders its title once; the app bar
 * carries the destination name and back action.
 */

export interface PageProps {
  title: string;
  subtitle?: string;
  action?: preact.ComponentChildren;
  children?: preact.ComponentChildren;
}

export function Page({ title: _title, subtitle: _subtitle, action, children }: PageProps): preact.JSX.Element {
  return (
    <div class="ui-page">
      <header class="ui-page-head">
        <div class="ui-page-heading">
          {/* subtitle moved to app bar */}
        </div>
        {action ? <div class="ui-page-action">{action}</div> : null}
      </header>
      <div class="ui-page-body">{children}</div>
    </div>
  );
}

export interface SectionProps {
  title: string;
  description?: string;
  action?: preact.ComponentChildren;
  children?: preact.ComponentChildren;
}

export function Section({ title, description, action, children }: SectionProps): preact.JSX.Element {
  return (
    <section class="ui-section">
      <header class="ui-section-head">
        <div class="ui-section-heading">
          <h2 class="ui-section-title">{title}</h2>
          {description ? <p class="ui-section-description">{description}</p> : null}
        </div>
        {action ? <div class="ui-section-action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export type StatusTone = "ok" | "warn" | "bad" | "neutral" | "info";

export interface ListRowProps {
  title: preact.ComponentChildren;
  meta?: string;
  status?: string;
  statusTone?: StatusTone;
  badges?: preact.ComponentChildren;
  actions?: preact.ComponentChildren;
  menu?: preact.ComponentChildren;
  compact?: boolean;
  progress?: number;
  icon?: IconName;
  onSelect?: () => void;
  selected?: boolean;
}

/** Compact one-line muted empty variant for sections inside lists. */
export function EmptyLine({ text }: { text: string }): preact.JSX.Element {
  return <p class="ui-empty-line">{text}</p>;
}

function statusDotClass(tone: StatusTone): string {
  if (tone === "ok") return "is-on";
  if (tone === "bad") return "is-bad";
  if (tone === "warn") return "is-warn";
  if (tone === "info") return "is-info";
  return "";
}

/** One standard row: optional icon, title, one meta line, status, action area. */
export function ListRow({
  title,
  meta,
  status,
  statusTone = "neutral",
  badges,
  actions,
  menu,
  compact,
  progress,
  icon,
  onSelect,
  selected,
}: ListRowProps): preact.JSX.Element {
  const inner = (
    <>
      {icon ? (
        <span class="ui-row-icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <div class="ui-row-main">
        <div class="ui-row-title">
          {status ? (
            <span class="ui-row-status">
              <span class={"status-dot " + statusDotClass(statusTone)} aria-hidden="true" />
              <span>{status}</span>
            </span>
          ) : null}
          <span class="ui-row-name">{title}</span>
          {badges}
        </div>
        {meta ? <p class="ui-row-meta">{meta}</p> : null}
        {progress !== undefined ? (
          <span class="ui-progress" aria-hidden="true">
            <span class="ui-progress-bar" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </span>
        ) : null}
      </div>
      {actions ? <div class="ui-row-actions">{actions}</div> : null}
      {menu ? <div class="ui-row-menu">{menu}</div> : null}
      {onSelect && !actions && !menu ? (
        <span class="ui-row-chevron" aria-hidden="true">
          <Icon name="chevron-right" size={17} />
        </span>
      ) : null}
    </>
  );
  const rowClass = "ui-row" + (compact ? " ui-row--compact" : "") + (selected ? " is-selected" : "");
  if (onSelect) {
    return (
      <li class={rowClass}>
        <button type="button" class="ui-row-select" aria-pressed={selected ? "true" : "false"} onClick={onSelect}>
          {inner}
        </button>
      </li>
    );
  }
  return <li class={rowClass}>{inner}</li>;
}

export interface FieldProps {
  label: string;
  value: string;
  copyable?: boolean;
}

export function Field({ label, value, copyable }: FieldProps): preact.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class="ui-field">
      <span class="ui-field-label">{label}</span>
      <div class="ui-field-value">
        <code>{value}</code>
        {copyable ? (
          <Button variant="ghost" size="sm" icon={copied ? "check" : "copy"} ariaLabel={`Copy ${label}`} onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): preact.JSX.Element {
  return (
    <div class="ui-state">
      <Callout tone="danger">{message}</Callout>
      {onRetry ? (
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function SectionSkeleton(): preact.JSX.Element {
  return (
    <div class="skeleton-list" aria-busy="true">
      <Skeleton width="70%" />
      <Skeleton width="100%" />
      <Skeleton width="88%" />
    </div>
  );
}

export function DetailBack({ onBack }: { onBack: () => void }): preact.JSX.Element {
  return (
    <Button variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>
      Back
    </Button>
  );
}

export { Icon };
