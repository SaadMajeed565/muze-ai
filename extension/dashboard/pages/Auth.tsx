import { useState } from "preact/hooks";
import { Icon } from "../components/Icon.js";
import { Button, Callout, Segmented } from "../components/primitives.js";

export type AuthMode = "sign-in" | "sign-up";

export interface AuthPageProps {
  busy: boolean;
  error: string | null;
  onSubmit: (mode: AuthMode, email: string, password: string) => Promise<boolean>;
}

/**
 * Sign-in / sign-up inside the extension. The password lives only in
 * this form's state for the duration of the submit and is never stored.
 * There is no reset flow in the gateway, so none is offered here.
 */
export function AuthPage({ busy, error, onSubmit }: AuthPageProps): preact.JSX.Element {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setLocalError("Enter a valid email address.");
      return;
    }
    if (mode === "sign-up" && password.length < 8) {
      setLocalError("Use a password with at least 8 characters.");
      return;
    }
    if (!password) {
      setLocalError("Enter your password.");
      return;
    }
    setLocalError(null);
    await onSubmit(mode, cleanEmail, password);
  };

  const shownError = localError ?? error;

  return (
    <div class="auth-shell">
      <header class="auth-brand">
        <span class="brand-mark">
          <Icon name="logo" size={34} />
        </span>
        <span class="brand-name">Muze AI</span>
      </header>

      <main class="auth-main">
        <div class="auth-intro">
          <h1>{mode === "sign-in" ? "Welcome back." : "Create your account."}</h1>
          <p class="lede">
            {mode === "sign-in"
              ? "Sign in to link this browser to your Muze account."
              : "One account links your browsers and the AI apps you trust."}
          </p>
        </div>

        <div class="auth-card">
          <Segmented
            ariaLabel="Sign in or create an account"
            value={mode}
            options={[
              { id: "sign-in", label: "Sign in" },
              { id: "sign-up", label: "Create account" },
            ]}
            onChange={(next) => {
              setMode(next);
              setLocalError(null);
            }}
          />

          <form class="auth-form" onSubmit={(event) => void submit(event)}>
            <label class="field-label" for="auth-email">
              Email
              <input
                id="auth-email"
                class="text-input"
                type="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellcheck={false}
                value={email}
                disabled={busy}
                placeholder="you@example.com"
                onInput={(event) => setEmail((event.target as HTMLInputElement).value)}
              />
            </label>

            <label class="field-label" for="auth-password">
              Password
              <span class="password-wrap">
                <input
                  id="auth-password"
                  class="text-input"
                  {...(showPassword ? { type: "text" as const } : { type: "password" as const })}
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  value={password}
                  disabled={busy}
                  placeholder={mode === "sign-up" ? "At least 8 characters" : "Your password"}
                  onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
                />
                <button
                  type="button"
                  class="password-toggle"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword ? "true" : "false"}
                  disabled={busy}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
                </button>
              </span>
            </label>

            {shownError ? <Callout tone="danger">{shownError}</Callout> : null}

            <Button variant="primary" type="submit" block busy={busy}>
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <p class="auth-note">Password reset isn't available yet.</p>
        </div>

        <ul class="auth-points">
          <li>
            <Icon name="shield" size={16} />
            The agent only reaches what you allow.
          </li>
          <li>
            <Icon name="lock" size={16} />
            Passwords and page storage stay private.
          </li>
        </ul>
      </main>
    </div>
  );
}
