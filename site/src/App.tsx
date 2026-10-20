import { useEffect, useState } from "react";
import { LoginPage, SignupPage } from "./components/Auth";
import { CodeTabs } from "./components/CodeTabs";
import { DashboardPage } from "./components/Dashboard";
import { Icon } from "./components/Icon";
import { RampVisual } from "./components/RampVisual";
import { SessionLog } from "./components/SessionLog";
import { CONTRACT, CONTRACT_URL, FAILURES, GITHUB, PROVIDERS } from "./content";
import { getToken } from "./lib/api";
import { Link, navigate, safeNext, useLocation } from "./lib/router";

const DOCS = `${GITHUB}/blob/main/docs/reference.md`;
const NAV = [
  ["Reliability", "#problems"],
  ["Lifecycle", "#how"],
  ["Developers", "#developers"],
  ["Receipts", "#receipts"],
  ["Providers", "#providers"],
] as const;

const STRIP = [
  { name: "Stellar", note: "Network" },
  { name: "Soroban", note: "Receipts" },
  { name: "Stripe", note: "On-ramp" },
  { name: "MoonPay", note: "On · Off" },
  { name: "SEP-24", note: "Anchors" },
  { name: "Freighter", note: "Wallets" },
];

const TITLES: Record<string, string> = {
  "/login": "Sign in · Rampart",
  "/signup": "Create account · Rampart",
  "/dashboard": "Dashboard · Rampart",
};

/** Routes: the landing page, sign-in, sign-up and the dashboard. */
export function App() {
  const { path, search } = useLocation();
  const signedIn = Boolean(getToken());
  const next = safeNext(search.get("next"));
  // Signed-in users skip the auth pages; signed-out users can't open the dashboard.
  const redirect =
    (path === "/login" || path === "/signup") && signedIn ? next : path === "/dashboard" && !signedIn ? "/login?next=/dashboard" : null;

  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
  useEffect(() => {
    document.title = TITLES[path] ?? "Rampart: fiat ramps for Stellar, verified on-chain";
  }, [path]);

  if (redirect) return null;
  if (path === "/login") return <LoginPage next={next} notice={search.has("expired") ? "Your session ended. Sign in again." : undefined} />;
  if (path === "/signup") return <SignupPage next={next} />;
  if (path === "/dashboard") return <DashboardPage />;
  return <Home signedIn={signedIn} />;
}

