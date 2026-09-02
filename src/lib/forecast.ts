import { toEngineCsv, type EngineRow } from "./engine-csv.ts";
import { collectSeries, type DailySeries } from "./precip.ts";

/**
 * Runs the forecast engine over one of two transports, chosen by environment:
 *
 * - **HTTP** when `ENGINE_URL` is set. In production that variable is injected
 *   by a Vercel service binding, so the engine service is reachable internally
 *   without ever having a public route.
 * - **Subprocess** otherwise, invoking the engine's `water-forecast` CLI. This
 *   is the local-development path: `npm run dev` keeps working without running
 *   two services. The engine is no longer vendored, so this needs it installed
 *   — `npm run engine:install` creates services/engine/.venv from the pinned
 *   requirements, and that is where this looks first.
 *
 * The subprocess path cannot work in production regardless — Vercel's Node
 * runtime has no Python interpreter (verified: `spawn python3` is ENOENT) — so
 * this is not a fallback so much as two environments with different plumbing.
 *
 * Note the spawn is behind a dynamic import. Statically importing
 * node:child_process makes Turbopack trace the entire project into the server
 * bundle (it warns about exactly this), which bloated the build to ~200MB.
 */

/** Mirrors the engine's own JSON output. See the engine's source_json(). */
export type Correlation = {
  window: string;
  days: number;
  raw_r: number;
  ctrl_r: number;
};

export type BestWindow = {
  window: string;
  days: number;
  /** Season-controlled, pooled toward neighbors. The number the verdict keys off. */
  r: number;
  own_ctrl_r: number;
  raw_r: number;
  /** Fraction of `r` borrowed from neighboring sources (0 = none in range). */
  borrowed: number;
  group_n: number;
  signal_check: string;
};

/**
 * Report accounting, added upstream by the fix for engine #10. Reports outside
 * the precipitation record used to be dropped silently, which meant `n` — and
 * therefore %dry, mean flow and every correlation — quietly described a subset
 * of the data. Now the engine says so, and the UI must too: "12 reports, 9
 * usable" is a materially different claim from "9 reports".
 */
export type ReportAccounting = {
  total: number;
  /** Reports actually correlated. Always equals SourceForecast.n. */
  used: number;
  excluded_before_precip: number;
  excluded_after_precip: number;
  /** [first, last] of the precipitation record backing this source. */
  precip_span: [string, string];
};

/**
 * Antecedent rain for a window, ranked against the same calendar window in
 * every other year of that coordinate's record.
 *
 * Needs no field reports, so it is the only reading an unreported coordinate
 * gets — and it is emphatically **not** a flow verdict. "This is the wettest
 * 30 days in 19 years at this spot" says nothing about whether a particular
 * seep is running.
 */
export type RainPercentile = {
  inches: number;
  /** Percentile against the same window in other years. */
  pct: number;
  n_years: number;
  median_in: number;
};

/** A reported source inside the pooling radius, carrying its own read. */
export type NeighborRead = {
  name: string;
  distance_km: number;
  n: number;
  type: string | null;
  verdict: string | null;
};

/**
 * A source's read.
 *
 * **Everything verdict-derived is nullable.** Since engine 0.2.0 a source with
 * no usable reports appears here with `n: 0` and `verdict`, `best`, `type`,
 * `pct_dry`, `mean_flow`, `precip_in` and `predicted_flow` all null, instead of
 * being dropped from the payload and mentioned only in `notes`. Branch on
 * `n === 0` (equivalently `verdict === null`) before reading any of them.
 *
 * The keys are never *absent*, so nothing needs to test for existence — which
 * is why these are `T | null` rather than optional.
 */
