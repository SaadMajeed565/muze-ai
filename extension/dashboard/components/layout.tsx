import { useEffect, useState } from "preact/hooks";
import { Button, Callout, Skeleton } from "./primitives.js";
import { Icon } from "./Icon.js";

/**
 * The dashboard's layout system: Page, Section, ListRow, Field, and
 * per-section states. Every page uses Page (which renders the page
 * title exactly once); no page builds its own header. Colours come
 * from styles.css tokens only; status is always dot + word.
 */

export interface PageProps {
  title: string;
  subtitle?: string;
  action?: preact.ComponentChildren;
  children?: preact.ComponentChildren;
}

export function Page({ title, subtitle, action, children }: PageProps): preact.JSX.Element {
  return (
    <div class="ui-page">
      <header class="ui-page-head">
        <div>
          <h1 class="ui-page-title">{title}</h1>
          {subtitle ? <p class="ui-page-subtitle">{subtitle}</p> : null}
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
        <div>
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
  onSelect?: () => void;
  selected?: boolean;
}

function statusDotClass(tone: StatusTone): string {
  if (tone === "ok") return "is-on";
  if (tone === "bad") return "is-bad";
  if (tone === "warn") return "is-warn";
  return "";
}

/** One standard row: title, one meta line, status dot + word, one action area. */
export function ListRow({ title, meta, status, statusTone = "neutral", badges, actions, onSelect, selected }: ListRowProps): preact.JSX.Element {
  const inner = (
    <>
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
      </div>
      {actions ? <div class="ui-row-actions">{actions}</div> : null}
    </>
  );
  if (onSelect) {
    return (
      <li class={"ui-row" + (selected ? " is-selected" : "")}>
        <button type="button" class="ui-row-select" aria-pressed={selected ? "true" : "false"} onClick={onSelect}>
          {inner}
        </button>
      </li>
    );
  }
  return <li class="ui-row">{inner}</li>;
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
        <Button variant="primary" icon="refresh" onClick={onRetry}>
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

/** Detail rail: on wide windows a 280px rail beside the list; on narrow windows a full-panel view with a back action. */
export function useNarrow(maxWidth = 899): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [maxWidth]);
  return narrow;
}

export function DetailBack({ onBack }: { onBack: () => void }): preact.JSX.Element {
  return (
    <Button variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>
      Back
    </Button>
  );
}

export { Icon };
