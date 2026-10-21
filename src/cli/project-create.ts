import { createProject } from "../engine/projects";
import { config } from "../config";
import { db } from "../lib/db";
import { webhookUrlProblem } from "../lib/webhook-target";

/**
 * Creates a project with a live key, a test key and a webhook secret.
 * The secrets are printed once and only their hashes are stored.
 * (Signed-in users can do the same from the dashboard.)
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
  const problem = webhookUrl ? webhookUrlProblem(webhookUrl, config().NODE_ENV === "development") : null;
  if (problem) {
    console.error(`--webhook-url: ${problem}`);
    process.exit(1);
  }

  const { project, secrets } = await createProject({ name, webhookUrl });

  console.log(`Project:         ${project.name} (${project.id})`);
  console.log(`Live API key:    ${secrets.liveKey}`);
  console.log(`Test API key:    ${secrets.testKey}`);
  console.log(`Webhook secret:  ${secrets.webhookSecret}`);
  console.log(`Webhook URL:     ${webhookUrl ?? "(none: set one to receive ramp_session.updated)"}`);
  console.log("\nStore these now. Only their hashes are kept; they can't be shown again.");
  await db().$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db().$disconnect();
  process.exit(1);
});
