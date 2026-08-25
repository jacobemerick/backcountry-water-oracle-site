import Link from "next/link";
import { MIN_REPORTS_FOR_VERDICT, THRESHOLD_COPY } from "@/lib/present";
import { formatDistance } from "@/lib/coords";

export type Neighbour = {
  id: number;
  name: string;
  slug: string;
  distance_km: number;
  report_count: number;
};

/**
 * The page a source gets when there is not enough record to say anything.
 *
 * This is deliberately a different *shape*, not the same page with different
 * content. A thin source used to render the answer layout with a hedged block
 * where the verdict goes, and the failure mode that actually hurts someone is a
 * glance that reads "there's a number, probably fine". So there is no verdict
 * slot here at all — not greyed out, not hedged, absent — and no collar, since
 * a collar full of Record and Provenance would imply there is a reading to
 * annotate.
 *
 * Every threshold in the copy below is generated from the constants in
 * present.ts. Nothing user-facing on this page contains a typed number.
 */
export function ThinSourceSheet({
  reportCount,
  neighbours,
  engineError,
  children,
}: {
  reportCount: number;
  /** Everything inside the pooling radius, nearest first. */
  neighbours: Neighbour[];
  engineError?: string | null;
  /** The report form — the thing that actually fixes this. */
  children: React.ReactNode;
}) {
  // A neighbour is only worth offering if it has enough record to say something
  // itself. Pointing someone at a second thin source helps nobody.
  const usefulNeighbour = neighbours.find(
    (n) => n.report_count >= MIN_REPORTS_FOR_VERDICT,
  );

  return (
    <div className="space-y-8">
      {/*
        Where the verdict would be. Overprint, because on a quad that ink marks
        something about the sheet rather than about the terrain — and this is a
        statement about the record, not about the water.
      */}
      <div className="rounded-lg border-2 border-dashed border-overprint bg-surface px-5 py-6">
        <p className="collar-label text-overprint">Insufficient record</p>
        <p className="mt-2 text-2xl font-semibold">No read issued</p>
        <p className="mt-3 max-w-xl leading-relaxed text-muted">
          {THRESHOLD_COPY.noRead(reportCount)}
        </p>
      </div>

      <section>
        <p className="collar-label text-muted">Why</p>
        <div className="mt-3 max-w-2xl space-y-3 leading-relaxed text-muted">
          {reportCount === 0 ? (
            <p>
              This source is recorded, but nobody has reported what the water was doing. The model
              correlates a source&rsquo;s own report history against rainfall, so with no history
              there is nothing to correlate — and a guess dressed up as a forecast is the one thing
              this site should never show.
            </p>
          ) : (
            <p>
              The engine will still produce a number from{" "}
              <span className="value">{reportCount}</span> report
              {reportCount === 1 ? "" : "s"}, and that number is noise. It will happily report a
              perfect correlation from two observations. On a screen where someone is deciding how
              much water to carry, that is the most dangerous thing this site could render, so it
              is not rendered.
            </p>
          )}
          <p>{THRESHOLD_COPY.needed(reportCount)}</p>
        </div>

        {engineError && (
          <pre className="mt-4 overflow-x-auto rounded border border-border bg-surface-sunk p-3 text-xs text-muted">
            {engineError}
          </pre>
        )}
      </section>

      {/*
        A rainfall-percentile-against-climatology block goes here: useful with no
        reports at all, and explicitly *not* a flow verdict. It needs the engine's
        risky mode, which is issue #12 and not yet built. Deliberately rendering
        nothing until then — an empty or placeholder block on this page is exactly
        the "there's something here, probably fine" glance the rest of this layout
        exists to prevent.
      */}

      {usefulNeighbour && (
        <section>
          <p className="collar-label text-muted">Nearest source with a record</p>
          <div className="mt-3 rounded-lg border border-border bg-surface p-5">
            <p>
              <Link href={`/sources/${usefulNeighbour.slug}`} className="hydro-inline text-lg">
                {usefulNeighbour.name}
              </Link>{" "}
              <span className="value ml-1 text-sm text-accent">
                {formatDistance(usefulNeighbour.distance_km)} away
              </span>{" "}
              <span className="value text-sm text-muted">
                {usefulNeighbour.report_count} reports
              </span>
            </p>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              This is a neighbour, <strong className="font-semibold">not a substitute</strong>. Two
              sources this close can behave completely differently — one fed by groundwater that
              barely notices the weather, the other by runoff that is gone a week after the storm.
              Read it for the shape of the country, not as a proxy for this water.
            </p>
          </div>
        </section>
      )}

      <section>
        <p className="collar-label text-accent">This is the fix</p>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          {reportCount === 0
            ? "One dated observation is the difference between this page and a real read. It also sharpens every source around it, because nearby sources lend each other statistical strength."
            : "Every dated observation moves this source closer to a read, and sharpens the ones around it too."}
        </p>
        <div className="mt-5">{children}</div>
      </section>
    </div>
  );
}

/**
 * The engine could not produce a read, on a source that has plenty of record.
 *
 * A third state, and it has to be its own: a timeout or a rate-limit is a fact
 * about this server, not about the water or the corpus. Folding it into the
 * thin-source page produced a genuine contradiction — "15 reports, a
 * correlation needs at least 10, so no read is issued" directly above "this
 * source has enough reports for a read" — which blames the record for the
 * server's problem and tells someone their reports were not enough when they
 * were.
 *
 * Deliberately not an "Insufficient record" stamp and not overprint. Nothing
 * here is a statement about the sheet.
 */
export function ReadUnavailable({
  reportCount,
  engineError,
  children,
}: {
  reportCount: number;
  engineError?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-8">
      <div className="rounded-lg border-l-2 border-warn bg-warn-soft px-5 py-6">
        <p className="collar-label text-warn">Read unavailable</p>
        <p className="mt-2 text-2xl font-semibold">Could not compute a read just now</p>
        <p className="mt-3 max-w-xl leading-relaxed">
          This is a problem with this server, not with the water and not with the record. There
          {reportCount === 1 ? " is " : " are "}
          <span className="value">{reportCount}</span> report
          {reportCount === 1 ? "" : "s"} on file here and the read normally succeeds — try again in
          a minute.
        </p>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          Treat this as no information either way. It is not a quiet way of saying the source is
          dry.
        </p>
        {engineError && (
          <pre className="mt-4 overflow-x-auto rounded border border-border bg-surface p-3 text-xs text-muted">
            {engineError}
          </pre>
        )}
      </div>

      <section>
        <p className="collar-label text-accent">While you are here</p>
        <p className="mt-3 max-w-2xl leading-relaxed text-muted">
          If you have seen this source recently, the report is worth more than the read.
        </p>
        <div className="mt-5">{children}</div>
      </section>
    </div>
  );
}
