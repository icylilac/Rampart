import rateLimit from "@fastify/rate-limit";
import type { Provider } from "@prisma/client";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { config } from "./config";
import { ingestEvent } from "./engine/inbound";
import { serializeSession, serializeTransition } from "./engine/serialize";
import {
  advanceSandbox,
  createSession,
  getSession,
  listSessions,
  refreshSession,
  sessionEvents,
  submitAnchorAuth,
  submitTransaction,
} from "./engine/sessions";
import { requireApiKey, requireClientSecret } from "./http/auth";
import { sandboxCheckoutPage } from "./http/sandbox-page";
import { sha256Hex } from "./lib/crypto";
import { ApiError, badRequest } from "./lib/errors";
import { allProviders, provider as providerFor, sandbox } from "./providers/registry";
import { SCENARIO_DESCRIPTIONS, SCENARIOS } from "./providers/sandbox";
import { WebhookSignatureError } from "./providers/types";
import { HorizonClient } from "./stellar/horizon";
import { resolveAsset, usdc } from "./stellar/network";
import { preflight } from "./stellar/preflight";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

// ------------------------------------------------------------------ request schemas

/**
 * Where the provider sends the user back after checkout: https only (http just
 * for localhost while developing), so it can't be a javascript: or data: URL.
 */
const returnUrl = z
  .string()
  .url()
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  }, "Must be an https URL (http is allowed for localhost only).");

const amount = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]).transform(Number).pipe(z.number().positive());

