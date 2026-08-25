import type { Metadata } from "next";
import { headers } from "next/headers";
import { guardEngineRun } from "@/lib/rate-limit";
import { engineRowsForSources, listSourcesWithCounts } from "@/lib/db";
import { EngineError, runForecast, type ForecastResult } from "@/lib/forecast";
import {
  CONFIDENCE_LABEL,
  FRESHNESS_LABEL,
  byReliability,
  confidenceOf,
  describeAge,
  freshnessOf,
  signed,
} from "@/lib/present";
import { SiteShell } from "@/components/SiteShell";
import { SourceCard } from "@/components/SourceCard";

export const metadata: Metadata = {
  title: "Forecast",
  description:
    "Current water read for every source in the database, most reliable first, with the rainfall correlation behind each call.",
};

/**
 * Rendered per request, not at build.
 *
 * The engine is reached over a Vercel service binding, and bindings resolve at
 * runtime only — they are not available during builds. So this page cannot be
 * prerendered: at build time there is no ENGINE_URL to call. That is also why
 * the previous build-time snapshot had to go.
 *
 * The cost is one engine call per request. That is tolerable now (a warm
 * precipitation cache turns a three-source run into ~100ms) and stops being a
 * question at all once the precip cache moves into Postgres (#8). If it does
 * become one before then, the fix is unstable_cache around load() with an
 * hourly window — the precipitation record advances daily and ERA5 trails
 * about six days, so hourly is already more often than the data changes.
 */
export const dynamic = "force-dynamic";

/** Last-reported date per source name, which the engine does not carry. */
type LastReported = Record<string, string | null>;

type LoadResult =
  | { kind: "ok"; data: ForecastResult; lastReported: LastReported }
  | { kind: "empty" }
  | { kind: "throttled"; retryAfterSeconds: number; scope: "client" | "global" }
  | { kind: "error"; message: string; detail?: string };

