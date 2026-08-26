/**
 * Bulk-import field observations from a CSV.
 *
 *   npm run import:reports -- db/seed/jacob-field-notes-2026-08.csv --dry-run
 *   npm run import:reports -- db/seed/jacob-field-notes-2026-08.csv \
 *     --submitter="Jacob Emerick" --provenance=import
 *
 * The format is the engine's contract -- `source,lat,lon,date,score,status` --
 * which is also what `db/seed/*.csv` already uses, so one file serves as both a
 * local seed and a production import. Blank coordinates resolve against the
 * gazetteer by name.
 *
 * **Dry run first, always.** It reports exactly what would be written and every
 * row it refused, by reason, and touches nothing. #68 established this for the
 * archived reports and the reason is the same: see the yield before writing it.
 *
 * **Re-runs replace, they do not append.** `reports` has no natural key -- two
 * people may honestly report one spring on the same day and disagree, and the
 * schema protects that -- so a batch is identified by (provenance, submitter)
 * and cleared before reinsert. That means the CSV is authoritative: a hand
 * correction made in the database and not in the file is lost on the next run.
 * The alternative was an `import_ref` column, which is a migration; this is the
 * same trade `db:seed` already makes for provenance='seed'.
 */
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { collectSources, parseReportCsv } from "../src/lib/report-import.ts";

neonConfig.webSocketConstructor = ws;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name) => process.argv.includes(`--${name}`);

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun = has("dry-run");
const provenance = arg("provenance") ?? "import";
const submitter = arg("submitter") ?? null;
const state = (arg("state") ?? "AZ").toUpperCase();
/** How close an existing source has to be to be worth a warning. Matches the picker. */
const DUPLICATE_RADIUS_KM = 2;

if (!file) {
  console.error("[error] usage: npm run import:reports -- <file.csv> [--dry-run]");
  process.exit(1);
}
// 0001's CHECK. Failing here beats failing after the sources are already written.
if (!["user", "import", "seed"].includes(provenance)) {
  console.error(`[error] --provenance must be user, import or seed (got ${provenance})`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[error] DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

// The future-date boundary, decided once here rather than per row, so a run
// that straddles midnight cannot accept a row it would have refused a second
// earlier.
const today = new Date().toISOString().slice(0, 10);

const { rows, drops, errors } = parseReportCsv(readFileSync(file, "utf8"), today);
if (errors.length) {
  for (const e of errors) console.error(`[error] ${e}`);
  process.exit(1);
}

const { sources, errors: sourceErrors } = collectSources(rows);
if (sourceErrors.length) {
  for (const e of sourceErrors) console.error(`[error] ${e}`);
  process.exit(1);
}

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  // -------------------------------------------------------------------------
  // Resolve the sources that arrived without a coordinate
  // -------------------------------------------------------------------------
  const unresolved = [];
  for (const s of sources) {
    if (s.lat !== null) continue;

    const { rows: hits } = s.gnisId
      ? await client.query(
          `SELECT name, lat, lon, county, feed, external_id FROM gazetteer
            WHERE feed LIKE 'USGS GNIS%' AND external_id = $1`,
          [s.gnisId],
        )
      : await client.query(
          `SELECT name, lat, lon, county, feed, external_id FROM gazetteer
            WHERE state = $1 AND duplicate_of IS NULL AND lower(name) = lower($2)`,
          [state, s.name],
        );

    if (hits.length === 1) {
      s.lat = hits[0].lat;
      s.lon = hits[0].lon;
      // Carry the gazetteer identifier onto the source. This is the
      // reconciliation 0001 put gnis_id/osm_id there for: with it, the
      // gazetteer stays reloadable without the two ever drifting into two
      // points for one spring.
      if (hits[0].feed.startsWith("USGS GNIS")) s.gnisId = hits[0].external_id;
      else s.osmId = hits[0].external_id;
      console.log(`  resolved "${s.name}" → ${s.lat},${s.lon} (${hits[0].county ?? "—"} County)`);
    } else {
      // Refuse rather than take the first. The AZT has several unrelated "Bear
      // Spring"s and GNIS has 264 "Willow Spring"s; choosing silently would
      // correlate a report against rain that fell a hundred miles away, and
      // nothing in the output would ever show it. (#66)
      unresolved.push({ name: s.name, matches: hits.length });
    }
  }

  if (unresolved.length) {
    console.error("\n[error] these sources have no coordinate and could not be resolved:");
    for (const u of unresolved) {
      console.error(
        `  ${u.name} — ${u.matches === 0 ? "no gazetteer match" : `${u.matches} matches in ${state}, ambiguous`}`,
      );
    }
    console.error("  Give a lat/lon in the CSV, or a gnis_id column to disambiguate.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Warn where this lands on top of something already recorded
  // -------------------------------------------------------------------------
  for (const s of sources) {
    const { rows: near } = await client.query(
      `SELECT name, slug, round((ST_Distance(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography))::numeric) m
         FROM sources
        WHERE slug <> $3
          AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $4)
        ORDER BY m LIMIT 3`,
      [s.lat, s.lon, s.slug, DUPLICATE_RADIUS_KM * 1000],
    );
    for (const n of near) {
      console.log(`  note: "${s.name}" is ${n.m} m from existing source "${n.name}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log(`\n${dryRun ? "would import" : "importing"}: ${rows.length} reports across ${sources.length} sources`);
  for (const s of [...sources].sort((a, b) => b.reports - a.reports)) {
    console.log(`  ${String(s.reports).padStart(3)}  ${s.name}  (${s.lat}, ${s.lon})`);
  }
  const refused = Object.entries(drops).filter(([, n]) => n > 0);
  console.log("dropped:", refused.length ? Object.fromEntries(refused) : "none");
  console.log(`provenance: ${provenance}${submitter ? ` · submitter: ${submitter}` : ""}`);

  if (dryRun) {
    console.log("\n(dry run — nothing was written)");
  } else {
    await client.query("BEGIN");
    let written = 0;
    for (const s of sources) {
      const {
        rows: [source],
      } = await client.query(
        `INSERT INTO sources (name, slug, lat, lon, gnis_id, osm_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               gnis_id = COALESCE(EXCLUDED.gnis_id, sources.gnis_id),
               osm_id = COALESCE(EXCLUDED.osm_id, sources.osm_id)
         RETURNING id`,
        [s.name, s.slug, s.lat, s.lon, s.gnisId ?? null, s.osmId ?? null],
      );

      // Clear this batch only. A report somebody submitted through the form is
      // a different provenance and is never touched.
      await client.query(
        `DELETE FROM reports
          WHERE source_id = $1 AND provenance = $2
            AND submitter IS NOT DISTINCT FROM $3`,
        [source.id, provenance, submitter],
      );

      const mine = rows.filter((r) => r.source === s.name);
      const values = [];
      const params = [];
      mine.forEach((r, i) => {
        const b = i * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(source.id, r.observedOn, r.score, r.status, provenance, submitter);
      });
      await client.query(
        `INSERT INTO reports (source_id, observed_on, score, status, provenance, submitter)
         VALUES ${values.join(",")}`,
        params,
      );
      written += mine.length;
    }
    await client.query("COMMIT");
    console.log(`\nwrote ${written} reports across ${sources.length} sources`);
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
  await pool.end();
}
