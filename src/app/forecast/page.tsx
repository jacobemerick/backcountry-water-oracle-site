import type { Metadata } from "next";
import Link from "next/link";
import { engineRowsForSources, listSources } from "@/lib/db";
import { EngineError, runForecast, type ForecastResult } from "@/lib/forecast";
import { CONFIDENCE_LABEL, byReliability, confidenceOf, signed } from "@/lib/present";
import { SourceCard } from "./SourceCard";

export const metadata: Metadata = {
  title: "Forecast",
  description:
    "Current water read for every source in the database, most reliable first, with the rainfall correlation behind each call.",
};

/**
 * Re-run at most hourly. The underlying precipitation record only advances
 * daily and ERA5 runs about six days behind, so a fresher read would be
 * fiction — and each cold coordinate costs a multi-second upstream fetch.
 */
export const revalidate = 3600;

type LoadResult =
  | { kind: "ok"; data: ForecastResult }
  | { kind: "empty" }
  | { kind: "error"; message: string; detail?: string };

async function load(): Promise<LoadResult> {
  try {
    const sources = await listSources();
    if (sources.length === 0) return { kind: "empty" };

    const rows = await engineRowsForSources(sources.map((s) => s.id));
    if (rows.length === 0) return { kind: "empty" };

    return { kind: "ok", data: await runForecast(rows) };
  } catch (e) {
    if (e instanceof EngineError) {
      return { kind: "error", message: e.message, detail: e.stderr || undefined };
    }
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

function SummaryTable({ sources }: { sources: ForecastResult["sources"] }) {
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <Link href="/" className="font-mono text-sm font-medium tracking-tight hover:text-accent">
          <span aria-hidden="true">◇</span> Backcountry Water Oracle
        </Link>
      </header>
      <main className="pb-16">{children}</main>
    </div>
  );
}

export default async function ForecastPage() {
  const result = await load();

  if (result.kind === "empty") {
    return (
      <Shell>
        <h1 className="py-10 text-3xl font-semibold tracking-tight">No sources yet</h1>
        <p className="max-w-xl leading-relaxed text-muted">
          The database has no water sources with reports. Seed the worked example with{" "}
          <code className="rounded bg-surface-sunk px-1.5 py-0.5 font-mono text-sm">
            npm run db:seed
          </code>
          .
        </p>
      </Shell>
    );
  }

  if (result.kind === "error") {
    return (
      <Shell>
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
      </Shell>
    );
  }

  const { data } = result;
  const ordered = byReliability(data.sources);

  return (
    <Shell>
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
          <p className="font-medium text-warn">The engine reported:</p>
          <ul className="mt-1 list-inside list-disc text-muted">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <SummaryTable sources={ordered} />

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
          <SourceCard key={s.name} source={s} />
        ))}
      </div>
    </Shell>
  );
}