async function load(): Promise<LoadResult> {
  try {
    const guard = await guardEngineRun(await headers());
    if (!guard.allowed) {
      return { kind: "throttled", retryAfterSeconds: guard.retryAfterSeconds, scope: guard.scope };
    }

    const sources = await listSourcesWithCounts();
    if (sources.length === 0) return { kind: "empty" };

    const rows = await engineRowsForSources(sources.map((s) => s.id));
    if (rows.length === 0) return { kind: "empty" };

    const lastReported: LastReported = {};
    for (const s of sources) lastReported[s.name] = s.last_reported;

    return { kind: "ok", data: await runForecast(rows), lastReported };
  } catch (e) {
    if (e instanceof EngineError) {
      return { kind: "error", message: e.message, detail: e.stderr || undefined };
    }
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

function SummaryTable({
  sources,
  lastReported,
}: {
  sources: ForecastResult["sources"];
  lastReported: LastReported;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-sunk text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Reports</th>
            <th className="px-3 py-2 text-right font-medium">Dry</th>
            <th className="px-3 py-2 text-right font-medium">Best window</th>
            <th className="px-3 py-2 text-right font-medium">r*</th>
            <th className="px-3 py-2 font-medium">Last seen</th>
            <th className="px-4 py-2 font-medium">Read</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const confidence = confidenceOf(s);
            return (
              <tr key={s.name} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 font-medium">
                  {s.name}
                  {confidence !== "moderate" && (
                    <span className="ml-2 rounded-sm bg-warn-soft px-1.5 py-0.5 font-mono text-[0.65rem] text-warn">
                      {CONFIDENCE_LABEL[confidence]}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{s.n}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{s.pct_dry}%</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs">{s.best.window}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">
                  {signed(s.best.r)}
                </td>
                <td
                  className={`px-3 py-2.5 text-xs ${
                    ["aging", "stale", "unknown"].includes(freshnessOf(lastReported[s.name] ?? null))
                      ? "text-warn"
                      : "text-muted"
                  }`}
                  title={FRESHNESS_LABEL[freshnessOf(lastReported[s.name] ?? null)]}
                >
                  {describeAge(lastReported[s.name] ?? null)}
                </td>
                <td className="px-4 py-2.5">
                  {confidence === "none" ? (
                    <span className="text-muted">Not enough data</span>
                  ) : (
                    s.verdict
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function ForecastPage() {
  const result = await load();

  if (result.kind === "empty") {
    return (
      <SiteShell>
        <h1 className="py-10 text-3xl font-semibold tracking-tight">No sources yet</h1>
        <p className="max-w-xl leading-relaxed text-muted">
          The database has no water sources with reports. Seed the worked example with{" "}
          <code className="rounded bg-surface-sunk px-1.5 py-0.5 font-mono text-sm">
            npm run db:seed
          </code>
          .
        </p>
      </SiteShell>
    );
  }

  if (result.kind === "throttled") {
    return (
      <SiteShell>
        <h1 className="py-10 text-3xl font-semibold tracking-tight">One moment</h1>
        <p className="max-w-xl leading-relaxed text-muted">
          {result.scope === "global"
            ? "The forecast engine is busier than usual right now."
            : "That is a lot of forecasts in a short time."}{" "}
          Every uncached source costs a fetch of nearly two decades of daily rainfall from a free
          weather archive, so this site limits itself rather than lean on that service.
        </p>
        <p className="mt-4 text-muted">
          Try again in about {result.retryAfterSeconds} second
          {result.retryAfterSeconds === 1 ? "" : "s"}.
        </p>
      </SiteShell>
    );
  }

  if (result.kind === "error") {
    return (
      <SiteShell>
        <h1 className="py-10 text-3xl font-semibold tracking-tight">Forecast unavailable</h1>
        <p className="max-w-xl leading-relaxed text-muted">
          The forecast engine could not be reached, so there is nothing to show. Rather than render
          a stale or invented number, this page shows nothing at all — a water call built on a guess
          is worse than no water call.
        </p>
        <pre className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface-sunk p-4 text-xs text-muted">
          {result.message}
          {result.detail ? `\n\n${result.detail}` : ""}
        </pre>
      </SiteShell>
    );
  }

  const { data } = result;
  const ordered = byReliability(data.sources);

  return (
    <SiteShell>
      <div className="py-10">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Current read</h1>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          Every source in the database, most reliable first, as of{" "}
          <span className="font-medium text-foreground">{data.asof}</span>. Sources within{" "}
          {data.params.pool_radius_km} km of each other lend one another statistical strength where
          their rainfall responses agree.
        </p>
      </div>

      {data.notes.length > 0 && (
        <div className="mb-8 rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm">
          <p className="font-medium text-warn">
            {data.notes.length === 1 ? "One source" : `${data.notes.length} sources`} produced no
            forecast
          </p>
          <ul className="mt-2 space-y-1 text-muted">
            {data.notes.map((n, i) => (
              <li key={`${n.kind}-${n.source ?? "run"}-${i}`}>
                {n.source ? <span className="font-medium">{n.source}</span> : "This request"} —{" "}
                {n.message}
                {n.kind === "error" && " (error)"}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Listed rather than hidden: a missing source reads as &ldquo;no data on that
            spring&rdquo; when the real cause may be a failed precipitation fetch.
          </p>
        </div>
      )}

      <SummaryTable sources={ordered} lastReported={result.lastReported} />

      <p className="mt-3 text-xs leading-relaxed text-muted">
        <strong className="font-medium">r*</strong> is the season-controlled rain correlation,
        pooled toward nearby sources where they agree — the trustworthy number. Counter-intuitively,
        a <em>low</em> r* on a rarely-dry source is good news: it means groundwater keeps it running
        regardless of the weather.
      </p>

      <div className="mt-6 rounded-lg border-l-2 border-warn bg-warn-soft p-5 leading-relaxed">
        <strong className="font-semibold text-warn">Carry your water.</strong> These are base rates
        from historical correlation, not measurements of what is there today. The precipitation
        model also smooths over isolated summer storms, so warm-season reads are the least reliable
        exactly when they matter most — cross-check radar before a summer go/no-go.
      </div>

      <div className="mt-12 space-y-8">
        {ordered.map((s) => (
          <SourceCard key={s.name} source={s} lastReported={result.lastReported[s.name] ?? null} />
        ))}
      </div>
    </SiteShell>
  );
}
