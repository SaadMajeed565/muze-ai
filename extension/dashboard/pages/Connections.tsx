import { useCallback, useEffect, useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { TabId } from "../logic.js";
import { sendRequest } from "../logic.js";
import { dedupeAppsByName } from "../ui-logic.js";
import { Button, Segmented } from "../components/primitives.js";
import { EmptyLine, ErrorState, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";
import { BrowserRow, McpClientRow } from "../components/browser-rows.js";
import { AddAppSheet, Sheet } from "../components/shared.js";

const POLL_MS = 5000;

export type ConnectionsSegment = "browsers" | "apps";

export interface ConnectionsPageProps {
  state: DashboardState;
  busy: boolean;
  /** Segment remembered by the caller while the panel is open. */
  segment: ConnectionsSegment;
  onSegment: (segment: ConnectionsSegment) => void;
  onNavigate: (tab: TabId) => void;
}

/**
 * Connections (v3): browsers and apps, separate and never mixed. A
 * browser row never lists apps; an app row carries only one "Uses:
 * <browser name>" meta line and never lists other apps. Apps are
 * deduped by name (one row per name); revoking a row revokes every
 * underlying authorisation for that name. No ids, tokens, or
 * developer fields are ever rendered; unknown values are omitted.
 */
export function ConnectionsPage({ state, busy, segment, onSegment, onNavigate }: ConnectionsPageProps): preact.JSX.Element {
  const { gateway } = state;
  const [data, setData] = useState<BrowsersDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsersBusy, setBrowsersBusy] = useState(false);
  const [addBrowserOpen, setAddBrowserOpen] = useState(false);
  const [addAppOpen, setAddAppOpen] = useState(false);

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

  const revokeAll = useCallback(async (group: ReturnType<typeof dedupeAppsByName>[number]): Promise<void> => {
    setBrowsersBusy(true);
    try {
      for (const client of group.clients) {
        const response = await sendRequest({
          type: "muze/mcp-sessions/revoke",
          clientId: client.clientId,
          sessionId: client.sessionId,
        });
        if (!response.ok) {
          setError(response.error ?? "That action failed");
          break;
        }
      }
      await refresh();
    } finally {
      setBrowsersBusy(false);
    }
  }, [refresh]);

  const browserName = (sessionId: string): string | null =>
    data?.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? null;

  const deduped = data ? dedupeAppsByName(data.mcpClients) : [];
  const connectedApps = deduped.filter((group) => group.live);
  const previousApps = deduped.filter((group) => !group.live);

  return (
    <Page title="Connections" subtitle="Browsers and apps on your account.">
      <Segmented
        ariaLabel="Connections"
        value={segment}
        options={[
          { id: "browsers", label: `Browsers (${data ? data.browsers.length : 0})` },
          { id: "apps", label: `Apps (${deduped.length})` },
        ]}
        onChange={onSegment}
      />

      {error && !data ? (
        <ErrorState
          message={
            error === "gateway-unreachable"
              ? "The connection is unreachable. Check the connection, then try again. No browser data is shown because none could be verified."
              : error
          }
          onRetry={() => void refresh()}
        />
      ) : !data ? (
        <SectionSkeleton />
      ) : segment === "browsers" ? (
        <Section title="Browsers" description="Disconnect closes its connection only; Remove signs it out completely.">
          {data.browsers.length === 0 ? (
            <EmptyLine text="No browsers attached yet." />
          ) : (
            <ul class="ui-list">
              {data.browsers.map((browser) => (
                <BrowserRow key={browser.sessionId} data={data} browser={browser} busy={browsersBusy} onAction={act} />
              ))}
            </ul>
          )}
          {data.browsers.length === 1 ? (
            <p class="ui-row-meta">
              To remove your last browser, delete your account from{" "}
              <Button variant="ghost" size="sm" onClick={() => onNavigate("account")}>
                Account
              </Button>
              .
            </p>
          ) : null}
          <ListRow
            compact
            title="Add a browser"
            meta="Sign in with the same account in another browser."
            onSelect={() => setAddBrowserOpen(true)}
          />
        </Section>
      ) : (
        <Section
          title="Apps"
          description="AI apps authorised against this account."
          action={
            <Button variant="ghost" size="sm" icon="arrow-right" disabled={busy} onClick={() => setAddAppOpen(true)}>
              Add app
            </Button>
          }
        >
          {deduped.length === 0 ? (
            <EmptyLine text="No apps connected yet." />
          ) : (
            <>
              {connectedApps.length > 0 ? (
                <ul class="ui-list">
                  {connectedApps.map((group) => (
                    <McpClientRow
                      key={group.name}
                      group={group}
                      browserName={browserName}
                      busy={browsersBusy}
                      onRevokeAll={() => void revokeAll(group)}
                    />
                  ))}
                </ul>
              ) : null}
              {previousApps.length > 0 ? (
                <details class="ui-disclosure">
                  <summary class="ui-disclosure-summary">Previously connected</summary>
                  <ul class="ui-list">
                    {previousApps.map((group) => (
                      <McpClientRow
                        key={group.name}
                        group={group}
                        browserName={browserName}
                        busy={browsersBusy}
                        onRevokeAll={() => void revokeAll(group)}
                      />
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </Section>
      )}
      {error && data ? <ErrorState message={error} /> : null}

      <Sheet open={addBrowserOpen} label="Add a browser" onClose={() => setAddBrowserOpen(false)}>
        <ol class="steps-list">
          <li>Install the Muze AI extension in that browser.</li>
          <li>Sign in with the same account you use here.</li>
          <li>That browser will appear in the browsers list.</li>
        </ol>
        <Button variant="primary" onClick={() => setAddBrowserOpen(false)}>
          Close
        </Button>
      </Sheet>
      <AddAppSheet open={addAppOpen} onClose={() => setAddAppOpen(false)} mcpUrl={gateway.mcpUrl} />
    </Page>
  );
}
