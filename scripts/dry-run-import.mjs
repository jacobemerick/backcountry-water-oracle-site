/**
 * What an import of the archived water reports would produce — without importing.
 *
 * Reads the newest snapshot of each archived sheet, parses it, joins the miles
 * to coordinates, and reports the yield. Writes nothing anywhere.
 *
 * That separation is the point. Parsing and geolocating is ours to do; putting
 * somebody else's volunteer-compiled reports into a public database is not, and
 * the PCT Water Report carries no licence grant. This script exists so that
 * conversation can be had with real numbers, and so the stewards can be shown
 * exactly what would be produced from their data before any of it is used.
 *
 *   npm run import:dry-run
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { parseWaterReport, sheetDateFrom } from "../src/lib/pct-report-parse.ts";
import { coordForMile } from "../src/lib/trail-geo.ts";

neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[error] DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new Pool({ connectionString });
try {
  const { rows: markerRows } = await pool.query(
    `SELECT mile::float8 AS mile, lat, lon FROM trail_waypoints
     WHERE trail='PCT' AND kind='mile_marker' ORDER BY mile`,
  );
  const markers = markerRows.map((r) => ({ mile: r.mile, lat: r.lat, lon: r.lon }));
  console.log(`PCT mile markers loaded: ${markers.length}\n`);

  const { rows: snaps } = await pool.query(
    `SELECT DISTINCT ON (sheet_id) sheet_id, title, updated_line, body
     FROM sheet_snapshots
     WHERE body IS NOT NULL
     ORDER BY sheet_id, retrieved_at DESC`,
  );

  const totals = { entries: 0, placed: 0, unplaced: 0, dropped: {} };
  const seenSources = new Set();

  for (const snap of snaps) {
    const sheetDate = sheetDateFrom(snap.updated_line);
    if (!sheetDate) {
      console.log(`  ${String(snap.title).slice(0, 44).padEnd(46)} no updated line — skipped`);
      continue;
    }
    const result = parseWaterReport(snap.body, sheetDate);

    let placed = 0;
    for (const e of result.entries) {
      if (coordForMile(markers, e.mile)) placed++;
      seenSources.add(`${e.mile}|${e.location.toLowerCase()}`);
    }

    totals.entries += result.entries.length;
    totals.placed += placed;
    totals.unplaced += result.entries.length - placed;
    for (const [k, v] of Object.entries(result.dropped)) {
      totals.dropped[k] = (totals.dropped[k] ?? 0) + v;
    }

    const pct = result.entries.length ? ((placed / result.entries.length) * 100).toFixed(0) : "-";
    console.log(
      `  ${String(snap.title).slice(0, 44).padEnd(46)} ${String(result.entries.length).padStart(4)} entries  ${String(placed).padStart(4)} placed (${pct}%)`,
    );
  }

  console.log(`\n  observations parsed:      ${totals.entries}`);
  console.log(`  with a coordinate:        ${totals.placed}`);
  console.log(`  without:                  ${totals.unplaced}`);
  console.log(`  distinct sources implied: ${seenSources.size}`);
  console.log(`\n  dropped, by reason:`);
  for (const [k, v] of Object.entries(totals.dropped)) {
    if (v > 0) console.log(`    ${k.padEnd(24)} ${v}`);
  }
  console.log(`\n  Nothing was written. Ingestion is gated on permission — see issue #14.`);
} finally {
  await pool.end();
}
