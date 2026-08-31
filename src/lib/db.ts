import { neon } from "@neondatabase/serverless";
import type { EngineRow } from "./engine-csv.ts";

/**
 * Neon over HTTP: one round trip per query, no pool to keep warm, which is what
 * we want in a serverless function. Anything needing a transaction or a session
 * should use `Pool` from the same package instead (see scripts/migrate.mjs).
 */
function connection() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  return neon(url);
}

let cached: ReturnType<typeof connection> | null = null;
export function db() {
  return (cached ??= connection());
}

export type Source = {
  id: number;
  name: string;
  slug: string;
  lat: number;
  lon: number;
};

export async function listSources(): Promise<Source[]> {
  const sql = db();
  return (await sql`
    SELECT id::int AS id, name, slug, lat, lon
    FROM sources
    ORDER BY name
  `) as Source[];
}

/**
 * Every report for the given sources, ordered the way the engine expects.
 * This is the whole data-access path for a forecast -- there is no ORM layer
 * and no DTO, because the row shape is already the engine's input format.
 */
export async function engineRowsForSources(sourceIds: number[]): Promise<EngineRow[]> {
  if (sourceIds.length === 0) return [];
  const sql = db();
  return (await sql`
    SELECT source, lat, lon, date::text AS date, score::float8 AS score, status
    FROM engine_rows
    WHERE source_id = ANY(${sourceIds}::bigint[])
    ORDER BY source, date
  `) as EngineRow[];
}

export type NearbySource = Source & { distance_km: number; report_count: number; last_reported: string | null };

/**
 * Sources within `radiusKm`, nearest first — the duplicate-prevention query.
 *
 * This exists because of engine issue #9: two sources sharing a name are fused
 * by the engine onto the first one's coordinates, so half the observations get
 * correlated against the wrong location's rainfall and the output looks
 * completely normal. "Cottonwood Spring" is a spectacularly common name, so the
 * defence has to be at the point of creation, not after.
 */
export async function sourcesNear(
  lat: number,
  lon: number,
  radiusKm = 2,
  limit = 8,
): Promise<NearbySource[]> {
  const sql = db();
  return (await sql`
    SELECT s.id::int AS id, s.name, s.slug, s.lat, s.lon,
           ST_Distance(s.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) / 1000
             AS distance_km,
           count(r.id)::int         AS report_count,
           max(r.observed_on)::text AS last_reported
    FROM sources s
    LEFT JOIN reports r ON r.source_id = s.id
    WHERE ST_DWithin(s.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusKm * 1000})
    GROUP BY s.id
    ORDER BY distance_km
    LIMIT ${limit}
  `) as NearbySource[];
}

export type SourceListing = Source & { report_count: number; last_reported: string | null };

/** Every source with its report counts — small enough to send whole for the map. */
export async function listSourcesWithCounts(): Promise<SourceListing[]> {
  const sql = db();
  return (await sql`
    SELECT s.id::int AS id, s.name, s.slug, s.lat, s.lon,
           count(r.id)::int         AS report_count,
           max(r.observed_on)::text AS last_reported
    FROM sources s
    LEFT JOIN reports r ON r.source_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `) as SourceListing[];
}

export async function findSourceBySlug(slug: string): Promise<Source | null> {
  const sql = db();
  const rows = (await sql`SELECT id::int AS id, name, slug, lat, lon FROM sources WHERE slug = ${slug}`) as Source[];
  return rows[0] ?? null;
}

/** Insert a source. Caller is responsible for having offered the nearby matches first. */
export async function createSource(input: {
  name: string;
  slug: string;
  lat: number;
  lon: number;
  notes?: string | null;
  /* Promotion: the gazetteer identifier this source came from, so the two never
     drift into a second point for one spring and the gazetteer stays reloadable
     wholesale. Null for a source somebody pinned themselves. */
  gnisId?: string | null;
  osmId?: string | null;
}): Promise<Source> {
  const sql = db();
  const rows = (await sql`
    INSERT INTO sources (name, slug, lat, lon, notes, gnis_id, osm_id)
    VALUES (${input.name}, ${input.slug}, ${input.lat}, ${input.lon}, ${input.notes ?? null},
            ${input.gnisId ?? null}, ${input.osmId ?? null})
    RETURNING id::int AS id, name, slug, lat, lon
  `) as Source[];
  return rows[0];
}

