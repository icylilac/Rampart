import { z } from "zod";

const optional = z.string().trim().min(1).optional();

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  /** 32-byte key (base64) for encrypting stored secrets (AES-256-GCM). */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  /** Public base URL of this service, used for provider redirect/callback URLs. */
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),

  STELLAR_NETWORK: z.enum(["TESTNET", "PUBLIC"]).default("TESTNET"),
  HORIZON_URL: z.string().url().optional(),
  /** USDC issuer override; defaults to Circle's issuer for the network. */
  USDC_ISSUER: optional,

  /** Soroban RPC for the receipts contract; defaults to SDF's for the network. */
  SOROBAN_RPC_URL: z.string().url().optional(),
  /**
   * On-chain receipts (contracts/ramp-receipts). When both are set, every
   * verified live delivery is recorded in the contract by the attester key.
   */
  RECEIPTS_CONTRACT_ID: z
    .string()
    .trim()
    .regex(/^C[A-Z2-7]{55}$/, "RECEIPTS_CONTRACT_ID must be a contract address (C...)")
    .optional(),
  RECEIPTS_ATTESTER_SECRET: z
    .string()
    .trim()
    .regex(/^S[A-Z2-7]{55}$/, "RECEIPTS_ATTESTER_SECRET must be a Stellar secret key (S...)")
    .optional(),

  /**
   * Requests per minute per API key, client secret or (without one) IP
   * address. 0 turns rate limiting off. Health checks and provider webhooks
   * are never limited.
   */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  /** Sign-up, sign-in and wallet-challenge requests per minute per IP (0 = only the general limit). */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(10),
  /** How long a dashboard sign-in lasts. */
  USER_SESSION_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Supabase Auth, for dashboard sign-in with Google, GitHub and other
   * providers (POST /v1/auth/oauth). Set both, or neither to turn it off.
   */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: optional,
  /**
   * Server-only. Lets wallet sign-ins get a Supabase Auth user too, so every
   * account has a Supabase UID. Never send it to the browser.
   */
  SUPABASE_SERVICE_ROLE_KEY: optional,
  /** Domain for the placeholder email of a wallet's Supabase user; nothing is ever sent to it. */
  WALLET_EMAIL_DOMAIN: z.string().trim().min(1).default("wallet.rampartpay.xyz"),
  /**
   * Behind a reverse proxy, where client IPs come from X-Forwarded-For: the
   * number of proxies in front of Rampart (safest), or "true" to trust every
   * hop, which is only safe if the proxy overwrites the header (Vercel does).
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v): boolean | number => (v === "true" ? true : v && /^[0-9]+$/.test(v.trim()) ? Number(v) : false)),

  /**
   * Turns on POST /internal/reconcile (one worker pass) for a scheduler to
   * call with "Authorization: Bearer <CRON_SECRET>". At least 32 characters.
   */
  CRON_SECRET: z.string().trim().min(32).optional(),

  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,

  MOONPAY_PUBLISHABLE_KEY: optional,
  MOONPAY_SECRET_KEY: optional,
  MOONPAY_WEBHOOK_KEY: optional,
  MOONPAY_BUY_URL: z.string().url().default("https://buy-sandbox.moonpay.com"),
  MOONPAY_SELL_URL: z.string().url().default("https://sell-sandbox.moonpay.com"),
  MOONPAY_API_URL: z.string().url().default("https://api.moonpay.com"),
  /** MoonPay currency codes for Stellar assets. Confirm against your MoonPay account's currency list. */
  MOONPAY_CURRENCY_USDC: z.string().default("usdc_xlm"),
  MOONPAY_CURRENCY_XLM: z.string().default("xlm"),

  /** Comma-separated anchor home domains projects may use (SEP-1 / SEP-10 / SEP-24). */
  ANCHOR_DOMAINS: z.string().default("testanchor.stellar.org"),

  /**
   * Test mode: rk_test_ keys run every session on the simulated SANDBOX
   * provider. On by default, as in Stripe; set to "false" to turn test keys off.
   */
  SANDBOX_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  /** Seconds between simulated sandbox steps (CREATED → ... → COMPLETED). */
  SANDBOX_STEP_SECONDS: z.coerce.number().positive().default(3),

  /**
   * Run the reconciler and webhook delivery inside the API process. Set to
   * "false" when running `npm run worker` separately (e.g. docker-compose).
   */
  WORKER_IN_PROCESS: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
});

export const configSchema = baseSchema
  .refine((c) => Boolean(c.RECEIPTS_CONTRACT_ID) === Boolean(c.RECEIPTS_ATTESTER_SECRET), {
    message: "Set both RECEIPTS_CONTRACT_ID and RECEIPTS_ATTESTER_SECRET, or neither",
    path: ["RECEIPTS_CONTRACT_ID"],
  })
  .refine((c) => Boolean(c.SUPABASE_URL) === Boolean(c.SUPABASE_ANON_KEY), {
    message: "Set both SUPABASE_URL and SUPABASE_ANON_KEY, or neither",
    path: ["SUPABASE_URL"],
  })
  .refine((c) => !c.SUPABASE_SERVICE_ROLE_KEY || Boolean(c.SUPABASE_URL), {
    message: "SUPABASE_SERVICE_ROLE_KEY needs SUPABASE_URL",
    path: ["SUPABASE_SERVICE_ROLE_KEY"],
  });

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = configSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For tests that change the environment between cases. */
export function resetConfig() {
  cached = undefined;
}

export function anchorDomains(): string[] {
  return config()
    .ANCHOR_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}
