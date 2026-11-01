import { useEffect, useRef } from "preact/hooks";
import type { PermissionMode } from "../libs/security/index.js";
import { Icon } from "./components/Icon.js";
import { Button, Callout } from "./components/primitives.js";
import { Field } from "./components/layout.js";
import { PermissionLevelPicker } from "./PermissionLevelPicker.js";

export interface OnboardingProps {
  step: number;
  busy: boolean;
  error: string | null;
  mode: PermissionMode;
  mcpUrl: string;
  connectedClients: number;
  onStep: (step: number) => void;
  onModeChange: (mode: PermissionMode) => void;
  onFinish: () => void;
  onSkip: () => void;
}

const STEPS = [
  { id: "level", eyebrow: "Step 1 of 2", title: "How far may the agent go?", body: "Pick a starting point. You can change it any time from Me → Permissions and safety." },
  { id: "client", eyebrow: "Step 2 of 2", title: "Point your AI app here.", body: "Add this connection to your AI app, then authorise it through your account. No token paste." },
];

/** Two-step setup: permission level, then connect an AI app. */
export function Onboarding({
  step,
  busy,
  error,
  mode,
  mcpUrl,
  connectedClients,
  onStep,
  onModeChange,
  onFinish,
  onSkip,
}: OnboardingProps): preact.JSX.Element {
  const safeStep = Math.min(STEPS.length, Math.max(1, Math.round(Number.isFinite(step) ? step : 1)));
  const current = STEPS[safeStep - 1];
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, [safeStep]);

  return (
    <div class="onboarding">
      <header class="onboarding-head">
        <div class="brand">
          <Icon name="logo" size={26} class="brand-mark" />
          <span class="brand-name">Muze AI</span>
        </div>
        <span class="onboarding-count">{safeStep} of {STEPS.length}</span>
      </header>

      <div class="onboarding-progress" aria-hidden="true">
        <span style={{ width: `${Math.round((safeStep / STEPS.length) * 100)}%` }} />
      </div>

      <main class="onboarding-body">
        <div class="onboarding-pane" key={current.id}>
          <div class="onboarding-intro">
            <p class="eyebrow">{current.eyebrow}</p>
            <h1 tabindex={-1} ref={heading}>{current.title}</h1>
            <p class="lede">{current.body}</p>
          </div>

          {error ? <Callout tone="danger">{error}</Callout> : null}

          {safeStep === 1 ? <PermissionLevelPicker variant="cards" mode={mode} disabled={busy} onChange={onModeChange} /> : null}

          {safeStep === 2 ? (
            <div class="credential-list">
              {connectedClients > 0 ? (
                <Callout tone="success" icon="check">
                  {connectedClients} app{connectedClients === 1 ? "" : "s"} already connected.
                </Callout>
              ) : null}
              <Field label="Connection" value={mcpUrl} copyable />
              <ol class="steps-list">
                <li>Copy the connection above.</li>
                <li>Add it to your AI app as a remote server.</li>
                <li>Sign in and authorise the app when it asks.</li>
              </ol>
            </div>
          ) : null}
        </div>

        <footer class="onboarding-foot">
          <div class="onboarding-foot-left">
            {safeStep > 1 ? (
              <Button variant="ghost" icon="arrow-left" onClick={() => onStep(safeStep - 1)} disabled={busy}>
                Back
              </Button>
            ) : null}
          </div>
          <div class="onboarding-foot-right">
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              {safeStep < STEPS.length ? "Skip setup" : "Skip for now"}
            </Button>
            {safeStep < STEPS.length ? (
              <Button variant="primary" icon="arrow-right" onClick={() => onStep(safeStep + 1)} busy={busy}>
                Continue
              </Button>
            ) : (
              <Button variant="primary" icon="check" onClick={onFinish} busy={busy}>
                Finish setup
              </Button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}
