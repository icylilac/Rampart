import {
  Account,
  BASE_FEE,
  FeeBumpTransaction,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  WebAuth,
  type MemoType,
} from "@stellar/stellar-sdk";
import { anchorDomains } from "../config";
import { badRequest, upstream } from "../lib/errors";
import { fromSep24 } from "../domain/status";
import { HorizonClient, type FetchLike } from "../stellar/horizon";
import { networkPassphrase, toSdkAsset, type AssetRef } from "../stellar/network";
import type {
  Capabilities,
  CreateInput,
  CreateResult,
  NextAction,
  RampProvider,
  SessionContext,
  StatusUpdate,
} from "./types";

/** The parts of an anchor's stellar.toml (SEP-1) that the ramp needs. */
export type AnchorInfo = {
  domain: string;
  transferServer: string;
  webAuthEndpoint: string;
  signingKey: string;
};

type Sep24Transaction = {
  id: string;
  kind: "deposit" | "withdrawal";
  status: string;
  message?: string;
  more_info_url?: string;
  amount_in?: string;
  amount_out?: string;
  stellar_transaction_id?: string | null;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: "text" | "id" | "hash";
};

const TOML_KEYS = ["TRANSFER_SERVER_SEP0024", "WEB_AUTH_ENDPOINT", "SIGNING_KEY"] as const;

