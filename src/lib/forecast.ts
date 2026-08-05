import { spawn } from "node:child_process";
import { join } from "node:path";
import { toEngineCsv, type EngineRow } from "./engine-csv.ts";

/**
 * Runs the vendored Python engine. The contract is deliberately narrow: CSV in
 * on stdin, one JSON object out on stdout, diagnostics on stderr. No temp files
 * -- a serverless filesystem is read-only outside /tmp, and writing a file just
 * to read it back would be pointless anyway.
 */

const ENGINE = join(process.cwd(), "engine", "forecast.py");
const PYTHON = process.env.PYTHON_BIN ?? "python3";

/** Mirrors the engine's own JSON output. See engine/forecast.py:source_json. */
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

export type SourceForecast = {
  name: string;
  lat: number;
  lon: number;
  n: number;
  small_n: boolean;
  pct_dry: number;
  mean_flow: number;
  annual_precip_in: number;
  type: string;
  mean_flow_by_month: Record<string, number>;
  correlations: Correlation[];
  best: BestWindow;
  asof: string;
  precip_in: number;
  predicted_flow: number;
  verdict: string;
  harmonics: number;
};

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
  const args = ["-", "--json"];

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

  const args = buildArgs(opts);
  const csv = toEngineCsv(rows);

  // Generous default: a cold coordinate costs a multi-second upstream precip
  // fetch, and they run serially inside the engine. Once the Postgres precip
  // cache lands (site #8) this drops to milliseconds for warm coordinates.
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [ENGINE, ...args], { stdio: ["pipe", "pipe", "pipe"] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new EngineError(
          `Engine timed out after ${timeoutMs}ms (${rows.length} rows). ` +
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
      reject(new EngineError(`Could not start ${PYTHON}: ${e.message}`));
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
            "Engine stdout was not valid JSON. Is engine/forecast.py current with --json?",
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
