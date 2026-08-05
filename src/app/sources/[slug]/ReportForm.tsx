"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RUBRIC, RUBRIC_GUIDANCE } from "@/lib/rubric";
import { MAX_STATUS, todayIso } from "@/lib/reports";

export function ReportForm({
  slug,
  sourceName,
  reportCount,
  minForVerdict,
}: {
  slug: string;
  sourceName: string;
  reportCount: number;
  minForVerdict: number;
}) {
  const router = useRouter();
  const today = todayIso();

  const [observedOn, setObservedOn] = useState(today);
  const [score, setScore] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ warnings: string[] } | null>(null);

  const remaining = minForVerdict - reportCount;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (score === null || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sources/${slug}/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observed_on: observedOn, score, status: status.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save the report.");
        return;
      }
      setDone({ warnings: data.warnings ?? [] });
      setScore(null);
      setStatus("");
      // The page is force-dynamic, so this pulls the new report — and, if this
      // one crossed the threshold, the forecast that now exists.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the report.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border-l-2 border-accent bg-accent-soft p-5">
        <p className="font-semibold">Report recorded. Thank you.</p>
        {done.warnings.map((w) => (
          <p key={w} className="mt-2 text-sm text-muted">
            {w}
          </p>
        ))}
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {remaining > 1
            ? `${sourceName} needs about ${remaining - 1} more before a forecast means anything.`
            : reportCount + 1 >= minForVerdict
              ? "That is enough history for a forecast — reload to see it."
              : "One more and this source crosses into forecastable."}
        </p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="mt-4 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
        >
          Add another
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Add a report</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          What was the water doing when you were there? Every observation sharpens this source and,
          because nearby sources lend each other statistical strength, the ones around it.
        </p>
      </div>

      <div>
        <label htmlFor="observed_on" className="block text-sm font-medium">
          Date you saw it
        </label>
        <p className="mt-1 text-sm text-muted">
          The day you were standing there, not today. The forecast correlates rainfall up to this
          date, so a wrong date is worse than no report.
        </p>
        <input
          id="observed_on"
          type="date"
          required
          max={today}
          value={observedOn}
          onChange={(e) => setObservedOn(e.target.value)}
          className="mt-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium">How much water?</legend>
        <p className="mt-1 text-sm leading-relaxed text-muted">{RUBRIC_GUIDANCE}</p>
        <div className="mt-3 space-y-2">
          {RUBRIC.map((step) => (
            <label
              key={step.score}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                score === step.score
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-background hover:border-accent"
              }`}
            >
              <input
                type="radio"
                name="score"
                value={step.score}
                checked={score === step.score}
                onChange={() => setScore(step.score)}
                className="mt-1 accent-[var(--accent)]"
              />
              <span>
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">{step.label}</span>
                  <span className="font-mono text-xs text-accent tabular-nums">
                    {step.score.toFixed(1)}
                  </span>
                </span>
                <span className="mt-0.5 block text-sm text-muted">{step.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="status" className="block text-sm font-medium">
          Notes <span className="font-normal text-muted">(optional)</span>
        </label>
        <p className="mt-1 text-sm text-muted">
          In your own words. Kept verbatim — the number is what the model reads, but this is what a
          human checks when a forecast looks surprising.
        </p>
        <textarea
          id="status"
          rows={2}
          maxLength={MAX_STATUS}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="Spring box full, slow outflow. Tanks below still holding."
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </div>

      {error && (
        <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-3 text-sm">{error}</p>
      )}

      <button
        type="submit"
        disabled={score === null || submitting}
        className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Saving…" : "Add report"}
      </button>
    </form>
  );
}
