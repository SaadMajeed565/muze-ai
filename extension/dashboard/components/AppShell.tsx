import { TABS, type TabId } from "../logic.js";
import { NAV_TABS } from "../ui-logic.js";
import { Icon } from "./Icon.js";
import type { IconName } from "../logic.js";

export interface AppBarProps {
  title: string;
  icon?: IconName;
  subtitle?: string;
  connected: boolean;
  paused: boolean;
  browserCount: number | null;
  onPlan?: () => void;
  onBack?: () => void;
}

/**
 * Sticky app bar in the reference language: back chevron when a detail
 * is open, active-tab icon in the tile (never an M logo), title +
 * tagline, Free-plan donut tappable to Plan, stacked Online indicator
 * (wifi icon + word, amber when paused).
 */
export function AppBar({ title, subtitle, icon, connected, paused, browserCount, onPlan, onBack }: AppBarProps): preact.JSX.Element {
  const count = browserCount ?? 0;
  const filled = Math.max(0, Math.min(113.1, (count / 10) * 113.1));
  const onlineWord = paused ? "Paused" : connected ? "Online" : "Offline";
  const wifiColor = paused ? "var(--amber)" : connected ? "var(--green)" : "var(--muted2)";
  return (
    <header class="appbar">
      <div class="appbar-inner">
        {onBack ? (
          <button type="button" class="appbar-back" aria-label="Back" onClick={onBack}>
            <Icon name="chevron-left" size={18} />
          </button>
        ) : null}
        <span class="appbar-brand" aria-hidden="true">
          <Icon name={icon ?? "home"} size={18} />
        </span>
        <div class="appbar-titles">
          <span class="appbar-title">{title}</span>
          {subtitle ? <span class="appbar-subtitle">{subtitle}</span> : null}
        </div>
        <div class="appbar-actions">
          <button
            type="button"
            class="plan-donut-btn"
            aria-label={`Free plan: ${count} of 10 browsers`}
            onClick={onPlan}
          >
            <svg width="20" height="20" viewBox="0 0 44 44" aria-hidden="true">
              <circle cx="22" cy="22" r="18" fill="none" stroke="var(--border2)" stroke-width="4" />
              <circle
                cx="22"
                cy="22"
                r="18"
                fill="none"
                stroke="var(--fg)"
                stroke-width="4"
                stroke-linecap="round"
                stroke-dasharray={`${filled.toFixed(1)} 113.1`}
                transform="rotate(-90 22 22)"
              />
            </svg>
            <span class="plan-donut-label">
              <span class="plan-donut-count">{count} of 10</span>
              <span class="plan-donut-word">browsers</span>
            </span>
          </button>
          <span class="online-stack">
            <span style={{ color: wifiColor, display: "grid", placeItems: "center" }}>
              <Icon name="wifi" size={14} />
            </span>
            <span class="online-word">{onlineWord}</span>
          </span>
        </div>
      </div>
    </header>
  );
}

export interface BottomNavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

/** One five-column bottom bar at every width. No rail, ever. No badges. */
export function BottomNav({ active, onChange }: BottomNavProps): preact.JSX.Element {
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
          </button>
        );
      })}
    </nav>
  );
}
