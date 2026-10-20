import { createHmac, randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { safeEqual } from "./crypto";

/**
 * Proof of wallet ownership for dashboard sign-in.
 *
 * The server issues a short-lived challenge bound to one address; the wallet
 * signs its message with SEP-53 (`signMessage`), and a session is only issued
 * if that signature verifies against the address. Knowing a public key is
 * never enough to sign in.
 *
 * Challenges are stateless: the token is an HMAC over the payload, so there is
 * no table to write. They expire after CHALLENGE_TTL_MS.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;

type Payload = { a: string; n: string; e: number };

export type WalletChallenge = { message: string; token: string; expiresAt: number };

export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "tampered" | "expired" | "wrong_address" | "bad_signature" };

export const isStellarAddress = (v: string) => StrKey.isValidEd25519PublicKey(v);

function mac(secret: Buffer, body: string): string {
  // Its own key, so a challenge token can never pass for anything else signed with the secret.
  const key = createHmac("sha256", secret).update("rampart-wallet-challenge").digest();
  return createHmac("sha256", key).update(body).digest("base64url");
}

/** The exact text the wallet signs. Human-readable so the user knows what they approve. */
export function challengeMessage(address: string, nonce: string, expiresAt: number): string {
  return [
    "Sign in to Rampart",
    "",
    `Account: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    "",
    "Signing proves you own this wallet. It costs nothing and sends no transaction.",
  ].join("\n");
}

export function createWalletChallenge(address: string, secret: Buffer, now = Date.now()): WalletChallenge {
  if (!isStellarAddress(address)) throw new Error("Invalid Stellar address");
  const payload: Payload = { a: address, n: randomBytes(16).toString("hex"), e: now + CHALLENGE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { message: challengeMessage(payload.a, payload.n, payload.e), token: `${body}.${mac(secret, body)}`, expiresAt: payload.e };
}

export function verifyWalletChallenge(
  params: { address: string; token: string; signature: string },
  secret: Buffer,
  now = Date.now(),
): ChallengeResult {
  const { address, token, signature } = params;
  const [body, tag] = token.split(".");
  if (!body || !tag) return { ok: false, reason: "malformed" };
  if (!safeEqual(mac(secret, body), tag)) return { ok: false, reason: "tampered" };

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.a !== address) return { ok: false, reason: "wrong_address" };
  if (!(now < payload.e)) return { ok: false, reason: "expired" };

  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return { ok: false, reason: "bad_signature" };
  try {
    if (!Keypair.fromPublicKey(address).verifyMessage(challengeMessage(payload.a, payload.n, payload.e), sig)) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
