import { useCallback, useEffect, useState } from "preact/hooks";
import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { Appearance } from "../logic.js";
import { sendRequest } from "../logic.js";
import { Button, EmptyState } from "../components/primitives.js";
import { ErrorState, Field, Page, Section, SectionSkeleton } from "../components/layout.js";
import { BrowserRow, McpClientRow } from "../components/browser-rows.js";
import { PermissionsSections } from "../components/permissions-sections.js";

const POLL_MS = 5000;

export interface ProfilePageProps {
  state: DashboardState;
  busy: boolean;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  onModeChange: (mode: PermissionMode) => void;
  onPolicyPatch: (patch: Partial<PolicyConfig>) => void;
  onReadOnly: (enabled: boolean) => void;
  onKillSwitch: (engaged: boolean) => void;
  onGroupToggle: (group: string, enabled: boolean) => void;
  onSignOut: () => void;
  onReconnect: () => void;
  onDeleteAccount: () => void;
}

/**
 * Profile (v2): everything about the account, in short sections.
 * Browsers and apps are separate sections and never mixed: a browser
 * row never lists apps, and an app row carries only one
 * "Uses: <browser name>" meta line. No session ids, no scope strings,
 * no tokens, no developer fields are ever rendered.
 */
export function ProfilePage({
  state,
  busy,
  appearance,
  onAppearance,
  onModeChange,
  onPolicyPatch,
  onReadOnly,
  onKillSwitch,
  onGroupToggle,
  onSignOut,
  onReconnect,
  onDeleteAccount,
}: ProfilePageProps): preact.JSX.Element {
  const { gateway, snapshot } = state;
  const [data, setData] = useState<BrowsersDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsersBusy, setBrowsersBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/browsers/list" });
    if (response.ok && response.browsers) {
      setData(response.browsers);
      setError(null);
    } else {
      setError(response.error ?? "Could not load browsers");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(async (request: Record<string, unknown>): Promise<void> => {
    setBrowsersBusy(true);
    try {
      const response = await sendRequest(request);
      if (response.ok && response.browsers) {
        setData(response.browsers);
        setError(null);
      } else {
        setError(response.error ?? "That action failed");
      }
    } finally {
      setBrowsersBusy(false);
    }
  }, []);

  const signOut = (): void => {
    const ok = confirm("Sign out? This browser will be unlinked from your Muze account and the gateway connection will stop.");
    if (ok) onSignOut();
  };

  const deleteAccount = (): void => {
    const ok = confirm(
      "Permanently delete your Muze account? This removes your account, every attached browser, and every app authorisation. This cannot be undone.",
    );
    if (ok) onDeleteAccount();
  };

  const browserName = (sessionId: string): string =>
    data?.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? "Unknown browser";

  const connectionText = snapshot.bridgeStatus === "connected"
    ? "Connected"
    : gateway.authRequired
      ? "Sign in again"
      : "Not connected";

  return (
    <Page title="Profile" subtitle={gateway.email || "Your account"}>
      <Section title="Account">
        <div class="ui-row-inline">
          <span>Signed in as {gateway.email || "your account"}</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>
            Sign out
          </Button>
        </div>
        <div class="ui-row-inline">
          <span>Delete your account and everything attached to it.</span>
          <Button variant="ghost" size="sm" class="row-action-danger" disabled={busy} onClick={deleteAccount}>
            Delete account
          </Button>
        </div>
      </Section>

      <Section title="Connection">
        <div class="ui-row-inline">
          <span class={"status-dot " + (snapshot.bridgeStatus === "connected" ? "is-on" : "")} aria-hidden="true" />
          <span>{connectionText}</span>
          {snapshot.bridgeStatus === "disconnected" && gateway.enabled ? (
            <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
        </div>
      </Section>

      {error && !data ? (
        <ErrorState
          message={
            error === "gateway-unreachable"
              ? "The gateway is unreachable. Check the connection, then try again. No browser data is shown because none could be verified."
              : error
          }
          onRetry={() => void refresh()}
        />
      ) : !data ? (
        <SectionSkeleton />
      ) : (
        <>
          <Section
            title="Browsers"
            description="Disconnect closes its connection only; Remove signs it out completely."
          >
            {data.browsers.length === 0 ? (
              <EmptyState
                title="No browsers attached"
                description="Sign in from the Muze AI extension on a browser to attach it here."
              />
            ) : (
              <ul class="ui-list">
                {data.browsers.map((browser) => (
                  <BrowserRow key={browser.sessionId} data={data} browser={browser} busy={browsersBusy} onAction={act} />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Apps" description="AI apps authorised against this account.">
            {data.mcpClients.length === 0 ? (
              <EmptyState
                title="No apps connected"
                description="No AI app has been authorised against this account yet."
              />
            ) : (
              <ul class="ui-list">
                {data.mcpClients.map((client) => (
                  <McpClientRow
                    key={`${client.clientId}:${client.sessionId}`}
                    client={client}
                    browserName={browserName(client.sessionId)}
                    busy={browsersBusy}
                    onRevoke={() => void act({ type: "muze/mcp-sessions/revoke", clientId: client.clientId, sessionId: client.sessionId })}
                  />
                ))}
              </ul>
            )}
            <Field label="Connect a new app" value={gateway.mcpUrl} copyable />
          </Section>
        </>
      )}
      {error && data ? <ErrorState message={error} /> : null}

      <PermissionsSections
        state={state}
        busy={busy}
        appearance={appearance}
        onAppearance={onAppearance}
        onModeChange={onModeChange}
        onPolicyPatch={onPolicyPatch}
        onReadOnly={onReadOnly}
        onKillSwitch={onKillSwitch}
        onGroupToggle={onGroupToggle}
      />
    </Page>
  );
}
