#!/bin/sh
# Build step for the API on Vercel (see vercel.json).
set -e
npx prisma generate
# Only production deploys migrate: a PR preview must never change the live
# database's schema. Migrations go over Neon's direct (unpooled) connection.
if [ "$VERCEL_ENV" = "production" ]; then
  DATABASE_URL="${DATABASE_URL_UNPOOLED:-$DATABASE_URL}" npx prisma migrate deploy
fi
# One CommonJS file with the dependencies inlined (see api/index.js). Prisma
# stays external: its query engine is a native file Vercel traces and ships.
npx esbuild src/vercel.ts --bundle --platform=node --target=node22 --format=cjs \
  --outfile=dist-vercel/handler.js --external:@prisma/client --external:.prisma --external:sodium-native --log-level=warning
# Vercel wants a non-empty output directory; the API itself is the function in api/.
mkdir -p public
printf 'User-agent: *\nDisallow: /\n' > public/robots.txt
