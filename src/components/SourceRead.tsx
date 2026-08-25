import type { SourceForecast } from "@/lib/forecast";
import {
  CONFIDENCE_LABEL,
  FRESHNESS_LABEL,
  FRESHNESS_NOTE,
  MIN_REPORTS_FOR_VERDICT,
  confidenceOf,
  describeAge,
  freshnessOf,
  explainPooling,
  explainType,
  flowLabel,
  monthlyFlow,
  signed,
  verdictTone,
} from "@/lib/present";

/**
 * The pieces of a source's read, exported individually.
 *
 * The answer page lays these out as a quad sheet: the read in the body, and
 * Record / Pooling / Provenance in a collar down the right margin. They were
 * split apart so that page and `/forecast`'s linear card could share one
 * implementation; `/forecast` has since been retired, and the split earned its
 * keep a second time by making that a deletion rather than an untangling.
 */

const TONE: Record<string, string> = {
  dry: "border-warn bg-warn-soft",
  marginal: "border-warn bg-warn-soft",
  wet: "border-accent bg-accent-soft",
  unknown: "border-border bg-surface-sunk",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="collar-label text-muted">{label}</dt>
      <dd className="value mt-0.5 text-lg">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** A block heading in the collar, or above a body block. */
export function BlockLabel({ children }: { children: React.ReactNode }) {
  return <p className="collar-label text-muted">{children}</p>;
}

/** Twelve-month seasonality. Bars are relative to the source's own maximum. */
function SeasonBars({ source }: { source: SourceForecast }) {
  const months = monthlyFlow(source);
  const max = Math.max(...months.map((m) => m.flow ?? 0), 0.01);

  return (
    <div>
      <BlockLabel>Average flow by month</BlockLabel>
      <div className="mt-3 flex items-end gap-1" style={{ height: "64px" }}>
        {months.map((m) => (
          <div key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1">
            {m.flow === null ? (
              <div
                className="w-full rounded-sm border border-dashed border-border"
                style={{ height: "4px" }}
                title={`${m.month}: no reports`}
              />
            ) : (
              <div
                className="w-full rounded-sm bg-accent"
                style={{ height: `${Math.max(3, (m.flow / max) * 56)}px` }}
                title={`${m.month}: ${m.flow.toFixed(2)} (${flowLabel(m.flow)})`}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {months.map((m) => (
          <span key={m.month} className="value flex-1 text-center text-[0.6rem] text-muted">
            {m.month[0]}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        Dashed = no reports that month, which is not the same as dry.
      </p>
    </div>
  );
}

/**
 * Why some reports are not in the numbers above.
 *
 * The two reasons are genuinely different and must not be collapsed. A report
 * predating the precipitation record can never be correlated. A report *newer*
 * than the record is only waiting: ERA5 trails about six days, so an
 * observation from this week folds in on its own shortly.
 *
 * Saying "could not be used" to someone who reported water they saw two days
 * ago is both wrong and discouraging, and the whole point of collecting
 * reports is that people keep sending them.
 */
function ExcludedReports({ source }: { source: SourceForecast }) {
  const { total, excluded_before_precip: before, excluded_after_precip: after } = source.reports;
  const [recordStart, recordEnd] = source.reports.precip_span;

  return (
    <div className="rounded-lg border border-border bg-surface-sunk p-4 text-sm leading-relaxed text-muted">
      <p>
        <strong className="font-medium text-foreground">
          <span className="value">{source.n}</span> of <span className="value">{total}</span>{" "}
          reports are in these numbers.
        </strong>
      </p>
      <ul className="mt-2 space-y-1">
        {after > 0 && (
          <li>
            <span className="font-medium text-foreground">
              <span className="value">{after}</span> {after === 1 ? "is" : "are"} too recent to use
              yet.
            </span>{" "}
            The rainfall archive currently ends <span className="value">{recordEnd}</span> and runs
            about a week behind, so
            {after === 1 ? " it joins" : " they join"} the forecast once it catches up. Nothing to
            do.
          </li>
        )}
        {before > 0 && (
          <li>
            <span className="font-medium text-foreground">
              <span className="value">{before}</span> {before === 1 ? "predates" : "predate"} the
              rainfall record
            </span>{" "}
            (which starts <span className="value">{recordStart}</span>), so{" "}
            {before === 1 ? "it" : "they"} cannot be correlated. Still kept — it is a real
            observation, and a longer record may reach back one day.
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * The engine's own standing caveat, shown when it actually applies.
 *
 * ERA5 averages over a ~9–11 km grid, so it smooths isolated convective cells.
 * In the Southwest monsoon that is precisely the rainfall that fills a tank,
 * which makes warm-season reads least trustworthy exactly when a dry spring is
 * most consequential. The engine prints this on every run; here it is attached
 * to the reads it bears on rather than to all of them, so it keeps its force.
 */
function monsoonCaveat(asof: string): boolean {
  const month = Number(asof.slice(5, 7));
  return month >= 6 && month <= 9;
}

/** Freshness of the last sighting — from the database, not the engine. */
export function FreshnessTag({ lastReported }: { lastReported: string | null }) {
  const freshness = freshnessOf(lastReported);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs">
      <span
        className={`collar-label rounded-sm px-1.5 py-0.5 ${
          freshness === "fresh" || freshness === "recent"
            ? "bg-accent-soft text-accent"
            : "bg-warn-soft text-warn"
        }`}
      >
        {FRESHNESS_LABEL[freshness]}
      </span>
      <span className="text-muted">
        last reported <span className="value">{describeAge(lastReported)}</span>
      </span>
    </p>
  );
}

/**
 * The read itself: the verdict, what it was computed from, and what kind of
 * source this is. Everything a hiker needs before deciding how much to carry.
 */
export function TheRead({
  source,
  lastReported = null,
}: {
  source: SourceForecast;
  lastReported?: string | null;
}) {
  const confidence = confidenceOf(source);
  const showVerdict = confidence !== "none";
  const freshnessNote = FRESHNESS_NOTE[freshnessOf(lastReported)];

  return (
    <div className="space-y-5">
      <div className={`rounded-lg border-l-2 px-5 py-4 ${TONE[verdictTone(source)]}`}>
        {showVerdict ? (
          <>
            <p className="text-xl font-semibold">{source.verdict}</p>
            <p className="mt-1 text-sm text-muted">
              As of <span className="value">{source.asof}</span> ·{" "}
              <span className="value">{source.best.window}</span> rain ={" "}
              <span className="value">{source.precip_in.toFixed(2)}&Prime;</span> · nearest
              historical analogs averaged{" "}
              <span className="value text-foreground">{source.predicted_flow.toFixed(2)}</span> (
              {flowLabel(source.predicted_flow)})
            </p>
          </>
        ) : (
          <>
            <p className="text-xl font-semibold">No verdict — too few reports</p>
            <p className="mt-1 text-sm text-muted">
              <span className="value">{source.n}</span> report{source.n === 1 ? "" : "s"} is below
              the <span className="value">{MIN_REPORTS_FOR_VERDICT}</span> needed before a
              correlation means anything. The observations below are real; any forecast built on
              them would not be.
            </p>
          </>
        )}
      </div>

      <p className="text-sm leading-relaxed text-muted">{explainType(source)}</p>

      {freshnessNote && (
        <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
          {freshnessNote}
        </p>
      )}

      {showVerdict && monsoonCaveat(source.asof) && (
        <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
          <strong className="font-semibold text-warn">Warm-season read.</strong> The rainfall model
          averages over roughly a 9&ndash;11 km grid, so it smooths out the isolated monsoon storms
          that actually fill tanks. This read is least reliable right now, which is exactly when a
          dry spring costs the most. Check radar before committing.
        </p>
      )}
    </div>
  );
}

/** What the corpus for this source actually is. Collar material. */
export function SourceRecord({ source }: { source: SourceForecast }) {
  const confidence = confidenceOf(source);
  return (
    <div className="space-y-4">
      <BlockLabel>Record</BlockLabel>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
        <Stat
          label="Reports"
          value={
            source.reports.total > source.n
              ? `${source.n} of ${source.reports.total}`
              : String(source.n)
          }
          hint={CONFIDENCE_LABEL[confidence]}
        />
        <Stat label="Ever dry" value={`${source.pct_dry}%`} hint="of all reports" />
        <Stat
          label="Average flow"
          value={source.mean_flow.toFixed(2)}
          hint={flowLabel(source.mean_flow)}
        />
        <Stat label="Type" value={source.type.split(" (")[0]} />
      </dl>
      {source.reports.total > source.n && <ExcludedReports source={source} />}
    </div>
  );
}

/**
 * The pooling stamp, in overprint purple.
 *
 * Overprint is the quad convention for annotation *about the sheet* rather than
 * about the terrain, which is exactly what pooling is: a statement about how
 * this source's numbers were arrived at, not about its water.
 */
export function SourcePooling({ source }: { source: SourceForecast }) {
  const pooling = explainPooling(source);
  if (!pooling) return null;
  return (
    <div className="rounded-lg border-l-2 border-overprint bg-surface p-4">
      <p className="collar-label text-overprint">Pooling</p>
      <p className="mt-2 text-xs leading-relaxed text-muted">{pooling}</p>
    </div>
  );
}

/** Where the numbers came from. Collar material, and the least urgent of it. */
export function SourceProvenance({ source }: { source: SourceForecast }) {
  const [recordStart, recordEnd] = source.reports.precip_span;
  return (
    <div>
      <BlockLabel>Provenance</BlockLabel>
      <dl className="mt-3 space-y-2 text-xs text-muted">
        <div className="flex justify-between gap-3">
          <dt>Coordinates</dt>
          <dd className="value text-right text-foreground">
            {source.lat.toFixed(5)}, {source.lon.toFixed(5)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Annual rain</dt>
          <dd className="value text-right text-foreground">
            {source.annual_precip_in.toFixed(0)}&Prime;/yr
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Rain record</dt>
          <dd className="value text-right text-foreground">
            {recordStart} – {recordEnd}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Read as of</dt>
          <dd className="value text-right text-foreground">{source.asof}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The correlation table and seasonality — the working behind the read.
 *
 * Genuinely load-bearing rather than decorative: the raw-versus-season-
 * controlled distinction is the difference between a real rain response and a
 * calendar artefact, and someone deciding a water carry deserves to see which
 * one they are being handed.
 */
export function WhyThisRead({ source }: { source: SourceForecast }) {
  const showCorrelations = confidenceOf(source) !== "none";

  return (
    <div className="space-y-6">
      {showCorrelations && (
        <div>
          <BlockLabel>How well rain predicts this source</BlockLabel>
          <div className="overflow-x-auto">
            <table className="mt-3 w-full min-w-[26rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="collar-label pb-1 text-muted">Window</th>
                  <th className="collar-label pb-1 text-right text-muted">Raw</th>
                  <th className="collar-label pb-1 text-right text-muted">Season-controlled</th>
                  <th className="collar-label w-1/3 pb-1 pl-3 text-muted">Strength</th>
                </tr>
              </thead>
              <tbody>
                {source.correlations.map((c) => {
                  const isBest = c.window === source.best.window;
                  return (
                    <tr key={c.window} className={isBest ? "font-medium" : ""}>
                      <td className="value py-1 text-xs">
                        {c.window}
                        {isBest && <span className="ml-1 text-accent">←</span>}
                      </td>
                      <td className="value py-1 text-right text-xs text-muted">{signed(c.raw_r)}</td>
                      <td className="value py-1 text-right text-xs">{signed(c.ctrl_r)}</td>
                      <td className="py-1 pl-3">
                        <div className="h-1.5 w-full rounded-full bg-surface-sunk">
                          <div
                            className={`h-1.5 rounded-full ${isBest ? "bg-accent" : "bg-border"}`}
                            style={{ width: `${Math.min(100, Math.abs(c.ctrl_r) * 100)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Rain and season are entangled — more reports get filed in cool, wet months. The
            season-controlled column removes that day-of-year cycle, so it is the trustworthy one.
            A big gap between the two columns means a correlation was mostly calendar, not rainfall.{" "}
            {source.best.signal_check}
          </p>
        </div>
      )}

      <SeasonBars source={source} />
    </div>
  );
}
