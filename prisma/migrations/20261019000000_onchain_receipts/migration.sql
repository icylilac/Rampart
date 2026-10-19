-- On-chain receipts (contracts/ramp-receipts) for verified live deliveries.
ALTER TABLE "ramp_sessions" ADD COLUMN "receipt_tx_hash" TEXT;
ALTER TABLE "ramp_sessions" ADD COLUMN "receipt_recorded_at" TIMESTAMP(3);
ALTER TABLE "ramp_sessions" ADD COLUMN "receipt_refunded_at" TIMESTAMP(3);
ALTER TABLE "ramp_sessions" ADD COLUMN "receipt_error" TEXT;
