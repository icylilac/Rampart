import type { HorizonClient, HorizonOperation } from "./horizon";
import type { AssetRef } from "./network";

export type OnchainCheck = {
  verified: boolean;
  reason: string;
  txHash: string;
  ledger?: number;
  deliveredAmount?: string;
  memo?: string | null;
  /** True when the check was simulated by the sandbox, not read from Horizon. */
  simulated?: boolean;
};

const matchesAsset = (op: HorizonOperation, asset: AssetRef) =>
  asset.issuer === null
    ? op.asset_type === "native"
    : op.asset_code === asset.code && op.asset_issuer === asset.issuer;

const DELIVERY_TYPES = new Set(["payment", "path_payment_strict_receive", "path_payment_strict_send"]);

/**
 * Independently confirms a delivery on Stellar instead of trusting the
 * provider's "completed": the transaction must be successful and move the
 * expected asset to the expected account (directly or as a claimable
 * balance, which anchors use when the trustline is missing).
 */
export async function verifyDelivery(
  horizon: HorizonClient,
  params: { txHash: string; to: string; asset: AssetRef; minAmount?: number; memo?: string | null },
): Promise<OnchainCheck> {
  const { txHash, to, asset, minAmount, memo } = params;
  const tx = await horizon.transaction(txHash);
  if (!tx) return { verified: false, reason: "transaction_not_found", txHash };
  if (!tx.successful) return { verified: false, reason: "transaction_failed", txHash, ledger: tx.ledger };
  if (memo != null && (tx.memo ?? null) !== memo) {
    return { verified: false, reason: "memo_mismatch", txHash, ledger: tx.ledger, memo: tx.memo ?? null };
  }

  const ops = await horizon.operations(txHash);
  let total = 0;
  for (const op of ops) {
    if (DELIVERY_TYPES.has(op.type) && op.to === to && matchesAsset(op, asset)) {
      total += Number(op.amount ?? 0);
    }
    if (op.type === "create_claimable_balance" && op.claimants?.some((c) => c.destination === to)) {
      const expected = asset.issuer === null ? "native" : `${asset.code}:${asset.issuer}`;
      if (op.asset === expected) total += Number(op.amount ?? 0);
    }
  }

  if (total === 0) return { verified: false, reason: "no_matching_payment", txHash, ledger: tx.ledger };
  // Tolerate rounding in the 7th decimal.
  if (minAmount !== undefined && total + 1e-7 < minAmount) {
    return { verified: false, reason: "amount_short", txHash, ledger: tx.ledger, deliveredAmount: total.toFixed(7) };
  }
  return { verified: true, reason: "ok", txHash, ledger: tx.ledger, deliveredAmount: total.toFixed(7), memo: tx.memo ?? null };
}
