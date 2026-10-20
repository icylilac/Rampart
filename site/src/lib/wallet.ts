import { api, setToken, type SignedIn } from "./api";

/**
 * Wallet sign-in, the same path as Doqtri's: ask the API for a one-time
 * challenge, have Freighter sign it (SEP-53, no transaction, no fee), and
 * trade the signature for a session.
 */
export async function walletSignIn(): Promise<SignedIn> {
  // Loaded on click, so the landing page doesn't ship the wallet code.
  const freighter = await import("@stellar/freighter-api");

  const connected = await freighter.isConnected();
  if (connected.error || !connected.isConnected) {
    throw new Error("Freighter isn't installed. Get it at freighter.app, then try again.");
  }
  const access = await freighter.requestAccess();
  if (access.error || !access.address) throw new Error(access.error?.message ?? "Freighter didn't share an account.");
  const address = access.address;

  const challenge = await api<{ message: string; token: string }>("/v1/auth/wallet/challenge", { body: { address } });

  const signed = await freighter.signMessage(challenge.message, { address });
  if (signed.error || !signed.signedMessage) throw new Error(signed.error?.message ?? "Signing was cancelled.");
  const signature = typeof signed.signedMessage === "string" ? signed.signedMessage : toBase64(signed.signedMessage);

  const session = await api<SignedIn>("/v1/auth/wallet", { body: { address, token: challenge.token, signature } });
  setToken(session.token);
  return session;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
