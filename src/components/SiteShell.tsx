import Link from "next/link";

const SITE_REPO = "https://github.com/jacobemerick/backcountry-water-oracle-site";

/**
 * Direction B has two verbs, not four routes: look something up, and add what
 * you saw. Method is a quiet third, because it is what makes the other two
 * trustworthy but is not a thing you come here to do.
 *
 * `/forecast` is deliberately absent — an every-source table invites exactly the
 * comparison the data cannot support, since most sources sit under the verdict
 * floor. It is being retired outright.
 *
 * These three targets are the reason the shell exists. /method now points at a
 * real route; home becomes the lookup in the ticket after this one, and when it
 * does it is one href in one file rather than a hunt through four pages that
 * had each drifted.
 */
const NAV = [
  { href: "/sources", label: "Look up a source" },
  { href: "/sources#add", label: "Add what you saw" },
] as const;

const METHOD_HREF = "/method";

/**
 * The collar of the sheet.
 *
 * A 7.5-minute quad carries its administrative matter in the margin: the name of
 * the sheet on one side, where you are and what edition it is on the other. That
 * is what this is. Four pages used to hand-roll a header here and all four had
 * drifted — different secondary links, different wrappers — which is cosmetic
 * right up until the drift is about which route the site wants you in.
 *
 * `context` is the right-hand slot: a back-link, a quad name, whatever the route
 * knows and the shell cannot.
 */
export function SiteShell({
  children,
  context,
}: {
  children: React.ReactNode;
  context?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 sm:px-8">
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pt-6 pb-2">
          <Link
            href="/"
            className="collar-label text-foreground transition-colors hover:text-accent"
            style={{ "--collar-size": "0.75rem" } as React.CSSProperties}
          >
            <span aria-hidden="true">◇</span> Backcountry Water Oracle
          </Link>
          {context ? <div className="collar-label text-muted">{context}</div> : null}
        </div>

        {/* The collar rule. Contour brown rather than border grey, because on a
            quad the line that closes the margin is drawn in the terrain ink. */}
        <div className="h-px w-full bg-contour/50" />

        <nav className="flex flex-wrap items-baseline gap-x-5 gap-y-2 py-3 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-foreground transition-colors hover:text-accent"
            >
              {item.label}
            </Link>
          ))}
          <Link
            href={METHOD_HREF}
            className="ml-auto text-muted transition-colors hover:text-accent"
          >
            Method
          </Link>
        </nav>

        <div className="h-px w-full bg-border" />
      </header>

      <main className="flex-1 pb-16">{children}</main>

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
        <p className="mt-2">
          Built for hikers who have walked a long way to a dry spring.{" "}
          <a
            href={SITE_REPO}
            className="underline decoration-border underline-offset-4 hover:text-accent"
          >
            Source on GitHub
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
