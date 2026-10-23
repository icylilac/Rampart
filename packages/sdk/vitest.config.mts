import { defineConfig } from "vitest/config";

// The SDK has no database; don't inherit the service's test setup.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
