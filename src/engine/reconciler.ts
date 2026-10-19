import type { RampSession } from "@prisma/client";
import { config } from "../config";
import { db } from "../lib/db";
import { provider as providerFor, sandbox } from "../providers/registry";
import { ingestEvent } from "./inbound";
import { deliverDue } from "./outbound";
import { syncReceipts } from "./receipts";
import { applyUpdate, verifySession, withSecrets } from "./sessions";

const OPEN = ["CREATED", "AWAITING_USER", "AWAITING_PAYMENT", "PROCESSING"] as const;
/** Sessions that may still be abandoned; once money is moving we never expire them. */
const EXPIRABLE = ["CREATED", "AWAITING_USER"] as const;
const BATCH = 50;

type Log = (msg: string, err?: unknown) => void;
const defaultLog: Log = (msg, err) => console.error(`[reconciler] ${msg}`, err ?? "");

/**
 * Sandbox: emit the session's due webhooks through the normal ingestion path,
 * then apply its true current state as a poll would.
 */
export async function processSandboxSession(session: RampSession): Promise<RampSession> {
  const ctx = withSecrets(session);
  for (const hook of sandbox.dueWebhooks(ctx)) {
    await ingestEvent("SANDBOX", hook, { sandbox: true, event_id: hook.eventId, status: hook.update?.status });
  }
  const observedAt = new Date();
  const fresh = await db().rampSession.findUniqueOrThrow({ where: { id: session.id } });
  const update = await sandbox.poll(withSecrets(fresh));
  if (update) await applyUpdate(fresh.id, update, "poll", "sandbox", { observedAt });
  return db().rampSession.findUniqueOrThrow({ where: { id: session.id } });
}

/** Polls open sessions that haven't been checked within the reconcile interval. */
async function pollOpenSessions(now: Date, log: Log) {
  const cutoff = new Date(now.getTime() - config().RECONCILE_INTERVAL_SECONDS * 1000);
  const due = await db().rampSession.findMany({
    where: {
      status: { in: [...OPEN] },
      provider: { not: "SANDBOX" },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
    },
    orderBy: { lastPolledAt: { sort: "asc", nulls: "first" } },
    take: BATCH,
  });
  for (const s of due) {
    try {
      const observedAt = new Date();
      const update = await providerFor(s.provider).poll(withSecrets(s));
      if (update) await applyUpdate(s.id, update, "poll", "reconciler", { observedAt });
      else await db().rampSession.update({ where: { id: s.id }, data: { lastPolledAt: new Date() } });
    } catch (e) {
      log(`poll ${s.id} failed`, e);
      await db().rampSession.update({ where: { id: s.id }, data: { lastPolledAt: new Date() } });
    }
  }
}

/**
 * Sandbox sessions, including recently finished ones: a scenario may still
 * have late webhooks to send after completion.
 */
async function driveSandbox(now: Date, log: Log) {
  const recent = await db().rampSession.findMany({
    where: { provider: "SANDBOX", updatedAt: { gt: new Date(now.getTime() - 60 * 60_000) } },
    take: 200,
  });
  for (const s of recent) {
    try {
      await processSandboxSession(s);
    } catch (e) {
      log(`sandbox ${s.id} failed`, e);
    }
  }
}

/** Expires sessions the user abandoned, after one last look at the provider. */
async function expireStale(now: Date, log: Log) {
  const stale = await db().rampSession.findMany({
    where: { status: { in: [...EXPIRABLE] }, expiresAt: { lt: now } },
    take: BATCH,
  });
  for (const s of stale) {
    try {
      const observedAt = new Date();
      const update = await providerFor(s.provider).poll(withSecrets(s)).catch(() => null);
      let current = s;
      if (update) current = (await applyUpdate(s.id, update, "poll", "pre-expiry check", { observedAt })).session;
      if ((EXPIRABLE as readonly string[]).includes(current.status)) {
        await applyUpdate(
          s.id,
          { status: "EXPIRED", providerStatus: current.providerStatus ?? "expired", failureReason: "The session expired before the user finished." },
          "expire",
          "session TTL reached",
        );
      }
    } catch (e) {
      log(`expire ${s.id} failed`, e);
    }
  }
}

/** Completed sessions whose delivery Horizon hasn't confirmed yet. */
async function retryVerification(now: Date, log: Log) {
  const pending = await db().rampSession.findMany({
    where: {
      status: "COMPLETED",
      onchainVerified: null,
      stellarTxHash: { not: null },
      completedAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
    },
    take: BATCH,
  });
  for (const s of pending) {
    try {
      await verifySession(s);
    } catch (e) {
      log(`verify ${s.id} failed`, e);
    }
  }
}

/** One full pass. Each step is independent, so one failure doesn't stop the rest. */
export async function reconcileOnce(now = new Date(), log: Log = defaultLog): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["sandbox", () => (config().SANDBOX_ENABLED ? driveSandbox(now, log) : Promise.resolve())],
    ["poll", () => pollOpenSessions(now, log)],
    ["expire", () => expireStale(now, log)],
    ["verify", () => retryVerification(now, log)],
    ["receipts", () => syncReceipts(log)],
    ["webhooks", () => deliverDue()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      log(`${name} step failed`, e);
    }
  }
}

/** Runs reconcileOnce on a loop. Returns a function that stops it. */
export function startWorker(intervalMs = 2000, log: Log = defaultLog): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = reconcileOnce(new Date(), log).finally(() => {
      running = null;
    });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