/** Reads top-level `KEY = "value"` pairs; enough for the SEP-1 keys used here. */
export function parseStellarToml(toml: string): Partial<Record<(typeof TOML_KEYS)[number], string>> {
  const out: Record<string, string> = {};
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // stop at the first table; the keys we need are top-level
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m && (TOML_KEYS as readonly string[]).includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

/**
 * SEP-24 anchors: deposit (on-ramp) and withdraw (off-ramp) through the
 * anchor's interactive flow.
 *
 *   create()          SEP-1 discovery + SEP-10 challenge for the wallet to sign
 *   completeAuth()    exchange the signed challenge for a JWT, start SEP-24
 *   poll()            GET /transaction; for withdrawals, build the payment
 *   submitPayment()   check the wallet-signed payment and submit it
 *
 * The service never holds user keys: the wallet signs the challenge and the
 * payment. Only anchors on the ANCHOR_DOMAINS allowlist are contacted.
 */
export class AnchorProvider implements RampProvider {
  readonly id = "ANCHOR" as const;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly horizon = new HorizonClient(),
  ) {}

  capabilities(): Capabilities {
    return {
      provider: "ANCHOR",
      enabled: anchorDomains().length > 0,
      directions: ["ON", "OFF"],
      assets: ["USDC"],
      fiat: [],
      notes: `SEP-24 anchors: ${anchorDomains().join(", ")}. Fiat currencies and KYC depend on the anchor.`,
    };
  }

  async discover(domain: string): Promise<AnchorInfo> {
    const normalized = domain.trim().toLowerCase();
    if (!anchorDomains().includes(normalized)) {
      throw badRequest("anchor_not_allowed", `Anchor ${domain} is not on this deployment's ANCHOR_DOMAINS allowlist.`);
    }
    const res = await this.fetchImpl(`https://${normalized}/.well-known/stellar.toml`);
    if (!res.ok) throw upstream("anchor_toml_unavailable", `Could not load stellar.toml from ${normalized}.`);
    const toml = parseStellarToml(await res.text());
    if (!toml.TRANSFER_SERVER_SEP0024 || !toml.WEB_AUTH_ENDPOINT || !toml.SIGNING_KEY) {
      throw upstream("anchor_not_sep24", `${normalized} does not publish SEP-24 and SEP-10 endpoints.`);
    }
    return {
      domain: normalized,
      transferServer: toml.TRANSFER_SERVER_SEP0024.replace(/\/+$/, ""),
      webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
      signingKey: toml.SIGNING_KEY,
    };
  }

  async create(input: CreateInput): Promise<CreateResult> {
    if (!input.anchorDomain) throw badRequest("anchor_domain_required", "anchor_domain is required for the ANCHOR provider.");
    const anchor = await this.discover(input.anchorDomain);

    const url = new URL(anchor.webAuthEndpoint);
    url.searchParams.set("account", input.wallet);
    url.searchParams.set("home_domain", anchor.domain);
    const res = await this.fetchImpl(url.toString());
    if (!res.ok) throw upstream("anchor_auth_failed", `SEP-10 challenge request failed (HTTP ${res.status}).`);
    const { transaction, network_passphrase } = (await res.json()) as { transaction: string; network_passphrase?: string };

    const passphrase = networkPassphrase();
    if (network_passphrase && network_passphrase !== passphrase) {
      throw upstream("anchor_network_mismatch", "The anchor is on a different Stellar network.");
    }
    // Refuse to hand the wallet anything that isn't a genuine challenge from this anchor.
    const challenge = this.readChallenge(transaction, anchor, passphrase);
    if (challenge.clientAccountID !== input.wallet) {
      throw upstream("anchor_challenge_invalid", "The SEP-10 challenge is for a different account.");
    }

    return {
      status: "AWAITING_USER",
      providerStatus: "sep10_challenge",
      metadata: { anchor, challengeHash: Buffer.from(challenge.tx.hash()).toString("hex") },
      nextAction: { type: "sign_sep10_challenge", xdr: transaction, network_passphrase: passphrase },
    };
  }

  private readChallenge(xdr: string, anchor: AnchorInfo, passphrase: string) {
    try {
      return WebAuth.readChallengeTx(xdr, anchor.signingKey, passphrase, anchor.domain, new URL(anchor.webAuthEndpoint).host);
    } catch (e) {
      throw upstream("anchor_challenge_invalid", `The anchor's SEP-10 challenge is invalid: ${(e as Error).message}`);
    }
  }

  /** Exchange the wallet-signed challenge for a JWT and open the SEP-24 flow. */
  async completeAuth(session: SessionContext, signedXdr: string): Promise<StatusUpdate> {
    const meta = (session.metadata ?? {}) as { anchor?: AnchorInfo; challengeHash?: string };
    if (!meta.anchor || !meta.challengeHash) throw badRequest("no_pending_challenge", "This session has no pending SEP-10 challenge.");
    const passphrase = networkPassphrase();
    const signed = this.readChallenge(signedXdr, meta.anchor, passphrase);
    if (Buffer.from(signed.tx.hash()).toString("hex") !== meta.challengeHash) {
      throw badRequest("challenge_mismatch", "The signed transaction is not the challenge issued for this session.");
    }

    const authRes = await this.fetchImpl(meta.anchor.webAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signedXdr }),
    });
    const auth = (await authRes.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!authRes.ok || !auth.token) {
      throw badRequest("anchor_auth_rejected", auth.error ?? "The anchor rejected the signed challenge.");
    }

    const kind = session.direction === "ON" ? "deposit" : "withdraw";
    const body: Record<string, string> = {
      asset_code: session.assetCode,
      account: session.walletAddress,
      lang: "en",
    };
    if (session.assetIssuer) body.asset_issuer = session.assetIssuer;
    if (session.cryptoAmount) body.amount = session.cryptoAmount.toString();
    if (session.direction === "ON") body.claimable_balance_supported = "true";

    const res = await this.fetchImpl(`${meta.anchor.transferServer}/transactions/${kind}/interactive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
    });
    const started = (await res.json().catch(() => ({}))) as { type?: string; url?: string; id?: string; error?: string };
    if (!res.ok || !started.url || !started.id) {
      throw upstream("anchor_interactive_failed", started.error ?? `The anchor did not start the ${kind} (HTTP ${res.status}).`);
    }

    return {
      status: "AWAITING_USER",
      providerStatus: "incomplete",
      providerRef: started.id,
      secrets: { sep10Token: auth.token },
      nextAction: { type: "open_url", url: started.url },
    };
  }

  async poll(session: SessionContext): Promise<StatusUpdate | null> {
    const meta = (session.metadata ?? {}) as { anchor?: AnchorInfo };
    const token = session.secrets.sep10Token;
    if (!meta.anchor || !token || !session.providerRef) return null;

    const res = await this.fetchImpl(`${meta.anchor.transferServer}/transaction?id=${encodeURIComponent(session.providerRef)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return {
        status: session.status,
        providerStatus: session.providerStatus ?? "unknown",
        failureReason: "The anchor session token expired; the user must sign in to the anchor again to refresh status.",
      };
    }
    if (!res.ok) throw upstream("anchor_status_failed", `Anchor status request failed (HTTP ${res.status}).`);
    const { transaction } = (await res.json()) as { transaction: Sep24Transaction };
    return this.toUpdate(session, transaction);
  }

  private async toUpdate(session: SessionContext, tx: Sep24Transaction): Promise<StatusUpdate> {
    const status = fromSep24(tx.status) ?? session.status;
    let nextAction: NextAction | undefined;
    if (tx.status === "pending_user_transfer_start" && tx.kind === "withdrawal") {
      nextAction = await this.buildWithdrawPayment(session, tx);
    } else if (tx.status === "pending_trust") {
      nextAction = { type: "none" };
    } else if (tx.more_info_url && status !== "COMPLETED") {
      nextAction = { type: "open_url", url: tx.more_info_url };
    } else if (status === "COMPLETED" || status === "FAILED" || status === "REFUNDED" || status === "EXPIRED") {
      nextAction = { type: "none" };
    }
    return {
      status,
      providerStatus: tx.status,
      providerRef: tx.id,
      stellarTxHash: tx.stellar_transaction_id ?? undefined,
      cryptoAmount: tx.kind === "deposit" ? num(tx.amount_out) : num(tx.amount_in),
      failureReason: status === "FAILED" ? tx.message ?? `Anchor reported ${tx.status}.` : undefined,
      nextAction,
      metadata: tx.withdraw_anchor_account
        ? {
            withdraw: {
              destination: tx.withdraw_anchor_account,
              amount: tx.amount_in,
              memo: tx.withdraw_memo ?? null,
              memoType: tx.withdraw_memo_type ?? null,
            },
          }
        : undefined,
    };
  }

  /** The exact payment the anchor expects, for the wallet to sign. */
  private async buildWithdrawPayment(session: SessionContext, tx: Sep24Transaction): Promise<NextAction> {
    if (!tx.withdraw_anchor_account || !tx.amount_in) {
      throw upstream("anchor_withdraw_incomplete", "The anchor did not provide a withdraw account and amount.");
    }
    const acct = await this.horizon.account(session.walletAddress);
    if (!acct) throw badRequest("account_not_found", "The wallet's Stellar account does not exist.");
    const asset: AssetRef = { code: session.assetCode, issuer: session.assetIssuer };
    const builder = new TransactionBuilder(new Account(acct.id, acct.sequence), {
      fee: BASE_FEE,
      networkPassphrase: networkPassphrase(),
    })
      .addOperation(
        Operation.payment({ destination: tx.withdraw_anchor_account, asset: toSdkAsset(asset), amount: tx.amount_in }),
      )
      .setTimeout(600);
    const memo = toMemo(tx.withdraw_memo, tx.withdraw_memo_type);
    if (memo) builder.addMemo(memo);
    return {
      type: "sign_payment",
      xdr: builder.build().toXDR(),
      network_passphrase: networkPassphrase(),
      destination: tx.withdraw_anchor_account,
      amount: tx.amount_in,
      asset,
      memo: tx.withdraw_memo ?? null,
      memo_type: tx.withdraw_memo_type ?? null,
    };
  }

  /**
   * Validates a wallet-signed withdraw payment against what the anchor asked
   * for — destination, asset, amount and memo — then submits it. A payment
   * with the wrong memo is the classic way off-ramp funds get stuck.
   */
  async submitPayment(session: SessionContext, signedXdr: string): Promise<StatusUpdate> {
    const withdraw = ((session.metadata ?? {}) as { withdraw?: { destination: string; amount: string; memo: string | null; memoType: string | null } })
      .withdraw;
    if (session.direction !== "OFF" || !withdraw) {
      throw badRequest("no_pending_payment", "This session is not waiting for a withdraw payment.");
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
    if (problems.length) throw badRequest("payment_mismatch", "The signed payment does not match the anchor's instructions.", problems);
    if (tx.signatures.length === 0) throw badRequest("unsigned", "The transaction is not signed.");

    const result = await this.horizon.submit(signedXdr);
    if (!result.successful) throw upstream("stellar_submit_failed", "Stellar rejected the payment.", result.extras);
    return { status: "PROCESSING", providerStatus: "pending_user_transfer_complete", stellarTxHash: result.hash, nextAction: { type: "none" } };
  }
}

