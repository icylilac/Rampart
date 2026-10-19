import { Prisma, type Direction, type Project, type Provider, type RampSession } from "@prisma/client";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "../config";
import { canTransition, isBackward, TERMINAL, type UpdateSource } from "../domain/status";
import { decrypt, encrypt } from "../lib/crypto";
import { db } from "../lib/db";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors";
import { newClientSecret } from "../lib/keys";
import { provider as providerFor, sandbox, type LiveProvider } from "../providers/registry";
import type { NextAction, SessionContext, StatusUpdate } from "../providers/types";
import { HorizonClient } from "../stellar/horizon";
import { resolveAsset, type AssetRef } from "../stellar/network";
import { preflight } from "../stellar/preflight";
import { verifyDelivery, type OnchainCheck } from "../stellar/verify";
import { enqueueSessionEvent } from "./outbound";

export type Caller = { project: Project; livemode: boolean };

export type CreateSessionInput = {
  direction: Direction;
  provider?: Provider;
  walletAddress: string;
  asset: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  cryptoAmount?: number;
  externalReference?: string;
  anchorDomain?: string;
  redirectUrl?: string;
  customerIp?: string;
  lang?: string;
  sandboxScenario?: string;
  skipPreflight?: boolean;
};

let horizon: HorizonClient | undefined;
const horizonClient = () => (horizon ??= new HorizonClient());

/** Tests can replace Horizon so the engine never touches the network. */
export function setHorizonClient(client: HorizonClient) {
  horizon = client;
}

// ------------------------------------------------------------------ helpers

export function withSecrets(s: RampSession): SessionContext {
  return { ...s, secrets: s.secretsEnc ? (JSON.parse(decrypt(s.secretsEnc)) as Record<string, string>) : {} };
}

const sameAction = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const asJson = (v: unknown) => v as Prisma.InputJsonValue;

function assetOf(code: string): AssetRef {
  try {
    return resolveAsset(code);
  } catch {
    throw badRequest("unsupported_asset", `Asset ${code} is not supported. Use USDC or XLM.`);
  }
}

// ------------------------------------------------------------------ create

/**
 * Starts a ramp. Test-mode callers always run on the sandbox; live callers
 * must name an enabled real provider and pass the Stellar pre-flight.
 * `external_reference` makes the call idempotent per project and mode.
 */
