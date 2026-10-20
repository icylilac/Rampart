# @rampart/sdk

SDK for [Rampart](../../README.md): non-custodial on/off-ramps for Stellar.

It has two parts:

| Import | Runs on | Authenticates with | Use it to |
|---|---|---|---|
| `@rampart/sdk` | Your server | Project API key (`rk_live_…` / `rk_test_…`) | Create and read sessions, pre-flight wallets, verify webhooks, drive the sandbox |
| `@rampart/sdk/browser` | The browser | The session's `client_secret` (`rcs_…`) | Follow one session and do each `next_action`: open the provider page, mount Stripe's widget, have the wallet sign |

Your API key never reaches the browser. The client secret only opens its own session.

No runtime dependencies. Node 18+ on the server; any modern browser.

## Server

```ts
import { Rampart } from "@rampart/sdk";

const ramp = new Rampart(process.env.RAMPART_KEY!, { baseUrl: "https://ramp.example.com" });

// Is the wallet ready? Returns unsigned fix-up XDR (e.g. a missing USDC trustline).
const pf = await ramp.preflight({ wallet_address, asset: "USDC", direction: "ON", crypto_amount: 50 });

const session = await ramp.sessions.create({
  direction: "ON",
  provider: "STRIPE",            // or MOONPAY / ANCHOR (+ anchor_domain)
  wallet_address,
  asset: "USDC",
  fiat_amount: 50,
  fiat_currency: "USD",
  external_reference: order.id,  // idempotent: safe to retry
});

// Hand these two values to your frontend:
res.json({ sessionId: session.id, clientSecret: session.client_secret });
```

Other calls: `sessions.retrieve(id)`, `sessions.list({ status, limit })`, `sessions.listAll()` (async iterator over every page), `sessions.events(id)` (status history), `sessions.refresh(id)`, `sessions.waitFor(id)`, `sessions.submitAnchorAuth(id, xdr)`, `sessions.submitTransaction(id, xdr)`, `providers()`.

Errors are `RampartError` with the API's `code` (`preflight_failed`, `idempotency_conflict`, `invalid_wallet`, …), `status` and `details`.

### Webhooks

Rampart POSTs a `ramp_session.updated` event whenever a session changes, signed with your project's webhook secret. Verify it against the **raw** body:

```ts
import express from "express";
import { Rampart, RampartSignatureError } from "@rampart/sdk";

app.post("/hooks/ramp", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = Rampart.webhooks.constructEvent(req.body, req.header("Rampart-Signature"), process.env.RAMPART_WEBHOOK_SECRET!);
    const session = event.data.object;
    if (session.status === "COMPLETED" && session.onchain_verified) fulfil(session.external_reference);
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(e instanceof RampartSignatureError ? 400 : 500);
  }
});
```

Treat a session as delivered only when `onchain_verified` is `true`: Rampart checks the delivery on Stellar instead of trusting the provider's "completed".

## Browser

```ts
import { RampRunner, stellarWalletsKitSigner } from "@rampart/sdk/browser";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

const runner = new RampRunner({
  sessionId,
  clientSecret,
  baseUrl: "https://ramp.example.com",
  signTransaction: stellarWalletsKitSigner(StellarWalletsKit, walletAddress), // needed for off-ramps and anchors
  stripe: { publishableKey: "pk_test_…", element: "#onramp" },              // needed for Stripe on-ramps
  onUpdate: (s) => render(s.status, s.next_action),
});

const final = await runner.start(); // resolves at COMPLETED, FAILED, EXPIRED or REFUNDED
```

| `next_action` | What the runner does |
|---|---|
| `open_url` | Opens the provider or anchor page in a popup (or your `openUrl`) |
| `stripe_onramp` | Loads Stripe's onramp scripts and mounts the widget in `stripe.element` |
| `sign_sep10_challenge` | Wallet signs the anchor's challenge; submitted to the session |
| `sign_payment` | Wallet signs the exact off-ramp payment (destination, amount, memo); submitted |
| `none` | Waits for the next status |

Pass `onAction(action, session)` to handle any action yourself (return `true`). Browsers block popups that aren't started by a click, so for `open_url` you may prefer to render a button in `openUrl`. If the user declines to sign, `start()` rejects; call it again to retry.

## Test mode

Use an `rk_test_` key and every session runs on the **sandbox**: no cards, no KYC, nothing on-chain. Pick a scenario to test how your integration handles each failure:

```ts
const s = await ramp.sessions.create({ direction: "OFF", wallet_address, crypto_amount: 10, sandbox_scenario: "late_webhook" });
await ramp.sandbox.runToEnd(s.id);       // skip the waiting
```

| `sandbox_scenario` | What happens |
|---|---|
| `success` (default) | Every step succeeds; webhooks on time |
| `missing_webhooks` | No webhooks; polling finds every step |
| `out_of_order_webhooks` | Webhooks arrive newest-first; stale ones are ignored |
| `late_webhook` | A stale PROCESSING webhook after completion; ignored |
| `completed_not_delivered` | Provider says COMPLETED, nothing arrives: `onchain_verified: false` |
| `kyc_rejected` | Ends FAILED |
| `expired` | Ends EXPIRED |
| `refunded` | COMPLETED, then REFUNDED |

Off-ramps pause at `AWAITING_PAYMENT` until the wallet signs the payment (the sandbox checks it exactly like an anchor would, but never submits it), so `runToEnd` returns `reason: "waiting_for_payment"` there.
