/**
 * Load named water features into `gazetteer` for the interior Southwest.
 *
 * Two feeds, one row shape:
 *
 *   USGS GNIS   public domain, a US government work. Springs, tanks, lakes,
 *               basins and swamps from the per-state DomesticNames files.
 *   OpenStreetMap  ODbL. Springs, wells, cisterns and drinking water, queried
 *               per state area from Overpass.
 *
 *   npm run db:gazetteer                    # both feeds, six states
 *   npm run db:gazetteer -- --dry-run       # parse and count, write nothing
 *   npm run db:gazetteer -- --feed=osm --state=AZ
 *   npm run db:gazetteer -- --refresh       # ignore the download cache
 *
 * Downloads are cached under .cache/gazetteer and re-used on every subsequent
 * run. That is not a speed optimisation -- Overpass is a donated public service
 * and USGS is a public agency, and re-fetching 90 MB because a write failed is
 * rude in the same way #65 decided re-fetching the Internet Archive was.
 *
 * Reference data, so the loader is the only writer and a re-run upserts in place
 * rather than appending. Deliberately a script, not a cron: GNIS is republished
 * a few times a year and OSM changes daily, but nothing here should move without
 * somebody deciding it should.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import {
  FEEDS,
  SOUTHWEST_STATES,
  emptyDrops,
  overpassQuery,
  parseGnis,
  parseOverpass,
} from "../src/lib/gazetteer.ts";

neonConfig.webSocketConstructor = ws;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "gazetteer");

const GNIS_URL = (state) =>
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_${state}_Text.zip`;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Node's fetch sends no User-Agent, and Overpass answers that with a bare 406
 * and an HTML body -- it asks clients to identify themselves, which is fair for
 * a donated service. Saying who we are is the fix, not a workaround.
 */
const USER_AGENT = "backcountry-water-oracle/0.1 (+https://backcountrywateroracle.com)";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const refresh = has("refresh");
const onlyFeed = arg("feed");
const onlyState = arg("state")?.toUpperCase();