export async function createSession(
  caller: Caller,
  input: CreateSessionInput,
): Promise<{ session: RampSession; clientSecret?: string; created: boolean }> {
  if (!StrKey.isValidEd25519PublicKey(input.walletAddress)) {
    throw badRequest("invalid_wallet", "wallet_address must be a Stellar account (G...).");
  }
  const asset = assetOf(input.asset);
  if (input.direction === "OFF" && input.cryptoAmount === undefined) {
    throw badRequest("crypto_amount_required", "crypto_amount is required for an off-ramp.");
  }

  // Choose the provider.
  let chosen: Provider;
  let simulating: Provider | null = null;
  if (!caller.livemode) {
    if (!config().SANDBOX_ENABLED) throw new ApiError(403, "test_mode_disabled", "Test mode is disabled on this deployment.");
    chosen = "SANDBOX";
    simulating = input.provider && input.provider !== "SANDBOX" ? input.provider : null;
  } else {
    if (!input.provider) throw badRequest("provider_required", "provider is required (STRIPE, MOONPAY or ANCHOR).");
    if (input.provider === "SANDBOX") throw badRequest("sandbox_requires_test_key", "The SANDBOX provider is only available with an rk_test_ key.");
    chosen = input.provider;
    const caps = providerFor(chosen as LiveProvider).capabilities();
    if (!caps.enabled) throw badRequest("provider_disabled", `${chosen} is not configured on this deployment.`);
    if (!caps.directions.includes(input.direction)) {
      throw badRequest("unsupported_direction", `${chosen} does not support ${input.direction === "ON" ? "on" : "off"}-ramps.`);
    }
  }
  if (caller.livemode && input.sandboxScenario) {
    throw badRequest("sandbox_requires_test_key", "sandbox_scenario is only available with an rk_test_ key.");
  }

  // Idempotency.
  if (input.externalReference) {
    const existing = await db().rampSession.findUnique({
      where: {
        projectId_livemode_externalReference: {
          projectId: caller.project.id,
          livemode: caller.livemode,
          externalReference: input.externalReference,
        },
      },
    });
    if (existing) return { session: assertSameRequest(existing, input, chosen, asset), created: false };
  }

  // Pre-flight (live only; sandbox wallets needn't exist).
  if (caller.livemode && !input.skipPreflight) {
    const pf = await preflight(horizonClient(), {
      wallet: input.walletAddress,
      asset,
      direction: input.direction,
      cryptoAmount: input.cryptoAmount,
    });
    if (!pf.ready) {
      throw new ApiError(422, "preflight_failed", "The wallet is not ready for this ramp. Resolve the issues and try again.", pf);
    }
  }

  const client = newClientSecret();
  let row: RampSession;
  try {
    row = await db().rampSession.create({
      data: {
        projectId: caller.project.id,
        livemode: caller.livemode,
        direction: input.direction,
        provider: chosen,
        walletAddress: input.walletAddress,
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        fiatCurrency: input.fiatCurrency?.toUpperCase(),
        fiatAmount: input.fiatAmount,
        cryptoAmount: input.cryptoAmount,
        externalReference: input.externalReference,
        anchorDomain: input.anchorDomain?.toLowerCase(),
        clientSecretHash: client.hash,
        expiresAt: new Date(Date.now() + config().SESSION_TTL_MINUTES * 60_000),
      },
    });
  } catch (e) {
    // Two identical requests raced on external_reference: return the winner.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && input.externalReference) {
      const existing = await db().rampSession.findFirstOrThrow({
        where: { projectId: caller.project.id, livemode: caller.livemode, externalReference: input.externalReference },
      });
      return { session: assertSameRequest(existing, input, chosen, asset), created: false };
    }
    throw e;
  }

  try {
    const result = await providerFor(chosen).create({
      sessionId: row.id,
      direction: input.direction,
      wallet: input.walletAddress,
      asset,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      cryptoAmount: input.cryptoAmount,
      redirectUrl: input.redirectUrl,
      customerIp: input.customerIp,
      anchorDomain: input.anchorDomain,
      lang: input.lang,
      sandboxScenario: input.sandboxScenario,
      simulating,
    });
    const { session } = await applyUpdate(row.id, result, "create", `created with ${chosen}`);
    return { session, clientSecret: client.secret, created: true };
  } catch (e) {
    const reason = e instanceof ApiError ? e.message : "The provider could not start the session.";
    await applyUpdate(row.id, { status: "FAILED", providerStatus: "create_failed", failureReason: reason }, "create", "provider create failed");
    throw e;
  }
}

function assertSameRequest(existing: RampSession, input: CreateSessionInput, provider: Provider, asset: AssetRef): RampSession {
  const same =
    existing.direction === input.direction &&
    existing.provider === provider &&
    existing.walletAddress === input.walletAddress &&
    existing.assetCode === asset.code &&
    (existing.fiatAmount?.toNumber() ?? undefined) === input.fiatAmount &&
    (existing.cryptoAmount?.toNumber() ?? undefined) === input.cryptoAmount;
  if (!same) {
    throw conflict("idempotency_conflict", "A different session already uses this external_reference.");
  }
  return existing;
}

// ------------------------------------------------------------------ updates

export type ApplyResult = { session: RampSession; changed: boolean; ignored?: string };

/**
 * The only way a session changes state. Locks the row, enforces the
 * transition rules (src/domain/status.ts), records the transition, and then
 * verifies deliveries and notifies the project.
 */
