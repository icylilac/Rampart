import { Prisma, type User } from "@prisma/client";
import { config } from "../config";
import { randomToken, sha256Hex } from "../lib/crypto";
import { db } from "../lib/db";
import { ApiError, conflict, unauthorized } from "../lib/errors";
import { decoyHash, hashPassword, verifyPassword } from "../lib/password";
import { createWalletChallenge, verifyWalletChallenge, type WalletChallenge } from "../lib/wallet-challenge";

/**
 * Dashboard accounts, signed in the same two ways as Doqtri: email + password,
 * or a Stellar wallet that signs a one-time SEP-53 challenge. Either way the
 * result is an opaque bearer token (rds_...) whose hash is stored.
 */

export type SignInMethod = "password" | "wallet";
export type SignedIn = { user: User; token: string; expiresAt: Date };

const SESSION_PREFIX = "rds_";
export const isUserSessionToken = (v: string) => /^rds_[A-Za-z0-9_-]{20,}$/.test(v);

const challengeSecret = () => Buffer.from(config().ENCRYPTION_KEY, "base64");
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const invalidLogin = () => new ApiError(401, "invalid_login", "Email or password is incorrect.");

async function startSession(user: User, method: SignInMethod): Promise<SignedIn> {
  const token = `${SESSION_PREFIX}${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + config().USER_SESSION_DAYS * 86_400_000);
  await db().userSession.create({ data: { userId: user.id, tokenHash: sha256Hex(token), method, expiresAt } });
  return { user, token, expiresAt };
}

export async function signUp(email: string, password: string): Promise<SignedIn> {
  const passwordHash = await hashPassword(password);
  try {
    const user = await db().user.create({ data: { email: email.toLowerCase(), passwordHash } });
    return startSession(user, "password");
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("email_taken", "An account with this email already exists. Sign in instead.");
    throw e;
  }
}

export async function signIn(email: string, password: string): Promise<SignedIn> {
  const user = await db().user.findUnique({ where: { email: email.toLowerCase() } });
  // Hash something either way, so an unknown email takes as long as a wrong password.
  const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
  if (!user?.passwordHash || !ok) throw invalidLogin();
  return startSession(user, "password");
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
  const existing = await db().user.findUnique({ where: { walletAddress: address } });
  if (existing) return startSession(existing, "wallet");
  try {
    return startSession(await db().user.create({ data: { walletAddress: address } }), "wallet");
  } catch (e) {
    // Two tabs signing in with the same new wallet: the other one created it.
    if (!isUniqueViolation(e)) throw e;
    return startSession(await db().user.findUniqueOrThrow({ where: { walletAddress: address } }), "wallet");
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
