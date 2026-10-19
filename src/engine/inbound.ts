import { Prisma, type Provider } from "@prisma/client";
import { db } from "../lib/db";
import type { ParsedWebhook } from "../providers/types";
import { applyUpdate, type ApplyResult } from "./sessions";

export type IngestResult =
  | { outcome: "duplicate" }
  | { outcome: "unmatched" }
  | { outcome: "recorded"; sessionId: string }
  | { outcome: "applied" | "ignored"; sessionId: string; detail?: string };

/**
 * Records one provider event and applies it to its session.
 *
 * Every event is stored once (unique on provider + event id), so a provider
 * retrying the same webhook is a no-op. Webhooks go through the same state
 * machine as polls, but may not move a session backwards.
 */
export async function ingestEvent(provider: Provider, parsed: ParsedWebhook, payload: unknown): Promise<IngestResult> {
  const session = parsed.sessionId
    ? await db().rampSession.findFirst({ where: { id: parsed.sessionId, provider } })
    : parsed.providerRef
      ? await db().rampSession.findFirst({ where: { provider, providerRef: parsed.providerRef }, orderBy: { createdAt: "desc" } })
      : null;

  try {
    await db().providerEvent.create({
      data: {
        provider,
        eventId: parsed.eventId,
        type: parsed.type,
        sessionId: session?.id ?? null,
        payload: (payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { outcome: "duplicate" };
    throw e;
  }

  if (!session) return { outcome: "unmatched" };
  if (!parsed.update) return { outcome: "recorded", sessionId: session.id };

  const result: ApplyResult = await applyUpdate(session.id, parsed.update, "webhook", parsed.type);
  return result.ignored
    ? { outcome: "ignored", sessionId: session.id, detail: result.ignored }
    : { outcome: "applied", sessionId: session.id };
}