const createSessionBody = z
  .object({
    direction: z.enum(["ON", "OFF"]),
    provider: z.enum(["STRIPE", "MOONPAY", "ANCHOR", "SANDBOX"]).optional(),
    wallet_address: z.string().trim(),
    asset: z.string().trim().default("USDC"),
    fiat_currency: z.string().trim().length(3).optional(),
    fiat_amount: amount.optional(),
    crypto_amount: amount.optional(),
    external_reference: z.string().trim().min(1).max(200).optional(),
    anchor_domain: z.string().trim().optional(),
    redirect_url: returnUrl.optional(),
    customer_ip: z.string().ip().optional(),
    lang: z.string().trim().max(10).optional(),
    sandbox_scenario: z.string().trim().optional(),
    skip_preflight: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.fiat_amount !== undefined || b.crypto_amount !== undefined, {
    message: "Provide fiat_amount or crypto_amount.",
  });

const preflightBody = z
  .object({
    wallet_address: z.string().trim(),
    asset: z.string().trim().default("USDC"),
    direction: z.enum(["ON", "OFF"]).default("ON"),
    crypto_amount: amount.optional(),
  })
  .strict();

const listQuery = z.object({
  status: z.enum(["CREATED", "AWAITING_USER", "AWAITING_PAYMENT", "PROCESSING", "COMPLETED", "FAILED", "EXPIRED", "REFUNDED"]).optional(),
  provider: z.enum(["STRIPE", "MOONPAY", "ANCHOR", "SANDBOX"]).optional(),
  wallet_address: z.string().optional(),
  external_reference: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().uuid().optional(),
});

const signedXdrBody = z.object({ signed_xdr: z.string().min(1) }).strict();
const idParams = z.object({ id: z.string().uuid() });

// ------------------------------------------------------------------ server

/** CORS for the browser-facing routes; they take no cookies, only a client secret. */
function cors(reply: FastifyReply) {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Max-Age", "600");
}

/** Rate-limit bucket: the caller's key or client secret (hashed), else its IP. */
function rateLimitKey(request: FastifyRequest): string {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
  return m ? `k:${sha256Hex(m[1]).slice(0, 32)}` : `ip:${request.ip}`;
}

export function buildServer(): FastifyInstance {
  const cfg = config();
  const app = Fastify({ logger: cfg.NODE_ENV !== "test", bodyLimit: 256 * 1024, trustProxy: cfg.TRUST_PROXY });

  if (cfg.RATE_LIMIT_PER_MINUTE > 0) {
    void app.register(rateLimit, {
      max: cfg.RATE_LIMIT_PER_MINUTE,
      timeWindow: "1 minute",
      keyGenerator: rateLimitKey,
      // Providers retry webhooks we refuse; health checks come from the platform.
      allowList: (request) => request.url === "/health" || request.url.startsWith("/webhooks/"),
    });
  }

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
  });

  // Keep the raw body: webhook signatures are computed over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = body as string;
    request.rawBody = raw;
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(badRequest("invalid_json", "The request body is not valid JSON."), undefined);
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (request.url.startsWith("/v1/client")) cors(reply);
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_error", message: "The request is invalid.", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    if (err instanceof WebhookSignatureError) {
      return reply.status(400).send({ error: { code: "invalid_signature", message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests. Try again shortly." } });
    }
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    request.log.error(err);
    return reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong." } });
  });

  // Routes go in their own plugin so they load after the rate limiter, which
  // only applies itself to routes declared once it has loaded.
  void app.register(async (app) => {
    // ---------------------------------------------------------------- public
    app.get("/health", async () => ({ status: "ok", network: config().STELLAR_NETWORK }));

    app.get("/v1/providers", async () => ({
      network: config().STELLAR_NETWORK,
      usdc: usdc(),
      providers: allProviders().map((p) => p.capabilities()),
      test_mode: {
        ...sandbox.capabilities(),
        scenarios: SCENARIOS.map((id) => ({ id, description: SCENARIO_DESCRIPTIONS[id] })),
      },
    }));

    // ---------------------------------------------------------------- project API (API key)
    app.post("/v1/preflight", async (request) => {
      await requireApiKey(request);
      const body = preflightBody.parse(request.body);
      let asset;
      try {
        asset = resolveAsset(body.asset);
      } catch {
        throw badRequest("unsupported_asset", `Asset ${body.asset} is not supported. Use USDC or XLM.`);
      }
      return preflight(new HorizonClient(), {
        wallet: body.wallet_address,
        asset,
        direction: body.direction,
        cryptoAmount: body.crypto_amount,
      });
    });

    app.post("/v1/sessions", async (request, reply) => {
      const caller = await requireApiKey(request);
      const b = createSessionBody.parse(request.body);
      const { session, clientSecret, created } = await createSession(caller, {
        direction: b.direction,
        provider: b.provider as Provider | undefined,
        walletAddress: b.wallet_address,
        asset: b.asset,
        fiatCurrency: b.fiat_currency,
        fiatAmount: b.fiat_amount,
        cryptoAmount: b.crypto_amount,
        externalReference: b.external_reference,
        anchorDomain: b.anchor_domain,
        redirectUrl: b.redirect_url,
        customerIp: b.customer_ip ?? request.ip,
        lang: b.lang,
        sandboxScenario: b.sandbox_scenario,
        skipPreflight: b.skip_preflight,
      });
      return reply.status(created ? 201 : 200).send(serializeSession(session, { clientSecret }));
    });

    app.get("/v1/sessions", async (request) => {
      const caller = await requireApiKey(request);
      const q = listQuery.parse(request.query);
      const { rows, hasMore } = await listSessions(caller, {
        status: q.status,
        provider: q.provider as Provider | undefined,
        walletAddress: q.wallet_address,
        externalReference: q.external_reference,
        limit: q.limit,
        startingAfter: q.starting_after,
      });
      return { object: "list", data: rows.map((s) => serializeSession(s)), has_more: hasMore };
    });

    app.get("/v1/sessions/:id", async (request) => {
      const caller = await requireApiKey(request);
      const { id } = idParams.parse(request.params);
      return serializeSession(await getSession(caller, id));
    });

    app.get("/v1/sessions/:id/events", async (request) => {
      const caller = await requireApiKey(request);
      const { id } = idParams.parse(request.params);
      const { transitions, events } = await sessionEvents(await getSession(caller, id));
      return {
        object: "list",
        status_changes: transitions.map(serializeTransition),
        provider_events: events.map((e) => ({ object: "provider_event", id: e.eventId, type: e.type, received_at: e.receivedAt.toISOString() })),
      };
    });

    app.post("/v1/sessions/:id/refresh", async (request) => {
      const caller = await requireApiKey(request);
      const { id } = idParams.parse(request.params);
      return serializeSession(await refreshSession(await getSession(caller, id)));
    });

    app.post("/v1/sessions/:id/anchor/auth", async (request) => {
      const caller = await requireApiKey(request);
      const { id } = idParams.parse(request.params);
      const { signed_xdr } = signedXdrBody.parse(request.body);
      return serializeSession(await submitAnchorAuth(await getSession(caller, id), signed_xdr));
    });

    app.post("/v1/sessions/:id/transactions", async (request) => {
      const caller = await requireApiKey(request);
      const { id } = idParams.parse(request.params);
      const { signed_xdr } = signedXdrBody.parse(request.body);
      return serializeSession(await submitTransaction(await getSession(caller, id), signed_xdr));
    });

    app.post("/v1/sandbox/sessions/:id/advance", async (request) => {
      const caller = await requireApiKey(request);
      if (caller.livemode) throw badRequest("test_key_required", "Use an rk_test_ key to advance sandbox sessions.");
      const { id } = idParams.parse(request.params);
      const { session, advanced, reason } = await advanceSandbox(await getSession(caller, id));
      return { advanced, reason: reason ?? null, session: serializeSession(session) };
    });

    // ---------------------------------------------------------------- browser API (client secret)
    app.options("/v1/client/*", async (_request, reply) => {
      cors(reply);
      return reply.status(204).send();
    });

    const clientRoute = (handler: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
      cors(reply);
      return handler(request);
    };

    app.get(
      "/v1/client/sessions/:id",
      clientRoute(async (request) => {
        const { id } = idParams.parse(request.params);
        return serializeSession(await requireClientSecret(request, id));
      }),
    );

    app.post(
      "/v1/client/sessions/:id/anchor/auth",
      clientRoute(async (request) => {
        const { id } = idParams.parse(request.params);
        const { signed_xdr } = signedXdrBody.parse(request.body);
        return serializeSession(await submitAnchorAuth(await requireClientSecret(request, id), signed_xdr));
      }),
    );

    app.post(
      "/v1/client/sessions/:id/transactions",
      clientRoute(async (request) => {
        const { id } = idParams.parse(request.params);
        const { signed_xdr } = signedXdrBody.parse(request.body);
        return serializeSession(await submitTransaction(await requireClientSecret(request, id), signed_xdr));
      }),
    );

    // ---------------------------------------------------------------- provider webhooks
    const webhookRoute = (id: "STRIPE" | "MOONPAY") => async (request: FastifyRequest, reply: FastifyReply) => {
      const p = providerFor(id);
      if (!p.parseWebhook || request.rawBody === undefined) throw badRequest("invalid_webhook", "Expected a JSON webhook body.");
      const parsed = p.parseWebhook(request.rawBody, request.headers);
      if (!parsed) return reply.status(200).send({ received: true });
      const result = await ingestEvent(id, parsed, request.body);
      return reply.status(200).send({ received: true, outcome: result.outcome });
    };
    app.post("/webhooks/stripe", webhookRoute("STRIPE"));
    app.post("/webhooks/moonpay", webhookRoute("MOONPAY"));

    // ---------------------------------------------------------------- sandbox checkout page
    app.get("/sandbox/checkout/:id", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply
        .type("text/html; charset=utf-8")
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        .send(sandboxCheckoutPage(id));
    });
  });

  return app;
}
