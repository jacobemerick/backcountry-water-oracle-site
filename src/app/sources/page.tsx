import type { Metadata } from "next";
import { parseLatLon } from "@/lib/coords";
import { listSourcesWithCounts } from "@/lib/db";
import { SiteShell } from "@/components/SiteShell";
import { SourcePicker } from "./SourcePicker";

export const metadata: Metadata = {
  title: "Water sources",
  description:
    "Find a backcountry water source on the map, or add one that isn't recorded yet.",
};

export const dynamic = "force-dynamic";

export default async function SourcesPage({ searchParams }: PageProps<"/sources">) {
  // ?at=<coordinate> comes from the search field's "add it", so a coordinate
  // typed on the home page is not typed a second time here. Parsed with the
  // same parser as everything else — there is exactly one coordinate reader.
  const at = (await searchParams).at;
  const parsedAt = typeof at === "string" ? parseLatLon(at) : null;
  const initialPoint = parsedAt?.ok ? parsedAt.value : null;

  let sources: Awaited<ReturnType<typeof listSourcesWithCounts>> = [];
  let error: string | null = null;

  try {
    sources = await listSourcesWithCounts();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <SiteShell
      context={
        sources.length > 0 ? (
          <>
            <span className="value">{sources.length}</span> recorded
          </>
        ) : null
      }
    >
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
        // The shell's "Add what you saw" verb targets #add, since placing a pin
        // here is how a source gets recorded in the first place.
        <SourcePicker
          id="add"
          initialPoint={initialPoint}
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
    </SiteShell>
  );
}
