import type { ApiKey, Project } from "@prisma/client";
import { encrypt } from "../lib/crypto";
import { db } from "../lib/db";
import { newApiKey, newWebhookSecret, type KeyMode } from "../lib/keys";

export type NewProject = {
  project: Project & { apiKeys: ApiKey[] };
  /** Shown once; only hashes (keys) or ciphertext (webhook secret) are stored. */
  secrets: { liveKey: string; testKey: string; webhookSecret: string };
};

/** A project with a live key, a test key and a webhook secret. Used by the CLI and the dashboard. */
export async function createProject(input: { name: string; webhookUrl?: string | null; ownerId?: string }): Promise<NewProject> {
  const live = newApiKey("LIVE");
  const test = newApiKey("TEST");
  const webhookSecret = newWebhookSecret();
  const project = await db().project.create({
    data: {
      name: input.name,
      webhookUrl: input.webhookUrl ?? null,
      webhookSecretEnc: encrypt(webhookSecret),
      ownerId: input.ownerId ?? null,
      apiKeys: {
        create: [
          { mode: "LIVE", keyHash: live.hash, prefix: live.prefix },
          { mode: "TEST", keyHash: test.hash, prefix: test.prefix },
        ],
      },
    },
    include: { apiKeys: { orderBy: { createdAt: "asc" } } },
  });
  return { project, secrets: { liveKey: live.key, testKey: test.key, webhookSecret } };
}

/** A new API key for an existing project; the key itself is returned once. */
export async function addApiKey(projectId: string, mode: KeyMode): Promise<{ apiKey: ApiKey; key: string }> {
  const k = newApiKey(mode);
  const apiKey = await db().apiKey.create({ data: { projectId, mode, keyHash: k.hash, prefix: k.prefix } });
  return { apiKey, key: k.key };
}
