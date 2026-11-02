import { useEffect, useState } from "preact/hooks";
import type { PermissionMode } from "../../libs/security/index.js";
import type { BrowsersDashboard, DashboardState } from "../../src/messages.js";
import type { Appearance, IconName } from "../logic.js";
import { sendRequest } from "../logic.js";
import { Button } from "../components/primitives.js";
import { EmptyLine, ListRow, Page } from "../components/layout.js";
import { PlanCard } from "../components/shared.js";
import { AppearancePrivacy, PermissionsSafety } from "../components/permissions-sections.js";
import { useConfirm } from "../components/confirm.js";

export interface AccountPageProps {
  state: DashboardState;
  busy: boolean;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  onModeChange: (mode: PermissionMode) => void;
  onKillSwitch: (engaged: boolean) => void;
  onGroupToggle: (group: string, enabled: boolean) => void;
  onReset: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
  detail?: AccountDetail | null;
  onOpen?: (detail: AccountDetail | null) => void;
}

export type AccountDetail = "profile" | "permissions" | "appearance" | "plan";

const SUB_SCREENS: { id: AccountDetail; title: string; hint: string; icon: IconName }[] = [
  { id: "profile", title: "Profile", hint: "", icon: "user" },
  { id: "permissions", title: "Permissions and safety", hint: "Applies to this browser only", icon: "shield" },
  { id: "appearance", title: "Appearance and privacy", hint: "", icon: "sliders" },
  { id: "plan", title: "Plan and billing", hint: "Free plan", icon: "grid" },
];

export function accountDetailTitle(detail: AccountDetail | null | undefined): string | null {
  return SUB_SCREENS.find((screen) => screen.id === detail)?.title ?? null;
}

/**
 * Me in the reference language: identity header, plan row, four hub
 * rows (no Help and feedback screen), and sub-screens where the app
 * bar back action returns to Me. Profile is an identity header, a
 * Plan row, a full-width Sign out, and a hairline-separated danger
 * zone — no duplicated headings, no inner card inside the Plan screen.
 */
export function AccountPage({
  state,
  busy,
  appearance,
  onAppearance,
  onModeChange,
  onKillSwitch,
  onGroupToggle,
  onReset,
  onSignOut,
  onDeleteAccount,
  detail: detailProp,
  onOpen,
}: AccountPageProps): preact.JSX.Element {
  const { gateway } = state;
  const [browsersData, setBrowsersData] = useState<BrowsersDashboard | null>(null);
  const confirm = useConfirm();

  const detail = detailProp ?? null;
  const open = onOpen ?? ((): void => undefined);

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
  const browserCount = browsersData ? browsersData.browsers.length : 0;

  if (detail) {
    return (
      <div class="ui-page detail-page">
        {detail === "profile" ? (
          <>
            <div class="flex" style={{ gap: "12px" }}>
              <span class="tile" style={{ width: "44px", height: "44px", fontSize: "20px", background: "var(--blue-soft)", color: "var(--blue)", fontWeight: 800 }}>
                {firstLetter}
              </span>
              <div>
                <b style={{ fontSize: "15px" }}>{gateway.email || "Your account"}</b>
                <div class="muted" style={{ fontSize: "12px", marginTop: "2px" }}>Signed in</div>
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--border)", margin: "20px 0 16px" }} />
            <div>
              <div class="muted" style={{ fontSize: "12px" }}>Plan</div>
              <div style={{ marginTop: "4px" }}>Free plan · {browserCount} of 10 browsers</div>
            </div>
            <Button class="mt16" block onClick={() => void signOut()}>
              Sign out
            </Button>
            <div style={{ borderTop: "1px solid var(--border)", marginTop: "24px", paddingTop: "16px" }}>
              <Button variant="danger" block disabled={busy} onClick={() => void deleteAccount()}>
                Delete account
              </Button>
              <p class="muted" style={{ fontSize: "12px", marginTop: "8px" }}>
                Permanently deletes your account and its data. You will be asked to type DELETE to confirm.
              </p>
            </div>
          </>
        ) : null}

        {detail === "permissions" ? (
          <>
            <p class="detail-note">Applies to this browser only. Changes save immediately.</p>
            <PermissionsSafety
              state={state}
              busy={busy}
              onModeChange={onModeChange}
              onKillSwitch={onKillSwitch}
              onGroupToggle={onGroupToggle}
              onReset={onReset}
            />
          </>
        ) : null}

        {detail === "appearance" ? <AppearancePrivacy appearance={appearance} onAppearance={onAppearance} /> : null}

        {detail === "plan" ? (
          <div>
            <b>Free plan</b>
            <div class="muted">
              {browserCount} of 10 browsers · No usage meter, no billing backend — so no Upgrade button is shown.
            </div>
            <ul>
              <li>Up to 10 browsers per account</li>
              <li>Tasks, approvals, and files included</li>
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Page title="Me" subtitle="Your account and this browser.">
      <div class="card">
        <div class="flex">
          <span class="tile" style={{ background: "var(--blue-soft)", color: "var(--blue)", fontWeight: 800, fontSize: "20px" }}>
            {firstLetter}
          </span>
          <div>
            <b>{gateway.email || "Your account"}</b>
            <div class="muted" style={{ fontSize: "12px" }}>Signed in · Free plan</div>
          </div>
        </div>
      </div>

      {browsersData ? <PlanCard browserCount={browsersData.browsers.length} /> : <EmptyLine text="Loading your plan…" />}

      <div class="ui-list">
        {SUB_SCREENS.map((screen) => (
          <ListRow
            key={screen.id}
            icon={screen.icon}
            title={screen.title}
            meta={screen.hint || undefined}
            onSelect={() => open(screen.id)}
          />
        ))}
      </div>
    </Page>
  );
}
