export const GITHUB = "https://github.com/Agentium-AI/Rampart";
export const CONTRACT = "CDJK4Y5OLDZJE566HEYRVGBXT4E56EQC2VT6ZP25436M2BX2YRVWKUYT";
export const CONTRACT_URL = `https://stellar.expert/explorer/testnet/contract/${CONTRACT}`;

/** The hero's session log: one on-ramp, start to finish, including a lost webhook. */
export type LogLine = { t: string; source: string; event: string; state?: string; tone?: "ok" | "warn" | "muted" };

export const SESSION_LOG: LogLine[] = [
  { t: "00:00.0", source: "api", event: "POST /v1/sessions · 25 USD → USDC", state: "CREATED" },
  { t: "00:00.4", source: "preflight", event: "account funded · USDC trustline ok", tone: "ok" },
  { t: "00:02.9", source: "stripe", event: "widget opened for the user", state: "AWAITING_PAYMENT" },
  { t: "00:41.8", source: "stripe", event: "webhook never arrived", tone: "warn" },
  { t: "00:45.0", source: "reconciler", event: "polled Stripe · fulfillment_processing", state: "PROCESSING" },
  { t: "01:12.3", source: "stripe", event: "fulfillment_complete", state: "COMPLETED" },
  { t: "01:13.0", source: "horizon", event: "25.0000000 USDC reached GDMK…SPYG", tone: "ok" },
  { t: "01:14.2", source: "soroban", event: "receipt recorded · tx d7ee4c84…", tone: "ok" },
];

/** Failures ramps hit in production, and what Rampart does about each. */
export const FAILURES: { problem: string; impact: string; fix: string }[] = [
  { problem: "Missing trustline", impact: "Card charged, USDC undeliverable.", fix: "Checked before payment." },
  { problem: "Wrong memo", impact: "Off-ramp funds land unassigned.", fix: "Exact payment built and enforced." },
  { problem: "Lost webhook", impact: "Sessions stuck on pending.", fix: "Every open session reconciled." },
  { problem: "Out-of-order events", impact: "Stale updates overwrite final ones.", fix: "Forward-only state machine." },
  { problem: "Unverified completion", impact: "Provider says done, wallet disagrees.", fix: "Every delivery checked on Stellar." },
  { problem: "Fragmented statuses", impact: "Each provider, its own vocabulary.", fix: "One lifecycle across providers." },
];

export const CODE: { tab: string; file: string; code: string }[] = [
  {
    tab: "Server",
    file: "server.ts",
    code: `import { Rampart } from "@rampart/sdk";

const ramp = new Rampart(process.env.RAMP_KEY);

const session = await ramp.sessions.create({
  direction: "ON",
  wallet_address: user.wallet,
  asset: "USDC",
  fiat_amount: 25,
  external_reference: order.id, // safe to retry
});

return { id: session.id, secret: session.client_secret };`,
  },
  {
    tab: "Browser",
    file: "checkout.ts",
    code: `import { RampRunner, stellarWalletsKitSigner } from "@rampart/sdk/browser";

const runner = new RampRunner({
  sessionId: id,
  clientSecret: secret,
  signTransaction: stellarWalletsKitSigner(kit),
  onUpdate: (s) => render(s.status),
});

// Opens the provider, mounts widgets, asks the wallet to sign.
const final = await runner.start();`,
  },
  {
    tab: "Webhook",
    file: "webhook.ts",
    code: `app.post("/hooks/ramp", (req, res) => {
  const event = Rampart.webhooks.constructEvent(
    req.rawBody,
    req.headers["rampart-signature"],
    process.env.RAMP_WEBHOOK_SECRET,
  );
  const s = event.data.object;
  if (s.status === "COMPLETED" && s.onchain_verified) {
    fulfil(s.external_reference, s.receipt);
  }
  res.sendStatus(200);
});`,
  },
];

export const PROVIDERS = [
  { name: "Stripe", detail: "Card to USDC and XLM", region: "US · EU", dirs: "On" },
  { name: "MoonPay", detail: "Cards and bank transfers", region: "Global", dirs: "On · Off" },
  { name: "SEP-24 anchors", detail: "Local bank rails", region: "Per anchor", dirs: "On · Off" },
];
