import { db } from "./db.ts";

/**
 * Shared precipitation cache.
 *
 * The engine fetches ~19 years of daily rainfall per coordinate from Open-Meteo,
 * a free service. On serverless that fetch has nowhere durable to land: the
 * deployment bundle is read-only and /tmp dies with the instance, so production
 * measured a cold render at ~13s against ~1.2s warm — entirely upstream work,
 * repeated by every cold instance.
 *
 * **Why this lives in Node rather than in the engine service.** The engine is
 * stdlib-only by rule and its HTTP wrapper has deliberately kept that property.
 * Giving it a Postgres driver would end that for one query. Node already holds
 * the database connection, so it gathers the series and passes them to the
 * engine, which installs them as its PRECIP_PROVIDER. Two consequences worth
 * having: the engine service stays dependency-free, and Node can fetch missing
 * coordinates *concurrently* — the engine fetches them one at a time.
 */

/**
 * The engine caches per coordinate rounded to 2dp (~1.1 km), which is far finer
 * than ERA5's ~9–11 km grid, so neighbouring sources share a series. Matching
 * that rounding exactly is what makes this a drop-in replacement for its own
 * cache rather than a second, differently-keyed one.
 */
export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export type DailySeries = {
  /** First day of the series (ISO). Days are contiguous from here. */
  start: string;
  /** Daily totals in inches, dense — index i is start + i days. */
  values: number[];
};

/** The engine's own start; a shorter series silently shrinks its analog pool. */
export const PRECIP_START = "2007-01-01";

