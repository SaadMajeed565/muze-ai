import { useEffect, useState } from "preact/hooks";
import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { Appearance } from "../logic.js";
import { sendRequest } from "../logic.js";
import { Button } from "../components/primitives.js";
import { DetailBack, EmptyLine, Field, ListRow, Page, Section, useNarrow } from "../components/layout.js";
import { PlanCard } from "../components/shared.js";
import { AppearancePrivacy, PermissionsSafety } from "../components/permissions-sections.js";

export interface AccountPageProps {
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
  onDeleteAccount: () => void;
}

type SubScreen = "profile" | "plan" | "permissions" | "appearance" | "help";

const SUB_SCREENS: { id: SubScreen; title: string; hint: string }[] = [
  { id: "profile", title: "Profile", hint: "Email, sign out, delete account" },
  { id: "plan", title: "Plan and billing", hint: "Your current plan" },
  { id: "permissions", title: "Permissions and safety", hint: "What the agent may do in this browser" },
  { id: "appearance", title: "Appearance and privacy", hint: "Theme and what Muze never touches" },
  { id: "help", title: "Help and feedback", hint: "Support, privacy, and terms" },
];

/**
 * Account (v3, replaces Profile): a hub of short rows. Narrow
 * windows open a sub-screen as a full panel with a back action; wide
 * windows show hub + selected sub-screen side by side (default:
 * Profile). No sub-screen scrolls much beyond 1.5 viewports. Delete
 * account lives ONLY at the bottom of Profile, separated and
 * muted-danger. There are no Security or Notifications screens, no
 * invented name (avatar circle = first letter of the email + email
 * only), no usage numbers, and no Upgrade button anywhere.
 */
export function AccountPage({
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
  onDeleteAccount,
}: AccountPageProps): preact.JSX.Element {
  const { gateway } = state;
  const narrow = useNarrow();
  const [selected, setSelected] = useState<SubScreen | null>(null);
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);

  // Wide windows default to the Profile sub-screen; narrow windows
  // start on the hub and open a sub-screen only after a tap.
  useEffect(() => {
    if (!narrow && selected === null) setSelected("profile");
  }, [narrow, selected]);

  useEffect(() => {
    if (!gateway.signedIn) return;
    let cancelled = false;
    void sendRequest({ type: "muze/browsers/list" }).then((response) => {
      if (!cancelled && response.ok && response.browsers) setBrowsersData(response.browsers);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway.signedIn]);

  const signOut = (): void => {
    const ok = confirm("Sign out? This browser will be unlinked from your Muze account and the connection will stop.");
    if (ok) onSignOut();
  };

  const deleteAccount = (): void => {
    const ok = confirm(
      "Permanently delete your Muze account? This removes your account, every attached browser, and every app authorisation. This cannot be undone.",
    );
    if (ok) onDeleteAccount();
  };

  const firstLetter = (gateway.email || "?").trim().charAt(0).toUpperCase() || "?";
  const base = gateway.url.replace(/\/$/, "");
  const helpLinks = base
    ? [
        { label: "Support", href: `${base}/support` },
        { label: "Privacy policy", href: `${base}/privacy` },
        { label: "Terms of service", href: `${base}/terms` },
      ]
    : [];

  const detail = (sub: SubScreen): preact.JSX.Element => {
    if (sub === "profile") {
      return (
        <>
          <Section title="Profile">
            <Field label="Email" value={gateway.email || "Your account"} />
            <div class="ui-row-inline">
              <span>Signed in as {gateway.email || "your account"}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>
                Sign out
              </Button>
            </div>
          </Section>
          <Section title="Delete account">
            <div class="ui-row-inline">
              <span>Delete your account and everything attached to it.</span>
              <Button variant="ghost" size="sm" class="row-action-danger" disabled={busy} onClick={deleteAccount}>
                Delete account
              </Button>
            </div>
          </Section>
        </>
      );
    }
    if (sub === "plan") {
      return (
        <Section title="Plan and billing">
          <p class="ui-row-meta">You're on the Free plan. Up to 10 browsers.</p>
        </Section>
      );
    }
    if (sub === "permissions") {
      return (
        <>
          <p class="ui-row-meta">Permissions and safety. Applies to this browser only.</p>
          <PermissionsSafety
            state={state}
            busy={busy}
            onModeChange={onModeChange}
            onPolicyPatch={onPolicyPatch}
            onReadOnly={onReadOnly}
            onKillSwitch={onKillSwitch}
            onGroupToggle={onGroupToggle}
          />
        </>
      );
    }
    if (sub === "appearance") {
      return <AppearancePrivacy appearance={appearance} onAppearance={onAppearance} />;
    }
    return (
      <Section title="Help and feedback">
        {helpLinks.length === 0 ? (
          <EmptyLine text="Help pages are not available right now." />
        ) : (
          <ul class="ui-list">
            {helpLinks.map((link) => (
              <ListRow
                key={link.href}
                title={
                  <a class="ui-row-link" href={link.href} target="_blank" rel="noreferrer">
                    {link.label}
                  </a>
                }
              />
            ))}
          </ul>
        )}
      </Section>
    );
  };

  const hub = (
    <div class="account-hub">
      <div class="account-header">
        <span class="account-avatar" aria-hidden="true">
          {firstLetter}
        </span>
        <span class="account-email">{gateway.email || "Your account"}</span>
      </div>
      {browsersData ? <PlanCard browserCount={browsersData.browsers.length} /> : null}
      <ul class="ui-list">
        {SUB_SCREENS.map((screen) => (
          <ListRow
            key={screen.id}
            compact
            title={screen.title}
            meta={screen.hint}
            onSelect={() => setSelected(screen.id)}
            selected={!narrow && selected === screen.id}
          />
        ))}
      </ul>
    </div>
  );

  // Narrow: hub, or one full-panel sub-screen with a back action.
  if (narrow) {
    return (
      <Page title="Account" subtitle="Your account and this browser.">
        {selected ? (
          <>
            <DetailBack onBack={() => setSelected(null)} />
            {detail(selected)}
          </>
        ) : (
          hub
        )}
      </Page>
    );
  }

  return (
    <Page title="Account" subtitle="Your account and this browser.">
      <div class="ui-grid">
        <div>{hub}</div>
        <aside class="ui-rail" aria-label="Account detail">
          {selected ? detail(selected) : null}
        </aside>
      </div>
    </Page>
  );
}
