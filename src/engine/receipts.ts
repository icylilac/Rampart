import type { RampSession } from "@prisma/client";
import { db } from "../lib/db";
import { ReceiptContractError, type ReceiptsClient, receiptsClient } from "../stellar/receipts";
import type { OnchainCheck } from "../stellar/verify";
import { enqueueSessionEvent } from "./outbound";

const BATCH = 25;

type Log = (msg: string, err?: unknown) => void;

/**
 * Records a session's verified delivery in the receipts contract. Safe to run
 * again, from several workers: a receipt that's already on-chain is adopted
 * instead of written twice (the contract refuses duplicates anyway).
 */
export async function recordReceipt(client: ReceiptsClient, s: RampSession): Promise<RampSession> {
  const existing = await client.get(s.id);
  let txHash: string | null = null;
  if (!existing) {
    const amount = (s.onchainCheck as OnchainCheck | null)?.deliveredAmount ?? s.cryptoAmount?.toString();
    if (!amount || !s.stellarTxHash) {
      return db().rampSession.update({ where: { id: s.id }, data: { receiptError: "no verified amount or delivery transaction" } });
    }
    try {
      txHash = await client.record({
        sessionId: s.id,
        wallet: s.walletAddress,
        direction: s.direction,
        provider: s.provider,
        asset: { code: s.assetCode, issuer: s.assetIssuer },
        amount,
        txHash: s.stellarTxHash,
      });
    } catch (e) {
      if (e instanceof ReceiptContractError && e.reason === "already_recorded") {
        // Another worker got there first; fall through and adopt it.
      } else if (e instanceof ReceiptContractError && e.reason !== "not_attester") {
        // Permanent for this session (e.g. its delivery tx already backs another
        // session's receipt): record why and stop retrying. A missing attester
        // role is a setup problem, so that one keeps retrying.
        return db().rampSession.update({ where: { id: s.id }, data: { receiptError: e.reason } });
      } else {
        throw e;
      }
    }
  }
  const updated = await db().rampSession.update({
    where: { id: s.id },
    data: {
      receiptRecordedAt: existing?.recordedAt ?? new Date(),
      receiptTxHash: txHash ?? s.receiptTxHash,
      receiptRefundedAt: existing?.status === "REFUNDED" ? new Date() : undefined,
      receiptError: null,
    },
  });
  await enqueueSessionEvent(updated);
  return updated;
}

/** Marks a recorded receipt refunded once its session is REFUNDED. */
export async function refundReceipt(client: ReceiptsClient, s: RampSession): Promise<RampSession> {
  try {
    await client.markRefunded(s.id, null);
  } catch (e) {
    if (!(e instanceof ReceiptContractError && e.reason === "already_refunded")) throw e;
  }
  const updated = await db().rampSession.update({ where: { id: s.id }, data: { receiptRefundedAt: new Date() } });
  await enqueueSessionEvent(updated);
  return updated;
}

/**
 * Reconciler step: live sessions whose delivery was verified on Stellar get
 * a receipt; refunded ones get it marked refunded. Test-mode sessions never
 * touch the chain. Does nothing when receipts aren't configured.
 */
export async function syncReceipts(log: Log, client: ReceiptsClient | null = receiptsClient()): Promise<void> {
  if (!client) return;
  const toRecord = await db().rampSession.findMany({
    where: {
      livemode: true,
      status: { in: ["COMPLETED", "REFUNDED"] },
      onchainVerified: true,
      receiptRecordedAt: null,
      receiptError: null,
    },
    orderBy: { completedAt: "asc" },
    take: BATCH,
  });
  for (const s of toRecord) {
    try {
      await recordReceipt(client, s);
    } catch (e) {
      log(`receipt ${s.id} failed`, e);
    }
  }

  const toRefund = await db().rampSession.findMany({
    where: { livemode: true, status: "REFUNDED", receiptRecordedAt: { not: null }, receiptRefundedAt: null },
    take: BATCH,
  });
  for (const s of toRefund) {
    try {
      await refundReceipt(client, s);
    } catch (e) {
      log(`receipt refund ${s.id} failed`, e);
    }
  }
}
