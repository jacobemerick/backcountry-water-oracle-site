/**
 * Link existing sources to the gazetteer feature they already are.
 *
 *   npm run db:reconcile            # reports what it would write, touches nothing
 *   npm run db:reconcile -- --apply # writes the identifiers
 *
 * #76 does this during a CSV import. Nothing did it for a source somebody
 * pinned in the browser, and those carry no identifier at all: measured on prod
 * before this ran, 35 of 57 sources sat within 500 m of an unlinked gazetteer
 * feature, same-named and 0-4 m away in most cases.
 *
 * The identifier is what keeps the two tables reconcilable. `gazetteer` is
 * reference data, re-derivable by re-running its loader (0007), and a wholesale
 * reload is only safe while every source that came from a feature still says
 * which feature that was. Proximity alone will not survive GNIS restating a
 * coordinate.
 *
 * **The rule is not this script's to invent.** `chooseGazetteerLink` owns it --
 * same name AND within LINK_RADIUS_M, refusing on more than one candidate --
 * and the site now asks the same question at read time on the feature page. One
 * rule, three callers.
 *
 * **Dry run is the default.** Writing a wrong identifier silently asserts that
 * a spring somebody walked to is a different spring, and nothing downstream
 * would ever contradict it. Seeing the pairs first costs one command.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { LINK_RADIUS_M, chooseGazetteerLink } from "../src/lib/report-import.ts";

neonConfig.webSocketConstructor = ws;

const apply = process.argv.includes("--apply");

if (!process.env.DATABASE_URL) {
  console.error("[error] DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

/** Every outcome is counted and printed. A silently shrunk result looks like a
    smaller world rather than a bug -- the rule #68 set for the archive. */
const tally = { linked: 0, "no-match": 0, ambiguous: 0, "feature-taken": 0 };

try {
  const { rows: sources } = await client.query(
    `SELECT id, name, slug, lat, lon
       FROM sources
      WHERE gnis_id IS NULL AND osm_id IS NULL
      ORDER BY name`,
  );

  console.log(`${sources.length} unlinked source${sources.length === 1 ? "" : "s"}\n`);

  const writes = [];
  /* A feature claimed twice inside one run would pass the database check --
     nothing is written until the end, so the second claimant sees a clean
     table. Two same-named sources within 500 m of one feature is exactly the
     collision worth catching, so the claim is tracked here as well. */
  const claimed = new Map();

  for (const s of sources) {
    const { rows: candidates } = await client.query(
      `SELECT feed, external_id,
              ST_Distance(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) m
         FROM gazetteer
        WHERE duplicate_of IS NULL
          AND name IS NOT NULL
          AND lower(name) = lower($3)
          AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $4)
        ORDER BY m`,
      [s.lat, s.lon, s.name, LINK_RADIUS_M],
    );

    const link = chooseGazetteerLink(
      candidates.map((c) => ({ feed: c.feed, externalId: c.external_id, distanceM: Number(c.m) })),
    );

    if (!link.linked) {
      tally[link.reason]++;
      if (link.reason === "ambiguous") {
        console.log(
          `  ambiguous  ${s.name} — ${link.candidates} features share that name within ${LINK_RADIUS_M} m`,
        );
      }
      continue;
    }

    // A feature already claimed by another source means two sources for one
    // spring, which is engine issue #9 waiting to happen. Refuse and say so:
    // merging them is a judgement about somebody's water, not an import step.
    const externalId = link.gnisId ?? link.osmId;
    const column = link.gnisId ? "gnis_id" : "osm_id";
    const { rows: taken } = await client.query(
      `SELECT name, slug FROM sources WHERE ${column} = $1 AND id <> $2`,
      [externalId, s.id],
    );
    const claimant = taken[0]?.name ?? claimed.get(`${column}:${externalId}`);
    if (claimant) {
      tally["feature-taken"]++;
      console.log(
        `  conflict   ${s.name} — that feature is already recorded as "${claimant}". ` +
          `Two entries for one spring; merge them by hand.`,
      );
      continue;
    }

    tally.linked++;
    claimed.set(`${column}:${externalId}`, s.name);
    writes.push({ id: s.id, column, externalId });
    console.log(
      `  link       ${s.name} → ${link.gnisId ? "GNIS" : "OSM"} ${externalId} (${Math.round(link.distanceM)} m)`,
    );
  }

  console.log(`\n${JSON.stringify(tally)}`);

  if (!apply) {
    console.log("\n(dry run — nothing was written. Re-run with --apply.)");
  } else if (writes.length === 0) {
    console.log("\nnothing to write");
  } else {
    await client.query("BEGIN");
    for (const w of writes) {
      await client.query(`UPDATE sources SET ${w.column} = $1 WHERE id = $2`, [w.externalId, w.id]);
    }
    await client.query("COMMIT");
    console.log(`\nwrote ${writes.length} identifier${writes.length === 1 ? "" : "s"}`);
    // Reversible, and worth saying: this sets a column that was null.
    console.log("to undo: UPDATE sources SET gnis_id = NULL, osm_id = NULL WHERE id IN (...)");
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("[error]", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
