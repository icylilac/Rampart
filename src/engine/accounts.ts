import { Prisma, type User } from "@prisma/client";
import { config } from "../config";
import { randomToken, sha256Hex } from "../lib/crypto";
import { db } from "../lib/db";
import { ApiError, unauthorized } from "../lib/errors";
import { walletAuthUserId, type SupabaseUser } from "../lib/supabase-auth";
import { createWalletChallenge, verifyWalletChallenge, type WalletChallenge } from "../lib/wallet-challenge";

/**
 * Dashboard accounts, signed in two ways: Supabase Auth (email + password,
 * Google, GitHub, ...), or a Stellar wallet that signs a one-time SEP-53
 * challenge. Either way ends in an opaque bearer token (rds_...) whose hash
 * is stored.
 */

export type SignInMethod = "supabase" | "wallet";
export type SignedIn = { user: User; token: string; expiresAt: Date };

const SESSION_PREFIX = "rds_";
export const isUserSessionToken = (v: string) => /^rds_[A-Za-z0-9_-]{20,}$/.test(v);

const challengeSecret = () => Buffer.from(config().ENCRYPTION_KEY, "base64");
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function startSession(user: User, method: SignInMethod): Promise<SignedIn> {
  const token = `${SESSION_PREFIX}${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + config().USER_SESSION_DAYS * 86_400_000);
  await db().userSession.create({ data: { userId: user.id, tokenHash: sha256Hex(token), method, expiresAt } });
  return { user, token, expiresAt };
}

export const walletChallenge = (address: string): WalletChallenge => createWalletChallenge(address, challengeSecret());

/** Verifies the signed challenge, then signs in the wallet's account, creating it on first use. */
export async function walletSignIn(address: string, token: string, signature: string): Promise<SignedIn> {
  const proof = verifyWalletChallenge({ address, token, signature }, challengeSecret());
  if (!proof.ok) {
    throw proof.reason === "expired"
      ? new ApiError(401, "challenge_expired", "The sign-in request expired. Connect your wallet again.")
      : new ApiError(401, "invalid_signature", "The wallet signature could not be verified.");
  }
  const user = await linkWalletAuthUser(await walletUser(address));
  return startSession(user, "wallet");
}

async function walletUser(address: string): Promise<User> {
  const existing = await db().user.findUnique({ where: { walletAddress: address } });
  if (existing) return existing;
  try {
    return await db().user.create({ data: { walletAddress: address } });
  } catch (e) {
    // Two tabs signing in with the same new wallet: the other one created it.
    if (!isUniqueViolation(e)) throw e;
    return db().user.findUniqueOrThrow({ where: { walletAddress: address } });
  }
}

/**
 * Gives a wallet account its Supabase Auth user (and UID) the first time it
 * signs in. Best effort: if Supabase is down the sign-in still works, and the
 * next one tries again.
 */
async function linkWalletAuthUser(user: User): Promise<User> {
  if (user.authUserId || !user.walletAddress) return user;
  try {
    const authUserId = await walletAuthUserId(user.walletAddress);
    if (!authUserId) return user;
    return await db().user.update({ where: { id: user.id }, data: { authUserId } });
  } catch (e) {
    console.error(`[accounts] couldn't create the Supabase Auth user for wallet ${user.walletAddress}`, e);
    return user;
  }
}

/**
 * Signs in the Rampart account for a Supabase Auth user, creating it on first
 * use. Linked by Supabase's user id, so a changed email stays the same account.
 */
export async function supabaseSignIn(authUser: SupabaseUser): Promise<SignedIn> {
  const linked = await db().user.findUnique({ where: { authUserId: authUser.id } });
  if (linked) {
    const user = linked.email === authUser.email ? linked : await db().user.update({ where: { id: linked.id }, data: { email: authUser.email } });
    return startSession(user, "supabase");
  }
  try {
    return startSession(await db().user.create({ data: { authUserId: authUser.id, email: authUser.email } }), "supabase");
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Two tabs finishing the same first sign-in: the other one created it.
    const user = await db().user.findUnique({ where: { authUserId: authUser.id } });
    if (user) return startSession(user, "supabase");
    throw new ApiError(409, "email_taken", "Another account already uses this email address.");
  }
}

/** The user behind a live session token. */
export async function userForToken(token: string): Promise<{ user: User; sessionId: string }> {
  if (!isUserSessionToken(token)) throw unauthorized("Sign in to continue.");
  const session = await db().userSession.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw unauthorized("Your session has ended. Sign in again.");
  return { user: session.user, sessionId: session.id };
}

export async function signOut(sessionId: string): Promise<void> {
  await db().userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}
