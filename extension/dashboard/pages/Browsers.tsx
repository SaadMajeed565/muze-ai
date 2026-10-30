import { useCallback, useEffect, useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../../src/messages.js";
import { sendRequest } from "../logic.js";
import { attachedClients, browserDetail, browserStatus, canRemoveBrowser, formatTimestamp, mcpClientStatus, tabCountText } from "../browsers-logic.js";
import { Badge, Button, EmptyState } from "../components/primitives.js";
import { ErrorState, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";

const POLL_MS = 5000;

function BrowserRow({
  data,
  browser,
  busy,
  onAction,
}: {
  data: BrowsersDashboard;
  browser: DashboardBrowser;
  busy: boolean;
  onAction: (request: Record<string, unknown>) => void;
}): preact.JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(browser.name);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const clients = attachedClients(data, browser.sessionId);
  const detail = browserDetail(browser);
  const status = browserStatus(browser);
  const meta = [
    tabCountText(browser),
    detail || null,
    `Added ${formatTimestamp(browser.createdAt)}`,
    `Last seen ${formatTimestamp(browser.lastSeenAt)}`,
    clients.length > 0
      ? `Apps: ${clients.map((client) => `${client.clientName}${client.live ? "" : " (not connected)"}`).join(", ")}`
      : "No apps attached",
  ]
    .filter(Boolean)
    .join(" · ");

  const saveRename = (): void => {
    const cleaned = name.trim();
    if (!cleaned || cleaned === browser.name) {
      setRenaming(false);
      setName(browser.name);
      return;
    }
    setRenaming(false);
    onAction({ type: "muze/browsers/rename", sessionId: browser.sessionId, name: cleaned });
  };

  const actions = (
    <>
      {!browser.isDefault ? (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => onAction({ type: "muze/browsers/set-default", sessionId: browser.sessionId })}
        >
          Set as default
        </Button>
      ) : null}
      <Button size="sm" disabled={busy} onClick={() => setRenaming(true)}>
        Rename
      </Button>
      {browser.connected ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onAction({ type: "muze/browsers/disconnect", sessionId: browser.sessionId })}
        >
          Disconnect
        </Button>
      ) : null}
      {canRemoveBrowser(data, browser.sessionId) ? (
        confirmingRemove ? (
          <span class="ui-confirm">
            <span>Remove this browser? It will be signed out and its sessions close.</span>
            <Button
              size="sm"
              class="row-action-danger"
              disabled={busy}
              onClick={() => onAction({ type: "muze/browsers/remove", sessionId: browser.sessionId })}
            >
              Remove
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirmingRemove(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" class="row-action-danger" disabled={busy} onClick={() => setConfirmingRemove(true)}>
            Remove
          </Button>
        )
      ) : null}
    </>
  );

  if (renaming) {
    return (
      <li class="ui-row">
        <div class="ui-row-main">
          <span class="ui-rename">
            <input
              type="text"
              value={name}
              disabled={busy}
              aria-label="Browser name"
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveRename();
                if (event.key === "Escape") {
                  setRenaming(false);
                  setName(browser.name);
                }
              }}
            />
            <Button size="sm" variant="primary" disabled={busy} onClick={saveRename}>
              Save
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setRenaming(false);
                setName(browser.name);
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      </li>
    );
  }

  return (
    <ListRow
      title={
        <>
          <strong>{browser.name}</strong>
          {browser.isDefault ? <Badge tone="info">Default</Badge> : null}
          {browser.isLocal ? <Badge tone="neutral">This browser</Badge> : null}
        </>
      }
      meta={meta}
      status={status}
      statusTone={browser.connected ? "ok" : "neutral"}
      actions={actions}
    />
  );
}

function McpClientRow({
  client,
  browserName,
  busy,
  onRevoke,
}: {
  client: DashboardMcpClient;
  browserName: string;
  busy: boolean;
  onRevoke: () => void;
}): preact.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const status = mcpClientStatus(client);
  const meta = [
    `Browser: ${browserName}`,
    client.live
      ? `Connected since ${formatTimestamp(client.connectedSince)} · Last activity ${formatTimestamp(client.lastActivityAt)}`
      : `Authorised ${formatTimestamp(client.authorizedSince)} · Last refresh ${formatTimestamp(client.lastRefreshedAt)}`,
  ].join(" · ");
  return (
    <ListRow
      title={<strong>{client.clientName}</strong>}
      meta={meta}
      status={status}
      statusTone={client.live ? "ok" : "neutral"}
      actions={
        confirming ? (
          <span class="ui-confirm">
            <span>Revoke this app? It will be signed out and its sessions close.</span>
            <Button size="sm" class="row-action-danger" disabled={busy} onClick={onRevoke}>
              Revoke
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" class="row-action-danger" disabled={busy} onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )
      }
    />
  );
}

/**
 * Browsers, re-skinned onto Page / Section / ListRow. Every feature
 * from the multi-browser build is kept: rename, set as default,
 * disconnect, remove, and the apps attached to each browser. No
 * session ids, no scope strings, no tokens are ever rendered.
 */
export function BrowsersPage(): preact.JSX.Element {
  const [data, setData] = useState<BrowsersDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const act = useCallback(
    async (request: Record<string, unknown>): Promise<void> => {
      setBusy(true);
      try {
        const response = await sendRequest(request);
        if (response.ok && response.browsers) {
          setData(response.browsers);
          setError(null);
        } else {
          setError(response.error ?? "That action failed");
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (error && !data) {
    const unreachable = error === "gateway-unreachable";
    return (
      <Page title="Browsers" subtitle="Browsers attached to this account and the apps using them.">
        <ErrorState
          message={
            unreachable
              ? "The gateway is unreachable. Check the connection, then try again. No browser data is shown because none could be verified."
              : error
          }
          onRetry={() => void refresh()}
        />
      </Page>
    );
  }

  if (!data) {
    return (
      <Page title="Browsers" subtitle="Browsers attached to this account and the apps using them.">
        <SectionSkeleton />
      </Page>
    );
  }

  const browserName = (sessionId: string): string =>
    data.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? "Unknown browser";

  return (
    <Page
      title="Browsers"
      subtitle="Browsers attached to this account and the apps using them."
      action={
        <Button size="sm" icon="refresh" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      {error ? <ErrorState message={error} /> : null}
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
              <BrowserRow key={browser.sessionId} data={data} browser={browser} busy={busy} onAction={act} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Connected apps"
        description="AI apps authorised against these browsers. A connected app shows when it connected and last acted; an app that is not connected shows when it was authorised and last refreshed."
      >
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
                busy={busy}
                onRevoke={() => void act({ type: "muze/mcp-sessions/revoke", clientId: client.clientId, sessionId: client.sessionId })}
              />
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
