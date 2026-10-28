import { useEffect, useRef } from "preact/hooks";
import type { PermissionMode } from "../libs/security/index.js";
import { ONBOARDING_STEPS, clampStep, onboardingProgress } from "./logic.js";
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
  /** Derived from dashboard state (snapshot.toolCount), never hardcoded. */
  toolCount: number;
  connectedClients: number;
  onStep: (step: number) => void;
  onModeChange: (mode: PermissionMode) => void;
  onSignIn: () => void;
  onFinish: () => void;
  onSkip: () => void;
}

function valueRows(toolCount: number): { icon: "key" | "shield" | "lock"; title: string; body: string }[] {
  return [
  {
    icon: "key",
    title: `${toolCount} browser tools`,
    body: "Read pages, fill forms, download files, search history and capture screenshots.",
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
  toolCount,
  connectedClients,
  onStep,
  onModeChange,
  onSignIn,
  onFinish,
  onSkip,
}: OnboardingProps): preact.JSX.Element {
  // Render is clamped, not just the progress math: an out-of-range persisted
  // step used to index ONBOARDING_STEPS[step - 1] directly and could crash
  // rendering. safeStep is the only step value the render below uses.
  const safeStep = clampStep(step);
  const heading = useRef<HTMLHeadingElement>(null);
  const progress = onboardingProgress(safeStep);

  useEffect(() => {
    heading.current?.focus();
  }, [safeStep]);

  const back = (): void => onStep(Math.max(1, safeStep - 1));
  const next = (): void => onStep(Math.min(ONBOARDING_STEPS.length, safeStep + 1));

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
        {safeStep < ONBOARDING_STEPS.length ? (
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

      <div class="onboarding-progress" aria-hidden="true">
        <span style={{ width: `${progress.percent}%` }} />
      </div>

      <main class="onboarding-body">
        <div class="onboarding-pane" key={ONBOARDING_STEPS[safeStep - 1].id}>
          <div class="onboarding-intro">
            <p class="eyebrow">{ONBOARDING_STEPS[safeStep - 1].caption}</p>
            <h1 tabindex={-1} ref={heading}>
              {safeStep === 1
                ? "Your browser, under your control."
                : safeStep === 2
                  ? "How far may the agent go?"
                  : safeStep === 3
                    ? "Connect this browser."
                    : "Point your AI client here."}
            </h1>
            <p class="lede">
              {safeStep === 1
                ? "Muze AI links this browser to your AI client over MCP. The agent only reaches what you allow, and every risky action can ask you first."
                : safeStep === 2
                  ? "Pick a starting point. You can change it, or override any single tool, at any time from the Permissions tab."
                  : safeStep === 3
                    ? "Sign in to link this browser to your Muze account. The token stays inside this extension and is only used to talk to the gateway."
                    : "Add the endpoint to your MCP client, then sign in and authorise the client — no token paste needed."}
            </p>
          </div>

          {error ? <Callout tone="danger">{error}</Callout> : null}

          {safeStep === 1 ? (
            <ul class="value-list">
              {valueRows(toolCount).map((row) => (
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

          {safeStep === 2 ? <PermissionLevelPicker variant="cards" mode={mode} disabled={busy} onChange={onModeChange} /> : null}

          {safeStep === 3 ? (
            <div class="connect-pane">
              {signedIn ? (
                <Callout tone="success" icon="check">
                  <strong>Connected as {email || "your account"}.</strong>
                  <span>
                    {connectedClients > 0
                      ? `${connectedClients} client${connectedClients === 1 ? "" : "s"} connected.`
                      : "This browser is linked. Add the endpoint to your client next."}
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

          {safeStep === 4 ? (
            signedIn ? (
              <div class="credential-list">
                <div class="credential">
                  <span class="credential-label">MCP endpoint</span>
                  <div class="credential-value">
                    <code>{mcpUrl}</code>
                    <CopyButton value={mcpUrl} label="Copy" />
                  </div>
                </div>
                <ol class="steps-list">
                  <li>Copy the endpoint above.</li>
                  <li>Add it to your MCP client as a remote server.</li>
                  <li>Sign in and authorise the client when it asks — the client is approved through your account, not by pasting a token.</li>
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
