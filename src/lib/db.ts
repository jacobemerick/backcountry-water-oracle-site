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
