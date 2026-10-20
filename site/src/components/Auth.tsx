import { useState, type FormEvent, type ReactNode } from "react";
import { api, setToken, type SignedIn } from "../lib/api";
import { Link, navigate, withNext } from "../lib/router";
import { walletSignIn } from "../lib/wallet";
import { Icon } from "./Icon";

export const MIN_PASSWORD_LENGTH = 10;

/** Centers an auth card on a soft grid, with the wordmark back to the landing page. */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <Link to="/" className="nav-brand small auth-home" aria-label="Rampart home">
        <img src="/icon.svg" alt="" />
        Rampart
      </Link>
      <main className="auth-main">{children}</main>
    </div>
  );
}

/** The card every auth screen sits in: title, one line of context, then the form. */
export function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="auth-card box">
      <header className="auth-head">
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </header>
      {children}
    </section>
  );
}

/** The line under the card that swaps between sign-in and sign-up. */
export function AuthSwitch({ prompt, to, label }: { prompt: string; to: string; label: string }) {
  return (
    <p className="auth-switch muted">
      {prompt} <Link to={to}>{label}</Link>
    </p>
  );
}

/** Email + password, against the Rampart API. */
export function EmailForm({ mode, next }: { mode: "sign-in" | "sign-up"; next: string }) {
  const signUp = mode === "sign-up";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError("Enter a valid email address.");
    if (signUp && password.length < MIN_PASSWORD_LENGTH) return setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
    if (!password) return setError("Enter your password.");
    setBusy(true);
    try {
      const session = await api<SignedIn>(signUp ? "/v1/auth/signup" : "/v1/auth/login", { body: { email: email.trim(), password } });
      setToken(session.token);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="field">
        <span className="mono-label">Email</span>
        <input type="email" name="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span className="mono-label">Password</span>
        <input
          type="password"
          name="password"
          autoComplete={signUp ? "new-password" : "current-password"}
          minLength={signUp ? MIN_PASSWORD_LENGTH : undefined}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {signUp && <span className="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>}
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-solid btn-block" disabled={busy}>
        {busy ? (signUp ? "Creating account…" : "Signing in…") : signUp ? "Create account" : "Sign in"}
        {!busy && <Icon name="arrow" />}
      </button>
    </form>
  );
}

/** The wallet path: below email, and deliberately quieter. */
export function WalletOption({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await walletSignIn();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the wallet.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="divider mono-label">
        <span />
        or
        <span />
      </div>
      <button type="button" className="btn btn-outline btn-block" disabled={busy} onClick={() => void connect()}>
        <Icon name="wallet" />
        {busy ? "Check Freighter…" : "Use Freighter wallet"}
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
}

export function LoginPage({ next, notice }: { next: string; notice?: string }) {
  return (
    <AuthPage>
      <AuthCard title="Welcome back" description="Sign in to manage your projects and API keys.">
        {notice && (
          <p role="status" className="form-notice">
            {notice}
          </p>
        )}
        <EmailForm mode="sign-in" next={next} />
        <WalletOption next={next} />
      </AuthCard>
      <AuthSwitch prompt="New to Rampart?" to={withNext("/signup", next)} label="Create an account" />
    </AuthPage>
  );
}

export function SignupPage({ next }: { next: string }) {
  return (
    <AuthPage>
      <AuthCard title="Create your account" description="Sign up with email. No wallet needed to get test keys.">
        <EmailForm mode="sign-up" next={next} />
        <WalletOption next={next} />
      </AuthCard>
      <AuthSwitch prompt="Already have an account?" to={withNext("/login", next)} label="Sign in" />
    </AuthPage>
  );
}