/** Matches the engine's URL exactly — timezone changes how days are bucketed. */
function openMeteoUrl(lat: number, lon: number, endDate: string): string {
  return (
    "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=${PRECIP_START}&end_date=${endDate}` +
    "&daily=precipitation_sum&precipitation_unit=inch" +
    "&timezone=America%2FPhoenix"
  );
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function seriesEnd(series: DailySeries): string {
  return addDays(series.start, series.values.length - 1);
}

async function fetchFromUpstream(
  lat: number,
  lon: number,
  endDate: string,
  timeoutMs: number,
): Promise<DailySeries> {
  const res = await fetch(openMeteoUrl(lat, lon, endDate), {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo returned ${res.status} for ${lat},${lon}`);
  }
  const data = (await res.json()) as {
    daily?: { time?: string[]; precipitation_sum?: (number | null)[] };
  };
  const time = data.daily?.time;
  const sums = data.daily?.precipitation_sum;
  if (!Array.isArray(time) || !Array.isArray(sums) || time.length === 0) {
    throw new Error(`Open-Meteo returned no daily series for ${lat},${lon}`);
  }
  // Nulls become 0, which is what the engine does with them anyway.
  return { start: time[0], values: sums.map((v) => v ?? 0) };
}

const BACKEND = "open-meteo-era5";

async function readCached(latR: number, lonR: number): Promise<DailySeries | null> {
  const sql = db();
  const rows = (await sql`
    SELECT start_date::text AS start, daily_in
    FROM precip_cache
    WHERE lat_r = ${latR} AND lon_r = ${lonR} AND backend = ${BACKEND}
  `) as { start: string; daily_in: number[] }[];
  const row = rows[0];
  return row ? { start: row.start, values: row.daily_in } : null;
}

async function writeCached(latR: number, lonR: number, series: DailySeries): Promise<void> {
  const sql = db();
  // Upsert rather than insert: the row is keyed on coordinate and backend, never
  // on the end date, so extending it is an update. That key is the structural
  // fix for the engine's old cache bug, where the key moved every day and so
  // missed every day.
  await sql`
    INSERT INTO precip_cache (lat_r, lon_r, backend, start_date, end_date, daily_in)
    VALUES (${latR}, ${lonR}, ${BACKEND}, ${series.start}, ${seriesEnd(series)}, ${series.values})
    ON CONFLICT (lat_r, lon_r, backend) DO UPDATE
      SET start_date = EXCLUDED.start_date,
          end_date   = EXCLUDED.end_date,
          daily_in   = EXCLUDED.daily_in,
          fetched_at = now()
  `;
}

export type SeriesResult = { series: DailySeries; source: "cache" | "upstream" };

/**
 * One coordinate's series, covering at least through `endDate`.
 *
 * A cached series that runs longer than needed is still a hit — the engine trims
 * to the as-of date itself, so one row per coordinate answers every date.
 */
export async function getSeries(
  lat: number,
  lon: number,
  endDate: string,
  opts: { timeoutMs?: number; refresh?: boolean } = {},
): Promise<SeriesResult> {
  const latR = roundCoord(lat);
  const lonR = roundCoord(lon);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  if (!opts.refresh) {
    try {
      const cached = await readCached(latR, lonR);
      if (cached && cached.values.length > 0 && seriesEnd(cached) >= endDate) {
        return { series: cached, source: "cache" };
      }
    } catch {
      // A cache read failure must not stop a forecast; fall through and fetch.
    }
  }

  const fresh = await fetchFromUpstream(latR, lonR, endDate, timeoutMs);
  try {
    await writeCached(latR, lonR, fresh);
  } catch {
    // Likewise for the write — the forecast has what it needs either way.
  }
  return { series: fresh, source: "upstream" };
}

/**
 * Node-side grouping key, used only to avoid fetching one coordinate twice.
 *
 * Deliberately NOT the key the engine looks up by. JavaScript and Python round
 * differently at the half-way point — `Math.round` goes away from zero,
 * Python's `round` goes to even — so 34.125 is 34.13 here and 34.12 there. A
 * source sitting on such a coordinate would be written under one key and looked
 * up under another, and because a miss falls back to fetching, the cache would
 * simply never hit for it, silently and forever.
 *
 * So the wire format sends raw coordinates and lets the engine service do all
 * the rounding. Rounding disagreement here costs at most one duplicate fetch;
 * rounding disagreement across the boundary cost the entire feature.
 */
export function groupKey(lat: number, lon: number): string {
  return `${roundCoord(lat).toFixed(2)},${roundCoord(lon).toFixed(2)}`;
}

/** What the engine service receives: full precision, rounded on its side. */
export function wireKey(lat: number, lon: number): string {
  return `${lat},${lon}`;
}

export type PrecipBundle = {
  series: Record<string, DailySeries>;
  hits: number;
  misses: number;
};

/**
 * Gather every coordinate a forecast needs, in parallel.
 *
 * Concurrency is the point as much as caching is: the engine fetches
 * coordinates serially, so a route with a dozen sources would otherwise cost a
 * dozen sequential upstream round trips.
 */
export async function collectSeries(
  points: { lat: number; lon: number }[],
  endDate: string,
  opts: { timeoutMs?: number } = {},
): Promise<PrecipBundle> {
  // One entry per distinct coordinate cell, so a cluster of sources sharing a
  // precipitation cell costs one fetch rather than one each.
  const unique = new Map<string, { lat: number; lon: number }>();
  for (const p of points) {
    const k = groupKey(p.lat, p.lon);
    if (!unique.has(k)) unique.set(k, p);
  }

  const results = await Promise.allSettled(
    [...unique.values()].map(async (p) => ({
      key: wireKey(p.lat, p.lon),
      ...(await getSeries(p.lat, p.lon, endDate, opts)),
    })),
  );

  const bundle: PrecipBundle = { series: {}, hits: 0, misses: 0 };
  for (const r of results) {
    // A coordinate that could not be fetched is simply absent: the engine falls
    // back to its own provider for anything missing, so one upstream failure
    // costs that source its speed, not its forecast.
    if (r.status !== "fulfilled") continue;
    bundle.series[r.value.key] = r.value.series;
    if (r.value.source === "cache") bundle.hits++;
    else bundle.misses++;
  }
  return bundle;
}
