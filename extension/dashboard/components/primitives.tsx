import { useRef, useState } from "preact/hooks";
import type { IconName } from "../logic.js";
import { Icon } from "./Icon.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps {
  children?: preact.ComponentChildren;
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit";
  disabled?: boolean;
  busy?: boolean;
  block?: boolean;
  icon?: IconName;
  class?: string;
  title?: string;
  ariaLabel?: string;
  ariaHasPopup?: "menu" | "dialog";
  ariaExpanded?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function Button({
  children,
  variant = "secondary",
  size = "md",
  type = "button",
  disabled,
  busy,
  block,
  icon,
  class: className,
  title,
  ariaLabel,
  ariaHasPopup,
  ariaExpanded,
  onClick,
}: ButtonProps): preact.JSX.Element {
  return (
    <button
      type={type}
      class={[
        "btn",
        `btn--${variant}`,
        `btn--${size}`,
        block ? "btn--block" : "",
        busy ? "is-busy" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      title={title}
      onClick={onClick}
    >
      {busy ? <span class="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children ? <span class="btn-label">{children}</span> : null}
    </button>
  );
}

export interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  label?: preact.ComponentChildren;
  onToggle: (next: boolean) => void;
}

/** A real `role="switch"` control — replaces the checkbox/pill markup. */
export function Switch({ checked, disabled, label, onToggle }: SwitchProps): preact.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      class="switch"
      onClick={() => {
        if (disabled) return;
        onToggle(!checked);
      }}
    >
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
      {label !== undefined ? <span class="switch-label">{label}</span> : null}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  hint?: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (next: T) => void;
}

/** Radio-group segmented control with roving tabindex and arrow-key selection. */
export function Segmented<T extends string>({
  options,
  value,
  disabled,
  ariaLabel,
  onChange,
}: SegmentedProps<T>): preact.JSX.Element {
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, key: string): number => {
    const last = options.length - 1;
    if (key === "ArrowRight" || key === "ArrowDown") return from >= last ? 0 : from + 1;
    if (key === "ArrowLeft" || key === "ArrowUp") return from <= 0 ? last : from - 1;
    if (key === "Home") return 0;
    if (key === "End") return last;
    return from;
  };

  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const next = move(index, event.key);
    if (next === index) return;
    event.preventDefault();
    onChange(options[next].id);
    items.current[next]?.focus();
  };

  return (
    <div class="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(node) => {
              items.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabindex={selected ? 0 : -1}
            class={"segment" + (selected ? " is-on" : "")}
            disabled={disabled}
            title={option.hint}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface CardProps {
  title?: preact.ComponentChildren;
  description?: preact.ComponentChildren;
  actions?: preact.ComponentChildren;
  icon?: IconName;
  class?: string;
  children?: preact.ComponentChildren;
}

export function Card({ title, description, actions, icon, class: className, children }: CardProps): preact.JSX.Element {
  return (
    <section class={["card", className ?? ""].filter(Boolean).join(" ")}>
      {title || actions ? (
        <header class="card-head">
          <div class="card-head-text">
            {title ? (
              <h2 class="card-title">
                {icon ? <Icon name={icon} size={16} class="card-title-icon" /> : null}
                <span>{title}</span>
              </h2>
            ) : null}
            {description ? <p class="card-description">{description}</p> : null}
          </div>
          {actions ? <div class="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export interface SearchInputProps {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  onChange: (next: string) => void;
}

export function SearchInput({ value, placeholder, ariaLabel, onChange }: SearchInputProps): preact.JSX.Element {
  return (
    <div class="search-input">
      <Icon name="search" size={15} class="search-input-icon" />
      <input
        type="text"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onInput={(event) => onChange((event.target as HTMLInputElement).value)}
      />
      {value ? (
        <button type="button" class="search-input-clear" aria-label="Clear search" onClick={() => onChange("")}>
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export interface ChipProps {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: preact.ComponentChildren;
}

export function Chip({ active, disabled, onClick, children }: ChipProps): preact.JSX.Element {
  return (
    <button
      type="button"
      class={"chip" + (active ? " is-on" : "")}
      aria-pressed={active ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  tone?: BadgeTone;
  children: preact.ComponentChildren;
}

export function Badge({ tone = "neutral", children }: BadgeProps): preact.JSX.Element {
  return <span class={`badge badge--${tone}`}>{children}</span>;
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: preact.ComponentChildren;
}

export function EmptyState({ icon = "check", title, description, action }: EmptyStateProps): preact.JSX.Element {
  return (
    <div class="empty">
      <span class="empty-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p class="empty-title">{title}</p>
      {description ? <p class="empty-description">{description}</p> : null}
      {action}
    </div>
  );
}

export interface CalloutProps {
  tone?: "info" | "warning" | "danger" | "success";
  icon?: IconName;
  children: preact.ComponentChildren;
}

export function Callout({ tone = "info", icon, children }: CalloutProps): preact.JSX.Element {
  const fallback: Record<string, IconName> = { info: "alert", warning: "alert", danger: "alert", success: "check" };
  return (
    <div class={`callout callout--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon ?? fallback[tone]} size={16} class="callout-icon" />
      <div class="callout-body">{children}</div>
    </div>
  );
}

export function Skeleton({ width = "100%" }: { width?: string }): preact.JSX.Element {
  return <span class="skeleton" style={{ width }} aria-hidden="true" />;
}

export interface CopyButtonProps {
  value: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function CopyButton({ value, label = "Copy", variant = "secondary", size = "sm" }: CopyButtonProps): preact.JSX.Element {
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
    <Button variant={variant} size={size} icon={copied ? "check" : "copy"} onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </Button>
  );
}
