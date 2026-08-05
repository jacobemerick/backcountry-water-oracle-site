import type { Metadata } from "next";
import Link from "next/link";
import { listSourcesWithCounts } from "@/lib/db";
import { SourcePicker } from "./SourcePicker";

export const metadata: Metadata = {
  title: "Water sources",
  description:
    "Find a backcountry water source on the map, or add one that isn't recorded yet.",
};

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  let sources: Awaited<ReturnType<typeof listSourcesWithCounts>> = [];
  let error: string | null = null;

  try {
    sources = await listSourcesWithCounts();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <Link href="/" className="font-mono text-sm font-medium tracking-tight hover:text-accent">
          <span aria-hidden="true">◇</span> Backcountry Water Oracle
        </Link>
        <Link
          href="/forecast"
          className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-accent"
        >
          Current read
        </Link>
      </header>

      <main className="pb-16">
        <div className="py-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Water sources</h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            {sources.length > 0
              ? `${sources.length} source${sources.length === 1 ? "" : "s"} recorded. Click one on the map to see it, or drop a pin somewhere new.`
              : "Nothing recorded yet. Drop a pin to add the first source."}
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border-l-2 border-warn bg-warn-soft p-5">
            <p className="font-medium text-warn">Could not load sources</p>
            <pre className="mt-2 overflow-x-auto text-xs text-muted">{error}</pre>
          </div>
        ) : (
          <SourcePicker
            sources={sources.map((s) => ({
              id: s.id,
              name: s.name,
              slug: s.slug,
              lat: s.lat,
              lon: s.lon,
              report_count: s.report_count,
            }))}
          />
        )}
      </main>
    </div>
  );
}