function Home({ signedIn }: { signedIn: boolean }) {
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  return (
    <>
      <a className="announce" href={CONTRACT_URL} target="_blank" rel="noreferrer">
        <span className="sq" />
        Receipts contract live on Stellar testnet <span aria-hidden>-&gt;</span>
        <span className="sq" />
      </a>

      <div className="page">
        <header className="nav box">
          <a className="nav-brand" href="#top" aria-label="Rampart home">
            <img src="icon.svg" alt="" />
            <span>Rampart</span>
          </a>
          <div className="nav-right">
            <a className="nav-icon" href={GITHUB} aria-label="GitHub" target="_blank" rel="noreferrer">
              <Icon name="github" />
            </a>
            <a className="btn btn-outline hide-sm" href={DOCS} target="_blank" rel="noreferrer">
              Docs
            </a>
            <Link className="btn btn-outline hide-sm" to={signedIn ? "/dashboard" : "/login"}>
              {signedIn ? "Dashboard" : "Sign in"}
            </Link>
            <a className="btn btn-solid hide-sm" href="#developers">
              Start building
            </a>
            <button className="nav-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Icon name={menu ? "close" : "menu"} />
            </button>
          </div>
          {menu && (
            <nav className="nav-menu" onClick={() => setMenu(false)}>
              {NAV.map(([label, href]) => (
                <a key={href} href={href}>
                  {label}
                </a>
              ))}
              <a href={DOCS} target="_blank" rel="noreferrer">
                Docs
              </a>
              <Link to={signedIn ? "/dashboard" : "/login"}>{signedIn ? "Dashboard" : "Sign in"}</Link>
            </nav>
          )}
        </header>

        <main id="top">
          <section className="hero box">
            <div className="hero-copy">
              <h1>Fiat ramps for Stellar, verified on-chain.</h1>
              <p className="lead">
                One API for Stripe, MoonPay and SEP-24 anchors.
                <br />
                Non&#8209;custodial by design.
              </p>
              <div className="actions">
                <a className="btn btn-solid btn-lg" href="#developers">
                  Start building <Icon name="arrow" />
                </a>
                <a className="btn btn-outline btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </div>
            </div>
            <RampVisual />
          </section>

          <div className="strip box">
            {STRIP.map((s) => (
              <div key={s.name} className="strip-cell">
                <span className="strip-name">{s.name}</span>
                <span className="mono-label">{s.note}</span>
              </div>
            ))}
          </div>

          <section id="problems" className="box section">
            <div className="section-head">
              <span className="mono-label">[01] Reliability</span>
              <h2>Six failure modes, handled.</h2>
            </div>
            <div className="fail-grid">
              {FAILURES.map((f, i) => (
                <article key={f.problem} className="fail">
                  <span className="mono-label">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{f.problem}</h3>
                  <p className="fail-impact">{f.impact}</p>
                  <p className="fail-fix">
                    <Icon name="check" />
                    {f.fix}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <section id="how" className="box section split">
            <div className="section-head">
              <span className="mono-label">[02] Lifecycle</span>
              <h2>Tracked to settlement.</h2>
              <p className="muted">A live on-ramp. The webhook is lost; the delivery still settles.</p>
              <ol className="how-steps">
                <li>
                  <b>Create</b> a session from your backend
                </li>
                <li>
                  <b>Pay</b> through the provider
                </li>
                <li>
                  <b>Verify</b> on Stellar and receipt on-chain
                </li>
              </ol>
            </div>
            <SessionLog />
          </section>

          <section id="developers" className="box section split">
            <div className="section-head">
              <span className="mono-label">[03] Developers</span>
              <h2>Integrate in hours.</h2>
              <ul className="ticks">
                <li>Typed TypeScript SDK</li>
                <li>Browser runner for widgets and wallet signing</li>
                <li>Idempotent sessions, signed webhooks</li>
                <li>Sandbox that simulates real failures</li>
                <li>
                  Self-host with <code>docker compose up</code>
                </li>
              </ul>
            </div>
            <CodeTabs />
          </section>

          <section id="receipts" className="box section split">
            <div className="section-head">
              <span className="mono-label">[04] On-chain receipts</span>
              <h2>Proof, on-chain.</h2>
              <p className="muted">Every verified delivery is recorded in a Soroban contract anyone can audit.</p>
              <ul className="ticks">
                <li>Write-once, attester-signed</li>
                <li>One payment, one session</li>
                <li>Refunds recorded</li>
                <li>Holds no funds</li>
              </ul>
            </div>
            <div className="receipt-wrap">
              <div className="receipt">
                <div className="receipt-top">
                  <img src="icon.svg" alt="" />
                  <span className="mono-label">Ramp receipt</span>
                </div>
                <dl>
                  <dt>Status</dt>
                  <dd className="ok">DELIVERED</dd>
                  <dt>Direction</dt>
                  <dd>ON via STRIPE</dd>
                  <dt>Amount</dt>
                  <dd>25.5 USDC</dd>
                  <dt>Wallet</dt>
                  <dd>GDMK…SPYG</dd>
                  <dt>Delivery tx</dt>
                  <dd>6f4ff6af…72304975</dd>
                  <dt>Ledger</dt>
                  <dd>5275234</dd>
                </dl>
                <a className="receipt-foot" href={CONTRACT_URL} target="_blank" rel="noreferrer">
                  {CONTRACT.slice(0, 8)}…{CONTRACT.slice(-6)} on stellar.expert <Icon name="arrow" />
                </a>
              </div>
            </div>
          </section>

          <section id="providers" className="box section">
            <div className="section-head">
              <span className="mono-label">[05] Coverage</span>
              <h2>Global reach, local rails.</h2>
            </div>
            <div className="prov-grid">
              {PROVIDERS.map((p) => (
                <div key={p.name} className="prov">
                  <h3>{p.name}</h3>
                  <p className="muted">{p.detail}</p>
                  <div className="prov-meta">
                    <span className="mono-label">{p.dirs}</span>
                    <span className="mono-label">{p.region}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="box cta">
            <h2>Ship ramps your users can trust.</h2>
            <div className="actions">
              <a className="btn btn-solid btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
                Start building <Icon name="arrow" />
              </a>
              <a className="btn btn-outline btn-lg" href={DOCS} target="_blank" rel="noreferrer">
                Documentation
              </a>
            </div>
          </section>
        </main>

        <footer className="footer">
          <span className="nav-brand small">
            <img src="icon.svg" alt="" />
            Rampart
          </span>
          <span className="mono-label">Non-custodial · KYC and payouts by licensed partners</span>
        </footer>
      </div>
    </>
  );
}
