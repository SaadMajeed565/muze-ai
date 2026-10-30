import { useEffect, useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { TabId } from "../logic.js";
import { sendRequest, setupChecklist, setupRemaining } from "../logic.js";
import { browserCounts } from "../browsers-logic.js";
import { homeNextAction } from "../ui-logic.js";
import { Icon } from "../components/Icon.js";
import { Button, EmptyState, Switch } from "../components/primitives.js";
import { Field, ListRow, Page, Section } from "../components/layout.js";

export interface OverviewPageProps {
  state: DashboardState;
  busy: boolean;
  onGatewayToggle: (enabled: boolean) => void;
  onReconnect: () => void;
  onOpenWizard: () => void;
  onNavigate: (tab: TabId) => void;
}

function Metric({ value, label, tone }: { value: string; label: string; tone?: "ok" | "warn" | "bad" }): preact.JSX.Element {
  return (
    <div class={"ui-metric" + (tone ? ` ui-metric--${tone}` : "")}>
      <span class="ui-metric-value">{value}</span>
      <span class="ui-metric-label">{label}</span>
    </div>
  );
}

/**
 * Home: status strip plus exactly one next action. Setup, appearance,
 * privacy and connect instructions live on their own pages/sections,
 * not here. No tool counts, no developer fields, no token controls.
 */
export function OverviewPage({
  state,
  busy,
  onGatewayToggle,
  onReconnect,
  onOpenWizard,
  onNavigate,
}: OverviewPageProps): preact.JSX.Element {
  const { snapshot, gateway, clients, onboarding } = state;
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  useEffect(() => {
    if (!gateway.signedIn) return;
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsersData(response.browsers);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway.signedIn]);
  const counts = browsersData ? browserCounts(browsersData) : null;
  const remaining = setupRemaining({
    signedIn: gateway.signedIn,
    connectedClients: snapshot.connectedClients,
    onboardingStep: onboarding.step,
  });
  const checklist = setupChecklist({
    signedIn: gateway.signedIn,
    connectedClients: snapshot.connectedClients,
    onboardingStep: onboarding.step,
  });
  const next = homeNextAction({
    signedIn: gateway.signedIn,
    setupRemaining: remaining,
    pendingApprovals: snapshot.pendingApprovals,
  });

  const nextAction =
    next === "setup" ? (
      <Button variant="primary" icon="arrow-right" disabled={busy} onClick={onOpenWizard}>
        Resume setup
      </Button>
    ) : next === "approvals" ? (
      <Button variant="primary" icon="alert" disabled={busy} onClick={() => onNavigate("tasks")}>
        Review requests
      </Button>
    ) : (
      <Button variant="primary" icon="arrow-right" disabled={busy} onClick={() => onNavigate("profile")}>
        Manage browsers
      </Button>
    );

  return (
    <Page
      title="Home"
      subtitle={gateway.signedIn ? gateway.email || "Signed in" : "Not signed in"}
      action={nextAction}
    >
      <Section title="Status">
        <div class="ui-metrics">
          <Metric
            value={snapshot.bridgeStatus === "connected" ? "Connected" : "Not connected"}
            label="Gateway"
            tone={snapshot.bridgeStatus === "connected" ? "ok" : "bad"}
          />
          <Metric
            value={counts ? `${counts.connected} of ${counts.attached}` : "—"}
            label="Browsers connected"
          />
          <Metric value={String(snapshot.connectedClients)} label="Apps connected" />
          <Metric
            value={String(snapshot.pendingApprovals)}
            label="Requests waiting"
            tone={snapshot.pendingApprovals > 0 ? "warn" : undefined}
          />
        </div>
        <div class="ui-row-inline">
          <span class={"status-dot " + (snapshot.bridgeStatus === "connected" ? "is-on" : "")} aria-hidden="true" />
          <span>
            {snapshot.bridgeStatus === "connected"
              ? "Connected to the gateway"
              : gateway.authRequired
                ? "Sign in again to reconnect"
                : "Not connected"}
          </span>
          {snapshot.bridgeStatus === "disconnected" && gateway.enabled && !gateway.authRequired ? (
            <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
          <Switch checked={gateway.enabled} disabled={busy} onToggle={onGatewayToggle} label="Browser connection" />
        </div>
      </Section>

      {remaining > 0 ? (
        <Section title="Finish setup" description={`${remaining} step${remaining === 1 ? "" : "s"} left`}>
          <ul class="ui-checklist">
            {checklist.map((item) => (
              <li key={item.id} class={item.done ? "is-done" : ""}>
                <span class="ui-checklist-mark" aria-hidden="true">
                  <Icon name={item.done ? "check" : "close"} size={12} strokeWidth={2.6} />
                </span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {gateway.signedIn ? (
        <>
          <Section
            title="Connected apps"
            description={clients.length ? `${clients.length} paired` : undefined}
            action={
              <Button variant="ghost" size="sm" icon="arrow-right" onClick={() => onNavigate("profile")}>
                Manage apps
              </Button>
            }
          >
            {clients.length === 0 ? (
              <EmptyState
                icon="link"
                title="No apps yet"
                description="Add the connection below to your AI app and it will show up here."
              />
            ) : (
              <ul class="ui-list">
                {clients.map((client) => (
                  <ListRow key={client.id} title={client.name} meta="Paired" />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Connect your AI app" description="Add this to your AI app, then approve it when it asks.">
            <Field label="Connection" value={gateway.mcpUrl} copyable />
          </Section>
        </>
      ) : (
        <Section title="Not signed in" description="Sign in to link this browser to your account." />
      )}
    </Page>
  );
}
