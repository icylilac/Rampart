import { db } from "../lib/db";
import { encrypt } from "../lib/crypto";
import { newApiKey, newWebhookSecret } from "../lib/keys";

/**
 * Creates a project with a live key, a test key and a webhook secret.
 * The secrets are printed once and only their hashes are stored.
 *
 *   npm run project:create -- --name "My app" [--webhook-url https://example.com/hooks/ramp]
 *   docker compose run --rm api node dist/cli/project-create.js --name "My app"
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg("name");
  const webhookUrl = arg("webhook-url");
  if (!name) {
    console.error('Usage: npm run project:create -- --name "My app" [--webhook-url https://...]');
    process.exit(1);
  }
  if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) {
    console.error("--webhook-url must be an http(s) URL");
    process.exit(1);
  }

  const live = newApiKey("LIVE");
  const test = newApiKey("TEST");
  const webhookSecret = newWebhookSecret();

  const project = await db().project.create({
    data: {
      name,
      webhookUrl: webhookUrl ?? null,
      webhookSecretEnc: encrypt(webhookSecret),
      apiKeys: {
        create: [
          { mode: "LIVE", keyHash: live.hash, prefix: live.prefix },
          { mode: "TEST", keyHash: test.hash, prefix: test.prefix },
        ],
      },
    },
  });

  console.log(`Project:         ${project.name} (${project.id})`);
  console.log(`Live API key:    ${live.key}`);
  console.log(`Test API key:    ${test.key}`);
  console.log(`Webhook secret:  ${webhookSecret}`);
  console.log(`Webhook URL:     ${webhookUrl ?? "(none: set one to receive ramp_session.updated)"}`);
  console.log("\nStore these now. Only their hashes are kept; they can't be shown again.");
  await db().$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db().$disconnect();
  process.exit(1);
});
