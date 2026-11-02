import { useCallback, useEffect, useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { TabId } from "../logic.js";
import { sendRequest } from "../logic.js";
import { dedupeAppsByName } from "../ui-logic.js";
import { Button, Segmented } from "../components/primitives.js";
import { EmptyLine, ErrorState, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";
import { BrowserRowsList, McpClientRow } from "../components/browser-rows.js";
import { AddAppSheet, Sheet } from "../components/shared.js";
import { showToast } from "../components/feedback.js";

const POLL_MS = 5000;

/** Friendly copy for post-load failures, same mapping as initial load. */
function friendlyError(error: string): string {
  return error === "gateway-unreachable"
    ? "The connection is unreachable. Check your network, then try again. No browser data is shown because none could be verified."
    : error;
}

export type ConnectionsSegment = "browsers" | "apps";

export interface ConnectionsPageProps {
  state: DashboardState;
  busy: boolean;
  segment: ConnectionsSegment;
  onSegment: (segment: ConnectionsSegment) => void;
  onNavigate: (tab: TabId) => void;
}

/**
 * Connect: browsers and apps, separate and never mixed. Apps dedupe by
 * name; revoking a row revokes every underlying authorisation. The
 * browser rows are the same component Home renders, so the two lists
 * cannot drift.
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
    // Visibility-gated like App's poll: pause while hidden, refresh
    // immediately and restart on show. The interval never changes.
    let timer = 0;
    const poll = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    const restart = (): void => {
      clearInterval(timer);
      timer = window.setInterval(poll, POLL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void refresh();
        restart();
      } else {
        clearInterval(timer);
      }
    };
    restart();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const act = useCallback(async (request: Record<string, unknown>): Promise<void> => {
    setBrowsersBusy(true);
    try {
      const response = await sendRequest(request);
      if (response.ok && response.browsers) {
        setData(response.browsers);
        setError(null);
        showToast("Browser updated");
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
      let revoked = 0;
      const failed: string[] = [];
      for (const client of group.clients) {
        const response = await sendRequest({
          type: "muze/mcp-sessions/revoke",
          clientId: client.clientId,
          sessionId: client.sessionId,
        });
        if (response.ok) revoked += 1;
        else failed.push(client.clientName);
      }
      await refresh();
      if (failed.length === 0) {
        showToast(`${group.name} revoked`);
      } else {
        // Refresh above clears errors, so report failures after it.
        // Never claim a full revocation when only part succeeded.
        setError(`Could not revoke ${failed.join(", ")}`);
        if (revoked > 0) showToast(`${revoked} of ${group.clients.length} revoked`);
      }
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
    <Page title="Connect" subtitle="Browsers and AI apps on your account.">
      <div class="page-controls">
        <Segmented
          ariaLabel="Browsers or apps"
          value={segment}
          options={[
            { id: "browsers", label: `Browsers (${data ? data.browsers.length : 0})` },
            { id: "apps", label: `Apps (${deduped.length})` },
          ]}
          onChange={onSegment}
        />
      </div>

      {error && !data ? (
        <ErrorState
          message={friendlyError(error)}
          onRetry={() => void refresh()}
        />
      ) : !data ? (
        <SectionSkeleton />
      ) : segment === "browsers" ? (
        <Section title="Browsers" description="Disconnect closes the connection. Remove signs the browser out completely.">
          {data.browsers.length === 0 ? (
            <EmptyLine text="No browsers attached yet." />
          ) : (
            <BrowserRowsList data={data} withMenus busy={browsersBusy} onAction={act} />
          )}
          <div class="ui-list">
            <ListRow
              icon="plus"
              title="Add a browser"
              meta="Sign in with the same account in another browser."
              onSelect={() => setAddBrowserOpen(true)}
            />
          </div>
          {data.browsers.length === 1 ? (
            <p class="ui-row-meta">
              To remove your last browser, delete your account from{" "}
              <Button variant="ghost" size="sm" onClick={() => onNavigate("account")}>
                Me
              </Button>
              .
            </p>
          ) : null}
        </Section>
      ) : (
        <Section
          title="Apps"
          description="AI apps authorised against this account."
          action={
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAddAppOpen(true)}>
              + Add app
            </Button>
          }
        >
          {deduped.length === 0 ? (
            <EmptyLine text="No apps connected yet." />
          ) : (
            <>
              {connectedApps.length > 0 ? (
                <div class="ui-list">
                  {connectedApps.map((group) => (
                    <McpClientRow
                      key={group.name}
                      group={group}
                      browserName={browserName}
                      onRevokeAll={() => void revokeAll(group)}
                    />
                  ))}
                </div>
              ) : null}
              {previousApps.length > 0 ? (
                <details class="ui-disclosure">
                  <summary class="ui-disclosure-summary">Previously connected ({previousApps.length})</summary>
                  <div class="ui-list">
                    {previousApps.map((group) => (
                      <McpClientRow
                        key={group.name}
                        group={group}
                        browserName={browserName}
                        onRevokeAll={() => void revokeAll(group)}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </Section>
      )}
      {error && data ? <ErrorState message={friendlyError(error)} /> : null}

      <Sheet open={addBrowserOpen} label="Add a browser" onClose={() => setAddBrowserOpen(false)}>
        <ol class="steps-list">
          <li>Install the Muze AI extension in that browser.</li>
          <li>Sign in with the same account you use here.</li>
          <li>That browser will appear in this list automatically.</li>
        </ol>
        <Button variant="primary" block onClick={() => setAddBrowserOpen(false)}>
          Got it
        </Button>
      </Sheet>
      <AddAppSheet open={addAppOpen} onClose={() => setAddAppOpen(false)} mcpUrl={gateway.mcpUrl} />
    </Page>
  );
}
