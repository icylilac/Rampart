import { Account, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { HorizonAccount, HorizonClient } from "./horizon";
import { isNative, networkPassphrase, toSdkAsset, type AssetRef } from "./network";

/** Base reserve in XLM (protocol constant since 2019). */
export const BASE_RESERVE = 0.5;

export type PreflightIssue =
  | { code: "account_not_found"; message: string }
  | { code: "insufficient_xlm"; message: string; available: string; required: string }
  | { code: "missing_trustline"; message: string; xdr: string }
  | { code: "trustline_not_authorized"; message: string }
  | { code: "trustline_limit"; message: string; room: string }
  | { code: "insufficient_balance"; message: string; available: string };

export type PreflightResult = {
  ready: boolean;
  wallet: string;
  asset: AssetRef;
  xlm: { balance: string; minimum: string; spendable: string } | null;
  assetBalance: string | null;
  issues: PreflightIssue[];
};

function minimumBalance(acct: HorizonAccount, extraSubentries = 0): number {
  const subentries = acct.subentry_count + extraSubentries;
  const sponsoring = acct.num_sponsoring ?? 0;
  const sponsored = acct.num_sponsored ?? 0;
  return (2 + subentries + sponsoring - sponsored) * BASE_RESERVE;
}

const fmt = (n: number) => n.toFixed(7);

/** Unsigned changeTrust transaction for the wallet to sign. */
export function buildTrustlineXdr(acct: HorizonAccount, asset: AssetRef): string {
  const tx = new TransactionBuilder(new Account(acct.id, acct.sequence), {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.changeTrust({ asset: toSdkAsset(asset) }))
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

/**
 * Checks that a wallet can actually complete a ramp before any money moves.
 * These are the failures that most often strand Stellar on/off-ramps:
 * unfunded accounts, missing USDC trustlines, and XLM stuck in reserves.
 */
export async function preflight(
  horizon: HorizonClient,
  params: { wallet: string; asset: AssetRef; direction: "ON" | "OFF"; cryptoAmount?: number },
): Promise<PreflightResult> {
  const { wallet, asset, direction, cryptoAmount } = params;
  const acct = await horizon.account(wallet);
  if (!acct) {
    return {
      ready: false,
      wallet,
      asset,
      xlm: null,
      assetBalance: null,
      issues: [
        {
          code: "account_not_found",
          message: "The Stellar account does not exist yet. It must be funded with at least 1 XLM (plus 0.5 XLM per trustline).",
        },
      ],
    };
  }

  const issues: PreflightIssue[] = [];
  const native = acct.balances.find((b) => b.asset_type === "native");
  const xlmBalance = Number(native?.balance ?? 0);
  const xlmLiabilities = Number(native?.selling_liabilities ?? 0);
  const line = isNative(asset)
    ? undefined
    : acct.balances.find((b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer);

  const needsTrustline = !isNative(asset) && !line;
  const minimum = minimumBalance(acct, needsTrustline ? 1 : 0);
  // Room for a couple of transaction fees on top of the reserve.
  const required = minimum + 0.01;
  const spendable = Math.max(0, xlmBalance - xlmLiabilities - minimumBalance(acct));

  if (xlmBalance - xlmLiabilities < required) {
    issues.push({
      code: "insufficient_xlm",
      message: `The account needs at least ${fmt(required)} XLM to cover reserves${needsTrustline ? " including the new trustline" : ""} and fees.`,
      available: fmt(xlmBalance - xlmLiabilities),
      required: fmt(required),
    });
  }

  if (needsTrustline) {
    issues.push({
      code: "missing_trustline",
      message: `The account has no trustline for ${asset.code}, so ${asset.code} cannot be delivered to it. Sign the included transaction to add one.`,
      xdr: buildTrustlineXdr(acct, asset),
    });
  } else if (line) {
    if (line.is_authorized === false) {
      issues.push({ code: "trustline_not_authorized", message: `The issuer has not authorized this ${asset.code} trustline.` });
    }
    if (direction === "ON" && cryptoAmount !== undefined && line.limit) {
      const room = Number(line.limit) - Number(line.balance);
      if (room < cryptoAmount) {
        issues.push({
          code: "trustline_limit",
          message: `The ${asset.code} trustline limit leaves room for only ${fmt(room)}.`,
          room: fmt(room),
        });
      }
    }
  }

  const assetBalance = isNative(asset) ? fmt(spendable) : line?.balance ?? null;
  if (direction === "OFF" && cryptoAmount !== undefined) {
    const available = isNative(asset) ? spendable : Number(line?.balance ?? 0);
    if (available < cryptoAmount) {
      issues.push({
        code: "insufficient_balance",
        message: `The wallet holds ${fmt(available)} ${asset.code}, less than the ${fmt(cryptoAmount)} being sold.`,
        available: fmt(available),
      });
    }
  }

  return {
    ready: issues.length === 0,
    wallet,
    asset,
    xlm: { balance: fmt(xlmBalance), minimum: fmt(minimum), spendable: fmt(spendable) },
    assetBalance,
    issues,
  };
}
