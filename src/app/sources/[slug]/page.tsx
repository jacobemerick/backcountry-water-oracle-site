import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guardEngineRun } from "@/lib/rate-limit";
import { engineRowsForSources, findSourceBySlug, sourcesNear } from "@/lib/db";
import { EngineError, hasRead, runForecast } from "@/lib/forecast";
import type { ReadableSource } from "@/lib/forecast";
import { MIN_REPORTS_FOR_VERDICT, THRESHOLD_COPY, confidenceOf } from "@/lib/present";
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
} from "@/components/SourceRead";
import { ReadUnavailable, ThinSourceSheet } from "@/components/ThinSourceSheet";
import { ReportHistory } from "@/components/ReportHistory";
import { ReportForm } from "./ReportForm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * The source page is the URL people actually share, so its social metadata has
 * to describe the source rather than the site.
 *
 * It did not. `title` and `description` were set, but `openGraph` was not — and
 * an unset `openGraph` does not inherit them, it inherits the root layout's
 * static block, which hardcodes the site name and `url: "/"`. So every shared
 * source link unfurled as the generic front page: same title, same blurb,
 * pointing at the homepage. The `title.template` in the layout only rewrites
 * the `<title>` tag; it never touches `og:title`.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const source = await findSourceBySlug(slug).catch(() => null);
  if (!source) return { title: "Source not found" };

  const title = `${source.name} · Backcountry Water Oracle`;
  const description =
    `Is there water at ${source.name}? A read built from this source's own field ` +
    `reports, correlated against nearly two decades of rainfall at ${formatLatLon(source)}.`;
  const url = `/sources/${slug}`;

  return {
    title: source.name,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "Backcountry Water Oracle", type: "article" },
    twitter: { card: "summary", title, description },
  };
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

  let forecast: ReadableSource | null = null;
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
        // Since engine 0.2.0 a source with no usable reports comes back *in*
        // sources[] with every verdict-derived field null, rather than being
        // dropped. Narrow here so the thin-source page handles that case rather
        // than the sheet rendering a row of nulls.
        const found = result.sources.find((s) => s.name === source.name);
        forecast = found && hasRead(found) ? found : null;
      } catch (e) {
        engineError = e instanceof EngineError ? e.message : String(e);
      }
    }
  }

  const neighbourList = neighbours
    .filter((n) => n.id !== source.id)
    .map((n) => ({
      id: n.id,
      name: n.name,
      slug: n.slug,
      distance_km: n.distance_km,
      report_count: n.report_count,
    }));

  const reportForm = (
    <ReportForm
      slug={slug}
      sourceName={source.name}
      reportCount={rows.length}
      minForVerdict={MIN_REPORTS_FOR_VERDICT}
    />
  );

  /*
   * Two page shapes, not one page with a hole in it.
   *
   * A thin source used to render this same layout with a hedged block where the
   * verdict goes, which can be skimmed as a weak verdict — "there's a number,
   * probably fine". That glance is the failure mode that actually hurts
   * someone, so the absence is structural: no verdict slot, no collar, and a
   * prose measure rather than the wide sheet, because a collar full of Record
   * and Provenance would imply there is a reading to annotate.
   */
  // Three states, not two. "No read" has two completely different causes and
  // they must not share a page: too little record is a fact about the corpus,
  // an engine failure is a fact about this server. Saying the first when the
  // second is true tells someone their reports were not enough when they were.
  const enoughReports = rows.length >= MIN_REPORTS_FOR_VERDICT;

  if (!forecast) {
    return (
      <SiteShell context={<span className="value">{formatLatLon(source)}</span>}>
        <div className="py-8">
          <h1 className="hydro-display text-3xl sm:text-4xl">{source.name}</h1>
          <p className="value mt-2 text-sm text-muted">{formatLatLon(source)}</p>
          {/* Freshness belongs here more than on the read page, not less: with
              no verdict to qualify, how old the record is *is* the information. */}
          <div className="mt-3">
            <FreshnessTag lastReported={lastReported} />
          </div>
          <p className="mt-3 max-w-2xl text-sm text-muted">
            How this site decides what it can and cannot say —{" "}
            <Link
              href="/method"
              className="underline decoration-border underline-offset-4 hover:text-accent"
            >
              the method
            </Link>
            .
          </p>
        </div>

        {enoughReports ? (
          <ReadUnavailable reportCount={rows.length} engineError={engineError}>
            {reportForm}
          </ReadUnavailable>
        ) : (
          <ThinSourceSheet
            reportCount={rows.length}
            rows={rows}
            neighbours={neighbourList}
            engineError={engineError}
          >
            {reportForm}
          </ThinSourceSheet>
        )}

        {/* The thin sheet renders the record itself, in place. This is only for
            the engine-failure shape, which has plenty of record and no read. */}
        {enoughReports && rows.length > 0 && (
          <section className="mt-10">
            <BlockLabel>Report history ({rows.length})</BlockLabel>
            <ReportHistory rows={rows} />
          </section>
        )}
      </SiteShell>
    );
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
          <TheRead source={forecast} lastReported={lastReported} />

          {/* A read above the floor but under the engine's weak-evidence
              threshold is still a read — it just has to say so. Generated from
              the constants, never typed. */}
          {confidenceOf(forecast) === "weak" && (
            <p className="mt-5 rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
              <strong className="font-semibold text-warn">Thin evidence.</strong>{" "}
              {THRESHOLD_COPY.weak(forecast.n)}
            </p>
          )}
        </div>

        {/* The collar. Sunk ground and letterspaced keys, down the right margin
            on desktop; directly under the read on a phone, where there is no
            margin to hang anything in. */}
        <aside className="lg:col-start-2 lg:row-span-full">
            <div className="space-y-6 rounded-lg border border-border bg-surface-sunk p-5 lg:sticky lg:top-6">
              <SourceRecord source={forecast} />
              <SourcePooling source={forecast} />
            <SourceProvenance source={forecast} />
          </div>
        </aside>

        <details className="why-this-read lg:col-start-1" open={false}>
            <summary className="collar-label cursor-pointer text-accent">Why this read</summary>
          <div className="mt-5">
            <WhyThisRead source={forecast} />
          </div>
        </details>

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
            <ReportHistory rows={rows} />
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
