/**
 * Minimal forward-only migration runner.
 *
 * Applies every db/migrations/*.sql not yet recorded in _migrations, each in its
 * own transaction, in filename order. No rollback: to undo something, write a
 * new migration. That constraint is deliberate -- it keeps production and a
 * fresh local database reachable by exactly one path.
 *
 *   npm run db:migrate           # apply pending
 *   npm run db:migrate -- --dry  # list pending, change nothing
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const dryRun = process.argv.includes("--dry");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "[error] DATABASE_URL is not set.\n" +
      "        Put your Neon connection string in .env.local (see .env.example),\n" +
      "        or pass it inline: DATABASE_URL=... npm run db:migrate",
  );
  process.exit(1);
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const pool = new Pool({ connectionString });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await pool.query("SELECT name, checksum FROM _migrations");
  const appliedBy = new Map(applied.map((r) => [r.name, r.checksum]));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // A migration whose contents changed after being applied means the file and
  // the database have diverged -- every environment that ran the old version is
  // now silently different. Refuse rather than guess.
  for (const file of files) {
    const prev = appliedBy.get(file);
    if (prev === undefined) continue;
    const now = sha(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    if (prev !== now) {
      console.error(
        `[error] ${file} was modified after it was applied (${prev} -> ${now}).\n` +
          "        Restore the original and add a new migration instead.",
      );
      process.exit(1);
    }
  }

  const pending = files.filter((f) => !appliedBy.has(f));
  if (pending.length === 0) {
    console.log(`Up to date (${files.length} migration${files.length === 1 ? "" : "s"} applied).`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`${pending.length} pending:`);
    for (const f of pending) console.log(`  - ${f}`);
    process.exit(0);
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
        file,
        sha(sql),
      ]);
      await client.query("COMMIT");
      console.log(`  applied  ${file}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`  FAILED   ${file}\n           ${err.message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(`\nDone -- ${pending.length} migration${pending.length === 1 ? "" : "s"} applied.`);
} finally {
  await pool.end();
}
