import { config } from "../config";
import { hmacBase64, hmacHex, parseSignatureHeader, safeEqual } from "../lib/crypto";
import { badRequest, upstream } from "../lib/errors";
import { fromMoonpay } from "../domain/status";
import type { FetchLike } from "../stellar/horizon";
import {
  WebhookSignatureError,
  type Capabilities,
  type CreateInput,
  type CreateResult,
  type ParsedWebhook,
  type RampProvider,
  type SessionContext,
  type StatusUpdate,
} from "./types";

const TOLERANCE_SECONDS = 300;

type MoonpayTx = {
  id: string;
  status: string;
  externalTransactionId?: string | null;
  // buy
  cryptoTransactionId?: string | null;
  // sell
  depositHash?: string | null;
  baseCurrencyAmount?: number | null;
  quoteCurrencyAmount?: number | null;
  failureReason?: string | null;
  updatedAt?: string;
};

/**
 * MoonPay widget: buy (on-ramp) and sell (off-ramp) for USDC/XLM on Stellar.
 * Widget URLs are signed with the secret key; the session id is passed as
 * `externalTransactionId` so webhooks and lookups map straight back to it.
 */
export class MoonpayProvider implements RampProvider {
  readonly id = "MOONPAY" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  capabilities(): Capabilities {
    const cfg = config();
    return {
      provider: "MOONPAY",
      enabled: !!(cfg.MOONPAY_PUBLISHABLE_KEY && cfg.MOONPAY_SECRET_KEY),
      directions: ["ON", "OFF"],
      assets: ["USDC", "XLM"],
      fiat: ["USD", "EUR", "GBP"],
      notes: "Sell deposits on Stellar require the memo MoonPay shows in the widget.",
    };
  }

  private currencyCode(assetCode: string): string {
    const cfg = config();
    return assetCode.toUpperCase() === "XLM" ? cfg.MOONPAY_CURRENCY_XLM : cfg.MOONPAY_CURRENCY_USDC;
  }

  async create(input: CreateInput): Promise<CreateResult> {
    const cfg = config();
    if (!cfg.MOONPAY_PUBLISHABLE_KEY || !cfg.MOONPAY_SECRET_KEY) {
      throw badRequest("provider_disabled", "MoonPay is not configured.");
    }
    const crypto = this.currencyCode(input.asset.code);
    const fiat = (input.fiatCurrency ?? "usd").toLowerCase();
    const params = new URLSearchParams({ apiKey: cfg.MOONPAY_PUBLISHABLE_KEY, externalTransactionId: input.sessionId });

    let base: string;
    if (input.direction === "ON") {
      base = cfg.MOONPAY_BUY_URL;
      params.set("currencyCode", crypto);
      params.set("walletAddress", input.wallet);
      params.set("baseCurrencyCode", fiat);
      if (input.fiatAmount !== undefined) params.set("baseCurrencyAmount", String(input.fiatAmount));
      else if (input.cryptoAmount !== undefined) params.set("quoteCurrencyAmount", String(input.cryptoAmount));
    } else {
      base = cfg.MOONPAY_SELL_URL;
      params.set("baseCurrencyCode", crypto);
      params.set("quoteCurrencyCode", fiat);
      params.set("refundWalletAddress", input.wallet);
      if (input.cryptoAmount !== undefined) params.set("baseCurrencyAmount", String(input.cryptoAmount));
    }
    if (input.redirectUrl) params.set("redirectURL", input.redirectUrl);

    return {
      status: "AWAITING_USER",
      providerStatus: "widget_created",
      nextAction: { type: "open_url", url: signMoonpayUrl(base, params, cfg.MOONPAY_SECRET_KEY) },
    };
  }

  async poll(session: SessionContext): Promise<StatusUpdate | null> {
    const cfg = config();
    if (!cfg.MOONPAY_PUBLISHABLE_KEY) return null;
    const path =
      session.direction === "ON"
        ? `/v1/transactions/ext/${encodeURIComponent(session.id)}`
        : `/v3/sell_transactions/ext/${encodeURIComponent(session.id)}`;
    const res = await this.fetchImpl(`${cfg.MOONPAY_API_URL}${path}?apiKey=${encodeURIComponent(cfg.MOONPAY_PUBLISHABLE_KEY)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw upstream("moonpay_error", `MoonPay returned HTTP ${res.status}`);
    // External ids aren't guaranteed unique on MoonPay's side, so this is a list.
    const list = (await res.json()) as MoonpayTx[];
    const latest = [...list].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    return latest ? toUpdate(latest, session.direction) : null;
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null {
    const key = config().MOONPAY_WEBHOOK_KEY;
    if (!key) throw new WebhookSignatureError("MoonPay webhook key is not configured");
    verifyMoonpaySignature(rawBody, String(headers["moonpay-signature-v2"] ?? ""), key);

    const event = JSON.parse(rawBody) as { type: string; data?: MoonpayTx };
    const tx = event.data;
    if (!tx) return { eventId: `${event.type}:unknown:${Date.now()}`, type: event.type };
    const direction = event.type.startsWith("sell_") ? "OFF" : "ON";
    return {
      // MoonPay payloads carry no event id; (type, transaction, updatedAt) is unique per change.
      eventId: `${event.type}:${tx.id}:${tx.updatedAt ?? ""}`,
      type: event.type,
      sessionId: tx.externalTransactionId ?? undefined,
      providerRef: tx.id,
      update: toUpdate(tx, direction),
    };
  }
}

function toUpdate(tx: MoonpayTx, direction: "ON" | "OFF"): StatusUpdate {
  const status = fromMoonpay(tx.status) ?? "AWAITING_USER";
  // Buy: base = fiat, quote = crypto. Sell: base = crypto, quote = fiat.
  const fiat = direction === "ON" ? tx.baseCurrencyAmount : tx.quoteCurrencyAmount;
  const crypto = direction === "ON" ? tx.quoteCurrencyAmount : tx.baseCurrencyAmount;
  return {
    status,
    providerStatus: tx.status,
    providerRef: tx.id,
    stellarTxHash: (direction === "ON" ? tx.cryptoTransactionId : tx.depositHash) ?? undefined,
    fiatAmount: fiat ?? undefined,
    cryptoAmount: crypto ?? undefined,
    failureReason: tx.status === "failed" ? tx.failureReason ?? "Failed at MoonPay." : undefined,
    nextAction: status === "AWAITING_USER" || status === "AWAITING_PAYMENT" ? undefined : { type: "none" },
  };
}

/** Appends `signature` = base64(HMAC-SHA256(secret, "?query")). */
export function signMoonpayUrl(base: string, params: URLSearchParams, secretKey: string): string {
  const url = new URL(base);
  url.search = params.toString();
  const signature = hmacBase64(secretKey, url.search);
  url.searchParams.set("signature", signature);
  return url.toString();
}

/** `Moonpay-Signature-V2: t=<unix>,s=<hex hmac(webhookKey, "t.body")>` */
export function verifyMoonpaySignature(rawBody: string, header: string, key: string, now = Date.now()): void {
  const parts = parseSignatureHeader(header);
  const t = parts.get("t")?.[0];
  const s = parts.get("s")?.[0];
  if (!t || !s) throw new WebhookSignatureError("Missing MoonPay signature");
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) throw new WebhookSignatureError("MoonPay signature timestamp outside tolerance");
  if (!safeEqual(s, hmacHex(key, `${t}.${rawBody}`))) throw new WebhookSignatureError("MoonPay signature mismatch");
}
