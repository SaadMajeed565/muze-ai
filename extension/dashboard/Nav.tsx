import { TABS, type TabDefinition, type TabId } from "./logic.js";

/**
 * Tasks nav entry, appended here rather than in logic.ts TABS (which this
 * section does not own). The cast + dedupe keep this working both before
 * and after the coordinator adds "tasks" to TabId/TABS in logic.ts: once
 * it is there, this append is skipped and no duplicate entry appears.
 */
const TASKS_TAB: TabDefinition = { id: "tasks" as TabId, label: "Tasks", icon: "clock" };
const NAV_TABS: TabDefinition[] = TABS.some((tab) => (tab.id as string) === "tasks") ? TABS : [...TABS, TASKS_TAB];
import { Icon } from "./components/Icon.js";

export interface NavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  status: "connected" | "disconnected";
  clients: number;
  pending: number;
}

function statusLabel(status: NavProps["status"], clients: number): string {
  if (status === "connected") return clients > 0 ? `${clients} client${clients === 1 ? "" : "s"}` : "Connected";
  return "Not connected";
}

/**
 * One component renders both navigation surfaces: a left rail on wide windows
 * (options page) and a bottom tab bar inside the side panel. CSS keeps exactly
 * one of them in the accessibility tree at a time.
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
          {NAV_TABS.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                class={"rail-link" + (active === tab.id ? " is-on" : "")}
                aria-current={active === tab.id ? "page" : undefined}
                onClick={() => onChange(tab.id)}
              >
                <Icon name={tab.icon} size={17} />
                <span>{tab.label}</span>
                {tab.id === "activity" && pending > 0 ? (
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
        {NAV_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            class={"tabbar-item" + (active === tab.id ? " is-on" : "")}
            aria-current={active === tab.id ? "page" : undefined}
            onClick={() => onChange(tab.id)}
          >
            <span class="tabbar-icon">
              <Icon name={tab.icon} size={19} />
              {tab.id === "activity" && pending > 0 ? <span class="tabbar-dot" aria-hidden="true" /> : null}
            </span>
            <span class="tabbar-label">{tab.label}</span>
            {tab.id === "activity" && pending > 0 ? (
              <span class="sr-only">{pending} requests waiting for approval</span>
            ) : null}
          </button>
        ))}
      </nav>
    </>
  );
}
