import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Database for the integration tests.
 *
 * - TEST_DATABASE_URL set (CI): use that Postgres.
 * - Otherwise: start a throwaway Postgres with `embedded-postgres`, so tests
 *   run on a laptop without Docker.
 *
 * Migrations are applied with `prisma migrate deploy` either way, so the
 * tests also prove the migrations work.
 */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

export default async function setup() {
  let stop: (() => Promise<void>) | undefined;
  let url = process.env.TEST_DATABASE_URL;

  if (!url) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const dir = mkdtempSync(join(tmpdir(), "rampart-pg-"));
    const port = await freePort();
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: true, onLog: () => {} });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("rampart_test");
    url = `postgresql://postgres:postgres@localhost:${port}/rampart_test?schema=public`;
    stop = async () => {
      // pg.stop() can wait forever for the process to exit on Windows; don't let it hold the run open.
      await Promise.race([pg.stop(), new Promise((r) => setTimeout(r, 10_000))]);
      // The folder is removed here rather than by embedded-postgres (persistent: true). On Windows
      // Postgres can hold its files for a moment after stopping, so retry, and if a file is still
      // locked, leave the folder in the temp directory with a warning instead of failing the run.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (error) {
        console.warn(`Could not remove the test database folder ${dir}: ${(error as Error).message}`);
      }
    };
  }

  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });

  return async () => {
    await stop?.();
  };
}
