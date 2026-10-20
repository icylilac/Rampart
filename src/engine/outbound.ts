import { randomUUID } from "node:crypto";
import type { RampSession } from "@prisma/client";
import { decrypt, hmacHex } from "../lib/crypto";
import { db } from "../lib/db";
import type { FetchLike } from "../stellar/horizon";
import { serializeSession } from "./serialize";

/** Retry schedule after a failed delivery; the last entry is the final attempt. */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10800, 21600, 43200];
const TIMEOUT_MS = 10_000;

/** `Rampart-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>` */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

/** Queues a ramp_session.updated event for the project's webhook endpoint, if it has one. */
export async function enqueueSessionEvent(session: RampSession): Promise<void> {
  const project = await db().project.findUnique({ where: { id: session.projectId }, select: { webhookUrl: true } });
  if (!project?.webhookUrl) return;
  const payload = {
    id: `evt_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    type: "ramp_session.updated",
    created: Math.floor(Date.now() / 1000),
    livemode: session.livemode,
    data: { object: serializeSession(session) },
  };
  await db().webhookDelivery.create({
    data: { projectId: session.projectId, sessionId: session.id, eventType: payload.type, payload },
  });
}

/**
 * Sends due deliveries. Each one is claimed with a conditional update on its
 * attempt count, so several workers can run without sending an event twice.
 */
export async function deliverDue(limit = 25, fetchImpl: FetchLike = fetch, now = new Date()): Promise<number> {
  const due = await db().webhookDelivery.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    include: { project: { select: { webhookUrl: true, webhookSecretEnc: true } } },
  });

  let sent = 0;
  for (const d of due) {
    const attempt = d.attempts + 1;
    const final = attempt >= RETRY_DELAYS_SECONDS.length + 1;
    const nextAttemptAt = new Date(now.getTime() + (RETRY_DELAYS_SECONDS[attempt - 1] ?? 0) * 1000);
    const claimed = await db().webhookDelivery.updateMany({
      where: { id: d.id, attempts: d.attempts, status: "PENDING" },
      data: { attempts: attempt, nextAttemptAt },
    });
    if (claimed.count === 0) continue;

    if (!d.project.webhookUrl) {
      await db().webhookDelivery.update({ where: { id: d.id }, data: { status: "FAILED", lastError: "Project has no webhook URL." } });
      continue;
    }

    const body = JSON.stringify(d.payload);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(d.project.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Rampart-Webhooks/1",
          "Rampart-Signature": signPayload(decrypt(d.project.webhookSecretEnc), body),
          "Rampart-Event-Id": (d.payload as { id?: string }).id ?? d.id,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      statusCode = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message;
    }

    if (!error) {
      sent++;
      await db().webhookDelivery.update({
        where: { id: d.id },
        data: { status: "DELIVERED", deliveredAt: new Date(), lastStatusCode: statusCode, lastError: null },
      });
    } else {
      await db().webhookDelivery.update({
        where: { id: d.id },
        data: { status: final ? "FAILED" : "PENDING", lastStatusCode: statusCode, lastError: error.slice(0, 500) },
      });
    }
  }
  return sent;
}
