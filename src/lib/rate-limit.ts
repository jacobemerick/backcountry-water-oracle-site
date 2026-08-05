import { createHmac } from "node:crypto";
import { db } from "./db.ts";

/**
 * Fixed-window rate limiting, backed by Postgres.
 *
 * The threat here is not a determined attacker — there is nothing to steal and
 * the corpus is public. It is (a) someone scripting junk sources into a
 * database whose entire value is that its contents are real, and (b) anyone,
 * malicious or not, driving enough forecasts to hammer Open-Meteo. The second
 * matters more than it looks: the engine fetches ~19 years of daily
 * precipitation per uncached coordinate from a free service that asks nicely
 * for reasonable use, and being cut off would take the site with it.
 */

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window ends. */
  resetAt: number;
  /** True when the check itself failed and the request was let through. */
  degraded?: boolean;
};

export const RULES = {
  /**
   * Creating sources. Deliberately tight — a real person adds a handful after a
   * trip, and legitimate use never approaches this.
   */
  createSource: { limit: 10, windowSeconds: 3600 },

  /** Cheap read, but it hits the database on every keystroke-ish debounce. */
  nearby: { limit: 120, windowSeconds: 60 },

  /**
   * Anything that runs the engine. The binding cost is upstream fetches, not
   * our own compute, which is why this is stricter than a page view deserves.
   */
  forecast: { limit: 30, windowSeconds: 60 },

  /**
   * A ceiling across everyone, so a distributed burst — or one enthusiastic
   * crawler on many IPs — still cannot turn into a flood of upstream requests.
   */
  forecastGlobal: { limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Vercel overwrites `x-forwarded-for` with the real client address and does not
 * forward external ones, specifically to prevent spoofing. `x-vercel-forwarded-for`
 * is the same value but survives a proxy sitting on top of Vercel, so prefer it.
 *
 * Locally none of these exist, and everything shares one bucket — which is
 * correct: there is one client.
 */
export function clientIp(headers: Headers): string {
  const candidate =
    headers.get("x-vercel-forwarded-for") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for");

  if (!candidate) return "local";
  // Take the first entry: Vercel sets a single address, but a proxy in front
  // could produce a list, and the leftmost is the closest thing to the client.
  return candidate.split(",")[0]!.trim() || "local";
}

/**
 * IPs are personal data. Store a keyed digest so a bucket can be counted and
 * compared but not read back into an address.
 *
 * The key falls back to DATABASE_URL when RATE_LIMIT_SECRET is unset — it is
 * always present, secret, and stable. Rotating either just resets the buckets,
 * which is harmless.
 */
function subjectDigest(subject: string): string {
  const secret = process.env.RATE_LIMIT_SECRET ?? process.env.DATABASE_URL ?? "insecure-dev-key";
  return createHmac("sha256", secret).update(subject).digest("hex").slice(0, 32);
}

function windowStart(windowSeconds: number, now = Date.now()): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now / ms) * ms);
}

/**
 * Count one request against `bucket` for `subject`, returning whether it is
 * allowed.
 *
 * **Fails open.** If the counter cannot be read or written, the request is
 * permitted and `degraded` is set. This is a guardrail, not a security
 * boundary: a database hiccup should not take down a site whose whole purpose
 * is telling people whether to carry more water. It is also mostly moot for
 * writes, since the write needs the same database.
 */
export async function checkRateLimit(
  bucket: string,
  subject: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const start = windowStart(rule.windowSeconds);
  const resetAt = Math.floor(start.getTime() / 1000) + rule.windowSeconds;
  const key = `${bucket}:${subjectDigest(subject)}`;

  try {
    const sql = db();
    // One statement: the upsert both increments and reports the new count, so
    // concurrent requests in the same window cannot race past the limit.
    const rows = (await sql`
      INSERT INTO rate_limits (bucket_key, window_start, count)
      VALUES (${key}, ${start.toISOString()}, 1)
      ON CONFLICT (bucket_key, window_start)
      DO UPDATE SET count = rate_limits.count + 1, updated_at = now()
      RETURNING count
    `) as { count: number }[];

    const count = rows[0]?.count ?? 1;
    return {
      allowed: count <= rule.limit,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - count),
      resetAt,
    };
  } catch {
    return { allowed: true, limit: rule.limit, remaining: rule.limit, resetAt, degraded: true };
  }
}

/** Convenience for the common case: limit this request by its client address. */
export function limitByIp(headers: Headers, bucket: string, rule: RateLimitRule) {
  return checkRateLimit(bucket, clientIp(headers), rule);
}

/** Standard headers, so a well-behaved client can back off on its own. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "ratelimit-limit": String(result.limit),
    "ratelimit-remaining": String(result.remaining),
    "ratelimit-reset": String(Math.max(0, result.resetAt - Math.floor(Date.now() / 1000))),
  };
}

/** 429 with a retry hint. */
export function tooManyRequests(result: RateLimitResult, message: string): Response {
  const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
  return Response.json(
    { error: message, retry_after_seconds: retryAfter },
    {
      status: 429,
      headers: { ...rateLimitHeaders(result), "retry-after": String(retryAfter) },
    },
  );
}

/**
 * Drop counters older than a day. Called opportunistically rather than on a
 * schedule — the table is tiny and a stray old row costs nothing, so this is
 * housekeeping, not correctness.
 */
export async function sweepRateLimits(): Promise<number> {
  try {
    const sql = db();
    const rows = (await sql`
      DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'
      RETURNING 1
    `) as unknown[];
    return rows.length;
  } catch {
    return 0;
  }
}

export const __test = { windowStart, subjectDigest };

/**
 * Guard for anything that runs the engine, checked per-client and globally.
 *
 * The global ceiling exists because per-IP limiting does nothing against a
 * distributed burst, and the resource being protected is not ours: an
 * uncached coordinate costs Open-Meteo a ~19-year daily series. Being cut off
 * there takes the whole site with it, so the ceiling is deliberately low
 * enough to be rude to a crawler and invisible to people.
 */
export async function guardEngineRun(headers: Headers): Promise<
  { allowed: true } | { allowed: false; scope: "client" | "global"; retryAfterSeconds: number }
> {
  const perClient = await limitByIp(headers, "forecast", RULES.forecast);
  if (!perClient.allowed) {
    return {
      allowed: false,
      scope: "client",
      retryAfterSeconds: Math.max(1, perClient.resetAt - Math.floor(Date.now() / 1000)),
    };
  }

  const global = await checkRateLimit("forecast_global", "all", RULES.forecastGlobal);
  if (!global.allowed) {
    return {
      allowed: false,
      scope: "global",
      retryAfterSeconds: Math.max(1, global.resetAt - Math.floor(Date.now() / 1000)),
    };
  }

  return { allowed: true };
}
