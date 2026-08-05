import Link from "next/link";

const ENGINE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle";
const SITE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle-site";

/* The six-point rubric every field report is scored on. Kept in sync with the
   /water-forecast skill — this table is the contract, and publishing it is also
   how we teach people to report consistently. */
const RUBRIC: { score: string; label: string; example: string }[] = [
  { score: "0.0", label: "Dry", example: "no water, no pools" },
  { score: "0.2", label: "Not flowing", example: "dripping, stagnant pools" },
  { score: "0.4", label: "Trickle", example: "light but filterable" },
  { score: "0.6", label: "Moderate", example: "about a quart per minute" },
  { score: "0.8", label: "Strong", example: "about a gallon per minute" },
  { score: "1.0", label: "Raging", example: "gallon-plus, loud" },
];

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
    title: "Thin data stays thin",
    body: "Under about 25 reports, a correlation is suggestive at best. We would rather show you an honest shrug than a confident number built on four observations.",
  },
];

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border py-14 sm:py-20">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <span className="font-mono text-sm font-medium tracking-tight">
          <span aria-hidden="true">◇</span> Backcountry Water Oracle
        </span>
        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/sources" className="text-muted transition-colors hover:text-accent">
            Sources
          </Link>
          <Link href="/forecast" className="text-muted transition-colors hover:text-accent">
            Current read
          </Link>
          <a
            href={SITE_REPO}
            className="text-muted underline decoration-border underline-offset-4 transition-colors hover:text-accent hover:decoration-accent"
          >
            GitHub
          </a>
        </nav>
      </header>

      <main>
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
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl">
            You also get the more interesting answer: <em>what kind of source it is</em> — flashy
            runoff that lives and dies by recent rain, or buffered groundwater that barely notices
            the weather.
          </p>
        </section>

        <Section eyebrow="Method" title="How the read is built">
          <ol className="grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li
                key={s.n}
                className="rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent"
              >
                <p className="font-mono text-xs text-accent">{s.n}</p>
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

        <Section eyebrow="Scoring" title="Every report becomes one number">
          <p className="max-w-2xl leading-relaxed text-muted">
            Trail reports are prose — &ldquo;good flow at the box,&rdquo; &ldquo;bone dry, tanks
            held.&rdquo; The engine needs a number, so every observation is mapped onto one scale.
            Report what is <em>usable</em>: if the seep proper is dry but the rock tanks are holding,
            that is water.
          </p>
          <dl className="mt-6 overflow-hidden rounded-lg border border-border">
            {RUBRIC.map((r, i) => (
              <div
                key={r.score}
                className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 ${
                  i % 2 ? "bg-surface-sunk" : "bg-surface"
                }`}
              >
                <dt className="font-mono text-sm font-medium tabular-nums text-accent">
                  {r.score}
                </dt>
                <dd className="font-medium">{r.label}</dd>
                <dd className="text-sm text-muted">{r.example}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section eyebrow="Honesty" title="What this cannot tell you">
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
      </main>

      <footer className="border-t border-border py-8 text-sm text-muted">
        <p>
          Precipitation from the{" "}
          <a
            href="https://open-meteo.com/"
            className="underline decoration-border underline-offset-4 hover:text-accent"
          >
            Open-Meteo ERA5 archive
          </a>
          . Engine and site are MIT licensed.
        </p>
        <p className="mt-2">Built for hikers who have walked a long way to a dry spring.</p>
      </footer>
    </div>
  );
}
