/**
 * Is a Stellar wallet ready to ramp?
 *
 *   npm run preflight -- <G...address> [USDC|XLM] [ON|OFF] [amount]
 *
 * Reports account existence, XLM reserves, trustline status and, when a
 * trustline is missing, prints the unsigned changeTrust XDR to sign.
 */
import { HorizonClient } from "../src/stellar/horizon";
import { horizonUrl, resolveAsset } from "../src/stellar/network";
import { preflight } from "../src/stellar/preflight";

async function main() {
  const [wallet, assetCode = "USDC", direction = "ON", amount] = process.argv.slice(2);
  if (!wallet || !/^G[A-Z2-7]{55}$/.test(wallet)) {
    console.error("Usage: npm run preflight -- <G...address> [USDC|XLM] [ON|OFF] [amount]");
    process.exit(2);
  }
  if (direction !== "ON" && direction !== "OFF") throw new Error("direction must be ON or OFF");

  const result = await preflight(new HorizonClient(), {
    wallet,
    asset: resolveAsset(assetCode),
    direction,
    cryptoAmount: amount ? Number(amount) : undefined,
  });

  console.log(`Horizon: ${horizonUrl()}`);
  console.log(`Wallet:  ${wallet}`);
  console.log(`Asset:   ${result.asset.code}${result.asset.issuer ? ` (${result.asset.issuer})` : ""}`);
  if (result.xlm) console.log(`XLM:     ${result.xlm.balance} (minimum ${result.xlm.minimum}, spendable ${result.xlm.spendable})`);
  if (result.asset.issuer && result.assetBalance !== null) console.log(`${result.asset.code}:    ${result.assetBalance}`);
  console.log(result.ready ? "\n✓ Ready to ramp." : "\n✗ Not ready:");
  for (const issue of result.issues) {
    console.log(`  - [${issue.code}] ${issue.message}`);
    if (issue.code === "missing_trustline") console.log(`    Sign and submit this XDR to add the trustline:\n    ${issue.xdr}`);
  }
  process.exit(result.ready ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