export async function applyUpdate(
  sessionId: string,
  update: StatusUpdate,
  source: UpdateSource,
  detail?: string,
  opts: { observedAt?: Date } = {},
): Promise<ApplyResult> {
  const result = await db().$transaction(async (tx): Promise<ApplyResult> => {
    await tx.$queryRaw`SELECT id FROM ramp_sessions WHERE id = ${sessionId} FOR UPDATE`;
    const s = await tx.rampSession.findUniqueOrThrow({ where: { id: sessionId } });

    const statusChange = update.status !== s.status;
    // A poll may move a session backwards (an anchor can ask for more info),
    // but not with an answer older than the session's last change: e.g. the
    // provider was asked just before the wallet's payment moved it forward.
    const stale =
      statusChange && source === "poll" && opts.observedAt !== undefined && s.updatedAt > opts.observedAt && isBackward(s.status, update.status);
    if (statusChange && (stale || !canTransition(s.status, update.status, source))) {
      if (source === "poll") {
        await tx.rampSession.update({ where: { id: sessionId }, data: { lastPolledAt: new Date() } });
      }
      const why = stale ? "the poll's answer predates the session's last change" : `it is not allowed from a ${source}`;
      return { session: s, changed: false, ignored: `${s.status} → ${update.status} ignored: ${why}` };
    }

    const data: Prisma.RampSessionUpdateInput = { providerStatus: update.providerStatus };
    if (statusChange) data.status = update.status;
    if (update.providerRef !== undefined) data.providerRef = update.providerRef;
    if (update.stellarTxHash !== undefined && update.stellarTxHash !== null) data.stellarTxHash = update.stellarTxHash;
    if (update.fiatAmount != null) data.fiatAmount = update.fiatAmount;
    if (update.cryptoAmount != null) data.cryptoAmount = update.cryptoAmount;
    if (update.failureReason !== undefined) data.failureReason = update.failureReason;

    let nextAction: NextAction | undefined = update.nextAction;
    if (nextAction === undefined && statusChange && TERMINAL.has(update.status)) nextAction = { type: "none" };
    if (nextAction !== undefined) data.nextAction = asJson(nextAction);

    if (update.metadata) data.metadata = asJson({ ...((s.metadata ?? {}) as object), ...update.metadata });
    if (update.secrets) {
      const current = s.secretsEnc ? (JSON.parse(decrypt(s.secretsEnc)) as Record<string, string>) : {};
      data.secretsEnc = encrypt(JSON.stringify({ ...current, ...update.secrets }));
    }
    if (source === "poll") data.lastPolledAt = new Date();
    if (statusChange && update.status === "COMPLETED") data.completedAt = new Date();

    const updated = await tx.rampSession.update({ where: { id: sessionId }, data });
    if (statusChange) {
      await tx.sessionTransition.create({
        data: { sessionId, fromStatus: s.status, toStatus: update.status, source, detail: detail ?? null },
      });
    }
    const changed =
      statusChange ||
      (nextAction !== undefined && !sameAction(nextAction, s.nextAction)) ||
      (updated.stellarTxHash !== s.stellarTxHash);
    return { session: updated, changed };
  });

  if (!result.changed) return result;
  if (result.session.status === "COMPLETED" && result.session.onchainVerified === null && result.session.stellarTxHash) {
    const verified = await verifySession(result.session);
    return { ...result, session: verified };
  }
  await enqueueSessionEvent(result.session);
  return result;
}

/**
 * Independently checks a completed delivery on Stellar. A transaction that
 * Horizon hasn't indexed yet stays unverified (null) for 30 minutes and is
 * retried by the reconciler before it is reported as not delivered.
 */
export async function verifySession(session: RampSession): Promise<RampSession> {
  if (!session.stellarTxHash) return session;
  const ctx = withSecrets(session);
  const p = providerFor(session.provider);
  let check: OnchainCheck;
  try {
    if (p.verify) {
      check = await p.verify(ctx);
    } else {
      const asset = { code: session.assetCode, issuer: session.assetIssuer };
      const withdraw = (session.metadata as { withdraw?: { destination: string; memo: string | null } } | null)?.withdraw;
      check =
        session.direction === "ON"
          ? await verifyDelivery(horizonClient(), {
              txHash: session.stellarTxHash,
              to: session.walletAddress,
              asset,
              minAmount: session.cryptoAmount?.toNumber(),
            })
          : await verifyDelivery(horizonClient(), {
              txHash: session.stellarTxHash,
              to: withdraw?.destination ?? "",
              asset,
              minAmount: session.cryptoAmount?.toNumber(),
              memo: withdraw?.memo ?? null,
            });
    }
  } catch {
    return session; // Horizon unavailable: transient, the reconciler retries
  }

  const tooEarly = !check.verified && check.reason === "transaction_not_found" && Date.now() - (session.completedAt ?? new Date()).getTime() < 30 * 60_000;
  const verified = check.verified ? true : tooEarly ? null : false;
  const updated = await db().rampSession.update({
    where: { id: session.id },
    data: { onchainVerified: verified, onchainCheck: asJson(check) },
  });
  if (verified !== null) await enqueueSessionEvent(updated);
  return updated;
}

