import { Asset, Networks } from "@stellar/stellar-sdk";
import { config } from "../config";

// Circle's USDC issuers.
const USDC_ISSUER = {
  TESTNET: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  PUBLIC: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
} as const;

export function networkPassphrase(): string {
  return config().STELLAR_NETWORK === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
}

export function horizonUrl(): string {
  const cfg = config();
  return (
    cfg.HORIZON_URL ??
    (cfg.STELLAR_NETWORK === "PUBLIC" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org")
  ).replace(/\/+$/, "");
}

export type AssetRef = { code: string; issuer: string | null };

export const XLM: AssetRef = { code: "XLM", issuer: null };

export function usdc(): AssetRef {
  const cfg = config();
  return { code: "USDC", issuer: cfg.USDC_ISSUER ?? USDC_ISSUER[cfg.STELLAR_NETWORK] };
}

/** Assets the ramp supports by code. */
export function resolveAsset(code: string): AssetRef {
  const upper = code.toUpperCase();
  if (upper === "XLM") return XLM;
  if (upper === "USDC") return usdc();
  throw new Error(`Unsupported asset ${code}`);
}

export const toSdkAsset = (a: AssetRef) => (a.issuer ? new Asset(a.code, a.issuer) : Asset.native());

export const isNative = (a: AssetRef) => a.issuer === null;
