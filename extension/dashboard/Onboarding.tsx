import { useEffect, useRef } from "preact/hooks";
import type { PermissionMode } from "../libs/security/index.js";
import { ONBOARDING_STEPS, clampStep, onboardingProgress, type OnboardingStepDefinition } from "./logic.js";
import { Icon } from "./components/Icon.js";
import { Button, Callout, CopyButton, EmptyState } from "./components/primitives.js";
import { PermissionLevelPicker } from "./PermissionLevelPicker.js";

export interface OnboardingProps {
  step: number;
  busy: boolean;
  error: string | null;
  mode: PermissionMode;
  signedIn: boolean;
  email: string;
  mcpUrl: string;
  connectedClients: number;
  onStep: (step: number) => void;
  onModeChange: (mode: PermissionMode) => void;
  onSignIn: () => void;
  onFinish: () => void;
  onSkip: () => void;
  /**
   * Compact wizard (v2): only permission level + connect an AI app.
   * The auth screen covers sign-in, so the old welcome and
   * connect-browser steps are skipped. Implemented by mapping the two
   * compact steps onto the old step 2 and step 4 content, so the
   * non-compact wizard is untouched.
   */
  compact?: boolean;
}

const COMPACT_STEPS: OnboardingStepDefinition[] = [
  { id: "level", title: "Permission level", caption: "How far may the agent go?" },
  { id: "client", title: "Connect your AI app", caption: "Point your AI client here." },
];

function valueRows(): { icon: "key" | "shield" | "lock"; title: string; body: string }[] {
  return [
  {
    icon: "key",
    title: "Your AI, working in your browser",
    body: "Read pages, fill forms, download files, search history and capture screenshots — only what you allow.",
  },
  {
    icon: "shield",
    title: "Three permission levels",
    body: "Reading, reversible actions or everything — you decide how far the agent can go.",
  },
  {
    icon: "lock",
    title: "Metadata-only network observer",
    body: "No cookies, no site storage, no request or response bodies, ever.",
  },
  ];
}

export function Onboarding({
  step,
  busy,
  error,
  mode,
  signedIn,
  email,
  mcpUrl,
  connectedClients,
  onStep,
  onModeChange,
  onSignIn,
  onFinish,
  onSkip,
  compact = false,
}: OnboardingProps): preact.JSX.Element {
  // Render is clamped, not just the progress math: an out-of-range persisted
  // step used to index ONBOARDING_STEPS[step - 1] directly and could crash
  // rendering. safeStep is the only step value the render below uses.
  const steps = compact ? COMPACT_STEPS : ONBOARDING_STEPS;
  const safeStep = compact ? Math.min(steps.length, Math.max(1, step)) : clampStep(step);
  const heading = useRef<HTMLHeadingElement>(null);
  const progress = compact
    ? { current: safeStep, total: steps.length, percent: Math.round((safeStep / steps.length) * 100) }
    : onboardingProgress(safeStep);
  // In compact mode, step 1 is the old level step and step 2 is the old
  // connect-app step; all content below keys off oldStep, so the
  // non-compact wizard renders exactly as before.
  const oldStep = compact ? (safeStep === 1 ? 2 : 4) : safeStep;

  useEffect(() => {
    heading.current?.focus();
  }, [safeStep]);

  const back = (): void => onStep(Math.max(1, safeStep - 1));
  const next = (): void => onStep(Math.min(steps.length, safeStep + 1));

  const footer = (
    <footer class="onboarding-foot">
      <div class="onboarding-foot-left">
        {safeStep > 1 ? (
          <Button variant="ghost" icon="arrow-left" onClick={back} disabled={busy}>
            Back
          </Button>
        ) : null}
      </div>
      <div class="onboarding-foot-right">
        {safeStep < steps.length ? (
          <>
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              Skip setup
            </Button>
            <Button variant="primary" icon="arrow-right" onClick={next} busy={busy}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              Skip for now
            </Button>
            <Button variant="primary" icon="check" onClick={onFinish} busy={busy}>
              Finish setup
            </Button>
          </>
        )}
      </div>
    </footer>
  );

  return (
    <div class="onboarding">
      <header class="onboarding-head">
        <div class="brand">
          <Icon name="logo" size={22} class="brand-mark" />
          <span class="brand-name">Muze AI</span>
        </div>
        <span class="onboarding-count">
          Step {progress.current} of {progress.total}
        </span>
      </header>

      <main class="onboarding-body">
        <div class="onboarding-pane" key={steps[safeStep - 1].id}>
          <div class="onboarding-intro">
            <p class="eyebrow">{steps[safeStep - 1].caption}</p>
            <h1 tabindex={-1} ref={heading}>
              {oldStep === 1
                ? "Your browser, under your control."
                : oldStep === 2
                  ? "How far may the agent go?"
                  : oldStep === 3
                    ? "Connect this browser."
                    : "Point your AI client here."}
            </h1>
            <p class="lede">
              {oldStep === 1
                ? "Muze AI links this browser to your AI app. The agent only reaches what you allow, and every risky action can ask you first."
                : oldStep === 2
                  ? "Pick a starting point. You can change it at any time from Account."
                  : oldStep === 3
                    ? "Sign in to link this browser to your Muze account."
                    : "Add the connection to your AI app, then sign in and authorise the app — no token paste needed."}
            </p>
          </div>

          {error ? <Callout tone="danger">{error}</Callout> : null}

          {oldStep === 1 ? (
            <ul class="value-list">
              {valueRows().map((row) => (
                <li key={row.title}>
                  <span class="value-icon" aria-hidden="true">
                    <Icon name={row.icon} size={17} />
                  </span>
                  <span class="value-text">
                    <strong>{row.title}</strong>
                    <span>{row.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {oldStep === 2 ? <PermissionLevelPicker variant="cards" mode={mode} disabled={busy} onChange={onModeChange} /> : null}

          {oldStep === 3 ? (
            <div class="connect-pane">
              {signedIn ? (
                <Callout tone="success" icon="check">
                  <strong>Connected as {email || "your account"}.</strong>
                  <span>
                    {connectedClients > 0
                      ? `${connectedClients} client${connectedClients === 1 ? "" : "s"} connected.`
                      : "This browser is linked. Add the connection to your app next."}
                  </span>
                </Callout>
              ) : (
                <>
                  <Button variant="primary" block icon="link" busy={busy} onClick={onSignIn}>
                    {busy ? "Opening…" : "Sign in / Create account"}
                  </Button>
                  <p class="hint">A browser window opens on the Muze site to confirm it is you.</p>
                </>
              )}
            </div>
          ) : null}

          {oldStep === 4 ? (
            signedIn ? (
              <div class="credential-list">
                <div class="credential">
                  <span class="credential-label">Connection</span>
                  <div class="credential-value">
                    <code>{mcpUrl}</code>
                    <CopyButton value={mcpUrl} label="Copy" />
                  </div>
                </div>
                <ol class="steps-list">
                  <li>Copy the connection above.</li>
                  <li>Add it to your AI app as a remote server.</li>
                  <li>Sign in and authorise the app when it asks — the app is approved through your account, not by pasting a token.</li>
                </ol>
              </div>
            ) : (
              <EmptyState
                icon="link"
                title="Connect an account first"
                description="Link this browser to a Muze account first."
                action={
                  <Button variant="primary" icon="link" busy={busy} onClick={onSignIn}>
                    Sign in / Create account
                  </Button>
                }
              />
            )
          ) : null}

          {footer}
        </div>
      </main>
    </div>
  );
}
