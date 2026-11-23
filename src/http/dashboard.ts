import type { ApiKey, Prisma, Project, User } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config";
import { linkWallet, signOut, signOutEverywhere, supabaseSignIn, walletChallenge, walletSignIn, type SignedIn } from "../engine/accounts";
import { supabaseUser } from "../lib/supabase-auth";
import { addApiKey, createProject } from "../engine/projects";
import { serializeSession } from "../engine/serialize";
import { db } from "../lib/db";
import { ApiError, notFound } from "../lib/errors";
import { isStellarAddress } from "../lib/wallet-challenge";
import { webhookUrlProblem } from "../lib/webhook-target";
import { requireUser } from "./auth";

/**
 * Dashboard API: sign-in (Supabase Auth: email + password, Google, GitHub,
 * ...; or a Stellar wallet),
 * then projects and API keys for the signed-in user. The browser holds an
 * rds_ bearer token; no cookies, so CORS stays simple.
 */

const MAX_PROJECTS_PER_USER = 25;
const MAX_ACTIVE_KEYS_PER_PROJECT = 20;

const address = z.string().trim().refine(isStellarAddress, "Enter a Stellar account address (G...).");
const challengeBody = z.object({ address }).strict();
const walletBody = z.object({ address, token: z.string().min(1).max(1000), signature: z.string().min(1).max(200) }).strict();
const supabaseBody = z.object({ access_token: z.string().min(1).max(4000) }).strict();

