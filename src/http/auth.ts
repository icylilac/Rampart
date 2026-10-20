import type { RampSession, User } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { sha256Hex } from "../lib/crypto";
import { db } from "../lib/db";
import { ApiError, notFound, unauthorized } from "../lib/errors";
import { isApiKey, isClientSecret } from "../lib/keys";
import { userForToken } from "../engine/accounts";
import type { Caller } from "../engine/sessions";

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

/** Project API key (rk_live_ / rk_test_). The key's mode decides live or test. */
export async function requireApiKey(request: FastifyRequest): Promise<Caller> {
  const key = bearer(request);
  if (!key) throw unauthorized();
  if (isClientSecret(key)) {
    throw new ApiError(401, "client_secret_not_allowed", "Client secrets can only call /v1/client endpoints.");
  }
  if (!isApiKey(key)) throw unauthorized();
  const row = await db().apiKey.findUnique({ where: { keyHash: sha256Hex(key) }, include: { project: true } });
  if (!row || row.revokedAt) throw unauthorized();
  return { project: row.project, livemode: row.mode === "LIVE" };
}

/**
 * A session's client secret (rcs_...). It can read and act on that one
 * session, so a browser can follow a ramp without the project's API key.
 */
export async function requireClientSecret(request: FastifyRequest, sessionId: string): Promise<RampSession> {
  const secret = bearer(request);
  if (!secret || !isClientSecret(secret)) throw unauthorized("Missing or invalid client secret.");
  const session = await db().rampSession.findUnique({ where: { clientSecretHash: sha256Hex(secret) } });
  // Same error for "wrong secret" and "wrong session": never reveal which sessions exist.
  if (!session || session.id !== sessionId) throw notFound("Session");
  return session;
}

/** A signed-in dashboard user (rds_... session token). */
export async function requireUser(request: FastifyRequest): Promise<{ user: User; sessionId: string }> {
  const token = bearer(request);
  if (!token) throw unauthorized("Sign in to continue.");
  return userForToken(token);
}
