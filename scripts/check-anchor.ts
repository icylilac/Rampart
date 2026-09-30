/**
 * Does an anchor support what the ramp needs?
 *
 *   npm run anchor:check -- <home-domain>
 *
 * Reads the anchor's stellar.toml (SEP-1), confirms SEP-10 and SEP-24
 * endpoints, and lists the deposit/withdraw assets from SEP-24 /info.
 */
import { AnchorProvider } from "../src/providers/anchor";

async function main() {
  const domain = process.argv[2];
  if (!domain) {
    console.error("Usage: npm run anchor:check -- <home-domain>");
    process.exit(2);
  }
  // The allowlist guards the running service; this CLI checks whatever it is given.
  process.env.ANCHOR_DOMAINS = [process.env.ANCHOR_DOMAINS, domain].filter(Boolean).join(",");

  const anchor = await new AnchorProvider().discover(domain);
  console.log(`Anchor:          ${anchor.domain}`);
  console.log(`SEP-10 auth:     ${anchor.webAuthEndpoint}`);
  console.log(`SEP-10 signer:   ${anchor.signingKey}`);
  console.log(`SEP-24 server:   ${anchor.transferServer}`);

  const res = await fetch(`${anchor.transferServer}/info`);
  if (!res.ok) throw new Error(`SEP-24 /info returned HTTP ${res.status}`);
  const info = (await res.json()) as Record<string, Record<string, { enabled?: boolean; min_amount?: number; max_amount?: number }>>;
  for (const kind of ["deposit", "withdraw"] as const) {
    const assets = Object.entries(info[kind] ?? {}).filter(([, a]) => a.enabled);
    const list = assets.map(([code, a]) => `${code}${a.min_amount !== undefined ? ` (${a.min_amount}–${a.max_amount ?? "∞"})` : ""}`);
    console.log(`${kind.padEnd(16)} ${list.join(", ") || "none"}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
