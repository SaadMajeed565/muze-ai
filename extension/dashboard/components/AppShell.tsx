import { TABS, type TabId } from "../logic.js";
import { NAV_TABS } from "../ui-logic.js";
import { Icon } from "./Icon.js";
import type { IconName } from "../logic.js";
import { NavBadge } from "./shared.js";

export interface AppBarProps {
  title: string;
  icon?: IconName;
  subtitle?: string;
  connected: boolean;
  clients: number;
  pending: number;
  onApprovals: () => void;
  onBack?: () => void;
}

/** Sticky 56px app bar: context, connection status, approvals, back. */
export function AppBar({ title, subtitle, icon, connected, clients, pending, onApprovals, onBack }: AppBarProps): preact.JSX.Element {
  const statusLabel = connected ? (clients > 0 ? `${clients} app${clients === 1 ? "" : "s"}` : "Connected") : "Offline";
  return (
    <header class="appbar">
      <div class="appbar-inner">
        {onBack ? (
          <button type="button" class="icon-btn appbar-back" aria-label="Back" onClick={onBack}>
            <Icon name="arrow-left" size={21} />
          </button>
        ) : (
          <span class="appbar-brand" aria-hidden="true">
            <Icon name={icon ?? "logo"} size={27} />
          </span>
        )}
        <div class="appbar-titles">
          <span class="appbar-title">{title}</span>
          {subtitle ? <span class="appbar-subtitle">{subtitle}</span> : null}
        </div>
        <div class="appbar-actions">
          <span class={"status-pill" + (connected ? " is-online" : "")} title={statusLabel}>
            <span class="status-dot" aria-hidden="true" />
            <span class="status-pill-text">{connected ? "Online" : "Offline"}</span>
          </span>
          {pending > 0 ? (
            <button type="button" class="approvals-pill" aria-label={`${pending} request${pending === 1 ? "" : "s"} waiting`} onClick={onApprovals}>
              <span class="approvals-count">{pending > 9 ? "9+" : pending}</span>
              <span class="approvals-label">waiting</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export interface BottomNavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  pending: number;
}

/** One five-column bottom bar at every width. No rail, ever. */
export function BottomNav({ active, onChange, pending }: BottomNavProps): preact.JSX.Element {
  return (
    <nav class="tabbar bottomnav" aria-label="Sections">
      {NAV_TABS.map((id) => {
        const tab = TABS.find((entry) => entry.id === id);
        if (!tab) return null;
        const on = active === id;
        return (
          <button
            key={id}
            type="button"
            class={"tabbar-item" + (on ? " is-on" : "")}
            aria-current={on ? "page" : undefined}
            onClick={() => onChange(id)}
          >
            <span class="tabbar-icon">
              <Icon name={tab.icon} size={22} strokeWidth={on ? 2 : 1.7} />
            </span>
            <span class="tabbar-label">{tab.label}</span>
            {id === "home" && pending > 0 ? <NavBadge count={pending} label="requests waiting" /> : null}
          </button>
        );
      })}
    </nav>
  );
}
