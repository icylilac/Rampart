/**
 * Look up a ramp session's on-chain receipt, without trusting the service.
 *
 *   npm run receipt:check -- <contract C...> <session-id> [TESTNET|PUBLIC]
 *
 * Reads the receipt straight from the ramp-receipts contract over Soroban
 * RPC (no key or .env needed), then confirms on Horizon that the delivery
 * transaction it names exists and succeeded.
 */
import { Networks } from "@stellar/stellar-sdk";
import { readReceipt } from "../src/stellar/receipts";

const NETWORKS = {
  TESTNET: { rpcUrl: "https://soroban-testnet.stellar.org", horizon: "https://horizon-testnet.stellar.org", passphrase: Networks.TESTNET },
  PUBLIC: { rpcUrl: "https://mainnet.sorobanrpc.com", horizon: "https://horizon.stellar.org", passphrase: Networks.PUBLIC },
} as const;

async function main() {
  const [contractId, sessionId, network = "TESTNET"] = process.argv.slice(2);
  if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId) || !sessionId || !(network in NETWORKS)) {
    console.error("Usage: npm run receipt:check -- <contract C...> <session-id> [TESTNET|PUBLIC]");
    process.exit(2);
  }
  const net = NETWORKS[network as keyof typeof NETWORKS];
  const receipt = await readReceipt(contractId, sessionId, net);
  if (!receipt) {
    console.log(`✗ No receipt for session ${sessionId} in ${contractId}.`);
    process.exit(1);
  }
  console.log(`Status:       ${receipt.status}${receipt.refundTxHash ? ` (refund tx ${receipt.refundTxHash})` : ""}`);
  console.log(`Wallet:       ${receipt.wallet}`);
  console.log(`Direction:    ${receipt.direction} via ${receipt.provider}`);
  console.log(`Amount:       ${receipt.amount} of asset contract ${receipt.asset}`);
  console.log(`Delivery tx:  ${receipt.txHash}`);
  console.log(`Recorded:     ${receipt.recordedAt.toISOString()} by ${receipt.attester}`);

  const res = await fetch(`${net.horizon}/transactions/${receipt.txHash}`);
  if (res.status === 404) {
    console.log("✗ Horizon doesn't know the delivery transaction.");
    process.exit(1);
  }
  if (!res.ok) throw new Error(`Horizon returned HTTP ${res.status}`);
  const tx = (await res.json()) as { successful: boolean; ledger: number };
  console.log(tx.successful ? `✓ Delivery transaction succeeded in ledger ${tx.ledger}.` : "✗ Delivery transaction failed on Stellar.");
  process.exit(tx.successful ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
