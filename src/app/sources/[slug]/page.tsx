import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guardEngineRun } from "@/lib/rate-limit";
import { engineRowsForSources, findSourceBySlug, sourcesNear } from "@/lib/db";
import { EngineError, runForecast } from "@/lib/forecast";
import { MIN_REPORTS_FOR_VERDICT } from "@/lib/present";
import { formatDistance, formatLatLon } from "@/lib/coords";
import { SourceCard } from "../../forecast/SourceCard";
import { ReportForm } from "./ReportForm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const source = await findSourceBySlug(slug).catch(() => null);
  return source
    ? { title: source.name, description: `Water forecast and report history for ${source.name}.` }
    : { title: "Source not found" };
}

export default async function SourcePage({ params }: Props) {
  const { slug } = await params;
  const source = await findSourceBySlug(slug);
  if (!source) notFound();

  const rows = await engineRowsForSources([source.id]);
  // rows come back ordered by date, so the last one is the most recent sighting.
  const lastReported = rows.length > 0 ? rows[rows.length - 1].date : null;

  // Pull in neighbours so pooling has something to borrow from — the engine
  // lends a thin source strength from nearby ones that respond to rain the
  // same way, which is exactly the case a single-source page hits.
  const neighbours = await sourcesNear(source.lat, source.lon, 25);
  const neighbourIds = neighbours.map((n) => n.id).filter((id) => id !== source.id);
  const allRows = neighbourIds.length
    ? await engineRowsForSources([source.id, ...neighbourIds])
    : rows;

  let forecast = null;
  let engineError: string | null = null;
  if (rows.length >= MIN_REPORTS_FOR_VERDICT) {
    const guard = await guardEngineRun(await headers());
    if (!guard.allowed) {
      engineError =
        `Busy — try again in about ${guard.retryAfterSeconds}s. Each uncached source costs ` +
        "a fetch of nearly two decades of rainfall from a free archive, so this site limits itself.";
    } else {
      try {
        const result = await runForecast(allRows);
        forecast = result.sources.find((s) => s.name === source.name) ?? null;
      } catch (e) {
        engineError = e instanceof EngineError ? e.message : String(e);
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <Link href="/" className="font-mono text-sm font-medium tracking-tight hover:text-accent">
          <span aria-hidden="true">◇</span> Backcountry Water Oracle
        </Link>
        <Link
          href="/sources"
          className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-accent"
        >
          All sources
        </Link>
      </header>

      <main className="pb-16">
        <div className="py-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{source.name}</h1>
          <p className="mt-2 font-mono text-sm text-muted">{formatLatLon(source)}</p>
        </div>

        {forecast ? (
          <SourceCard source={forecast} lastReported={lastReported} />
        ) : (
          <div className="rounded-lg border border-border bg-surface p-6">
            <h2 className="text-lg font-semibold">
              {rows.length === 0
                ? "No reports yet"
                : `${rows.length} report${rows.length === 1 ? "" : "s"} — not enough for a forecast`}
            </h2>
            <p className="mt-2 leading-relaxed text-muted">
              {rows.length === 0 ? (
                <>
                  This source is recorded, but nobody has reported what the water was doing. The
                  model correlates a source&rsquo;s own report history against rainfall, so with no
                  history there is nothing to correlate — and a guess dressed up as a forecast is
                  the one thing this site should never show.
                </>
              ) : (
                <>
                  A correlation needs at least {MIN_REPORTS_FOR_VERDICT} observations before it
                  means anything. Below that the engine will still produce a number, and that
                  number is noise.
                </>
              )}
            </p>
            {engineError && (
              <pre className="mt-4 overflow-x-auto rounded border border-border bg-surface-sunk p-3 text-xs text-muted">
                {engineError}
              </pre>
            )}
          </div>
        )}

        <section className="mt-10">
          <ReportForm
            slug={slug}
            sourceName={source.name}
            reportCount={rows.length}
            minForVerdict={MIN_REPORTS_FOR_VERDICT}
          />
        </section>

        {rows.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">
              Report history ({rows.length})
            </h2>
            <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {[...rows].reverse().map((r, i) => (
                <li key={`${r.date}-${i}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface px-4 py-2.5">
                  <span className="font-mono text-sm tabular-nums">{r.date}</span>
                  <span className="font-mono text-sm tabular-nums text-accent">
                    {r.score.toFixed(1)}
                  </span>
                  {r.status && <span className="text-sm text-muted">{r.status}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {neighbourIds.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Nearby</h2>
            <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {neighbours
                .filter((n) => n.id !== source.id)
                .map((n) => (
                  <li key={n.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-surface px-4 py-3">
                    <Link href={`/sources/${n.slug}`} className="font-medium hover:text-accent">
                      {n.name}
                    </Link>
                    <span className="font-mono text-xs text-accent">
                      {formatDistance(n.distance_km)}
                    </span>
                    <span className="text-xs text-muted">
                      {n.report_count} report{n.report_count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
