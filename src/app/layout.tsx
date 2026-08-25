import type { Metadata } from "next";
import { Archivo_Narrow, IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import "./globals.css";

/**
 * The Quad type system. Four roles, four faces — which face does which job is
 * the whole design, so the role rules are enforced in `globals.css` by the
 * `.collar-label` / `.headline` / `.value` / `.hydro-*` classes rather than
 * left to whoever writes the next component.
 *
 * Headlines are set in Plex Sans 700 rather than Archivo 700. The design called
 * for Archivo, but a fifth family is a whole extra download to distinguish caps
 * that sit two steps apart in the hierarchy from the body face they're already
 * paired with. Dropped on purpose; the mockups' Archivo can come back if the
 * squarer caps turn out to matter at 2.9rem.
 */

/**
 * Collar labels only — block headings, collar keys, stamps. Pinned to a single
 * weight rather than the variable axis, which costs less to download and, more
 * usefully, makes the "600 and nothing else" rule mechanical: there is no other
 * weight of this face to reach for.
 */
const collar = Archivo_Narrow({
  weight: "600",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-collar-face",
  fallback: ["Arial Narrow", "ui-sans-serif", "system-ui", "sans-serif"],
});

/** Body, UI, and headlines. Variable: one file covers body 400 and headline 700. */
const sans = IBM_Plex_Sans({
  weight: "variable",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-sans",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

/**
 * Every number on the site. Plex Mono has no variable cut on Google Fonts, so
 * the weights are enumerated: 400 for incidental mono, 500 for values.
 */
const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-plex-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

/**
 * Hydrography — source names, everywhere they appear. Italic only, since they
 * are never set upright.
 *
 * Requested as the variable cut so the weight axis stays continuous: dark mode
 * steps hydrography up exactly one notch (display 500 to 600, inline 600 to
 * 700), and a static instance would snap instead of interpolate. Note that this
 * Next takes `weight: "variable"` — the `"400 700"` range string the font docs
 * show is rejected by both the types and the loader.
 *
 * The predecessor here was Bodoni Moda italic, which was beautiful in light and
 * illegible in dark. A didone's identity *is* its thick/thin contrast and an
 * inverted ground attacks precisely that. Source Serif 4 is a drawn italic with
 * modest contrast that holds on either ground, which is why the weight step
 * above can afford to be so small.
 */
const hydro = Source_Serif_4({
  weight: "variable",
  style: "italic",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hydro-face",
  fallback: ["Georgia", "ui-serif", "serif"],
});

const DESCRIPTION =
  "Will that seep be running? We correlate a backcountry water source's " +
  "historical field reports against nearly two decades of daily precipitation " +
  "for its exact coordinates, and give you a read on whether it's likely to " +
  "have water.";

export const metadata: Metadata = {
  metadataBase: new URL("https://backcountrywateroracle.com"),
  title: {
    default: "Backcountry Water Oracle",
    template: "%s · Backcountry Water Oracle",
  },
  description: DESCRIPTION,
  openGraph: {
    title: "Backcountry Water Oracle",
    description: DESCRIPTION,
    url: "/",
    siteName: "Backcountry Water Oracle",
    type: "website",
  },
  twitter: { card: "summary", title: "Backcountry Water Oracle", description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} ${collar.variable} ${hydro.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
