import { useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser } from "../../src/messages.js";
import { browserOsName, browserStatus, canRemoveBrowser, shortDate, tabCountText } from "../browsers-logic.js";
import type { DedupedApp } from "../ui-logic.js";
import { Badge, Button } from "./primitives.js";
import { ListRow } from "./layout.js";
import { MenuButton } from "./shared.js";

/**
 * Browser and app rows for Connections (v3). The separation rule is
 * enforced here, not just in the page: a browser row never lists apps,
 * and an app row carries only one "Uses: <browser name>" meta line.
 * No session ids, no scope strings, no tokens are ever rendered, and
 * unknown values are omitted — never "Unknown", never a guess.
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
  const status = browserStatus(browser);
  const added = shortDate(browser.createdAt);
  const meta = [tabCountText(browser), browserOsName(browser) || null, added ? `added ${added}` : null]
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

  const menuItems = [
    { label: "Rename", onSelect: () => setRenaming(true) },
    ...(!browser.isDefault
      ? [{ label: "Set as default", onSelect: () => onAction({ type: "muze/browsers/set-default", sessionId: browser.sessionId }) }]
      : []),
    ...(browser.connected
      ? [{ label: "Disconnect", onSelect: () => onAction({ type: "muze/browsers/disconnect", sessionId: browser.sessionId }) }]
      : []),
    ...(canRemoveBrowser(data, browser.sessionId)
      ? [{ label: "Remove", danger: true, onSelect: () => setConfirmingRemove(true) }]
      : []),
  ];

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
      compact
      title={
        <>
          <strong>{browser.name}</strong>
          {browser.isDefault ? <Badge tone="info">Default</Badge> : null}
          {browser.isLocal ? <Badge tone="neutral">This browser</Badge> : null}
        </>
      }
      meta={meta || undefined}
      status={status}
      statusTone={browser.connected ? "ok" : "neutral"}
      menu={<MenuButton items={menuItems} ariaLabel={`Actions for ${browser.name}`} />}
      actions={
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
        ) : undefined
      }
    />
  );
}

/**
 * One row per app NAME (deduped). Revoking revokes every underlying
 * authorisation for that name — the caller loops over every
 * clientId + sessionId in group.clients. The Revoke action itself is
 * a neutral ghost inside the "..." menu; red appears only on the
 * confirmation dialog's confirm button.
 */
export function McpClientRow({
  group,
  browserName,
  busy,
  onRevokeAll,
}: {
  group: DedupedApp;
  browserName: (sessionId: string) => string | null;
  busy: boolean;
  onRevokeAll: () => void;
}): preact.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const status = group.live ? "Connected" : "Not connected";
  const browserNames = [...new Set(group.clients.map((client) => browserName(client.sessionId)).filter((name): name is string => name !== null))];
  const liveSince = group.clients.filter((client) => client.live).map((client) => client.connectedSince).filter((v): v is number => v !== null);
  const authorisedSince = group.clients.map((client) => client.authorizedSince).filter((v): v is number => v !== null);
  const since = group.live
    ? (liveSince.length ? shortDate(Math.min(...liveSince)) : null)
    : (authorisedSince.length ? shortDate(Math.min(...authorisedSince)) : null);
  const meta = [
    browserNames.length ? `Uses: ${browserNames.join(", ")}` : null,
    group.live ? (since ? `Connected since ${since}` : null) : (since ? `Authorised ${since}` : null),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListRow
      compact
      title={<strong>{group.name}</strong>}
      meta={meta || undefined}
      status={status}
      statusTone={group.live ? "ok" : "neutral"}
      menu={<MenuButton items={[{ label: "Revoke", danger: false, onSelect: () => setConfirming(true) }]} ariaLabel={`Actions for ${group.name}`} />}
      actions={
        confirming ? (
          <span class="ui-confirm">
            <span>
              Revoke {group.name}? All authorisations for this app are revoked, the app is signed out and its sessions close.
            </span>
            <Button size="sm" class="row-action-danger" disabled={busy} onClick={onRevokeAll}>
              Revoke
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : undefined
      }
    />
  );
}
