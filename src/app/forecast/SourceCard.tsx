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

const TONE: Record<string, string> = {
  dry: "border-warn bg-warn-soft",
  marginal: "border-warn bg-warn-soft",
  wet: "border-accent bg-accent-soft",
  unknown: "border-border bg-surface-sunk",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.7rem] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** Twelve-month seasonality. Bars are relative to the source's own maximum. */
function SeasonBars({ source }: { source: SourceForecast }) {
  const months = monthlyFlow(source);
  const max = Math.max(...months.map((m) => m.flow ?? 0), 0.01);

  return (
    <div>
      <p className="font-mono text-[0.7rem] uppercase tracking-wider text-muted">
        Average flow by month
      </p>
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
          <span key={m.month} className="flex-1 text-center text-[0.6rem] text-muted">
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
          {source.n} of {total} reports are in the numbers above.
        </strong>
      </p>
      <ul className="mt-2 space-y-1">
        {after > 0 && (
          <li>
            <span className="font-medium text-foreground">
              {after} {after === 1 ? "is" : "are"} too recent to use yet.
            </span>{" "}
            The rainfall archive currently ends {recordEnd} and runs about a week behind, so
            {after === 1 ? " it joins" : " they join"} the forecast once it catches up. Nothing to
            do.
          </li>
        )}
        {before > 0 && (
          <li>
            <span className="font-medium text-foreground">
              {before} {before === 1 ? "predates" : "predate"} the rainfall record
            </span>{" "}
            (which starts {recordStart}), so {before === 1 ? "it" : "they"} cannot be correlated.
            Still kept — it is a real observation, and a longer record may reach back one day.
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

export function SourceCard({
  source,
  lastReported = null,
}: {
  source: SourceForecast;
  /** From the database — the engine has no idea when it was last visited. */
  lastReported?: string | null;
}) {
  const freshness = freshnessOf(lastReported);
  const freshnessNote = FRESHNESS_NOTE[freshness];
  const confidence = confidenceOf(source);
  const tone = verdictTone(source);
  const pooling = explainPooling(source);
  const showVerdict = confidence !== "none";

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface">
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h3 className="text-lg font-semibold tracking-tight">{source.name}</h3>
        <p className="mt-1 font-mono text-xs text-muted">
          {source.lat.toFixed(5)}, {source.lon.toFixed(5)} · ~{source.annual_precip_in.toFixed(0)}
          &Prime;/yr
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-sm px-1.5 py-0.5 font-mono ${
              freshness === "fresh" || freshness === "recent"
                ? "bg-accent-soft text-accent"
                : "bg-warn-soft text-warn"
            }`}
          >
            {FRESHNESS_LABEL[freshness]}
          </span>
          <span className="text-muted">last reported {describeAge(lastReported)}</span>
        </p>
      </header>

      {/* Verdict */}
      <div className={`border-l-2 px-5 py-4 sm:px-6 ${TONE[tone]}`}>
        {showVerdict ? (
          <>
            <p className="text-xl font-semibold">{source.verdict}</p>
            <p className="mt-1 text-sm text-muted">
              As of {source.asof} · {source.best.window} rain ={" "}
              {source.precip_in.toFixed(2)}&Prime; · nearest historical analogs averaged{" "}
              <span className="font-medium text-foreground">
                {source.predicted_flow.toFixed(2)}
              </span>{" "}
              ({flowLabel(source.predicted_flow)})
            </p>
          </>
        ) : (
          <>
            <p className="text-xl font-semibold">No verdict — too few reports</p>
            <p className="mt-1 text-sm text-muted">
              {source.n} report{source.n === 1 ? "" : "s"} is below the {MIN_REPORTS_FOR_VERDICT}{" "}
              needed before a correlation means anything. The observations below are real; any
              forecast built on them would not be.
            </p>
          </>
        )}
      </div>

      <div className="space-y-6 px-5 py-5 sm:px-6">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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

        <p className="text-sm leading-relaxed text-muted">{explainType(source)}</p>

        {freshnessNote && (
          <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
            {freshnessNote}
          </p>
        )}

        {showVerdict && monsoonCaveat(source.asof) && (
          <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
            <strong className="font-semibold text-warn">Warm-season read.</strong> The rainfall
            model averages over roughly a 9&ndash;11 km grid, so it smooths out the isolated
            monsoon storms that actually fill tanks. This read is least reliable right now, which
            is exactly when a dry spring costs the most. Check radar before committing.
          </p>
        )}

        {source.reports.total > source.n && <ExcludedReports source={source} />}

        {showVerdict && (
          <div>
            <p className="font-mono text-[0.7rem] uppercase tracking-wider text-muted">
              How well rain predicts this source
            </p>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="pb-1 font-medium">Window</th>
                  <th className="pb-1 text-right font-medium">Raw</th>
                  <th className="pb-1 text-right font-medium">Season-controlled</th>
                  <th className="w-1/3 pb-1 pl-3 font-medium">Strength</th>
                </tr>
              </thead>
              <tbody>
                {source.correlations.map((c) => {
                  const isBest = c.window === source.best.window;
                  return (
                    <tr key={c.window} className={isBest ? "font-medium" : ""}>
                      <td className="py-1 font-mono text-xs">
                        {c.window}
                        {isBest && <span className="ml-1 text-accent">←</span>}
                      </td>
                      <td className="py-1 text-right font-mono text-xs tabular-nums text-muted">
                        {signed(c.raw_r)}
                      </td>
                      <td className="py-1 text-right font-mono text-xs tabular-nums">
                        {signed(c.ctrl_r)}
                      </td>
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
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Rain and season are entangled — more reports get filed in cool, wet months. The
              season-controlled column removes that day-of-year cycle, so it is the trustworthy one.
              A big gap between the two columns means a correlation was mostly calendar, not
              rainfall. {source.best.signal_check}
            </p>
            {pooling && <p className="mt-2 text-xs leading-relaxed text-muted">{pooling}</p>}
          </div>
        )}

        <SeasonBars source={source} />
      </div>
    </article>
  );
}
