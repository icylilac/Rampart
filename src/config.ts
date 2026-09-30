import { z } from "zod";

const optional = z.string().trim().min(1).optional();

export const configSchema = z.object({
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

  /** Enables the MOCK provider (never in production). */
  ENABLE_MOCK_PROVIDER: z
    .string()
    .optional()
    .transform((v) => v === "true"),
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
    if (parsed.data.NODE_ENV === "production" && parsed.data.ENABLE_MOCK_PROVIDER) {
      throw new Error("ENABLE_MOCK_PROVIDER must not be set in production");
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
