import type { Prisma, RampSession, SessionTransition } from "@prisma/client";
import type { NextAction } from "../providers/types";
import type { SandboxMeta } from "../providers/sandbox";

const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toString());
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The public JSON shape of a session (snake_case, amounts as decimal strings).
 * Never includes provider secrets; the client secret only on creation.
 */
export function serializeSession(s: RampSession, opts: { clientSecret?: string } = {}) {
  const meta = (s.metadata ?? {}) as { sandbox?: SandboxMeta };
  return {
    id: s.id,
    object: "ramp_session" as const,
    livemode: s.livemode,
    direction: s.direction,
    provider: s.provider,
    status: s.status,
    provider_status: s.providerStatus,
    wallet_address: s.walletAddress,
    asset: { code: s.assetCode, issuer: s.assetIssuer },
    fiat_currency: s.fiatCurrency,
    fiat_amount: dec(s.fiatAmount),
    crypto_amount: dec(s.cryptoAmount),
    external_reference: s.externalReference,
    anchor_domain: s.anchorDomain,
    next_action: (s.nextAction ?? { type: "none" }) as NextAction,
    stellar_tx_hash: s.stellarTxHash,
    onchain_verified: s.onchainVerified,
    onchain_check: s.onchainCheck ?? null,
    failure_reason: s.failureReason,
    sandbox: meta.sandbox
      ? { scenario: meta.sandbox.scenario, simulating: meta.sandbox.simulating ?? null }
      : undefined,
    expires_at: iso(s.expiresAt),
    completed_at: iso(s.completedAt),
    created_at: iso(s.createdAt),
    updated_at: iso(s.updatedAt),
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  };
}

export type SerializedSession = ReturnType<typeof serializeSession>;

export function serializeTransition(t: SessionTransition) {
  return {
    object: "status_change" as const,
    from: t.fromStatus,
    to: t.toStatus,
    source: t.source,
    detail: t.detail,
    at: t.createdAt.toISOString(),
  };
}