export type SourceForecast = {
  name: string;
  lat: number;
  lon: number;
  /** Reports used. See `reports` for what was excluded and why. */
  n: number;
  reports: ReportAccounting;
  small_n: boolean;
  pct_dry: number | null;
  mean_flow: number | null;
  annual_precip_in: number;
  type: string | null;
  /** Empty when there are no usable reports. */
  mean_flow_by_month: Record<string, number>;
  /** Empty when there are no usable reports. */
  correlations: Correlation[];
  best: BestWindow | null;
  asof: string;
  precip_in: number | null;
  predicted_flow: number | null;
  verdict: string | null;
  /**
   * How many past reports `predicted_flow` averaged — at most the engine's
   * analog width (5). Null when there is no read.
   */
  analog_n: number | null;
  /**
   * True when that average was the source's *entire* history, which the engine
   * reaches at `n <= 5`. The rain figure was computed and then discarded, so the
   * source returns the same number on every date — the record, not a forecast.
   *
   * Not the same claim as `small_n` (`n < 25`), which says a read is coarse. A
   * source can be `small_n` and still respond to rain; Castersen Seep at n = 15
   * is exactly that. Both flags, both meanings, neither implying the other.
   *
   * Null when there is no read. Read an *absent* key (a payload stored by 0.2.0
   * or earlier) as unknown rather than false — at `n <= 5` it would have been
   * true, and that is most sources.
   *
   * On this site it is always true *below* MIN_REPORTS_FOR_VERDICT and never
   * above it, so it never contradicts a verdict we show — contract.test.ts
   * asserts that relationship rather than assuming it.
   */
  pred_is_constant: boolean | null;
  harmonics: number;
  /** Present for every source, reports or not. Never a flow verdict. */
  rain_percentiles: Record<string, RainPercentile>;
  /** Reported sources within the pooling radius, nearest first. */
  neighbors: NeighborRead[];
  /**
   * True when nearby sources disagree on `type`. The field to lead with when
   * offering a neighbour: disagreement is the evidence that no stand-in was
   * safe.
   */
  neighbors_disagree: boolean;
  /** Null on this host — see services/engine/app.py. */
  radar_check: unknown | null;
};

/**
 * A source whose verdict-derived fields are actually populated.
 *
 * Since 0.2.0 the engine returns unreported sources in `sources[]` with those
 * fields null, so "does this source have a read" became a runtime question. It
 * is answered once, here, rather than with a null check at each of the dozen
 * places that read them.
 */
export type ReadableSource = SourceForecast & {
  pct_dry: number;
  mean_flow: number;
  type: string;
  best: BestWindow;
  precip_in: number;
  predicted_flow: number;
  verdict: string;
  analog_n: number;
  pred_is_constant: boolean;
};

/**
 * Narrows to a source the engine actually produced a read for.
 *
 * Keyed on `verdict`, which the engine nulls together with the rest of the
 * verdict-derived fields. Note this is a *weaker* claim than the site's own
 * MIN_REPORTS_FOR_VERDICT floor: the engine will happily read two observations,
 * and `confidenceOf` is what refuses to show it. This predicate only says the
 * fields are safe to read.
 */
export function hasRead(s: SourceForecast): s is ReadableSource {
  return s.verdict !== null && s.best !== null;
}

/**
 * An engine diagnostic. These are objects, not strings — see forecast.py's
 * `note(kind, msg, name)`. `source` is null for whole-run failures.
 *
 * A note means part of the request did not produce a forecast: a source was
 * skipped, or its analysis failed. Never swallow them — a silently missing
 * source reads as "we have no data on that spring" when the truth may be
 * "the precipitation fetch failed".
 */
export type EngineNote = {
  kind: "skip" | "error" | string;
  source: string | null;
  message: string;
};

export type ForecastResult = {
  asof: string;
  params: {
    pool: boolean;
    pool_radius_km: number;
    harmonics: number;
    cache: boolean;
    windows: number[];
  };
  sources: SourceForecast[];
  notes: EngineNote[];
};

export type ForecastOptions = {
  /** Read the sources as of this date (YYYY-MM-DD). Defaults to today. */
  asof?: string;
  /**
   * Supply precipitation from the shared Postgres cache instead of letting the
   * engine fetch it. Default true over HTTP; ignored for the local subprocess
   * path, which has no way to inject a provider into a CLI.
   */
  useSharedPrecip?: boolean;
  /** Annual harmonics for season control. 2 suits bimodal climates like Arizona. */
  harmonics?: number;
  poolRadiusKm?: number;
  pool?: boolean;
  timeoutMs?: number;
};