export type ReportRow = {
  id: number;
  observed_on: string;
  score: number;
  status: string | null;
  provenance: string;
};

export async function reportsForSource(sourceId: number): Promise<ReportRow[]> {
  const sql = db();
  return (await sql`
    SELECT id::int AS id, observed_on::text AS observed_on, score::float8 AS score, status, provenance
    FROM reports
    WHERE source_id = ${sourceId}
    ORDER BY observed_on DESC, id DESC
  `) as ReportRow[];
}

/**
 * Record an observation.
 *
 * Deliberately no uniqueness check: two people can report one spring on the
 * same day and disagree, and that disagreement is real signal about a marginal
 * source rather than a data error. The seed corpus contains exactly this.
 */
export async function createReport(input: {
  sourceId: number;
  observedOn: string;
  score: number;
  status: string | null;
}): Promise<ReportRow> {
  const sql = db();
  const rows = (await sql`
    INSERT INTO reports (source_id, observed_on, score, status, provenance)
    VALUES (${input.sourceId}, ${input.observedOn}, ${input.score}, ${input.status}, 'user')
    RETURNING id::int AS id, observed_on::text AS observed_on, score::float8 AS score, status, provenance
  `) as ReportRow[];
  return rows[0];
}

/* ---------------------------------------------------------------------------
   The water-report mirror. Archiving only — see src/lib/water-sheets.ts.
   --------------------------------------------------------------------------- */

/** The hash of the most recent capture of a sheet, or null if we hold none. */
export async function latestSnapshotHash(sheetId: string): Promise<string | null> {
  const sql = db();
  const rows = (await sql`
    SELECT content_hash
    FROM sheet_snapshots
    WHERE sheet_id = ${sheetId}
    ORDER BY retrieved_at DESC
    LIMIT 1
  `) as { content_hash: string }[];
  return rows[0]?.content_hash ?? null;
}

/**
 * Store a capture.
 *
 * ON CONFLICT DO NOTHING against (sheet_id, content_hash) makes this idempotent
 * at the database rather than only in the caller's check: two overlapping runs,
 * or a retry after a partial failure, cannot produce a duplicate row. Returns
 * null when the bytes were already held.
 */
export async function insertSnapshot(input: {
  sheetId: string;
  title: string | null;
  updatedLine: string | null;
  contentHash: string;
  byteSize: number;
  /** Exactly one of these is set; the table has a CHECK that says so. */
  body: string | null;
  bodyBytes: Buffer | null;
  contentType: string;
  httpStatus: number;
  headers: Record<string, string>;
}): Promise<number | null> {
  const sql = db();
  // bytea goes over the wire as hex and is decoded server-side. Passing a
  // Buffer through the serverless driver's parameter encoding is not something
  // to leave to chance for bytes we are keeping precisely because they are hard
  // to get again.
  const hex = input.bodyBytes ? input.bodyBytes.toString("hex") : null;
  const rows = (await sql`
    INSERT INTO sheet_snapshots
      (sheet_id, title, updated_line, content_hash, byte_size, body, body_bytes,
       content_type, http_status, headers)
    VALUES
      (${input.sheetId}, ${input.title}, ${input.updatedLine}, ${input.contentHash},
       ${input.byteSize}, ${input.body},
       ${hex === null ? null : sql`decode(${hex}, 'hex')`},
       ${input.contentType}, ${input.httpStatus}, ${JSON.stringify(input.headers)})
    ON CONFLICT (sheet_id, content_hash) DO NOTHING
    RETURNING id::int AS id
  `) as { id: number }[];
  return rows[0]?.id ?? null;
}

