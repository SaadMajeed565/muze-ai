import { TABS, type IconName, type TabId } from "./logic.js";
import { NAV_GROUPS } from "./ui-logic.js";
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
 * Grouped navigation: a left rail with group headings on wide windows
 * (options page) and a compact bottom tab bar inside the side panel.
 * CSS keeps exactly one of them in the accessibility tree at a time.
 * There is no Tools entry: developer tool data is never rendered.
 */
export function Nav({ active, onChange, status, clients, pending }: NavProps): preact.JSX.Element {
  const allTabs = NAV_GROUPS.flatMap((group) => group.tabs);
  return (
    <>
      <nav class="rail" aria-label="Sections">
        <div class="rail-brand">
          <span class="brand">
            <Icon name="logo" size={22} class="brand-mark" />
            <span class="brand-name">Muze AI</span>
          </span>
        </div>
        {NAV_GROUPS.map((group) => (
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
                    {id === "activity" && pending > 0 ? (
                      <span class="rail-badge">{pending > 9 ? "9+" : pending}</span>
                    ) : null}
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
        {allTabs.map((id) => (
          <button
            key={id}
            type="button"
            class={"tabbar-item" + (active === id ? " is-on" : "")}
            aria-current={active === id ? "page" : undefined}
            onClick={() => onChange(id)}
          >
            <span class="tabbar-icon">
              <Icon name={tabIcon(id)} size={19} />
              {id === "activity" && pending > 0 ? <span class="tabbar-dot" aria-hidden="true" /> : null}
            </span>
            <span class="tabbar-label">{tabLabel(id)}</span>
            {id === "activity" && pending > 0 ? (
              <span class="sr-only">{pending} requests waiting for approval</span>
            ) : null}
          </button>
        ))}
      </nav>
    </>
  );
}
