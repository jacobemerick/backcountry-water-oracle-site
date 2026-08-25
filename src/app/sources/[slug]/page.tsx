import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guardEngineRun } from "@/lib/rate-limit";
import { engineRowsForSources, findSourceBySlug, sourcesNear } from "@/lib/db";
import { EngineError, runForecast } from "@/lib/forecast";
import { MIN_REPORTS_FOR_VERDICT } from "@/lib/present";
import { formatDistance, formatLatLon } from "@/lib/coords";
import { SiteShell } from "@/components/SiteShell";
import {
  BlockLabel,
  FreshnessTag,
  SourcePooling,
  SourceProvenance,
  SourceRecord,
  TheRead,
  WhyThisRead,
} from "@/components/SourceCard";
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
    <SiteShell width="sheet" context={<span className="value">{formatLatLon(source)}</span>}>
      <div className="py-8">
        <h1 className="hydro-display text-3xl sm:text-4xl">{source.name}</h1>
        <p className="collar-label mt-2 text-muted">
          <span className="value normal-case tracking-normal">{formatLatLon(source)}</span>
        </p>
        <div className="mt-3">
          <FreshnessTag lastReported={lastReported} />
        </div>
        <p className="mt-3 max-w-2xl text-sm text-muted">
          Every number here is a base rate from this source&rsquo;s own report history —{" "}
          <Link
            href="/method"
            className="underline decoration-border underline-offset-4 hover:text-accent"
          >
            how the read is built
          </Link>
          .
        </p>
      </div>

      {/*
        The sheet. One column on a phone, in the order someone reads it: the
        read, then what the record actually is, then the form. At desktop width
        it becomes a body and a collar — the marginalia a real quad carries down
        its right edge, which is the reason this identity earns a wide layout
        rather than a centred column.
      */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-10">
        <div className="lg:col-start-1">
          {forecast ? (
            <TheRead source={forecast} lastReported={lastReported} />
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
                    model correlates a source&rsquo;s own report history against rainfall, so with
                    no history there is nothing to correlate — and a guess dressed up as a forecast
                    is the one thing this site should never show.
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
        </div>

        {/* The collar. Sunk ground and letterspaced keys, down the right margin
            on desktop; directly under the read on a phone, where there is no
            margin to hang anything in. */}
        {forecast && (
          <aside className="lg:col-start-2 lg:row-span-full">
            <div className="space-y-6 rounded-lg border border-border bg-surface-sunk p-5 lg:sticky lg:top-6">
              <SourceRecord source={forecast} />
              <SourcePooling source={forecast} />
              <SourceProvenance source={forecast} />
            </div>
          </aside>
        )}

        {forecast && (
          <details className="why-this-read lg:col-start-1" open={false}>
            <summary className="collar-label cursor-pointer text-accent">Why this read</summary>
            <div className="mt-5">
              <WhyThisRead source={forecast} />
            </div>
          </details>
        )}

        <section className="lg:col-start-1">
          <ReportForm
            slug={slug}
            sourceName={source.name}
            reportCount={rows.length}
            minForVerdict={MIN_REPORTS_FOR_VERDICT}
          />
        </section>

        {rows.length > 0 && (
          <section className="lg:col-start-1">
            <BlockLabel>Report history ({rows.length})</BlockLabel>
            <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {[...rows].reverse().map((r, i) => (
                <li
                  key={`${r.date}-${i}`}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface px-4 py-2.5"
                >
                  <span className="value text-sm">{r.date}</span>
                  <span className="value text-sm text-accent">{r.score.toFixed(1)}</span>
                  {r.status && <span className="text-sm text-muted">{r.status}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {neighbourIds.length > 0 && (
          <section className="lg:col-start-1">
            <BlockLabel>Nearby</BlockLabel>
            <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {neighbours
                .filter((n) => n.id !== source.id)
                .map((n) => (
                  <li
                    key={n.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-surface px-4 py-3"
                  >
                    <Link href={`/sources/${n.slug}`} className="hydro-inline">
                      {n.name}
                    </Link>
                    <span className="value text-xs text-accent">
                      {formatDistance(n.distance_km)}
                    </span>
                    <span className="value text-xs text-muted">
                      {n.report_count} report{n.report_count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </SiteShell>
  );
}
