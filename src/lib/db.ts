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
    SELECT id, name, slug, lat, lon
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