const keyBody = z.object({ mode: z.enum(["live", "test"]) }).strict();
const projectParams = z.object({ id: z.string().uuid() });
const keyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });
const sessionsQuery = z.object({
  mode: z.enum(["live", "test"]).default("test"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  starting_after: z.string().uuid().optional(),
});

const serializeUser = (u: User) => ({
  object: "user",
  id: u.id,
  email: u.email,
  wallet_address: u.walletAddress,
  supabase_user_id: u.authUserId,
  created_at: u.createdAt.toISOString(),
});

const serializeSignIn = (s: SignedIn) => ({ token: s.token, expires_at: s.expiresAt.toISOString(), user: serializeUser(s.user) });

const serializeKey = (k: ApiKey) => ({
  object: "api_key",
  id: k.id,
  mode: k.mode === "LIVE" ? "live" : "test",
  prefix: k.prefix,
  created_at: k.createdAt.toISOString(),
  revoked_at: k.revokedAt?.toISOString() ?? null,
});

const serializeProject = (p: Project & { apiKeys: ApiKey[] }) => ({
  object: "project",
  id: p.id,
  name: p.name,
  webhook_url: p.webhookUrl,
  created_at: p.createdAt.toISOString(),
  api_keys: p.apiKeys.map(serializeKey),
});

/** A project the user owns and hasn't deleted; anyone else's looks like it doesn't exist. */
async function ownedProject(userId: string, id: string) {
  const project = await db().project.findFirst({ where: { id, ownerId: userId, archivedAt: null } });
  if (!project) throw notFound("Project");
  return project;
}

export function dashboardRoutes(app: FastifyInstance) {
  const cfg = config();
  // Checked again, with DNS, before every delivery (src/engine/outbound.ts).
  const webhookUrl = z
    .string()
    .trim()
    .url()
    .superRefine((v, ctx) => {
      const problem = webhookUrlProblem(v, cfg.NODE_ENV === "development");
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    });
  const projectBody = z.object({ name: z.string().trim().min(1).max(80), webhook_url: webhookUrl.nullish() }).strict();
  // webhook_url null removes the webhook. Deliveries already queued go to the new URL.
  const projectPatch = z
    .object({ name: z.string().trim().min(1).max(80).optional(), webhook_url: webhookUrl.nullable().optional() })
    .strict()
    .refine((b) => b.name !== undefined || b.webhook_url !== undefined, "Send a name or a webhook_url.");
  // Sign-in endpoints get their own, tighter per-IP budget.
  const authLimit =
    cfg.AUTH_RATE_LIMIT_PER_MINUTE > 0
      ? { config: { rateLimit: { max: cfg.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute", keyGenerator: (r: FastifyRequest) => `auth:${r.ip}` } } }
      : {};

  // ---------------------------------------------------------------- auth
  // The site signs in with Supabase Auth, then trades its access token for an rds_ session.
  app.post("/v1/auth/supabase", authLimit, async (request) => {
    const b = supabaseBody.parse(request.body);
    return serializeSignIn(await supabaseSignIn(await supabaseUser(b.access_token)));
  });

  app.post("/v1/auth/wallet/challenge", authLimit, async (request, reply) => {
    const b = challengeBody.parse(request.body);
    const c = walletChallenge(b.address);
    return reply.header("Cache-Control", "no-store").send({ message: c.message, token: c.token, expires_at: new Date(c.expiresAt).toISOString() });
  });

  app.post("/v1/auth/wallet", authLimit, async (request) => {
    const b = walletBody.parse(request.body);
    return serializeSignIn(await walletSignIn(b.address, b.token, b.signature));
  });

  app.get("/v1/auth/me", async (request) => serializeUser((await requireUser(request)).user));

  app.post("/v1/auth/logout", async (request, reply) => {
    await signOut((await requireUser(request)).sessionId);
    return reply.status(204).send();
  });

  app.post("/v1/auth/logout-all", async (request, reply) => {
    await signOutEverywhere((await requireUser(request)).user.id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- account
  app.post("/v1/account/wallet", authLimit, async (request) => {
    const { user } = await requireUser(request);
    const b = walletBody.parse(request.body);
    return serializeUser(await linkWallet(user, b.address, b.token, b.signature));
  });

  // ---------------------------------------------------------------- projects and keys
  app.get("/v1/dashboard/projects", async (request) => {
    const { user } = await requireUser(request);
    const projects = await db().project.findMany({
      where: { ownerId: user.id, archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: { apiKeys: { orderBy: { createdAt: "asc" } } },
    });
    return { object: "list", data: projects.map(serializeProject) };
  });

  app.post("/v1/dashboard/projects", async (request, reply) => {
    const { user } = await requireUser(request);
    const b = projectBody.parse(request.body);
    if ((await db().project.count({ where: { ownerId: user.id, archivedAt: null } })) >= MAX_PROJECTS_PER_USER) {
      throw new ApiError(409, "project_limit", `An account can have up to ${MAX_PROJECTS_PER_USER} projects.`);
    }
    const { project, secrets } = await createProject({ name: b.name, webhookUrl: b.webhook_url, ownerId: user.id });
    return reply.status(201).send({
      project: serializeProject(project),
      secrets: { live_key: secrets.liveKey, test_key: secrets.testKey, webhook_secret: secrets.webhookSecret },
    });
  });

  app.post("/v1/dashboard/projects/:id/keys", async (request, reply) => {
    const { user } = await requireUser(request);
    const { id } = projectParams.parse(request.params);
    const { mode } = keyBody.parse(request.body);
    await ownedProject(user.id, id);
    if ((await db().apiKey.count({ where: { projectId: id, revokedAt: null } })) >= MAX_ACTIVE_KEYS_PER_PROJECT) {
      throw new ApiError(409, "key_limit", `A project can have up to ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys. Revoke one first.`);
    }
    const { apiKey, key } = await addApiKey(id, mode === "live" ? "LIVE" : "TEST");
    return reply.status(201).send({ api_key: serializeKey(apiKey), secret: key });
  });

  app.patch("/v1/dashboard/projects/:id", async (request) => {
    const { user } = await requireUser(request);
    const { id } = projectParams.parse(request.params);
    const b = projectPatch.parse(request.body);
    await ownedProject(user.id, id);
    const project = await db().project.update({
      where: { id },
      data: { name: b.name, webhookUrl: b.webhook_url },
      include: { apiKeys: { orderBy: { createdAt: "asc" } } },
    });
    return serializeProject(project);
  });

  // Archived, not erased: ramps, receipts and webhook history stay. Its keys
  // stop working at once and queued webhooks fail for want of a URL.
  app.delete("/v1/dashboard/projects/:id", async (request, reply) => {
    const { user } = await requireUser(request);
    const { id } = projectParams.parse(request.params);
    await ownedProject(user.id, id);
    const now = new Date();
    await db().$transaction([
      db().apiKey.updateMany({ where: { projectId: id, revokedAt: null }, data: { revokedAt: now } }),
      db().project.update({ where: { id }, data: { archivedAt: now, webhookUrl: null } }),
    ]);
    return reply.status(204).send();
  });

  // The project's ramps, newest first, one mode at a time (the dashboard's two tabs).
  app.get("/v1/dashboard/projects/:id/sessions", async (request) => {
    const { user } = await requireUser(request);
    const { id } = projectParams.parse(request.params);
    const q = sessionsQuery.parse(request.query);
    await ownedProject(user.id, id);
    const where: Prisma.RampSessionWhereInput = { projectId: id, livemode: q.mode === "live" };
    if (q.starting_after) {
      const cursor = await db().rampSession.findFirst({ where: { id: q.starting_after, projectId: id } });
      if (!cursor) throw new ApiError(400, "invalid_cursor", "starting_after does not match a session.");
      where.OR = [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }];
    }
    const rows = await db().rampSession.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit + 1 });
    return { object: "list", data: rows.slice(0, q.limit).map((s) => serializeSession(s)), has_more: rows.length > q.limit };
  });

  app.delete("/v1/dashboard/projects/:id/keys/:keyId", async (request) => {
    const { user } = await requireUser(request);
    const { id, keyId } = keyParams.parse(request.params);
    await ownedProject(user.id, id);
    const key = await db().apiKey.findFirst({ where: { id: keyId, projectId: id } });
    if (!key) throw notFound("API key");
    const revoked = key.revokedAt ? key : await db().apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    return serializeKey(revoked);
  });
}
