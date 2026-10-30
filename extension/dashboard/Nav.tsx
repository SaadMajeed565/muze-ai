import { TABS, type IconName, type TabId } from "./logic.js";
import { NAV_TABS, navRailGroups } from "./ui-logic.js";
import { Icon } from "./components/Icon.js";
import { NavBadge } from "./components/shared.js";

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
 * Navigation (v3): exactly five destinations. Narrow windows get a
 * single-row bottom tab bar (five columns, one row, labels truncate).
 * Wide windows get a 232px left rail with two group headings — "This
 * browser" (Home, Tasks, Files) and "Account" (Connections, Account).
 * The pending-requests badge lives on Tasks only, with an accessible
 * label; there is no banner on every page. No Tools, Browsers,
 * Safety, or Activity destination: developer tool data is never
 * rendered.
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
        {navRailGroups().map((group) => (
          <div class="rail-group" key={group.label}>
            <span class="rail-group-label">{group.label}</span>
            <ul class="rail-links">
              {group.tabs.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    class={"rail-link" + (active === id ? " is-on" : "")}
                    aria-current={active === id ? "page" : undefined}
                    onClick={() => onChange(id)}
                  >
                    <Icon name={tabIcon(id)} size={17} />
                    <span>{tabLabel(id)}</span>
                    {id === "tasks" && pending > 0 ? <NavBadge count={pending} label="requests waiting" /> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
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
            </span>
            <span class="tabbar-label">{tabLabel(id)}</span>
            {id === "tasks" && pending > 0 ? (
              <NavBadge count={pending} label="requests waiting" />
            ) : null}
          </button>
        ))}
      </nav>
    </>
  );
}
