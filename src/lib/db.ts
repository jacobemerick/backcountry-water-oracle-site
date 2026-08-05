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
}): Promise<Source> {
  const sql = db();
  const rows = (await sql`
    INSERT INTO sources (name, slug, lat, lon, notes)
    VALUES (${input.name}, ${input.slug}, ${input.lat}, ${input.lon}, ${input.notes ?? null})
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
