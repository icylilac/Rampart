import { config } from "../config";
import { hmacHex, parseSignatureHeader, safeEqual } from "../lib/crypto";
import { badRequest, upstream } from "../lib/errors";
import { fromStripe } from "../domain/status";
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

const API = "https://api.stripe.com/v1";
const TOLERANCE_SECONDS = 300;

type OnrampSession = {
  id: string;
  client_secret: string;
  status: string;
  transaction_details?: {
    destination_amount?: string | null;
    destination_currency?: string | null;
    destination_network?: string | null;
    source_amount?: string | null;
    transaction_id?: string | null;
    wallet_address?: string | null;
  };
};

/**
 * Stripe Crypto Onramp (fiat → USDC/XLM on Stellar). On-ramp only.
 * The Onramp API is in public preview and not in Stripe's SDKs, so it is
 * called over HTTP; webhooks are verified per Stripe's signing scheme.
 */
export class StripeProvider implements RampProvider {
  readonly id = "STRIPE" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  capabilities(): Capabilities {
    return {
      provider: "STRIPE",
      enabled: !!config().STRIPE_SECRET_KEY,
      directions: ["ON"],
      assets: ["USDC", "XLM"],
      fiat: ["USD", "EUR"],
      notes: "US (excluding Hawaii) and EU customers. Requires Stripe onramp approval.",
    };
  }

  private async call(method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<OnrampSession> {
    const key = config().STRIPE_SECRET_KEY;
    if (!key) throw badRequest("provider_disabled", "Stripe is not configured.");
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form?.toString(),
    });
    const body = (await res.json()) as OnrampSession & { error?: { code?: string; message?: string } };
    if (!res.ok) {
      throw upstream(body.error?.code ?? "stripe_error", body.error?.message ?? `Stripe returned HTTP ${res.status}`);
    }
    return body;
  }

  async create(input: CreateInput): Promise<CreateResult> {
    if (input.direction !== "ON") throw badRequest("unsupported_direction", "Stripe supports on-ramp only.");
    const currency = input.asset.code.toLowerCase();
    const form = new URLSearchParams({
      "wallet_addresses[stellar]": input.wallet,
      lock_wallet_address: "true",
      "destination_networks[]": "stellar",
      "destination_currencies[]": currency,
      destination_network: "stellar",
      destination_currency: currency,
    });
    if (input.fiatCurrency) form.set("source_currency", input.fiatCurrency.toLowerCase());
    if (input.fiatAmount !== undefined) form.set("source_amount", input.fiatAmount.toFixed(2));
    else if (input.cryptoAmount !== undefined) form.set("destination_amount", String(input.cryptoAmount));
    if (input.customerIp) form.set("customer_ip_address", input.customerIp);
    form.set("metadata[rampart_session_id]", input.sessionId);

    const session = await this.call("POST", "/crypto/onramp_sessions", form);
    return {
      ...toUpdate(session),
      nextAction: { type: "stripe_onramp", client_secret: session.client_secret, stripe_session_id: session.id },
    };
  }

  async poll(session: SessionContext): Promise<StatusUpdate | null> {
    if (!session.providerRef) return null;
    return toUpdate(await this.call("GET", `/crypto/onramp_sessions/${session.providerRef}`));
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null {
    const secret = config().STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new WebhookSignatureError("Stripe webhook secret is not configured");
    verifyStripeSignature(rawBody, String(headers["stripe-signature"] ?? ""), secret);

    const event = JSON.parse(rawBody) as { id: string; type: string; data?: { object?: OnrampSession } };
    if (event.type !== "crypto.onramp_session.updated" || !event.data?.object) {
      return { eventId: event.id, type: event.type };
    }
    const session = event.data.object;
    return { eventId: event.id, type: event.type, providerRef: session.id, update: toUpdate(session) };
  }
}

function toUpdate(session: OnrampSession): StatusUpdate {
  const status = fromStripe(session.status);
  const td = session.transaction_details ?? {};
  return {
    status: status ?? "AWAITING_USER",
    providerStatus: session.status,
    providerRef: session.id,
    stellarTxHash: td.transaction_id ?? undefined,
    fiatAmount: td.source_amount ? Number(td.source_amount) : undefined,
    cryptoAmount: td.destination_amount ? Number(td.destination_amount) : undefined,
    failureReason: session.status === "rejected" ? "Rejected by Stripe (KYC, sanctions or fraud checks)." : undefined,
  };
}

/** `Stripe-Signature: t=<unix>,v1=<hex hmac(secret, "t.body")>` */
export function verifyStripeSignature(rawBody: string, header: string, secret: string, now = Date.now()): void {
  const parts = parseSignatureHeader(header);
  const t = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!t || signatures.length === 0) throw new WebhookSignatureError("Missing Stripe signature");
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) throw new WebhookSignatureError("Stripe signature timestamp outside tolerance");
  const expected = hmacHex(secret, `${t}.${rawBody}`);
  if (!signatures.some((s) => safeEqual(s, expected))) throw new WebhookSignatureError("Stripe signature mismatch");
}
