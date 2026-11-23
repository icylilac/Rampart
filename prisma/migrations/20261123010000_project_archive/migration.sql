-- Deleting a project from the dashboard archives it: its ramps and receipts
-- stay for the record, its keys are revoked and it leaves the dashboard.
ALTER TABLE "projects" ADD COLUMN "archived_at" TIMESTAMP(3);
