import { useEffect, useState } from "react";
import { api, ApiError, setToken, type User } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { linkWalletToAccount } from "../lib/wallet";
import { DashFooter, DashNav, signOut } from "./Dashboard";
import { Icon } from "./Icon";

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

/** Who you are signed in as, the ways in, and signing out everywhere. */
export function AccountPage() {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"wallet" | "everywhere" | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<User>("/v1/auth/me")
      .then(setUser)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setToken(null);
          navigate("/login?next=/account&expired=1", { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load your account.");
      });
  }, []);

  async function linkWallet() {
    setBusy("wallet");
    setError(null);
    try {
      setUser(await linkWalletToAccount());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link the wallet.");
    } finally {
      setBusy(null);
    }
  }

  async function everywhere() {
    if (!window.confirm("Sign out on every device, including this one?")) return;
    setBusy("everywhere");
    await signOut(true);
  }

  const copyId = (id: string) =>
    void navigator.clipboard?.writeText(id).then(
      () => setCopied(true),
      () => undefined,
    );

  return (
    <div className="page dash">
      <DashNav user={user} />
      <main>
        <section className="box section dash-head">
          <Link to="/dashboard" className="mono-label back-link">
            ← Dashboard
          </Link>
          <h1>Account</h1>
          <p className="muted">How you sign in to Rampart.</p>
        </section>

        {error && (
          <div className="box section">
            <p role="alert" className="form-error">
              {error}
            </p>
          </div>
        )}
        {!user && !error && <div className="box section muted">Loading…</div>}

        {user && (
          <>
            <section className="box section account">
              <h2>Sign-in</h2>
              <dl className="account-list">
                <div>
                  <dt className="mono-label">Email</dt>
                  <dd>
                    {user.email ?? <span className="muted">None. This account signs in with its wallet.</span>}
                    {user.email && (
                      <Link to="/forgot" className="link-btn">
                        Reset password
                      </Link>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="mono-label">Wallet</dt>
                  <dd>
                    {user.wallet_address ? (
                      <code className="account-code">{user.wallet_address}</code>
                    ) : (
                      <>
                        <span className="muted">Not linked</span>
                        <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => void linkWallet()}>
                          <Icon name="wallet" />
                          {busy === "wallet" ? "Check Varial…" : "Link Varial wallet"}
                        </button>
                      </>
                    )}
                  </dd>
                </div>
                {!user.wallet_address && (
                  <p className="field-hint account-hint">Link a wallet to sign in with either one. A wallet that already has its own Rampart account can't be linked.</p>
                )}
                <div>
                  <dt className="mono-label">Supabase user ID</dt>
                  <dd>
                    {user.supabase_user_id ? (
                      <>
                        <code className="account-code">{user.supabase_user_id}</code>
                        <button className="link-btn" onClick={() => copyId(user.supabase_user_id!)}>
                          {copied ? "Copied" : "Copy"}
                        </button>
                      </>
                    ) : (
                      <span className="muted">Not created yet. It is the next time you sign in.</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="mono-label">Member since</dt>
                  <dd>{date(user.created_at)}</dd>
                </div>
              </dl>
            </section>

            <section className="box section account">
              <h2>Sessions</h2>
              <p className="muted">Lost a device, or signed in somewhere you shouldn't have? End every session at once.</p>
              <div>
                <button className="btn btn-outline" disabled={busy !== null} onClick={() => void everywhere()}>
                  {busy === "everywhere" ? "Signing out…" : "Sign out everywhere"}
                </button>
              </div>
            </section>
          </>
        )}
      </main>
      <DashFooter />
    </div>
  );
}
