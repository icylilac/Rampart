-- Test mode and the sandbox provider.
--
-- Hand-written rather than generated, so existing data survives:
-- * the MOCK provider value is renamed to SANDBOX in place;
-- * each project's existing API key moves to api_keys as a LIVE key before
--   the old columns are dropped.

-- Provider: MOCK -> SANDBOX
ALTER TYPE "Provider" RENAME VALUE 'MOCK' TO 'SANDBOX';

-- API keys, one row per key, with a mode
CREATE TYPE "ApiKeyMode" AS ENUM ('LIVE', 'TEST');

CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "mode" "ApiKeyMode" NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "api_keys" ("id", "project_id", "mode", "key_hash", "prefix", "created_at")
SELECT gen_random_uuid()::text, "id", 'LIVE', "api_key_hash", "api_key_prefix", "created_at" FROM "projects";

DROP INDEX "projects_api_key_hash_key";
ALTER TABLE "projects" DROP COLUMN "api_key_hash", DROP COLUMN "api_key_prefix";

-- Sessions: live/test separation and a per-session client secret
ALTER TABLE "ramp_sessions" ADD COLUMN "livemode" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "client_secret_hash" TEXT;

CREATE UNIQUE INDEX "ramp_sessions_client_secret_hash_key" ON "ramp_sessions"("client_secret_hash");

DROP INDEX "ramp_sessions_project_id_external_reference_key";
CREATE UNIQUE INDEX "ramp_sessions_project_id_livemode_external_reference_key" ON "ramp_sessions"("project_id", "livemode", "external_reference");
