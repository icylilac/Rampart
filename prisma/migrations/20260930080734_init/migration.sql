-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('ON', 'OFF');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('STRIPE', 'MOONPAY', 'ANCHOR', 'MOCK');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('CREATED', 'AWAITING_USER', 'AWAITING_PAYMENT', 'PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "api_key_prefix" TEXT NOT NULL,
    "webhook_url" TEXT,
    "webhook_secret_enc" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ramp_sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "provider" "Provider" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'CREATED',
    "provider_status" TEXT,
    "provider_ref" TEXT,
    "wallet_address" TEXT NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_issuer" TEXT,
    "fiat_currency" TEXT,
    "fiat_amount" DECIMAL(20,2),
    "crypto_amount" DECIMAL(24,7),
    "external_reference" TEXT,
    "anchor_domain" TEXT,
    "secrets_enc" TEXT,
    "next_action" JSONB,
    "stellar_tx_hash" TEXT,
    "onchain_verified" BOOLEAN,
    "onchain_check" JSONB,
    "failure_reason" TEXT,
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_polled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ramp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_transitions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "from_status" "SessionStatus" NOT NULL,
    "to_status" "SessionStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "event_id" TEXT NOT NULL,
    "session_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_api_key_hash_key" ON "projects"("api_key_hash");

-- CreateIndex
CREATE INDEX "ramp_sessions_provider_provider_ref_idx" ON "ramp_sessions"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "ramp_sessions_status_last_polled_at_idx" ON "ramp_sessions"("status", "last_polled_at");

-- CreateIndex
CREATE UNIQUE INDEX "ramp_sessions_project_id_external_reference_key" ON "ramp_sessions"("project_id", "external_reference");

-- CreateIndex
CREATE INDEX "session_transitions_session_id_created_at_idx" ON "session_transitions"("session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_provider_event_id_key" ON "provider_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "ramp_sessions" ADD CONSTRAINT "ramp_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_transitions" ADD CONSTRAINT "session_transitions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ramp_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ramp_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
