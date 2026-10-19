import { useEffect, useState } from "react";
import { CodeTabs } from "./components/CodeTabs";
import { Icon } from "./components/Icon";
import { RampVisual } from "./components/RampVisual";
import { SessionLog } from "./components/SessionLog";
import { CONTRACT, CONTRACT_URL, FAILURES, GITHUB, PROVIDERS } from "./content";

const DOCS = `${GITHUB}/blob/main/docs/reference.md`;
const NAV = [
  ["Problems", "#problems"],
  ["How it works", "#how"],
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

export function App() {
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
        On-chain receipts are live on Stellar testnet <span aria-hidden>-&gt;</span>
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
            <a className="btn btn-solid hide-sm" href="#developers">
              Get started
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
            </nav>
          )}
        </header>

        <main id="top">
          <section className="hero box">
            <div className="hero-copy">
              <h1>Fiat Ramps For Stellar That Actually Arrive</h1>
              <p className="lead">
                One API over Stripe, MoonPay and SEP-24 anchors. Rampart checks the wallet first, follows every
                session to the end and verifies each delivery on-chain.
              </p>
              <div className="actions">
                <a className="btn btn-solid btn-lg" href="#developers">
                  Get started <Icon name="arrow" />
                </a>
                <a className="btn btn-outline btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
                  View on GitHub
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
              <span className="mono-label">[01] The problem</span>
              <h2>Ramps fail in production in the same six ways.</h2>
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
              <span className="mono-label">[02] How it works</span>
              <h2>Every session, followed to the end.</h2>
              <p className="muted">
                A real on-ramp: the Stripe webhook never arrives, the reconciler notices, and the delivery is still
                verified on Stellar and receipted on-chain.
              </p>
              <ol className="how-steps">
                <li>
                  <b>Create</b> a session from your backend
                </li>
                <li>
                  <b>Pay</b> through the provider while the SDK runs each step
                </li>
                <li>
                  <b>Verify</b> on Stellar, record a receipt, sign a webhook
                </li>
              </ol>
            </div>
            <SessionLog />
          </section>

          <section id="developers" className="box section split">
            <div className="section-head">
              <span className="mono-label">[03] Developers</span>
              <h2>Server, browser and webhooks in a few lines.</h2>
              <ul className="ticks">
                <li>Typed TypeScript SDK with webhook verification</li>
                <li>Browser runner that handles widgets and wallet signing</li>
                <li>Idempotent sessions; webhooks signed and retried</li>
                <li>Test keys run on a sandbox that simulates real failures</li>
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
              <h2>Proof anyone can check.</h2>
              <p className="muted">
                Each verified delivery is written to a Soroban contract. Users and auditors don&apos;t have to take
                anyone&apos;s word for it.
              </p>
              <ul className="ticks">
                <li>Written once, by approved attesters only</li>
                <li>One payment can never back two sessions</li>
                <li>Refunds are marked on-chain too</li>
                <li>The contract holds no funds</li>
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
              <span className="mono-label">[05] Providers</span>
              <h2>Bring the rails you need.</h2>
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
                Get started <Icon name="arrow" />
              </a>
              <a className="btn btn-outline btn-lg" href={DOCS} target="_blank" rel="noreferrer">
                Read the docs
              </a>
            </div>
          </section>
        </main>

        <footer className="footer">
          <span className="nav-brand small">
            <img src="icon.svg" alt="" />
            Rampart
          </span>
          <span className="mono-label">Non-custodial · KYC and payouts by licensed providers</span>
        </footer>
      </div>
    </>
  );
}
