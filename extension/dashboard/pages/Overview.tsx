import type { DashboardState } from "../../src/messages.js";
import type { Appearance, TabId } from "../logic.js";
import { setupChecklist, setupRemaining } from "../logic.js";
import { Icon } from "../components/Icon.js";
import { Badge, Button, Card, Chip, EmptyState, Segmented, Switch } from "../components/primitives.js";

export interface OverviewPageProps {
  state: DashboardState;
  busy: boolean;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  onGatewayToggle: (enabled: boolean) => void;
  onSignIn: () => void;
  onReconnect: () => void;
  onRotateToken: () => void;
  onSignOut: () => void;
  onOpenWizard: () => void;
  onNavigate: (tab: TabId) => void;
}

function Metric({ value, label, tone }: { value: string; label: string; tone?: string }): preact.JSX.Element {
  return (
    <div class={"metric" + (tone ? ` metric--${tone}` : "")}>
      <span class="metric-value">{value}</span>
      <span class="metric-label">{label}</span>
    </div>
  );
}

export function OverviewPage({
  state,
  busy,
  appearance,
  onAppearance,
  onGatewayToggle,
  onSignIn,
  onReconnect,
  onRotateToken,
  onSignOut,
  onOpenWizard,
  onNavigate,
}: OverviewPageProps): preact.JSX.Element {
  const { snapshot, gateway, clients, onboarding } = state;
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
  const rotateToken = (): void => {
    const ok = confirm("Rotate the device token? The current token stops working and this browser reconnects with a new one.");
    if (ok) {
      onRotateToken();
    }
  };

  const signOut = (): void => {
    const ok = confirm("Sign out? This browser will be unlinked from your Muze account and the gateway connection will stop.");
    if (ok) onSignOut();
  };

  return (
    <div class="stack">
      {remaining > 0 ? (
        <Card title="Finish setup" icon="clock" description={`${remaining} step${remaining === 1 ? "" : "s"} left`}>
          <ul class="checklist">
            {checklist.map((item) => (
              <li key={item.id} class={item.done ? "is-done" : ""}>
                <span class="checklist-mark" aria-hidden="true">
                  <Icon name={item.done ? "check" : "close"} size={12} strokeWidth={2.6} />
                </span>
                <span>{item.label}</span>
                <span class="sr-only">{item.done ? "done" : "not done"}</span>
              </li>
            ))}
          </ul>
          <Button variant="primary" icon="arrow-right" disabled={busy} onClick={onOpenWizard}>
            Resume setup
          </Button>
        </Card>
      ) : null}

      <Card title="Status">
        <div class="metrics">
          <Metric
            value={snapshot.bridgeStatus === "connected" ? "Live" : "Off"}
            label="Gateway"
            tone={snapshot.bridgeStatus === "connected" ? "ok" : "bad"}
          />
          <Metric value={String(snapshot.connectedClients)} label="Clients" />
          <Metric value={`${snapshot.allowedTools.length}/${snapshot.toolCount}`} label="Tools allowed" />
          <Metric
            value={String(snapshot.pendingApprovals)}
            label="Approvals"
            tone={snapshot.pendingApprovals > 0 ? "warn" : undefined}
          />
        </div>

        <div class="row-between">
          <div class="connection">
            <span class={"status-dot " + (snapshot.bridgeStatus === "connected" ? "is-on" : "")} aria-hidden="true" />
            <span>
              {snapshot.bridgeStatus === "connected"
                ? "Connected to the gateway"
                : gateway.authRequired
                  ? "Sign in again to reconnect"
                  : "Gateway link is down"}
            </span>
          </div>
          <div class="row-inline">
            {gateway.authRequired ? (
              <Button variant="primary" size="sm" icon="link" disabled={busy} onClick={onSignIn}>
                Sign in again
              </Button>
            ) : snapshot.bridgeStatus === "disconnected" && gateway.enabled ? (
              <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={onReconnect}>
                Reconnect
              </Button>
            ) : null}
            <Switch checked={gateway.enabled} disabled={busy} onToggle={onGatewayToggle} label="Bridge" />
          </div>
        </div>
      </Card>

      {!gateway.signedIn ? (
        <Card title="Connect your browser" description="Sign in to create the endpoint your AI client uses.">
          <Button variant="primary" block icon="link" disabled={busy} onClick={onSignIn}>
            Sign in / Create account
          </Button>
        </Card>
      ) : (
        <>
          <Card
            title="Endpoint"
            actions={
              <Switch checked={gateway.enabled} disabled={busy} onToggle={onGatewayToggle} label="Enabled" />
            }
          >
            <div class="credential">
              <span class="credential-label">MCP URL</span>
              <div class="credential-value">
                <code>{gateway.mcpUrl}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="copy"
                  ariaLabel="Copy MCP URL"
                  disabled={busy}
                  onClick={() => void navigator.clipboard.writeText(gateway.mcpUrl)}
                />
              </div>
            </div>
            <div class="row-inline">
              <Button variant="secondary" size="sm" disabled={busy} onClick={rotateToken}>
                Rotate device token
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>
                Sign out
              </Button>
            </div>
            <p class="hint">Add the MCP URL to your client, then sign in and authorise it — no token paste needed. {gateway.email}</p>
          </Card>

          <Card title="Connected clients" description={clients.length ? `${clients.length} paired` : undefined}>
            {clients.length === 0 ? (
              <EmptyState
                icon="link"
                title="No clients yet"
                description="Add the endpoint to Claude or another MCP client and it will show up here."
                action={
                  <Button variant="secondary" size="sm" onClick={() => onNavigate("activity")}>
                    View activity
                  </Button>
                }
              />
            ) : (
              <ul class="client-list">
                {clients.map((client) => (
                  <li key={client.id}>
                    <span class="client-name">{client.name}</span>
                    <Badge tone="success">{client.transport}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card title="Appearance" description="Follows your system setting by default.">
        <Segmented
          ariaLabel="Appearance"
          value={appearance}
          options={[
            { id: "system", label: "System" },
            { id: "light", label: "Light" },
            { id: "dark", label: "Dark" },
          ]}
          onChange={onAppearance}
        />
      </Card>

      <Card title="Privacy" icon="lock" description="What Muze AI never touches.">
        <ul class="privacy-list">
          <li>Never reads cookies, saved passwords or browsing history unless an allowed tool asks for them.</li>
          <li>Never reads localStorage, IndexedDB or other site storage.</li>
          <li>Never sees request or response bodies — the observer keeps method, URL, status and timing only.</li>
          <li>Never clears browsing data, cookies or cache on its own.</li>
          <li>Runs locally: pages are read only when a tool call asks for them.</li>
        </ul>
        <div class="row-between">
          <span class="hint">Full details in SECURITY.md.</span>
          <Chip onClick={() => onNavigate("permissions")}>Review permissions</Chip>
        </div>
      </Card>

    </div>
  );
}