export class EngineError extends Error {
  // Plain field rather than a TS parameter property: parameter properties need
  // code generation, which Node's --experimental-strip-types refuses, and the
  // tests run under it.
  stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "EngineError";
    this.stderr = stderr;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function buildArgs(opts: ForecastOptions): string[] {
  // `--format json`, not `--json`: the old spelling was removed in engine 0.3.0
  // and now exits 2 with a message rather than falling through to the generic
  // unknown-flag error. The payload behind it did not change.
  const args = ["-", "--format", "json"];

  if (opts.asof !== undefined) {
    // The engine parses this with date.fromisoformat and would throw a raw
    // traceback on junk, so validate before it ever gets there.
    if (!ISO_DATE.test(opts.asof)) {
      throw new EngineError(`asof must be YYYY-MM-DD, got "${opts.asof}"`);
    }
    args.push(`--asof=${opts.asof}`);
  }
  if (opts.harmonics !== undefined) args.push(`--harmonics=${opts.harmonics}`);
  if (opts.poolRadiusKm !== undefined) args.push(`--pool-radius=${opts.poolRadiusKm}`);
  if (opts.pool === false) args.push("--no-pool");

  return args;
}

export async function runForecast(
  rows: EngineRow[],
  opts: ForecastOptions = {},
): Promise<ForecastResult> {
  if (rows.length === 0) {
    throw new EngineError("No reports to forecast from.");
  }
  if (opts.asof !== undefined && !ISO_DATE.test(opts.asof)) {
    // The engine parses this with date.fromisoformat and would throw a raw
    // traceback on junk, so validate before it ever gets there.
    throw new EngineError(`asof must be YYYY-MM-DD, got "${opts.asof}"`);
  }

  // Generous default: a cold coordinate costs a multi-second upstream precip
  // fetch, and they run serially inside the engine. Once the Postgres precip
  // cache lands (site #8) this drops to milliseconds for warm coordinates.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const csv = toEngineCsv(rows);

  const engineUrl = process.env.ENGINE_URL;
  if (!engineUrl) return runAsSubprocess(csv, opts, timeoutMs);

  // Gather the coordinates this run needs from the shared cache, in parallel,
  // before the engine would fetch them one at a time. Failing to gather is not
  // fatal: anything missing falls through to the engine's own provider.
  let precip: Record<string, DailySeries> | undefined;
  if (opts.useSharedPrecip !== false) {
    try {
      const asof = opts.asof ?? new Date().toISOString().slice(0, 10);
      const bundle = await collectSeries(rows, asof, { timeoutMs });
      if (Object.keys(bundle.series).length > 0) precip = bundle.series;
    } catch {
      // Shared cache unavailable — the engine still knows how to fetch.
    }
  }

  return runOverHttp(engineUrl, csv, opts, timeoutMs, precip);
}

async function runOverHttp(
  base: string,
  csv: string,
  opts: ForecastOptions,
  timeoutMs: number,
  precip?: Record<string, DailySeries>,
): Promise<ForecastResult> {
  const body = JSON.stringify({
    csv,
    asof: opts.asof,
    harmonics: opts.harmonics,
    pool: opts.pool,
    pool_radius_km: opts.poolRadiusKm,
    precip,
  });

  let response: Response;
  try {
    response = await fetch(new URL("/", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      // The engine is deterministic for a given (csv, asof), but the precip it
      // reads advances daily, so let the caller decide freshness rather than
      // caching this indefinitely.
      cache: "no-store",
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new EngineError(`Engine service unreachable at ${base}: ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new EngineError(`Engine service returned ${response.status}.`, text.slice(0, 500));
  }
  try {
    return JSON.parse(text) as ForecastResult;
  } catch {
    throw new EngineError("Engine service response was not valid JSON.", text.slice(0, 500));
  }
}

async function runAsSubprocess(
  csv: string,
  opts: ForecastOptions,
  timeoutMs: number,
): Promise<ForecastResult> {
  // Dynamic import so node:child_process never lands in the production server
  // bundle -- a static import makes Turbopack trace the whole project.
  const { spawn } = await import("node:child_process");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");

  // Prefer the project-local venv, so a checkout works after one setup command
  // without touching the system Python. Fall back to whatever is on PATH for
  // anyone who installed the engine themselves.
  const venvCli = join(process.cwd(), "services", "engine", ".venv", "bin", "water-forecast");
  const engineCli =
    process.env.ENGINE_CLI ?? (existsSync(venvCli) ? venvCli : "water-forecast");
  const args = buildArgs(opts);

  return new Promise((resolve, reject) => {
    // turbopackIgnore keeps Turbopack from tracing the entire project (source
    // tree and node_modules) into the server bundle on account of this one
    // call — it inflated the build cache to ~200MB. Safe because this path is
    // development-only: production reaches the engine over ENGINE_URL, and the
    // Vercel runtime has no Python to spawn regardless.
    const child = spawn(/*turbopackIgnore: true*/ engineCli, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new EngineError(
          `Engine timed out after ${timeoutMs}ms. ` +
            "Cold precipitation fetches are the usual cause.",
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new EngineError(
          `Could not start the engine (${engineCli}): ${e.message}. ` +
            "Run `npm run engine:install`, or set ENGINE_URL to use the engine service.",
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stderr = Buffer.concat(err).toString("utf8").trim();
      const stdout = Buffer.concat(out).toString("utf8");

      if (code !== 0) {
        reject(new EngineError(`Engine exited with code ${code}.`, stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ForecastResult);
      } catch {
        reject(
          new EngineError(
            "Engine stdout was not valid JSON. Does the installed engine support --format json (0.3.0+)?",
            stderr || stdout.slice(0, 500),
          ),
        );
      }
    });

    child.stdin.on("error", () => {
      /* Engine exited before consuming stdin; the close handler reports it. */
    });
    child.stdin.end(csv);
  });
}
