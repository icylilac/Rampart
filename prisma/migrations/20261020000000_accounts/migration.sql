-- Dashboard accounts: email + password and/or a Stellar wallet, with sessions.
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "wallet_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_wallet_address_key" ON "users"("wallet_address");
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Projects made from the dashboard belong to an account; CLI projects have none.
ALTER TABLE "projects" ADD COLUMN "owner_id" TEXT;
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
