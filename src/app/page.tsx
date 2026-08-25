import Link from "next/link";
import { listSourcesWithCounts } from "@/lib/db";
import { SiteShell } from "@/components/SiteShell";
import { SearchField } from "@/components/SearchField";
import { ContourBand } from "@/components/ContourBand";

/**
 * The front door of Direction B: the question, and a box to put a place into.
 *
 * This page used to be a ~1,800-word essay with the two things people come here
 * to do — look a source up, report what they saw — as buttons about 1,500 words
 * down. The essay was and is the most trustworthy thing on the site, which is
 * why it moved to /method rather than being cut.
 */

export const dynamic = "force-dynamic";

export default async function Home() {
  let sources: Awaited<ReturnType<typeof listSourcesWithCounts>> = [];
  let indexError: string | null = null;
  try {
    sources = await listSourcesWithCounts();
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
  }

  const reported = sources.filter((s) => s.report_count > 0).length;

  return (
    <SiteShell>
      <section className="pt-10 sm:pt-14">
        <h1 className="headline text-4xl leading-[1.05] sm:text-6xl">
          Will that seep
          <br />
          be running?
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl">
          We correlate a backcountry water source&rsquo;s historical field reports against nearly
          two decades of daily precipitation for its exact coordinates, and give you a read on
          whether it&rsquo;s likely to have water. You also get the more interesting answer:{" "}
          <em>what kind of source it is</em> — flashy runoff that lives and dies by recent rain, or
          buffered groundwater that barely notices the weather.
        </p>

        {/* The spine of the whole direction. Everything else on this site is the
            answer page this leads to. */}
        <div className="mt-10 max-w-2xl">
          <SearchField />
        </div>
      </section>

      <div className="mt-14 sm:mt-16">
        <ContourBand />
      </div>

      <section className="mt-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border pb-2">
          <h2 className="collar-label text-muted">Sources recorded</h2>
          <p className="collar-label text-muted">
            <span className="value">{sources.length}</span> total ·{" "}
            <span className="value">{reported}</span> with reports
          </p>
        </div>

        {indexError ? (
          <div className="mt-4 rounded-lg border-l-2 border-warn bg-warn-soft p-5">
            <p className="font-medium text-warn">Could not load the index</p>
            <pre className="mt-2 overflow-x-auto text-xs text-muted">{indexError}</pre>
          </div>
        ) : sources.length === 0 ? (
          <p className="mt-5 max-w-2xl leading-relaxed text-muted">
            Nothing recorded yet.{" "}
            <Link href="/sources#add" className="text-accent underline decoration-border underline-offset-4">
              Add the first source
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {sources.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/sources/${s.slug}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5 transition-colors hover:bg-surface"
                >
                  <span className="hydro-inline text-lg">{s.name}</span>
                  <span className="value text-sm text-muted">
                    {s.report_count} report{s.report_count === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-sm leading-relaxed text-muted">
          A source with no reports has no read — the model correlates a source&rsquo;s own history
          against rainfall, so with no history there is nothing to correlate.{" "}
          <Link href="/sources#add" className="text-accent underline decoration-border underline-offset-4">
            Add what you saw
          </Link>{" "}
          and it sharpens that source and the ones around it.
        </p>
      </section>

      {/* Quiet, and last. Someone who wants the method will look for it; someone
          who wants water should not have to scroll past it. */}
      <nav className="mt-12 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-6 text-sm">
        <Link href="/method" className="text-muted underline decoration-border underline-offset-4 hover:text-accent">
          How the read is built
        </Link>
        <Link href="/method#scoring" className="text-muted underline decoration-border underline-offset-4 hover:text-accent">
          The scoring rubric
        </Link>
        <Link href="/method#limits" className="text-muted underline decoration-border underline-offset-4 hover:text-accent">
          What this cannot tell you
        </Link>
      </nav>

      {/* Safety copy, attached to the front door as well as to /method. This is
          the one paragraph that does not get to live one click away. */}
      <p className="mt-6 rounded-lg border-l-2 border-warn bg-warn-soft p-5 leading-relaxed">
        <strong className="font-semibold text-warn">Carry your water.</strong> This is a planning
        aid built from historical correlation, not a promise that anything is wet. Never carry less
        because of what you read here.
      </p>
    </SiteShell>
  );
}
