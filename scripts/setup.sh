#!/usr/bin/env bash
# First-time setup: .env with a fresh encryption key, dependencies, Prisma client.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  key=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  # Portable in-place edit (macOS and Linux).
  sed "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=${key}#" .env > .env.tmp && mv .env.tmp .env
  echo "Created .env with a new ENCRYPTION_KEY. Fill in DATABASE_URL and provider keys."
else
  echo ".env already exists; left unchanged."
fi

npm install
npx prisma generate >/dev/null
echo
echo "Next:"
echo "  npm run db:migrate                     # create tables (needs DATABASE_URL)"
echo "  npm run dev                            # http://localhost:8080/health"
echo "  npm run preflight -- <G...address>     # is a wallet ready to receive USDC?"
echo "  npm run anchor:check -- testanchor.stellar.org"