/** Record an attempt, successful or not. The absence of these rows is the alarm. */
export async function recordFetchAttempt(input: {
  sheetId: string;
  ok: boolean;
  unchanged?: boolean;
  httpStatus?: number | null;
  byteSize?: number | null;
  durationMs?: number | null;
  error?: string | null;
  snapshotId?: number | null;
}): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO sheet_fetch_attempts
      (sheet_id, ok, unchanged, http_status, byte_size, duration_ms, error, snapshot_id)
    VALUES
      (${input.sheetId}, ${input.ok}, ${input.unchanged ?? false}, ${input.httpStatus ?? null},
       ${input.byteSize ?? null}, ${input.durationMs ?? null}, ${input.error ?? null},
       ${input.snapshotId ?? null})
  `;
}

export type GazetteerFeature = {
  id: number;
  feed: string;
  licence: string;
  external_id: string;
  name: string | null;
  feature_class: string;
  raw_class: string | null;
  state: string;
  county: string | null;
  lat: number;
  lon: number;
  duplicate_of: number | null;
};

/** One feature, by the identifier its URL carries. */
export async function findGazetteerFeature(
  feed: string,
  externalId: string,
): Promise<GazetteerFeature | null> {
  const sql = db();
  const rows = (await sql`
    SELECT id::int AS id, feed, licence, external_id, name, feature_class, raw_class,
           state, county, lat, lon, duplicate_of::int AS duplicate_of
    FROM gazetteer
    WHERE feed = ${feed} AND external_id = ${externalId}
  `) as GazetteerFeature[];
  return rows[0] ?? null;
}

export async function gazetteerFeatureById(id: number): Promise<GazetteerFeature | null> {
  const sql = db();
  const rows = (await sql`
    SELECT id::int AS id, feed, licence, external_id, name, feature_class, raw_class,
           state, county, lat, lon, duplicate_of::int AS duplicate_of
    FROM gazetteer
    WHERE id = ${id}
  `) as GazetteerFeature[];
  return rows[0] ?? null;
}

/**
 * The promotion check: has this feature already been reported on?
 *
 * Matched on the feed's own identifier rather than on name or proximity.
 * `sources.gnis_id` / `osm_id` are copied across at promotion for exactly this,
 * and it is the only join that stays correct when somebody later renames the
 * source or nudges its coordinate.
 */
export async function findSourceByExternalId(
  column: "gnis_id" | "osm_id",
  externalId: string,
): Promise<Source | null> {
  const sql = db();
  const rows =
    column === "gnis_id"
      ? ((await sql`SELECT id::int AS id, name, slug, lat, lon FROM sources WHERE gnis_id = ${externalId}`) as Source[])
      : ((await sql`SELECT id::int AS id, name, slug, lat, lon FROM sources WHERE osm_id = ${externalId}`) as Source[]);
  return rows[0] ?? null;
}

export type FeatureSourceMatch = Source & { distance_m: number; name_matches: boolean };

/**
 * Sources that might already be this gazetteer feature.
 *
 * The same question `scripts/import-reports.mjs` asks at import time, asked at
 * read time — because the identifier link is only ever written by an import or
 * by promotion, and a source somebody pinned by hand carries no identifier at
 * all. Measured on the live corpus: 35 of 57 sources sit within 500 m of an
 * unlinked gazetteer feature, 0–4 m and same-named in most cases. Without this,
 * every one of those springs has two live URLs saying opposite things.
 *
 * Returns candidates rather than a verdict; `chooseGazetteerLink`'s rule —
 * name and proximity together, refusing on ambiguity — decides.
 */
export async function sourcesNearFeature(
  lat: number,
  lon: number,
  name: string | null,
  radiusM: number,
): Promise<FeatureSourceMatch[]> {
  const sql = db();
  return (await sql`
    SELECT id::int AS id, s.name, slug, lat, lon,
           ST_Distance(geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) AS distance_m,
           (${name}::text IS NOT NULL AND lower(s.name) = lower(${name})) AS name_matches
    FROM sources s
    WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusM})
    ORDER BY distance_m
  `) as FeatureSourceMatch[];
}

export type SourceHit = {
  kind: "source";
  slug: string;
  name: string;
  report_count: number;
  last_reported: string | null;
  distance_km: number | null;
};

export type FeatureHit = {
  kind: "feature";
  feed: string;
  external_id: string;
  name: string | null;
  feature_class: string;
  county: string | null;
  state: string;
  lat: number;
  lon: number;
  distance_km: number | null;
};

/**
 * Name search, in two tiers: exact substring first, trigram only as a fallback.
 *
 * One tier cannot do both jobs, and the numbers say so plainly. At the trigram
 * default threshold of 0.3, "cottonwood spring" matches 5,268 features — every
 * name with enough letters in common — against 262 that actually contain the
 * phrase. Tighten to 0.45 and that reads sensibly, but "cottonwd spg" drops to
 * zero, which is exactly the misremembered query 0007 built a trigram index to
 * catch.
 *
 * So: if the typed text appears in a name, those are the matches and the count
 * means something. Only when nothing contains it does the fuzzy tier run, and
 * the result says it is guessing.
 */
/**
 * Sources matching a name. ILIKE on a corpus that grows one observation at a
 * time, with the same fuzzy fallback so a typo does not hide the one page that
 * actually has reports behind it.
 */
export async function searchSources(
  query: string,
  limit: number,
  mode: "exact" | "fuzzy" = "exact",
): Promise<SourceHit[]> {
  const sql = db();
  if (mode === "exact") {
    return (await sql`
      SELECT 'source' AS kind, s.slug, s.name,
             count(r.id)::int AS report_count,
             max(r.observed_on)::text AS last_reported,
             NULL::float8 AS distance_km
      FROM sources s
      LEFT JOIN reports r ON r.source_id = s.id
      WHERE s.name ILIKE ${"%" + query + "%"}
      GROUP BY s.id, s.slug, s.name
      ORDER BY count(r.id) DESC, s.name
      LIMIT ${limit}
    `) as SourceHit[];
  }
  return (await sql`
    SELECT 'source' AS kind, s.slug, s.name,
           count(r.id)::int AS report_count,
           max(r.observed_on)::text AS last_reported,
           NULL::float8 AS distance_km
    FROM sources s
    LEFT JOIN reports r ON r.source_id = s.id
    WHERE similarity(s.name, ${query}) >= 0.3
    GROUP BY s.id, s.slug, s.name
    ORDER BY similarity(s.name, ${query}) DESC, count(r.id) DESC
    LIMIT ${limit}
  `) as SourceHit[];
}

/** Sources near a point, as search hits. Nearest first. */
export async function searchSourcesNear(
  lat: number,
  lon: number,
  radiusKm: number,
  limit: number,
): Promise<SourceHit[]> {
  const sql = db();
  return (await sql`
    SELECT 'source' AS kind, s.slug, s.name,
           count(r.id)::int AS report_count,
           max(r.observed_on)::text AS last_reported,
           (ST_Distance(s.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) / 1000)::float8 AS distance_km
    FROM sources s
    LEFT JOIN reports r ON r.source_id = s.id
    WHERE ST_DWithin(s.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusKm * 1000})
    GROUP BY s.id, s.slug, s.name, s.geog
    ORDER BY distance_km
    LIMIT ${limit}
  `) as SourceHit[];
}

/**
 * Gazetteer features matching a name, excluding anything already promoted.
 *
 * A feature whose identifier is already on a source is dropped: that page
 * redirects to the source anyway, and offering both would put one spring in the
 * list twice under two headings.
 *
 * The total is counted, not inferred from the page of six. 203 primary rows are
 * named "Cottonwood Spring" and two of the first three share a county, so a
 * slice of six presented as the answer is a lie of omission — "6 of 262" tells
 * someone their query is the problem, which is the only thing that leads to a
 * better one.
 */
export async function searchFeatures(
  query: string,
  limit: number,
  mode: "exact" | "fuzzy" = "exact",
): Promise<{ rows: FeatureHit[]; total: number }> {
  const sql = db();
  const like = "%" + query + "%";

  if (mode === "exact") {
    const rows = (await sql`
      SELECT 'feature' AS kind, g.feed, g.external_id, g.name, g.feature_class,
             g.county, g.state, g.lat, g.lon, NULL::float8 AS distance_km
      FROM gazetteer g
      WHERE g.duplicate_of IS NULL
        AND g.name ILIKE ${like}
        AND NOT EXISTS (
          SELECT 1 FROM sources s
          WHERE (s.gnis_id = g.external_id AND g.feed LIKE 'USGS GNIS%')
             OR (s.osm_id = g.external_id AND g.feed = 'OpenStreetMap')
        )
      ORDER BY length(g.name), g.state, g.county NULLS LAST, g.name
      LIMIT ${limit}
    `) as FeatureHit[];
    if (rows.length === 0) return { rows, total: 0 };

    const counted = (await sql`
      SELECT count(*)::int AS n
      FROM gazetteer g
      WHERE g.duplicate_of IS NULL
        AND g.name ILIKE ${like}
        AND NOT EXISTS (
          SELECT 1 FROM sources s
          WHERE (s.gnis_id = g.external_id AND g.feed LIKE 'USGS GNIS%')
             OR (s.osm_id = g.external_id AND g.feed = 'OpenStreetMap')
        )
    `) as { n: number }[];
    return { rows, total: counted[0]?.n ?? rows.length };
  }

  // Nothing anywhere contained the text. Now the trigram index earns its keep:
  // `%` is index-backed at the default 0.3 threshold, which is far too loose to
  // be a primary filter and exactly right as a last resort.
  const rows = (await sql`
    SELECT 'feature' AS kind, g.feed, g.external_id, g.name, g.feature_class,
           g.county, g.state, g.lat, g.lon, NULL::float8 AS distance_km
    FROM gazetteer g
    WHERE g.duplicate_of IS NULL
      AND g.name IS NOT NULL
      AND g.name % ${query}
      AND NOT EXISTS (
        SELECT 1 FROM sources s
        WHERE (s.gnis_id = g.external_id AND g.feed LIKE 'USGS GNIS%')
           OR (s.osm_id = g.external_id AND g.feed = 'OpenStreetMap')
      )
    ORDER BY similarity(g.name, ${query}) DESC, g.state, g.county NULLS LAST, g.name
    LIMIT ${limit}
  `) as FeatureHit[];
  return { rows, total: rows.length };
}

/** Features near a point. Includes unnamed rows — an unnamed spring 300 m away
    is a real thing to tell somebody, which is half of why 0007 kept them. */
export async function searchFeaturesNear(
  lat: number,
  lon: number,
  radiusKm: number,
  limit: number,
): Promise<FeatureHit[]> {
  const sql = db();
  return (await sql`
    SELECT 'feature' AS kind, g.feed, g.external_id, g.name, g.feature_class,
           g.county, g.state, g.lat, g.lon,
           (ST_Distance(g.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) / 1000)::float8 AS distance_km
    FROM gazetteer g
    WHERE g.duplicate_of IS NULL
      AND ST_DWithin(g.geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusKm * 1000})
      AND NOT EXISTS (
        SELECT 1 FROM sources s
        WHERE (s.gnis_id = g.external_id AND g.feed LIKE 'USGS GNIS%')
           OR (s.osm_id = g.external_id AND g.feed = 'OpenStreetMap')
      )
    ORDER BY distance_km
    LIMIT ${limit}
  `) as FeatureHit[];
}

/**
 * Is this coordinate inside what the site actually covers?
 *
 * Asked of the data rather than of a bounding box. The gazetteer's CHECK
 * constraint names six states, but a box around them includes chunks of Idaho
 * and Texas that hold no rows, and "nothing found" for those should say the
 * scope rather than imply the water does not exist.
 */
export async function gazetteerCoversPoint(lat: number, lon: number, radiusKm = 50): Promise<boolean> {
  const sql = db();
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM gazetteer
      WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusKm * 1000})
    ) AS covered
  `) as { covered: boolean }[];
  return rows[0]?.covered ?? false;
}