const states = onlyState ? [onlyState] : [...SOUTHWEST_STATES];
for (const s of states) {
  if (!SOUTHWEST_STATES.includes(s)) {
    console.error(`[error] ${s} is outside this import's scope (${SOUTHWEST_STATES.join(", ")}).`);
    process.exit(1);
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString && !dryRun) {
  console.error("[error] DATABASE_URL is not set. Put it in .env.local, or pass --dry-run.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Download cache
// ---------------------------------------------------------------------------

mkdirSync(CACHE, { recursive: true });

async function cached(name, fetcher) {
  const path = join(CACHE, name);
  if (!refresh && existsSync(path)) {
    process.stdout.write(`  ${name}: cached\n`);
    return readFileSync(path);
  }
  const buf = await fetcher();
  writeFileSync(path, buf);
  process.stdout.write(`  ${name}: fetched ${(buf.length / 1e6).toFixed(1)} MB\n`);
  return buf;
}

/**
 * Read one entry out of a ZIP, via the central directory.
 *
 * USGS ships the state files zipped and offers no plain-text alternative. Doing
 * it here rather than shelling out to `unzip` keeps the script working the same
 * way everywhere, and it is sixty lines against a dependency this repo would
 * otherwise not have.
 *
 * The central directory is the authority on sizes, not the local header: when a
 * zip is written as a stream the local header carries zeroes and the real sizes
 * land in a trailing data descriptor.
 */
function unzipEntry(buf, predicate) {
  // End of central directory: signature, then a comment of unknown length, so
  // scan backwards for it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (predicate(name)) {
      // The local header's own name/extra lengths, not the central one's --
      // they are allowed to differ.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name}: unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("no matching entry in zip");
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

async function gnisRows(state) {
  const zip = await cached(`DomesticNames_${state}.zip`, async () => {
    const res = await fetch(GNIS_URL(state), { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`GNIS ${state}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
  const text = unzipEntry(zip, (n) => n.endsWith(`DomesticNames_${state}.txt`)).toString("utf8");
  return parseGnis(text);
}

async function osmRows(state) {
  const body = await cached(`overpass_${state}.json`, async () => {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body: new URLSearchParams({ data: overpassQuery(state) }),
    });
    if (!res.ok) throw new Error(`Overpass ${state}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    // Overpass answers an overloaded server with an HTML error page and a 200.
    // Caching that and then parsing it as an empty result would report "0
    // features in Utah" as though Utah had none.
    throw new Error(`Overpass ${state}: response was not JSON (cached at ${CACHE}); re-run with --refresh`);
  }
  if (!Array.isArray(parsed.elements)) throw new Error(`Overpass ${state}: no elements array`);
  return parseOverpass(parsed, state);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

async function write(pool, feed, licence, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
        params.push(feed, licence, r.externalId, r.name, r.featureClass, r.rawClass,
                    r.state, r.county, r.lat, r.lon);
      });
      await client.query(
        `INSERT INTO gazetteer
           (feed, licence, external_id, name, feature_class, raw_class, state, county, lat, lon)
         VALUES ${values.join(",")}
         ON CONFLICT (feed, external_id) DO UPDATE
           SET name = EXCLUDED.name, feature_class = EXCLUDED.feature_class,
               raw_class = EXCLUDED.raw_class, state = EXCLUDED.state,
               county = EXCLUDED.county, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
               licence = EXCLUDED.licence, loaded_at = now()`,
        params,
      );
      process.stdout.write(`\r    writing ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
    if (rows.length) process.stdout.write("\n");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Mark each OSM row that describes a feature GNIS already has (0008).
 *
 * Same name, within 200 m. Both halves matter: name alone would fuse the 264
 * different springs called "Willow Spring", and proximity alone would fuse a
 * spring and the stock tank fed by it, which are different water and can fail
 * independently.
 *
 * GNIS survives. Recomputed from scratch every time rather than incrementally,
 * because a name corrected upstream should be able to *undo* a link -- an
 * incremental pass can only ever add them.
 */
async function linkDuplicates(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE gazetteer SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL`);
    // A correlated subquery rather than a LATERAL join: Postgres refuses a
    // lateral reference to the relation being updated. It returns NULL where
    // there is no twin, which is also how a link gets undone.
    await client.query(`
      UPDATE gazetteer o
         SET duplicate_of = (
           SELECT g.id
             FROM gazetteer g
            WHERE ST_DWithin(g.geog, o.geog, 200)
              AND g.feed <> o.feed
              AND g.name IS NOT NULL
              AND lower(g.name) = lower(o.name)
            ORDER BY ST_Distance(g.geog, o.geog)
            LIMIT 1
         )
       WHERE o.feed = $1
         AND o.name IS NOT NULL
    `, [FEEDS.osm.feed]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM gazetteer WHERE duplicate_of IS NOT NULL`,
    );
    await client.query("COMMIT");
    return rows[0].n;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

const plan = [
  { key: "gnis", ...FEEDS.gnis, rowsFor: gnisRows },
  { key: "osm", ...FEEDS.osm, rowsFor: osmRows },
].filter((f) => !onlyFeed || f.key === onlyFeed);

if (plan.length === 0) {
  console.error(`[error] unknown --feed=${onlyFeed}. Use gnis or osm.`);
  process.exit(1);
}

const pool = connectionString && !dryRun ? new Pool({ connectionString }) : null;
const totals = { rows: 0, drops: emptyDrops(), byClass: {}, byState: {} };

try {
  for (const feed of plan) {
    console.log(`\n${feed.feed}  [${feed.licence}]`);
    for (const state of states) {
      const { rows, drops } = await feed.rowsFor(state);

      for (const [reason, n] of Object.entries(drops)) totals.drops[reason] += n;
      for (const r of rows) {
        totals.byClass[r.featureClass] = (totals.byClass[r.featureClass] ?? 0) + 1;
        totals.byState[r.state] = (totals.byState[r.state] ?? 0) + 1;
      }
      totals.rows += rows.length;

      console.log(`  ${state}: ${rows.length} features`);
      if (!dryRun) await write(pool, feed.feed, feed.licence, rows);
    }
  }

  console.log(`\n${dryRun ? "would load" : "loaded"}: ${totals.rows} features`);
  console.log("by class:", totals.byClass);
  console.log("by state:", totals.byState);
  // Every drop, by reason. A corpus that shrinks silently looks like a smaller
  // world rather than a bug -- the same rule the report parser in #68 follows.
  console.log("dropped:", Object.fromEntries(Object.entries(totals.drops).filter(([, n]) => n > 0)));

  // Always after a write, never after a dry run. Linking a partial corpus would
  // leave the survivors of pairs whose other half had not loaded yet.
  if (!dryRun && !onlyFeed) {
    const linked = await linkDuplicates(pool);
    console.log(`linked as duplicates: ${linked} OSM rows already described by GNIS`);
  } else if (!dryRun && onlyFeed) {
    console.log("note: --feed skips duplicate linking; re-run without it to relink");
  }
  if (dryRun) console.log("\n(dry run — nothing was written)");
} finally {
  await pool?.end();
}
