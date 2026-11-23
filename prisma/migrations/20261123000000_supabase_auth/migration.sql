-- Email sign-in moves to Supabase Auth: accounts link to its user id, and
-- Rampart no longer stores password hashes.
ALTER TABLE "users" ADD COLUMN "auth_user_id" UUID;
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");
ALTER TABLE "users" DROP COLUMN "password_hash";
