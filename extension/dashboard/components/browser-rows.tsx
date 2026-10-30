import { useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser, DashboardMcpClient } from "../../src/messages.js";
import { browserDetail, browserStatus, canRemoveBrowser, formatTimestamp, mcpClientStatus, tabCountText } from "../browsers-logic.js";
import { Badge, Button } from "./primitives.js";
import { ListRow } from "./layout.js";

/**
 * Browser and app rows shared by Profile (v2). The separation rule is
 * enforced here, not just in the page: a browser row never lists apps,
 * and an app row carries only one "Uses: <browser name>" meta line.
 * No session ids, no scope strings, no tokens are ever rendered.
 */

export function BrowserRow({
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
  const detail = browserDetail(browser);
  const status = browserStatus(browser);
  const meta = [tabCountText(browser), detail || null, `Added ${formatTimestamp(browser.createdAt)}`, `Last seen ${formatTimestamp(browser.lastSeenAt)}`]
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

export function McpClientRow({
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
    `Uses: ${browserName}`,
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
