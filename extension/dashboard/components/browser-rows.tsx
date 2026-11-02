import { useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser } from "../../src/messages.js";
import { browserStatus, canRemoveBrowser, shortDate, tabCountText } from "../browsers-logic.js";
import type { DedupedApp } from "../ui-logic.js";
import { Badge, Button } from "./primitives.js";
import { BrandIcon } from "./brand-icons.js";
import { KebabMenu, Sheet } from "./shared.js";
import { useConfirm } from "./confirm.js";

/**
 * Browser and app rows for Connect — and the same rows on Home
 * (Home rows tap through to Connect and carry no menu). A browser row
 * never lists apps, and an app row carries only one "Uses: <browser
 * name>" meta line. No session ids, scopes, tokens, or unknown values
 * are rendered. Status is always a dot + a word.
 */

function statusDot(status: "Online" | "Offline" | "Connected" | "Not connected"): preact.JSX.Element {
  const on = status === "Online" || status === "Connected";
  return (
    <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "6px", flex: "none" }}>
      <span class={"status-dot " + (on ? "is-on" : "")} aria-hidden="true" />
      <span class={"status " + (on ? "ok" : "grey")}>{status}</span>
    </span>
  );
}

function browserMeta(browser: DashboardBrowser): string | null {
  const parts = [
    browser.isLocal ? "This browser" : null,
    tabCountText(browser),
    browser.os || null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function BrowserRowsList({
  data,
  withMenus,
  busy,
  onAction,
  onRowSelect,
}: {
  data: BrowsersDashboard;
  withMenus: boolean;
  busy: boolean;
  onAction?: (request: Record<string, unknown>) => void;
  onRowSelect?: (browser: DashboardBrowser) => void;
}): preact.JSX.Element {
  return (
    <>
      {data.browsers.map((browser) => (
        <BrowserRow
          key={browser.sessionId}
          data={data}
          browser={browser}
          withMenu={withMenus}
          busy={busy}
          onAction={onAction ?? ((): void => undefined)}
          onSelect={onRowSelect ? () => onRowSelect(browser) : undefined}
        />
      ))}
    </>
  );
}

export function BrowserRow({
  data,
  browser,
  withMenu,
  busy,
  onAction,
  onSelect,
}: {
  data: BrowsersDashboard;
  browser: DashboardBrowser;
  withMenu: boolean;
  busy: boolean;
  onAction: (request: Record<string, unknown>) => void;
  onSelect?: () => void;
}): preact.JSX.Element {
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(browser.name);
  const confirm = useConfirm();
  const status = browserStatus(browser);
  const meta = browserMeta(browser);

  const saveRename = (): void => {
    const cleaned = name.trim();
    if (!cleaned || cleaned === browser.name) {
      setRenameOpen(false);
      setName(browser.name);
      return;
    }
    setRenameOpen(false);
    onAction({ type: "muze/browsers/rename", sessionId: browser.sessionId, name: cleaned });
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: "Remove this browser?",
      body: "It will be signed out and its sessions will close. Apps connected through it will be disconnected.",
      confirmLabel: "Remove browser",
      tone: "danger",
    });
    if (ok) onAction({ type: "muze/browsers/remove", sessionId: browser.sessionId });
  };

  const inner = (
    <>
      <BrandIcon name={browser.browser || browser.name} small />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span class="name">
          {browser.name}
          {browser.isDefault ? <Badge tone="info">Default</Badge> : null}
          {browser.isLocal ? <Badge tone="neutral">This browser</Badge> : null}
        </span>
        {meta ? <><br /><span class="meta">{meta}</span></> : null}
      </span>
      {statusDot(status)}
      {withMenu ? (
        <KebabMenu
          ariaLabel={`Actions for ${browser.name}`}
          items={[
            { label: "Rename", onSelect: () => { setName(browser.name); setRenameOpen(true); } },
            ...(!browser.isDefault
              ? [{ label: "Set as default", onSelect: () => onAction({ type: "muze/browsers/set-default", sessionId: browser.sessionId }) }]
              : []),
            ...(browser.connected
              ? [{ label: "Disconnect", onSelect: () => onAction({ type: "muze/browsers/disconnect", sessionId: browser.sessionId }) }]
              : []),
            ...(canRemoveBrowser(data, browser.sessionId)
              ? [{ label: "Remove", danger: true, onSelect: () => void remove() }]
              : []),
          ]}
        />
      ) : null}
    </>
  );

  return (
    <>
      {onSelect ? (
        <button type="button" class="row" disabled={busy} onClick={onSelect}>
          {inner}
        </button>
      ) : (
        <div class="row" style={{ cursor: "default" }}>{inner}</div>
      )}
      <Sheet open={renameOpen} label="Rename browser" onClose={() => { setRenameOpen(false); setName(browser.name); }}>
        <label class="field-label" for={`rename-${browser.sessionId}`}>
          Browser name
          <input
            id={`rename-${browser.sessionId}`}
            class="text-input"
            type="text"
            value={name}
            disabled={busy}
            onInput={(event) => setName((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveRename();
              if (event.key === "Escape") {
                setRenameOpen(false);
                setName(browser.name);
              }
            }}
          />
        </label>
        <div class="sheet-actions">
          <Button variant="ghost" onClick={() => { setRenameOpen(false); setName(browser.name); }}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={saveRename}>
            Save
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/**
 * One row per app NAME (deduped). Revoking revokes every underlying
 * authorisation for that name.
 */
export function McpClientRow({
  group,
  browserName,
  onRevokeAll,
}: {
  group: DedupedApp;
  browserName: (sessionId: string) => string | null;
  onRevokeAll: () => void;
}): preact.JSX.Element {
  const confirm = useConfirm();
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

  const revoke = async (): Promise<void> => {
    const ok = await confirm({
      title: `Revoke ${group.name}?`,
      body: "All authorisations for this app are revoked, the app is signed out, and its sessions close.",
      confirmLabel: "Revoke access",
      tone: "danger",
    });
    if (ok) onRevokeAll();
  };

  return (
    <div class="row" style={{ cursor: "default" }}>
      <BrandIcon name={group.name} small />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span class="name">{group.name}</span>
        {meta ? <><br /><span class="meta">{meta}</span></> : null}
      </span>
      {statusDot(status)}
      <KebabMenu
        ariaLabel={`Actions for ${group.name}`}
        items={[{ label: "Revoke access", danger: true, onSelect: () => void revoke() }]}
      />
    </div>
  );
}
