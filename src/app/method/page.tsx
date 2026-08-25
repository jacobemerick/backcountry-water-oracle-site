import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/SiteShell";
import { Section } from "@/components/Section";
import { RUBRIC, RUBRIC_GUIDANCE } from "@/lib/rubric";

const ENGINE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle";
const SITE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle-site";

export const metadata: Metadata = {
  title: "Method",
  description:
    "How the read is built: a source's own field reports, correlated against nearly two " +
    "decades of daily precipitation for its exact coordinates — and what that cannot tell you.",
};

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "Field reports",
    body: "Dated observations from people who were actually standing there, each scored from bone dry to raging. A source with a long report history is one we can say something about; a source with three reports is not.",
  },
  {
    n: "02",
    title: "Precipitation",
    body: "Daily rainfall back to 2007 for that source's exact coordinates, then antecedent totals over the 30, 60, 90, 180, 270 and 365 days before every single report.",
  },
  {
    n: "03",
    title: "Correlation",
    body: "How tightly flow tracks rain in each of those windows, with the seasonal cycle statistically removed. The strongest window is that source's memory — how far back its water remembers the weather.",
  },
];

const LIMITS: { title: string; body: string }[] = [
  {
    title: "It is a base rate, not a measurement",
    body: "Nobody is watching the spring. This is what the historical record says about conditions like today's — genuinely useful for planning, and no substitute for the report of someone who walked past yesterday.",
  },
  {
    title: "No reports, no read",
    body: "The whole method rests on a source's own report history. For an unreported spring, the most we can honestly offer is how this year's rain compares to normal at that spot — which is not the same as saying there is water in it.",
  },
  {
    title: "Summer storms are the weak spot",
    body: "The precipitation model averages over roughly a 9–11 km grid, so it smooths out isolated monsoon cells — least reliable in exactly the season when a desert water call matters most. For a summer go/no-go, cross-check radar.",
  },
  {
    // TODO(#37): "about 25" is hardcoded, and it is not the threshold the code
    // refuses at — present.ts stops showing a verdict at 10, while 25 is where
    // the engine drops its small_n flag. Two different numbers, one sentence.
    // Moved verbatim so this stays a move; #37 owns generating both sentences
    // from the constants.
    title: "Thin data stays thin",
    body: "Under about 25 reports, a correlation is suggestive at best. We would rather show you an honest shrug than a confident number built on four observations.",
  },
];

export default function MethodPage() {
  return (
    <SiteShell context="How the read is built">
      <div className="py-10">
        <h1 className="headline text-3xl sm:text-4xl">Method</h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted">
          Every number on this site comes from one source&rsquo;s own report history, correlated
          against the rain that fell on its exact coordinates. This is how that works, and where
          it stops working.
        </p>
      </div>

      <Section eyebrow="Method" title="How the read is built">
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className="rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent"
            >
              <p className="value text-xs text-accent">{s.n}</p>
              <h3 className="mt-2 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>

        <figure className="mt-8 rounded-lg border-l-2 border-accent bg-accent-soft p-6">
          <blockquote className="text-lg font-medium leading-relaxed text-balance">
            The more reliable a water source is, the <em>less</em> precipitation predicts it.
          </blockquote>
          <figcaption className="mt-3 text-sm leading-relaxed text-muted">
            It sounds backwards and it is the whole point. A true groundwater spring is decoupled
            from last month&rsquo;s weather — that decoupling is <em>why</em> you can count on it.
            A runoff-fed falls is a slave to it: on fast after a storm, off just as fast. So a weak
            rain correlation is not a failed prediction. It is the finding.
          </figcaption>
        </figure>
      </Section>

      <Section id="scoring" eyebrow="Scoring" title="Every report becomes one number">
        <p className="max-w-2xl leading-relaxed text-muted">
          Trail reports are prose — &ldquo;good flow at the box,&rdquo; &ldquo;bone dry, tanks
          held.&rdquo; The engine needs a number, so every observation is mapped onto one scale.
        </p>

        {/* Rendered from lib/rubric.ts, not retyped. This table is the contract
            between what a hiker saw and what the model reads, and a corpus
            scored under two different rubrics is worse than a smaller one
            scored consistently. The copy that used to live here had already
            drifted from the module. */}
        <dl className="mt-6 overflow-hidden rounded-lg border border-border">
          {RUBRIC.map((r, i) => (
            <div
              key={r.score}
              className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 ${
                i % 2 ? "bg-surface-sunk" : "bg-surface"
              }`}
            >
              <dt className="value text-sm text-accent">{r.score.toFixed(1)}</dt>
              <dd className="font-medium">{r.label}</dd>
              <dd className="text-sm text-muted">{r.detail}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 max-w-2xl rounded-lg border-l-2 border-accent bg-accent-soft p-4 leading-relaxed">
          {RUBRIC_GUIDANCE}
        </p>
      </Section>

      <Section id="limits" eyebrow="Honesty" title="What this cannot tell you">
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMITS.map((l) => (
            <div key={l.title} className="rounded-lg border border-border bg-surface p-5">
              <h3 className="font-semibold">{l.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{l.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 rounded-lg border-l-2 border-warn bg-warn-soft p-5 leading-relaxed">
          <strong className="font-semibold text-warn">Carry your water.</strong> This is a planning
          aid built from historical correlation, not a promise that anything is wet. Never carry
          less because of what you read here.
        </p>
      </Section>

      <Section id="status" eyebrow="Status" title="What is here, and what is coming">
        <p className="max-w-2xl leading-relaxed text-muted">
          The forecasting engine is built, open source, and has been used before real trips. This
          site is the front door for it, and it is being assembled now.
        </p>
        <p className="mt-4 max-w-2xl leading-relaxed text-muted">
          The honest constraint: the model is free, but the <em>reports</em> are the hard part.
          Every dated observation someone contributes sharpens the source it belongs to and the
          ones around it, because nearby sources lend each other statistical strength. If you keep
          trip notes on water, you already have the valuable thing.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
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

      <Section eyebrow="Next" title="Go look something up">
        <div className="flex flex-wrap gap-3">
          <Link
            href="/sources"
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Browse water sources
          </Link>
          <Link
            href="/sources#add"
            className="rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
          >
            Add what you saw
          </Link>
        </div>
      </Section>
    </SiteShell>
  );
}