// ------------------------------------------------------------------ queries

export async function getSession(caller: Caller, id: string): Promise<RampSession> {
  const s = await db().rampSession.findFirst({ where: { id, projectId: caller.project.id, livemode: caller.livemode } });
  if (!s) throw notFound("Session");
  return s;
}

export async function listSessions(
  caller: Caller,
  q: { status?: string; provider?: Provider; walletAddress?: string; externalReference?: string; limit: number; startingAfter?: string },
) {
  const where: Prisma.RampSessionWhereInput = {
    projectId: caller.project.id,
    livemode: caller.livemode,
    ...(q.status ? { status: q.status as RampSession["status"] } : {}),
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.walletAddress ? { walletAddress: q.walletAddress } : {}),
    ...(q.externalReference ? { externalReference: q.externalReference } : {}),
  };
  if (q.startingAfter) {
    const cursor = await db().rampSession.findFirst({ where: { id: q.startingAfter, projectId: caller.project.id } });
    if (!cursor) throw badRequest("invalid_cursor", "starting_after does not match a session.");
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }
  const rows = await db().rampSession.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

export async function sessionEvents(session: RampSession) {
  const [transitions, events] = await Promise.all([
    db().sessionTransition.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } }),
    db().providerEvent.findMany({ where: { sessionId: session.id }, orderBy: { receivedAt: "asc" } }),
  ]);
  return { transitions, events };
}

// ------------------------------------------------------------------ actions

/** Polls the provider now ("refresh"). */
export async function refreshSession(session: RampSession): Promise<RampSession> {
  const observedAt = new Date();
  const update = await providerFor(session.provider).poll(withSecrets(session));
  if (!update) {
    return db().rampSession.update({ where: { id: session.id }, data: { lastPolledAt: new Date() } });
  }
  return (await applyUpdate(session.id, update, "poll", "refresh", { observedAt })).session;
}

/** The wallet signed the anchor's SEP-10 challenge. */
export async function submitAnchorAuth(session: RampSession, signedXdr: string): Promise<RampSession> {
  const p = providerFor(session.provider);
  if (!p.completeAuth || session.nextAction === null || (session.nextAction as NextAction).type !== "sign_sep10_challenge") {
    throw badRequest("no_pending_challenge", "This session is not waiting for a signed SEP-10 challenge.");
  }
  const update = await p.completeAuth(withSecrets(session), signedXdr);
  return (await applyUpdate(session.id, update, "auth", "SEP-10 challenge signed")).session;
}

/** The wallet signed the payment the provider asked for (off-ramp). */
export async function submitTransaction(session: RampSession, signedXdr: string): Promise<RampSession> {
  const p = providerFor(session.provider);
  if (!p.submitPayment) throw badRequest("no_pending_payment", "This session is not waiting for a payment.");
  const update = await p.submitPayment(withSecrets(session), signedXdr);
  return (await applyUpdate(session.id, update, "submit", "wallet payment submitted")).session;
}

/**
 * Sandbox: jump the session's virtual clock to its next scripted event and
 * process it immediately, as the reconciler would.
 */
export async function advanceSandbox(session: RampSession): Promise<{ session: RampSession; advanced: boolean; reason?: string }> {
  if (session.provider !== "SANDBOX") throw badRequest("not_sandbox", "Only sandbox sessions can be advanced.");
  const ctx = withSecrets(session);
  if (sandbox.waitingForPayment(ctx)) {
    return { session, advanced: false, reason: "waiting_for_payment" };
  }
  const meta = sandbox.advance(ctx);
  if (!meta) return { session, advanced: false, reason: "scenario_finished" };
  const moved = await db().rampSession.update({
    where: { id: session.id },
    data: { metadata: asJson({ ...((session.metadata ?? {}) as object), sandbox: meta }) },
  });
  const { processSandboxSession } = await import("./reconciler");
  return { session: await processSandboxSession(moved), advanced: true };
}
