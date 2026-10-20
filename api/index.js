// Vercel function entry. The real handler is src/vercel.ts, bundled into one
// CommonJS file at build time (scripts/vercel-build.sh): Vercel's loader can't
// require() the ESM-only packages the Stellar SDK pulls in.
module.exports = require("../dist-vercel/handler.js").default;
