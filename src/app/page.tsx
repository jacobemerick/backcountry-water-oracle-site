import Link from "next/link";
import { SiteShell } from "@/components/SiteShell";
import { Section } from "@/components/Section";
import { SearchField } from "@/components/SearchField";

const ENGINE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle";
const SITE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle-site";

export default function Home() {
  return (
    <SiteShell>
      <section className="py-12 sm:py-20">
        <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 font-mono text-xs text-muted">
          <span className="inline-block size-1.5 rounded-full bg-accent" aria-hidden="true" />
          Early build — the report corpus is small and growing
        </p>
        <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
          Will that seep
          <br />
          be running?
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl">
          We correlate a backcountry water source&rsquo;s historical field reports against nearly
          two decades of daily precipitation for its exact coordinates, and give you a read on
          whether it&rsquo;s likely to have water.
        </p>

        {/* The spine of the whole direction. Everything else on this site is
            the answer page this leads to. */}
        <div className="mt-10 max-w-2xl">
          <SearchField />
        </div>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl">
          You also get the more interesting answer: <em>what kind of source it is</em> — flashy
          runoff that lives and dies by recent rain, or buffered groundwater that barely notices
          the weather.
        </p>
      </section>

      {/* Method, Scoring and What-this-cannot-tell-you now live at /method. The
          essay is the most trustworthy thing on this site, so it moved rather
          than shrank. */}
      <Section eyebrow="Method" title="How the read is built">
        <p className="max-w-2xl leading-relaxed text-muted">
          Three steps: a source&rsquo;s own dated field reports, nearly two decades of daily
          rainfall for its exact coordinates, and the correlation between them with the seasonal
          cycle removed. The counter-intuitive part is that the more reliable a source is, the{" "}
          <em>less</em> precipitation predicts it — and that is the finding, not a failure.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/method"
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            How the read is built
          </Link>
          <Link
            href="/method#scoring"
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            The scoring rubric
          </Link>
          <Link
            href="/method#limits"
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            What this cannot tell you
          </Link>
        </div>

        <p className="mt-6 rounded-lg border-l-2 border-warn bg-warn-soft p-5 leading-relaxed">
          <strong className="font-semibold text-warn">Carry your water.</strong> This is a planning
          aid built from historical correlation, not a promise that anything is wet. Never carry
          less because of what you read here.
        </p>
      </Section>

      <Section eyebrow="Status" title="What is here, and what is coming">
        <p className="max-w-2xl leading-relaxed text-muted">
          The forecasting engine is built, open source, and has been used before real trips. This
          site is the front door for it, and it is being assembled now — source lookup, report
          entry, and the comparison table are the next things to land.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted">
          The honest constraint: the model is free, but the <em>reports</em> are the hard part.
          Every dated observation someone contributes sharpens the source it belongs to and the
          ones around it, because nearby sources lend each other statistical strength. If you keep
          trip notes on water, you already have the valuable thing.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sources"
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Browse water sources
          </Link>
          <Link
            href="/forecast"
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            Current read
          </Link>
          <a
            href={ENGINE_REPO}
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            The engine on GitHub
          </a>
          <a
            href={`${SITE_REPO}/issues/20`}
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            Roadmap
          </a>
        </div>
      </Section>
    </SiteShell>
  );
}
