import { TABS, type IconName, type TabId } from "./logic.js";
import { NAV_TABS } from "./ui-logic.js";
import { Icon } from "./components/Icon.js";

export interface NavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  status: "connected" | "disconnected";
  clients: number;
  pending: number;
}

function statusLabel(status: NavProps["status"], clients: number): string {
  if (status === "connected") return clients > 0 ? `${clients} app${clients === 1 ? "" : "s"} connected` : "Connected";
  return "Not connected";
}

function tabLabel(id: TabId): string {
  return TABS.find((tab) => tab.id === id)?.label ?? id;
}

function tabIcon(id: TabId): IconName {
  return TABS.find((tab) => tab.id === id)?.icon ?? "home";
}

/**
 * Navigation (v2): exactly four tabs on every breakpoint — a left rail
 * on wide windows (options page) and a single-row bottom tab bar in
 * the side panel. The tab bar never wraps: with four columns it has
 * one row by construction, and labels truncate rather than wrap.
 * The pending-requests badge lives on Tasks, where approvals are
 * answered. There is no Tools, Browsers, Safety, or Activity tab:
 * developer tool data is never rendered.
 */
export function Nav({ active, onChange, status, clients, pending }: NavProps): preact.JSX.Element {
  return (
    <>
      <nav class="rail" aria-label="Sections">
        <div class="rail-brand">
          <span class="brand">
            <Icon name="logo" size={22} class="brand-mark" />
            <span class="brand-name">Muze AI</span>
          </span>
        </div>
        <ul class="rail-links">
          {NAV_TABS.map((id) => (
            <li key={id}>
              <button
                type="button"
                class={"rail-link" + (active === id ? " is-on" : "")}
                aria-current={active === id ? "page" : undefined}
                onClick={() => onChange(id)}
              >
                <Icon name={tabIcon(id)} size={17} />
                <span>{tabLabel(id)}</span>
                {id === "tasks" && pending > 0 ? (
                  <span class="rail-badge">{pending > 9 ? "9+" : pending}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <div class="rail-foot">
          <span class={"status-dot " + (status === "connected" ? "is-on" : "")} aria-hidden="true" />
          <span>{statusLabel(status, clients)}</span>
        </div>
      </nav>

      <nav class="tabbar" aria-label="Sections">
        {NAV_TABS.map((id) => (
          <button
            key={id}
            type="button"
            class={"tabbar-item" + (active === id ? " is-on" : "")}
            aria-current={active === id ? "page" : undefined}
            onClick={() => onChange(id)}
          >
            <span class="tabbar-icon">
              <Icon name={tabIcon(id)} size={19} />
              {id === "tasks" && pending > 0 ? <span class="tabbar-dot" aria-hidden="true" /> : null}
            </span>
            <span class="tabbar-label">{tabLabel(id)}</span>
            {id === "tasks" && pending > 0 ? (
              <span class="sr-only">{pending} requests waiting for approval</span>
            ) : null}
          </button>
        ))}
      </nav>
    </>
  );
}
