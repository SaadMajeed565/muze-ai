import { useEffect, useState } from "preact/hooks";
import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { Appearance, IconName } from "../logic.js";
import { sendRequest } from "../logic.js";
import { Button } from "../components/primitives.js";
import { EmptyLine, Field, ListRow, Page, Section } from "../components/layout.js";
import { PlanCard } from "../components/shared.js";
import { AppearancePrivacy, PermissionsSafety } from "../components/permissions-sections.js";
import { useConfirm } from "../components/confirm.js";

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
  detail?: AccountDetail | null;
  onOpen?: (detail: AccountDetail | null) => void;
}

export type AccountDetail = "profile" | "permissions" | "appearance" | "plan" | "help";

const SUB_SCREENS: { id: AccountDetail; title: string; hint: string; icon: IconName }[] = [
  { id: "profile", title: "Profile", hint: "Your account details and danger zone", icon: "user" },
  { id: "permissions", title: "Permissions and safety", hint: "What the agent may do in this browser", icon: "shield" },
  { id: "appearance", title: "Appearance and privacy", hint: "Theme, and what Muze never touches", icon: "sliders" },
  { id: "plan", title: "Plan and billing", hint: "Free plan · up to 10 browsers", icon: "grid" },
  { id: "help", title: "Help and feedback", hint: "Support, privacy, and terms", icon: "help" },
];

export function accountDetailTitle(detail: AccountDetail | null | undefined): string | null {
  return SUB_SCREENS.find((screen) => screen.id === detail)?.title ?? null;
}

/**
 * Me: profile header, plan, settings rows, sign out, and a separated
 * danger zone. Sub-screens open full-screen and are backed by the app bar.
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
  detail: detailProp,
  onOpen,
}: AccountPageProps): preact.JSX.Element {
  const { gateway } = state;
  const [localDetail, setLocalDetail] = useState<AccountDetail | null>(null);
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  const confirm = useConfirm();

  const detail = detailProp !== undefined ? detailProp : localDetail;
  const open = onOpen ?? setLocalDetail;

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

  const signOut = async (): Promise<void> => {
    const ok = await confirm({
      title: "Sign out?",
      body: "This browser will be unlinked from your Muze account and the connection will stop.",
      confirmLabel: "Sign out",
      tone: "danger",
    });
    if (ok) onSignOut();
  };

  const deleteAccount = async (): Promise<void> => {
    const ok = await confirm({
      title: "Delete your Muze account?",
      body: "This removes your account, every attached browser, and every app authorisation. This cannot be undone.",
      confirmLabel: "Delete account",
      tone: "danger",
      requireText: "DELETE",
    });
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

  if (detail) {
    return (
      <div class="ui-page detail-page">
        {detail === "profile" ? (
          <>
            <Section title="Profile details">
              <Field label="Email" value={gateway.email || "Your account"} />
            </Section>
            <Section title="Account">
              <ul class="ui-list">
                <ListRow icon="logout" title="Sign out" meta="Unlink this browser from your account." onSelect={() => void signOut()} />
              </ul>
            </Section>

            <Section title="Danger zone" description="This cannot be undone.">
              <div class="danger-row">
                <div class="danger-copy">
                  <strong>Delete account</strong>
                  <span>Remove your account, every attached browser, and every app authorisation.</span>
                </div>
                <Button variant="danger" size="sm" icon="trash" disabled={busy} onClick={() => void deleteAccount()}>
                  Delete
                </Button>
              </div>
            </Section>
          </>
        ) : null}

        {detail === "permissions" ? (
          <>
            <p class="detail-note">Applies to this browser only. Changes save immediately.</p>
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
        ) : null}

        {detail === "appearance" ? <AppearancePrivacy appearance={appearance} onAppearance={onAppearance} /> : null}

        {detail === "plan" ? (
          <Section title="Free plan" description="Up to 10 browsers on one account.">
            {browsersData ? <PlanCard browserCount={browsersData.browsers.length} /> : <EmptyLine text="Loading your plan…" />}
          </Section>
        ) : null}

        {detail === "help" ? (
          <Section title="Help and feedback" description="Open a page in your browser.">
            {helpLinks.length === 0 ? (
              <EmptyLine text="Help pages are not available right now." />
            ) : (
              <ul class="ui-list">
                {helpLinks.map((link) => (
                  <ListRow
                    key={link.href}
                    icon="external"
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
        ) : null}
      </div>
    );
  }

  return (
    <Page title="Me" subtitle="Your account and this browser.">
      <div class="account-header">
        <span class="account-avatar" aria-hidden="true">
          {firstLetter}
        </span>
        <span class="account-identity">
          <span class="account-name">{gateway.email ? gateway.email.split("@")[0] : "Your account"}</span>
          <span class="account-email">{gateway.email || "Your account"}</span>
        </span>
      </div>

      {browsersData ? <PlanCard browserCount={browsersData.browsers.length} /> : null}

      <ul class="ui-list">
        {SUB_SCREENS.map((screen) => (
          <ListRow key={screen.id} icon={screen.icon} title={screen.title} meta={screen.hint} onSelect={() => open(screen.id)} />
        ))}
      </ul>

    </Page>
  );
}
