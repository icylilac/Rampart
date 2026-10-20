import type { Direction, SessionStatus } from "@prisma/client";
import { Account, BASE_FEE, FeeBumpTransaction, Keypair, Memo, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { config } from "../config";
import { badRequest } from "../lib/errors";
import { networkPassphrase, toSdkAsset, type AssetRef } from "../stellar/network";
import type { OnchainCheck } from "../stellar/verify";
import { checkWithdrawPayment } from "./anchor";
import type {
  Capabilities,
  CreateInput,
  CreateResult,
  NextAction,
  ParsedWebhook,
  RampProvider,
  SessionContext,
  StatusUpdate,
} from "./types";

/**
 * The simulated provider behind test-mode (rk_test_) keys.
 *
 * Each session follows a scripted scenario. Polling always reports the
 * scenario's true current state, exactly like a real provider's status API;
 * webhooks are emitted separately and may be missing, late or out of order.
 * They go through the same ingestion path and state machine as real
 * webhooks, so the sandbox exercises the rules projects rely on in production.
 *
 * Time is measured in steps of SANDBOX_STEP_SECONDS. `advance()` moves a
 * session's virtual clock to its next event so tests don't have to wait.
 */

export const SCENARIOS = [
  "success",
  "missing_webhooks",
  "out_of_order_webhooks",
  "late_webhook",
  "completed_not_delivered",
  "kyc_rejected",
  "expired",
  "refunded",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_DESCRIPTIONS: Record<Scenario, string> = {
  success: "Every step succeeds and every webhook arrives on time.",
  missing_webhooks: "The provider sends no webhooks; only the reconciler's polling discovers each step.",
  out_of_order_webhooks: "Webhooks arrive newest-first; the stale ones must not move the session backwards.",
  late_webhook: "A stale PROCESSING webhook arrives after completion and must be ignored.",
  completed_not_delivered: "The provider reports COMPLETED, but nothing arrives on Stellar (onchain_verified: false).",
  kyc_rejected: "The user fails identity verification; the session ends FAILED.",
  expired: "The user never finishes; the provider expires the session.",
  refunded: "Completes, then the provider refunds it (COMPLETED → REFUNDED).",
};

type Event = {
  /** Steps after the phase starts. */
  at: number;
  status: SessionStatus;
  providerStatus: string;
  /** Part of the provider's real state (visible to polling). */
  state: boolean;
  /** Also delivered as a webhook. */
  webhook: boolean;
};

type Plan = { pre: Event[]; post: Event[] };

/** Sandbox bookkeeping, stored in the session's metadata.sandbox. */
export type SandboxMeta = {
  scenario: Scenario;
  /** Virtual time added by advance(), in milliseconds. */
  offsetMs: number;
  /** Off-ramp: the virtual time at which the user's payment was submitted. */
  paymentAtMs?: number;
  /** The provider this test session stands in for, if one was requested. */
  simulating?: string | null;
};

const ev = (at: number, status: SessionStatus, providerStatus: string, webhook = true, state = true): Event => ({
  at,
  status,
  providerStatus,
  webhook,
  state,
});

/** The scripted events for a scenario. Off-ramps pause between `pre` and `post` for the user's payment. */
export function plan(scenario: Scenario, direction: Direction): Plan {
  const start = ev(0, "AWAITING_USER", "sbx_user_action", false);
  if (scenario === "kyc_rejected") return { pre: [start, ev(1, "FAILED", "sbx_kyc_rejected")], post: [] };
  if (scenario === "expired") return { pre: [start, ev(3, "EXPIRED", "sbx_expired")], post: [] };

  const pre = direction === "ON" ? [start, ev(1, "AWAITING_PAYMENT", "sbx_awaiting_card_payment")] : [start, ev(1, "AWAITING_PAYMENT", "sbx_awaiting_user_payment")];
  // On-ramp: the provider collects the card payment by itself. Off-ramp: wait for the wallet's payment.
  const fulfil =
    direction === "ON"
      ? [ev(2, "PROCESSING", "sbx_delivering"), ev(3, "COMPLETED", "sbx_completed")]
      : [ev(1, "COMPLETED", "sbx_payout_sent")];
  const end = fulfil[fulfil.length - 1].at;

  const timeline = direction === "ON" ? [...pre, ...fulfil] : fulfil;
  const split = (events: Event[]): Plan => (direction === "ON" ? { pre: events, post: [] } : { pre, post: events });

  switch (scenario) {
    case "success":
    case "completed_not_delivered":
      return split(timeline);
    case "missing_webhooks":
      return direction === "ON"
        ? { pre: timeline.map((e) => ({ ...e, webhook: false })), post: [] }
        : { pre: pre.map((e) => ({ ...e, webhook: false })), post: fulfil.map((e) => ({ ...e, webhook: false })) };
    case "out_of_order_webhooks": {
      // State advances normally, but every webhook is delivered newest-first, after the last step.
      const states = timeline.map((e) => ({ ...e, webhook: false }));
      const late = [...timeline].filter((e) => e.webhook).reverse().map((e, i) => ({ ...e, at: end + i * 0.5, state: false }));
      return split([...states, ...late]);
    }
    case "late_webhook":
      return split([...timeline, ev(end + 1, "PROCESSING", "sbx_delivering", true, false)]);
    case "refunded":
      return split([...timeline, ev(end + 2, "REFUNDED", "sbx_refunded")]);
  }
}

export const isScenario = (v: unknown): v is Scenario => typeof v === "string" && (SCENARIOS as readonly string[]).includes(v);

const stepMs = () => config().SANDBOX_STEP_SECONDS * 1000;

/** The sandbox "anchor" account off-ramp payments go to. Deterministic, never funded. */
export const SANDBOX_DESTINATION = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("rampart-sandbox-destination").digest(),
).publicKey();

export function sandboxMeta(session: Pick<SessionContext, "metadata">): SandboxMeta {
  const meta = ((session.metadata ?? {}) as { sandbox?: SandboxMeta }).sandbox;
  return { scenario: "success", offsetMs: 0, ...meta };
}

/** Milliseconds of virtual time since the session was created. */
function virtualNow(session: Pick<SessionContext, "createdAt" | "metadata">, now = Date.now()): number {
  return now - session.createdAt.getTime() + sandboxMeta(session).offsetMs;
}

type Phase = { name: "pre" | "post"; events: Event[]; elapsedMs: number };

function currentPhase(session: SessionContext, now = Date.now()): Phase {
  const meta = sandboxMeta(session);
  const p = plan(meta.scenario, session.direction);
  const v = virtualNow(session, now);
  if (meta.paymentAtMs !== undefined) return { name: "post", events: p.post, elapsedMs: v - meta.paymentAtMs };
  return { name: "pre", events: p.pre, elapsedMs: v };
}

const fakeHash = (seed: string) => createHash("sha256").update(seed).digest("hex");

export class SandboxProvider implements RampProvider {
  readonly id = "SANDBOX" as const;

  capabilities(): Capabilities {
    return {
      provider: "SANDBOX",
      enabled: config().SANDBOX_ENABLED,
      directions: ["ON", "OFF"],
      assets: ["USDC", "XLM"],
      fiat: ["USD", "EUR"],
      notes: `Test mode (rk_test_ keys). Scenarios: ${SCENARIOS.join(", ")}. Nothing is charged or sent on-chain.`,
    };
  }

  async create(input: CreateInput): Promise<CreateResult> {
    const scenario = input.sandboxScenario ?? "success";
    if (!isScenario(scenario)) {
      throw badRequest("invalid_scenario", `Unknown sandbox_scenario "${scenario}".`, { scenarios: SCENARIOS });
    }
    const meta: SandboxMeta = { scenario, offsetMs: 0, simulating: input.simulating ?? null };
    return {
      status: "AWAITING_USER",
      providerStatus: "sbx_user_action",
      providerRef: `sbx_${input.sessionId}`,
      metadata: { sandbox: meta },
      nextAction: { type: "open_url", url: `${config().PUBLIC_BASE_URL.replace(/\/+$/, "")}/sandbox/checkout/${input.sessionId}` },
    };
  }

  /** The scenario's true current state. */
  async poll(session: SessionContext, now = Date.now()): Promise<StatusUpdate | null> {
    const phase = currentPhase(session, now);
    const due = phase.events.filter((e) => e.state && e.at * stepMs() <= phase.elapsedMs);
    const latest = due[due.length - 1];
    if (!latest) return null;
    return this.toUpdate(session, latest);
  }

  /** Webhooks whose time has come. Event ids are stable, so re-emitting is harmless (deduplicated). */
  dueWebhooks(session: SessionContext, now = Date.now()): ParsedWebhook[] {
    const phase = currentPhase(session, now);
    return phase.events.flatMap((e, i) =>
      e.webhook && e.at * stepMs() <= phase.elapsedMs
        ? [
            {
              eventId: `sbx_${session.id}_${phase.name}_${i}`,
              type: "sandbox.session.updated",
              sessionId: session.id,
              update: this.toUpdate(session, e),
            },
          ]
        : [],
    );
  }

  /**
   * Moves the virtual clock to the next scripted event. Returns the new
   * metadata.sandbox, or null when nothing more will happen until the user
   * acts (an off-ramp waiting for its payment) or the scenario has finished.
   */
  advance(session: SessionContext, now = Date.now()): SandboxMeta | null {
    const meta = sandboxMeta(session);
    const phase = currentPhase(session, now);
    const next = phase.events.find((e) => e.at * stepMs() > phase.elapsedMs);
    if (!next) return null;
    return { ...meta, offsetMs: meta.offsetMs + (next.at * stepMs() - phase.elapsedMs) };
  }

  /** Whether the session is paused waiting for the wallet's payment. */
  waitingForPayment(session: SessionContext): boolean {
    return session.direction === "OFF" && sandboxMeta(session).paymentAtMs === undefined && session.status === "AWAITING_PAYMENT";
  }

  /**
   * Off-ramp: checks the wallet-signed payment exactly like a real anchor
   * withdrawal (destination, asset, amount, memo, signature), but never
   * submits it to Stellar.
   */
  async submitPayment(session: SessionContext, signedXdr: string, now = Date.now()): Promise<StatusUpdate> {
    const withdraw = (session.metadata as { withdraw?: { destination: string; amount: string; memo: string | null; memoType: string | null } } | null)?.withdraw;
    if (!this.waitingForPayment(session) || !withdraw) {
      throw badRequest("no_pending_payment", "This session is not waiting for a payment.");
    }
    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
      if (parsed instanceof FeeBumpTransaction) throw new Error("fee bump");
      tx = parsed;
    } catch {
      throw badRequest("invalid_xdr", "signed_xdr is not a transaction for this network.");
    }
    const problems = checkWithdrawPayment(tx, {
      source: session.walletAddress,
      asset: { code: session.assetCode, issuer: session.assetIssuer },
      ...withdraw,
    });
    if (problems.length) throw badRequest("payment_mismatch", "The signed payment does not match the instructions.", problems);
    if (tx.signatures.length === 0) throw badRequest("unsigned", "The transaction is not signed.");

    const meta = sandboxMeta(session);
    return {
      status: "PROCESSING",
      providerStatus: "sbx_payment_received",
      stellarTxHash: Buffer.from(tx.hash()).toString("hex"),
      nextAction: { type: "none" },
      metadata: { sandbox: { ...meta, paymentAtMs: virtualNow(session, now) } },
    };
  }

  /** Simulated on-chain check: delivered, except in the completed_not_delivered scenario. */
  async verify(session: SessionContext): Promise<OnchainCheck> {
    const txHash = session.stellarTxHash ?? "";
    if (sandboxMeta(session).scenario === "completed_not_delivered") {
      return { verified: false, reason: "no_matching_payment", txHash, simulated: true };
    }
    return {
      verified: true,
      reason: "ok",
      txHash,
      deliveredAmount: session.cryptoAmount ? Number(session.cryptoAmount).toFixed(7) : undefined,
      simulated: true,
    };
  }

  private toUpdate(session: SessionContext, e: Event): StatusUpdate {
    const update: StatusUpdate = { status: e.status, providerStatus: e.providerStatus };
    if (e.status === "AWAITING_PAYMENT" && session.direction === "OFF") {
      const { action, withdraw } = this.paymentInstructions(session);
      update.nextAction = action;
      update.metadata = { withdraw };
    } else if (e.status === "AWAITING_PAYMENT") {
      update.nextAction = { type: "none" };
    } else if (e.status === "COMPLETED" || e.status === "PROCESSING") {
      update.nextAction = { type: "none" };
      if (session.direction === "ON") update.stellarTxHash = fakeHash(`sbx-delivery:${session.id}`);
    } else if (e.status === "FAILED") {
      update.failureReason = "Identity verification failed (sandbox scenario kyc_rejected).";
    } else if (e.status === "EXPIRED") {
      update.failureReason = "The user did not finish in time (sandbox scenario expired).";
    }
    return update;
  }

  /** The exact payment the "anchor" expects, for the wallet to sign. */
  private paymentInstructions(session: SessionContext): {
    action: NextAction;
    withdraw: { destination: string; amount: string; memo: string; memoType: string };
  } {
    const asset: AssetRef = { code: session.assetCode, issuer: session.assetIssuer };
    const amount = session.cryptoAmount ? Number(session.cryptoAmount).toFixed(7) : "10.0000000";
    const memo = `sbx-${session.id.slice(0, 8)}`;
    // Sequence 0: the sandbox never submits this transaction, so it needn't be current.
    const xdr = new TransactionBuilder(new Account(session.walletAddress, "0"), {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase(),
    })
      .addOperation(Operation.payment({ destination: SANDBOX_DESTINATION, asset: toSdkAsset(asset), amount }))
      .addMemo(Memo.text(memo))
      .setTimeout(0)
      .build()
      .toXDR();
    return {
      action: {
        type: "sign_payment",
        xdr,
        network_passphrase: networkPassphrase(),
        destination: SANDBOX_DESTINATION,
        amount,
        asset,
        memo,
        memo_type: "text",
      },
      withdraw: { destination: SANDBOX_DESTINATION, amount, memo, memoType: "text" },
    };
  }
}
