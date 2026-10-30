import { useState } from "preact/hooks";
import { Button, Callout } from "../components/primitives.js";
import { Page, Section } from "../components/layout.js";

export type AuthMode = "sign-in" | "sign-up";

export interface AuthPageProps {
  busy: boolean;
  error: string | null;
  onSubmit: (mode: AuthMode, email: string, password: string) => Promise<boolean>;
}

/**
 * Sign-in / sign-up inside the extension (v2). The dashboard no longer
 * opens a website page to sign in. The password lives only in this
 * form's state for the duration of the submit and is never stored.
 * There is no password-reset flow in the gateway, so none is offered
 * here — a fake reset link would be worse than an honest note.
 */
export function AuthPage({ busy, error, onSubmit }: AuthPageProps): preact.JSX.Element {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <Page
      title={mode === "sign-in" ? "Sign in" : "Create account"}
      subtitle="Sign in to link this browser to your Muze account."
    >
      <Section title={mode === "sign-in" ? "Welcome back" : "Create your account"}>
        <form class="auth-form" onSubmit={(event) => void submit(event)}>
          <div class="auth-field">
            <label htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              disabled={busy}
              onInput={(event) => setEmail((event.target as HTMLInputElement).value)}
            />
          </div>
          <div class="auth-field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              value={password}
              disabled={busy}
              onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
            />
            {mode === "sign-up" ? <span class="ui-row-meta">At least 8 characters.</span> : null}
          </div>
          {shownError ? <Callout tone="danger">{shownError}</Callout> : null}
          <Button variant="primary" type="submit" disabled={busy} busy={busy}>
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
              setLocalError(null);
            }}
          >
            {mode === "sign-in" ? "Don't have an account? Create one" : "Already have an account? Sign in"}
          </Button>
          <p class="ui-row-meta">Password reset isn't available yet.</p>
        </form>
      </Section>
    </Page>
  );
}