const num = (v?: string | null) => (v ? Number(v) : undefined);

function toMemo(value?: string, type?: string): Memo | null {
  if (!value) return null;
  switch (type) {
    case "id":
      return Memo.id(value);
    case "hash":
      return Memo.hash(Buffer.from(value, "base64").toString("hex"));
    default:
      return Memo.text(value);
  }
}

function memoValue(tx: Transaction): { type: MemoType; value: string | null } {
  const memo = tx.memo;
  if (memo.type === "none") return { type: memo.type, value: null };
  if (memo.type === "hash" || memo.type === "return") {
    return { type: memo.type, value: Buffer.from(memo.value as Buffer).toString("base64") };
  }
  // A text memo parsed from XDR comes back as bytes, not a string.
  if (memo.type === "text" && typeof memo.value !== "string") {
    return { type: memo.type, value: Buffer.from(memo.value as Uint8Array).toString("utf8") };
  }
  return { type: memo.type, value: String(memo.value) };
}

/** Returns a list of human-readable mismatches (empty means the payment is correct). */
export function checkWithdrawPayment(
  tx: Transaction,
  expected: { source: string; destination: string; amount: string; asset: AssetRef; memo: string | null; memoType: string | null },
): string[] {
  const problems: string[] = [];
  if (tx.source !== expected.source) problems.push(`source is ${tx.source}, expected ${expected.source}`);
  const payments = tx.operations.filter((op) => op.type === "payment");
  if (tx.operations.length !== 1 || payments.length !== 1) {
    problems.push("expected exactly one payment operation");
    return problems;
  }
  const op = payments[0] as Operation.Payment;
  if (op.destination !== expected.destination) problems.push(`destination is ${op.destination}, expected ${expected.destination}`);
  const assetOk = expected.asset.issuer
    ? op.asset.getCode() === expected.asset.code && op.asset.getIssuer() === expected.asset.issuer
    : op.asset.isNative();
  if (!assetOk) problems.push(`asset does not match ${expected.asset.code}`);
  if (Number(op.amount) !== Number(expected.amount)) problems.push(`amount is ${op.amount}, expected ${expected.amount}`);
  const memo = memoValue(tx);
  if ((expected.memo ?? null) !== memo.value) {
    problems.push(expected.memo ? `memo is ${memo.value ?? "missing"}, expected ${expected.memo}` : "unexpected memo");
  } else if (expected.memo && expected.memoType && expected.memoType !== memo.type) {
    problems.push(`memo type is ${memo.type}, expected ${expected.memoType}`);
  }
  return problems;
}
