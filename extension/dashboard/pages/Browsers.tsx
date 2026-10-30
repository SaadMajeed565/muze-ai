import { useCallback, useEffect, useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../../src/messages.js";
import { sendRequest } from "../logic.js";
import { attachedClients, browserDetail, browserStatus, canRemoveBrowser, formatTimestamp, mcpClientStatus, tabCountText } from "../browsers-logic.js";
import { Badge, Button, Callout, Card, EmptyState, Skeleton } from "../components/primitives.js";

const POLL_MS = 5000;

function StatusDot({ connected }: { connected: boolean }): preact.JSX.Element {
  return <span class={"status-dot " + (connected ? "is-on" : "")} aria-hidden="true" />;
}

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

  return (
    <li class="browser-row">
      <div class="browser-row-main">
        <div class="browser-row-title">
          <StatusDot connected={browser.connected} />
          {renaming ? (
            <span class="browser-rename">
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
          ) : (
            <>
              <strong>{browser.name}</strong>
              {browser.isDefault ? <Badge tone="info">Default</Badge> : null}
              {browser.isLocal ? <Badge tone="neutral">This browser</Badge> : null}
            </>
          )}
        </div>
        <p class="browser-row-meta">
          <span>{status}</span>
          <span aria-hidden="true"> · </span>
          <span>{tabCountText(browser)}</span>
          {detail ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{detail}</span>
            </>
          ) : null}
        </p>
        <p class="browser-row-meta">
          Added {formatTimestamp(browser.createdAt)} · Last seen {formatTimestamp(browser.lastSeenAt)}
        </p>
        <p class="browser-row-meta">
          {clients.length > 0
            ? `MCP clients: ${clients.map((client) => `${client.clientName}${client.live ? "" : " (not connected)"}`).join(", ")}`
            : "No MCP clients attached"}
        </p>
      </div>
      <div class="browser-row-actions">
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
            <span class="browser-confirm">
              <span>Remove this browser? Its token is revoked and its sessions close.</span>
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
      </div>
    </li>
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
  return (
    <li class="browser-row">
      <div class="browser-row-main">
        <div class="browser-row-title">
          <StatusDot connected={client.live} />
          <strong>{client.clientName}</strong>
        </div>
        <p class="browser-row-meta">
          <span>{status}</span>
          <span aria-hidden="true"> · </span>
          <span>Browser: {browserName}</span>
          <span aria-hidden="true"> · </span>
          <span>Scope: {client.scope || "—"}</span>
        </p>
        <p class="browser-row-meta">
          {client.live
            ? `Connected since ${formatTimestamp(client.connectedSince)} · Last activity ${formatTimestamp(client.lastActivityAt)}`
            : `Authorized ${formatTimestamp(client.authorizedSince)} · Last refresh ${formatTimestamp(client.lastRefreshedAt)}`}
        </p>
      </div>
      <div class="browser-row-actions">
        {confirming ? (
          <span class="browser-confirm">
            <span>Revoke this client? Its tokens stop working and live sessions close.</span>
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
        )}
      </div>
    </li>
  );
}

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
      <Card title="Browsers" description="Browsers attached to this account and the MCP clients using them.">
        <Callout tone="danger">
          {unreachable
            ? "The gateway is unreachable. Check the connection, then try again. No browser data is shown because none could be verified."
            : error}
        </Callout>
        <Button variant="primary" icon="refresh" onClick={() => void refresh()}>
          Try again
        </Button>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card title="Browsers">
        <div class="skeleton-list">
          <Skeleton width="70%" />
          <Skeleton width="100%" />
          <Skeleton width="88%" />
        </div>
      </Card>
    );
  }

  const browserName = (sessionId: string): string =>
    data.browsers.find((browser) => browser.sessionId === sessionId)?.name ?? "Unknown browser";

  return (
    <div class="browsers-page">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <Card
        title="Browsers"
        description="One row per browser. Disconnect closes its bridge only; Remove revokes its token. Tokens are never shown here."
        actions={
          <Button size="sm" icon="refresh" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      >
        {data.browsers.length === 0 ? (
          <EmptyState
            title="No browsers attached"
            description="Sign in from the Muze AI extension on a browser to attach it here."
          />
        ) : (
          <ul class="browser-list">
            {data.browsers.map((browser) => (
              <BrowserRow key={browser.sessionId} data={data} browser={browser} busy={busy} onAction={act} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="MCP sessions"
        description="AI clients authorized against these browsers. A live session shows when it connected and last acted; a client that is not live shows when it was authorized and last refreshed its token."
      >
        {data.mcpClients.length === 0 ? (
          <EmptyState
            title="No MCP sessions"
            description="No AI client has been authorized against this account yet."
          />
        ) : (
          <ul class="browser-list">
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
      </Card>
    </div>
  );
}
