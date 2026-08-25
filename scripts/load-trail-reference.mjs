/**
 * Load published trail geometry into `trail_waypoints`.
 *
 * Reference data, re-derivable at any time: this script is the only way rows
 * get into that table, and re-running it corrects coordinates in place rather
 * than accumulating duplicates. Deliberately a script rather than a cron -- the
 * feeds change about once a year, when the trail organisations re-measure their
 * centerlines, and a silent annual write is harder to reason about than a
 * deliberate one.
 *
 *   npm run db:trail-reference
 *   npm run db:trail-reference -- --trail=AZT
 *
 * Provenance and licence are recorded per row because they differ. PCTA publish
 * under CC BY 4.0 (pcta.org/discover-the-trail/maps/pct-data/). The ATA's layer
 * is public but states no licence, which puts it on the same footing as their
 * water-report PDFs.
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const PCTA = "https://services5.arcgis.com/ZldHa25efPFpMmfB/arcgis/rest/services";
const ATA = "https://services3.arcgis.com/IKBBLZOXy58PXgpl/arcgis/rest/services";

const FEEDS = [
  {
    trail: "PCT",
    kind: "mile_marker",
    feed: "PCTA Tenthmile_Marker_2026",
    licence: "CC BY 4.0 — Pacific Crest Trail Association",
    url: `${PCTA}/Tenthmile_Marker_2026/FeatureServer/0`,
    outFields: "Mile,Route,lat,lon",
    page: 2000,
    orderBy: "Mile",
    map: (a) => ({
      // A mile marker's identity *is* its mile. Giving it one lets a re-run
      // upsert in place, and means every row in this table has an external id
      // rather than two different uniqueness rules depending on the feed.
      externalId: Number(a.Mile).toFixed(1),
      name: null,
      featureType: null,
      mile: Number(a.Mile),
      lat: Number(a.lat),
      lon: Number(a.lon),
    }),
  },
  {
    trail: "AZT",
    kind: "water_source",
    feed: "ATA AZT Water Source Locations",
    licence: "No stated licence — public layer, permission conversation pending",
    url: `${ATA}/Arizona_National_Scenic_Trail_Feature_Layers_view/FeatureServer/0`,
    outFields: "Name,Type,ATA_Num,Water_ID",
    page: 1000,
    orderBy: "OBJECTID",
    geometry: true,
    map: (a, g) => ({
      externalId: a.ATA_Num ?? null,
      name: a.Name ?? null,
      featureType: a.Type ?? null,
      // ATA_Num encodes passage and tenth-mile: 01-079 is passage 1, mile 7.9.
      // Passage-relative, not cumulative, so it is a locator rather than a
      // trail mile -- and it disagrees with the water-report PDFs anyway.
      mile: null,
      lat: g?.y ?? null,
      lon: g?.x ?? null,
    }),
  },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[error] DATABASE_URL is not set. Put it in .env.local.");
  process.exit(1);
}

const only = process.argv.find((a) => a.startsWith("--trail="))?.split("=")[1];

async function fetchAll(feed) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const url =
      `${feed.url}/query?where=1%3D1&outFields=${encodeURIComponent(feed.outFields)}` +
      `&returnGeometry=${feed.geometry ? "true" : "false"}&outSR=4326&f=json` +
      // Paging without an explicit sort is not guaranteed to be consistent:
      // rows can repeat across pages or be skipped entirely. This produced
      // duplicate miles on the first run.
      `&orderByFields=${encodeURIComponent(feed.orderBy)}` +
      `&resultOffset=${offset}&resultRecordCount=${feed.page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${feed.feed}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`${feed.feed}: ${body.error.message}`);
    const batch = body.features ?? [];
    for (const f of batch) rows.push(feed.map(f.attributes, f.geometry));
    process.stdout.write(`\r  ${feed.feed}: ${rows.length} features`);
    if (batch.length < feed.page || !body.exceededTransferLimit) break;
    offset += feed.page;
  }
  process.stdout.write("\n");
  return rows;
}

const pool = new Pool({ connectionString });
try {
  for (const feed of FEEDS) {
    if (only && feed.trail !== only) continue;

    const fetched = (await fetchAll(feed)).filter(
      (r) => Number.isFinite(r.lat) && Number.isFinite(r.lon),
    );

    // One row per external id. A single INSERT cannot hit the same key twice
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so a
    // duplicate from upstream has to be resolved before the write, not by it.
    const byId = new Map();
    for (const r of fetched) if (r.externalId !== null) byId.set(r.externalId, r);
    const rows = [...byId.values()];

    if (rows.length === 0) throw new Error(`${feed.feed}: no usable features`);
    if (rows.length !== fetched.length) {
      console.log(`  note: ${fetched.length - rows.length} duplicate ids collapsed`);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Batched, not row-at-a-time. 26,600 markers over a serverless connection
      // is 26,600 round trips -- about half an hour of latency to move a few
      // megabytes. Multi-row VALUES turns it into a few dozen.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values = [];
        const params = [];
        chunk.forEach((r, j) => {
          const b = j * 10;
          values.push(
            `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`,
          );
          params.push(feed.trail, feed.kind, feed.feed, feed.licence, r.externalId,
                      r.name, r.featureType, r.mile, r.lat, r.lon);
        });
        await client.query(
          `INSERT INTO trail_waypoints
             (trail, kind, feed, licence, external_id, name, feature_type, mile, lat, lon)
           VALUES ${values.join(",")}
           ON CONFLICT (feed, external_id) WHERE external_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, feature_type = EXCLUDED.feature_type,
                         mile = EXCLUDED.mile, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                         loaded_at = now()`,
          params,
        );
        process.stdout.write(`\r  writing ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
      }
      process.stdout.write("\n");
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    console.log(`  loaded ${rows.length} rows for ${feed.trail}`);
  }
} finally {
  await pool.end();
}
