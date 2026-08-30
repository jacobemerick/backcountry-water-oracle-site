import type { EngineRow } from "@/lib/engine-csv";
import { RECORD_COPY, digestRecord } from "@/lib/present";
import { nearestStep } from "@/lib/rubric";
import { BlockLabel } from "./SourceRead";

/**
 * The observations themselves.
 *
 * Shared by both page shapes, which previously carried their own copy of this
 * list — the kind of duplication where one side eventually grows a column the
 * other does not.
 *
 * Scores render with their rubric word, not as bare decimals. `0.6` on its own
 * is the model's vocabulary, not the reporter's: the rubric table is the
 * contract between what a hiker saw and what the engine reads, and a page that
 * asks for "Moderate" on the form directly below should not report it back as
 * a number. `nearestStep` does the mapping, including its round-down tie rule,
 * so imported rows that interpolate between anchors still land on a word.
 */
export function ReportHistory({ rows }: { rows: readonly EngineRow[] }) {
  if (rows.length === 0) return null;

  return (
    <ul className="mt-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
      {[...rows].reverse().map((r, i) => (
        <li
          key={`${r.date}-${i}`}
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-surface px-4 py-2.5"
        >
          <span className="value text-sm">{r.date}</span>
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{nearestStep(r.score).label}</span>
            <span className="value text-xs text-accent">{r.score.toFixed(1)}</span>
          </span>
          {r.status && <span className="text-sm text-muted">{r.status}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the record shows, on a page that is issuing no read.
 *
 * This is the substance the thin-source page was missing. It sits above the
 * form rather than below it, because "three people reported here, most
 * recently two years ago, all three found it flowing" is genuinely useful to
 * someone deciding what to carry — and it was previously buried under the
 * whole page, in a form the reporter's own vocabulary had been stripped out of.
 *
 * It is a record, never a verdict: past tense, every claim pinned to a date,
 * and no aggregate that could be read as a statement about today. The refusal
 * block above it stays exactly as it was.
 */
export function RecordSoFar({ rows }: { rows: readonly EngineRow[] }) {
  const digest = digestRecord(rows);
  if (!digest) return null;
  const everDry = RECORD_COPY.everDry(digest);

  return (
    <section>
      <BlockLabel>What people saw</BlockLabel>
      <p className="mt-3 max-w-2xl text-lg leading-relaxed">{RECORD_COPY.summary(digest)}</p>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{RECORD_COPY.framing}</p>

      {everDry && (
        <p className="mt-4 max-w-2xl rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
          {everDry}
        </p>
      )}

      <ReportHistory rows={rows} />
    </section>
  );
}
