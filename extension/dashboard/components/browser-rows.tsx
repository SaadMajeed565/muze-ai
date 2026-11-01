import { useState } from "preact/hooks";
import type { BrowsersDashboard, DashboardBrowser } from "../../src/messages.js";
import { browserOsName, browserStatus, canRemoveBrowser, shortDate, tabCountText } from "../browsers-logic.js";
import type { DedupedApp } from "../ui-logic.js";
import { Badge, Button } from "./primitives.js";
import { ListRow } from "./layout.js";
import { ActionSheet, Sheet } from "./shared.js";
import { useConfirm } from "./confirm.js";

/**
 * Browser and app rows for Connect. A browser row never lists apps, and
 * an app row carries only one "Uses: <browser name>" meta line. No
 * session ids, scopes, tokens, or unknown values are rendered.
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
  const [sheet, setSheet] = useState<"actions" | "rename" | null>(null);
  const [name, setName] = useState(browser.name);
  const confirm = useConfirm();
  const status = browserStatus(browser);
  const added = shortDate(browser.createdAt);
  const meta = [tabCountText(browser), browserOsName(browser) || null, added ? `added ${added}` : null]
    .filter(Boolean)
    .join(" · ");

  const saveRename = (): void => {
    const cleaned = name.trim();
    if (!cleaned || cleaned === browser.name) {
      setSheet(null);
      setName(browser.name);
      return;
    }
    setSheet(null);
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

  return (
    <>
      <ListRow
        compact
        icon="browser"
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
        menu={
          <Button
            variant="ghost"
            size="sm"
            icon="more"
            ariaLabel={`Actions for ${browser.name}`}
            disabled={busy}
            onClick={() => setSheet("actions")}
          />
        }
      />

      <ActionSheet
        open={sheet === "actions"}
        title={browser.name}
        onClose={() => setSheet(null)}
        items={[
          { label: "Rename", icon: "pencil", onSelect: () => setSheet("rename") },
          ...(!browser.isDefault
            ? [{ label: "Set as default", icon: "check" as const, onSelect: () => onAction({ type: "muze/browsers/set-default", sessionId: browser.sessionId }) }]
            : []),
          ...(browser.connected
            ? [{ label: "Disconnect", icon: "plug" as const, onSelect: () => onAction({ type: "muze/browsers/disconnect", sessionId: browser.sessionId }) }]
            : []),
          ...(canRemoveBrowser(data, browser.sessionId)
            ? [{ label: "Remove", icon: "trash" as const, danger: true, onSelect: () => void remove() }]
            : []),
        ]}
      />

      <Sheet open={sheet === "rename"} label="Rename browser" onClose={() => setSheet(null)}>
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
                setSheet(null);
                setName(browser.name);
              }
            }}
          />
        </label>
        <div class="sheet-actions">
          <Button variant="ghost" onClick={() => setSheet(null)}>
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
  busy,
  onRevokeAll,
}: {
  group: DedupedApp;
  browserName: (sessionId: string) => string | null;
  busy: boolean;
  onRevokeAll: () => void;
}): preact.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false);
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
    <>
      <ListRow
        compact
        icon="app"
        title={<strong>{group.name}</strong>}
        meta={meta || undefined}
        status={status}
        statusTone={group.live ? "ok" : "neutral"}
        menu={
          <Button
            variant="ghost"
            size="sm"
            icon="more"
            ariaLabel={`Actions for ${group.name}`}
            disabled={busy}
            onClick={() => setActionsOpen(true)}
          />
        }
      />
      <ActionSheet
        open={actionsOpen}
        title={group.name}
        onClose={() => setActionsOpen(false)}
        items={[{ label: "Revoke access", icon: "logout", danger: true, onSelect: () => void revoke() }]}
      />
    </>
  );
}
