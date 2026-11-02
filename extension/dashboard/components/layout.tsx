import type { IconName } from "../logic.js";
import { Button, Callout, CopyButton, Skeleton } from "./primitives.js";
import { Icon } from "./Icon.js";

/**
 * The dashboard's layout system in the reference language: Page is a
 * plain wrapper (the app bar carries the destination name), Section is
 * one small-caps heading plus rows, ListRow is one reference row —
 * icon tile, bold name, muted meta, status as dot + word, chevron.
 */

export interface PageProps {
  title: string;
  subtitle?: string;
  action?: preact.ComponentChildren;
  children?: preact.ComponentChildren;
}

export function Page({ action, children }: PageProps): preact.JSX.Element {
  return (
    <div class="ui-page">
      {action ? <div class="ui-page-action">{action}</div> : null}
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
          <h2 class="sec">{title}</h2>
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
  progress,
  icon,
  onSelect,
}: ListRowProps): preact.JSX.Element {
  const inner = (
    <>
      {icon ? (
        <span class="tile sm" style={{ background: "var(--surface2)", color: "var(--muted)" }} aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          {status ? (
            <span class="ui-row-status">
              <span class={"status-dot " + statusDotClass(statusTone)} aria-hidden="true" />
              <span>{status}</span>
            </span>
          ) : null}
          <span class="name">{title}</span>
          {badges}
        </div>
        {meta ? <div class="meta">{meta}</div> : null}
        {progress !== undefined ? (
          <span class="ui-progress" aria-hidden="true">
            <span class="ui-progress-bar" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </span>
        ) : null}
      </div>
      {actions ? <div class="ui-row-actions">{actions}</div> : null}
      {menu ? <div class="ui-row-menu">{menu}</div> : null}
      {onSelect && !actions && !menu ? (
        <span class="chev" aria-hidden="true">
          <Icon name="chevron-right" size={17} />
        </span>
      ) : null}
    </>
  );
  if (onSelect) {
    return (
      <button type="button" class="row" onClick={onSelect}>
        {inner}
      </button>
    );
  }
  return <div class="row" style={{ cursor: "default" }}>{inner}</div>;
}

export interface FieldProps {
  label: string;
  value: string;
  copyable?: boolean;
}

export function Field({ label, value, copyable }: FieldProps): preact.JSX.Element {
  // One copy implementation: the shared CopyButton, not a second
  // inline copy handler duplicating it.
  return (
    <div class="ui-field">
      <span class="ui-field-label">{label}</span>
      <div class="ui-field-value">
        <code>{value}</code>
        {copyable ? <CopyButton value={value} variant="ghost" size="sm" /> : null}
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

export { Icon };
