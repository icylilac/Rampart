import { randomBytes } from "node:crypto";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      STELLAR_NETWORK: "TESTNET",
      PUBLIC_BASE_URL: "http://localhost:8080",
      STRIPE_WEBHOOK_SECRET: "whsec_test_stripe",
      // Off for the suite; test/security.test.ts turns it on.
      RATE_LIMIT_PER_MINUTE: "0",
    },
  },
});
