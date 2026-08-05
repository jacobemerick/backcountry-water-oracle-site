/**
 * Seed the database from the engine's worked example.
 *
 * Idempotent: every row it writes is tagged provenance='seed', and a re-run
 * clears only those before reinserting. User-submitted reports on the same
 * source are never touched.
 *
 *   npm run db:seed
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "seed");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[error] DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

/** RFC4180-ish reader: handles quoted fields containing commas and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);

  const [header, ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const slugify = (name) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-");

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".csv")).sort();
  if (files.length === 0) {
    console.log("No seed files found.");
    process.exit(0);
  }

  await client.query("BEGIN");

  let sourceCount = 0;
  let reportCount = 0;

  for (const file of files) {
    const rows = parseCsv(readFileSync(join(SEED_DIR, file), "utf8"));

    // Group by name. The engine treats rows sharing a name as one source and
    // silently adopts the first row's coordinates for all of them, so a name
    // spanning multiple coordinates is a data error, not something to smooth
    // over -- refuse rather than seed a source that correlates half its
    // observations against the wrong location's rainfall.
    const byName = new Map();
    for (const r of rows) {
      const entry = byName.get(r.source) ?? { lat: r.lat, lon: r.lon, rows: [] };
      if (entry.lat !== r.lat || entry.lon !== r.lon) {
        throw new Error(
          `${file}: "${r.source}" appears at both (${entry.lat}, ${entry.lon}) and ` +
            `(${r.lat}, ${r.lon}). Give the two sources distinct names.`,
        );
      }
      entry.rows.push(r);
      byName.set(r.source, entry);
    }

    for (const [name, { lat, lon, rows: reports }] of byName) {
      const slug = slugify(name);
      const {
        rows: [source],
      } = await client.query(
        `INSERT INTO sources (name, slug, lat, lon)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, slug, Number(lat), Number(lon)],
      );
      sourceCount++;

      await client.query("DELETE FROM reports WHERE source_id = $1 AND provenance = 'seed'", [
        source.id,
      ]);

      // Single multi-row INSERT: 233 round trips would be silly.
      const values = [];
      const params = [];
      reports.forEach((r, i) => {
        const b = i * 4;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, 'seed')`);
        params.push(source.id, r.date, Number(r.score), r.status || null);
      });
      await client.query(
        `INSERT INTO reports (source_id, observed_on, score, status, provenance)
         VALUES ${values.join(", ")}`,
        params,
      );
      reportCount += reports.length;
      console.log(`  ${name} — ${reports.length} reports`);
    }
  }

  await client.query("COMMIT");
  console.log(`\nSeeded ${sourceCount} source(s), ${reportCount} report(s).`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[error] ${err.message}`);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
