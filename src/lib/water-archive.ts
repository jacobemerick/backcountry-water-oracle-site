/**
 * The public water-report sheets we mirror, and the pure logic for doing it.
 *
 * Archiving only. Parsing these into `sources`/`reports` is a separate job that
 * is gated on a permission conversation with the stewards: the PCT Water Report
 * carries no licence grant, only a warranty disclaimer. Mirroring a public sheet
 * to prevent data loss is a much lower-risk act than republishing it, and it
 * should not wait on that conversation — roughly 1,500 dated observations age
 * out of these sheets every year and the Wayback Machine has never captured one.
 *
 * Everything here is pure and side-effect free so it can be tested without a
 * network or a database. The fetching and writing live in the cron route.
 */

export type ArchiveTarget = {
  /** Stable key. A sheet document id, or `wayback:<timestamp>:<slug>`. */
  id: string;
  /** Our slug, for logs and README prose. Never the storage key. */
  slug: string;
  /** Fully-resolved fetch URL. */
  url: string;
  format: "csv" | "pdf";
  /** Expected title, used only to flag a surprise. Never trusted as the label. */
  expectTitle: string;
  /**
   * Upstream can never change: a Wayback capture is a fixed snapshot at a fixed
   * timestamp. Once held, it is never fetched again — the bytes cannot differ,
   * and re-asking the Internet Archive weekly for something we already have is
   * rude for no benefit.
   */
  immutable?: boolean;
  /**
   * Provenance for artifacts whose bytes cannot state their own. A CSV carries
   * an "Updated ... by <steward>" line; a PDF we cannot parse in this runtime
   * does not, so the archived URL and capture time say where it came from.
   */
  provenance?: string;
  /**
   * Unmaintained upstream. Fetched anyway, but a run that finds it unchanged
   * forever is working correctly.
   */
  oneShot?: boolean;
};

/**
 * Keyed on document id, with titles verified against a live fetch on
 * 2026-08-25 rather than copied from the issue that specified this job.
 *
 * That verification mattered: three of the seven ids were mislabelled there, in
 * a three-way rotation — the id given as "Part Two: Idyllwild to Agua Dulce" is
 * Oregon, the one given as "Oregon" is the Snow & Ford Report, and the one given
 * as "Snow & Ford" is Part Two. Nothing was missing or duplicated, only
 * misfiled. For an archive whose whole premise is that the stored bytes are
 * ground truth, inheriting that would have been unfixable later.
 */
/** Google's keyless CSV export. No API key, no OAuth, no scraping. */
export function sheetCsvUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

const PCT_AND_CDT: readonly ArchiveTarget[] = [
  {
    id: "1gEyz3bw__aPvNXpqqHcs7KRwmwYrTH2L0DEMW3RbHes",
    slug: "pct-part-one-campo-to-idyllwild",
    url: sheetCsvUrl("1gEyz3bw__aPvNXpqqHcs7KRwmwYrTH2L0DEMW3RbHes"),
    format: "csv",
    expectTitle: "Part One: Campo to Idyllwild",
  },
  {
    id: "150zc_EiTZiiQTLXDogsICTRWtj1UF2Rp4hycYntHHfI",
    slug: "pct-part-two-idyllwild-to-agua-dulce",
    url: sheetCsvUrl("150zc_EiTZiiQTLXDogsICTRWtj1UF2Rp4hycYntHHfI"),
    format: "csv",
    expectTitle: "Part Two: Idyllwild to Agua Dulce",
  },
  {
    id: "1LcPeF9tEZ83YHm4-0K8QsH8bUc785h8nqQuTDQbzPJI",
    slug: "pct-part-three-agua-dulce-to-cottonwood",
    url: sheetCsvUrl("1LcPeF9tEZ83YHm4-0K8QsH8bUc785h8nqQuTDQbzPJI"),
    format: "csv",
    expectTitle: "Part Three: Agua Dulce to Cottonwood Pass",
  },
  {
    id: "1Tk7yDPd9JWAm7sbbad9idZxcDJlv7ilMz6qZa6pal8w",
    slug: "pct-northern-california",
    url: sheetCsvUrl("1Tk7yDPd9JWAm7sbbad9idZxcDJlv7ilMz6qZa6pal8w"),
    format: "csv",
    expectTitle: "Northern California",
  },
  {
    id: "1XxD94O2HwyTCvehX5ZiYJkLNK53Xw-S1Z7ATHyYDfr8",
    slug: "pct-oregon",
    url: sheetCsvUrl("1XxD94O2HwyTCvehX5ZiYJkLNK53Xw-S1Z7ATHyYDfr8"),
    format: "csv",
    expectTitle: "Oregon",
  },
  {
    id: "1LJAdNkL2EXwIiRnOfZe1jYptEgWzJlc5N_tyGQfS258",
    slug: "pct-washington",
    url: sheetCsvUrl("1LJAdNkL2EXwIiRnOfZe1jYptEgWzJlc5N_tyGQfS258"),
    format: "csv",
    expectTitle: "Washington",
  },
  {
    id: "1lqdNvriapux8sB90ufG4oYyxMJTisg3vB3ra2WUIrIw",
    slug: "pct-snow-and-ford",
    url: sheetCsvUrl("1lqdNvriapux8sB90ufG4oYyxMJTisg3vB3ra2WUIrIw"),
    format: "csv",
    expectTitle: "Snow & Ford Report",
  },
  {
    // cdtwaterreport.org now serves the FarOut bundle; this 2019 sheet is an
    // unmaintained orphan. Worth one capture, not a pipeline.
    id: "1xXhkxoCDn06hjcc17z2xoGi-7FaIc-muCcv9ZEp5xI4",
    slug: "cdt-2019-orphan",
    url: sheetCsvUrl("1xXhkxoCDn06hjcc17z2xoGi-7FaIc-muCcv9ZEp5xI4"),
    format: "csv",
    expectTitle: "CDT Water Report",
    oneShot: true,
  },
] as const;

/**
 * The Arizona Trail water report, recovered from the Internet Archive.
 *
 * The ATA's live report redirects into FarOut now, and that is closed — a paid
 * product with no public API. But the ATA published its own `AZT_WaterSources.pdf`
 * for years, and unlike a Google Sheet an ordinary web page is archived. Five
 * distinct editions survive, 2016-04-18 to 2018-02-05, together holding 578
 * distinct (location, date) observations across all 43 passages, with report
 * dates reaching back to 2009.
 *
 * Their columns are close to our contract already — location, type, a 0–4
 * reliability scale, free-text report, date, and reporter — which is the same
 * shape the PCT sheets need parsing into. Geolocation is the work: one row in
 * the whole document carries decimal coordinates, the rest are passage + mile.
 *
 * Captured here so the archive does not depend on the Internet Archive staying
 * reachable. As with everything else in this module: preservation only, and
 * republishing needs the permission conversation first. The document names its
 * compiler and prints a contact address.
 */
const AZT_WAYBACK_CAPTURES: readonly { ts: string; path: string }[] = [
  { ts: "20160418174702", path: "http://www.aztrail.org/AZT_WaterSources.pdf" },
  { ts: "20160910122137", path: "http://www.aztrail.org/watersources/AZT_WaterSources.pdf" },
  { ts: "20170329002451", path: "http://www.aztrail.org/watersources/AZT_WaterSources.pdf" },
  { ts: "20170519160847", path: "http://www.aztrail.org/watersources/AZT_WaterSources.pdf" },
  { ts: "20180205035808", path: "http://www.aztrail.org/watersources/AZT_WaterSources.pdf" },
];

/** `id_` asks the Wayback Machine for the original bytes, without its banner. */
export function waybackUrl(ts: string, original: string): string {
  return `https://web.archive.org/web/${ts}id_/${original}`;
}

/** `20160418174702` -> `2016-04-18T17:47:02Z`. */
export function waybackTimestampToIso(ts: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) throw new Error(`Not a Wayback timestamp: ${ts}`);
  const [, y, mo, d, h, mi, sec] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`;
}

const AZT_TARGETS: readonly ArchiveTarget[] = AZT_WAYBACK_CAPTURES.map(({ ts, path }) => ({
  id: `wayback:${ts}:azt-water-sources`,
  slug: `azt-water-sources-${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
  url: waybackUrl(ts, path),
  format: "pdf" as const,
  expectTitle: "Water Sources on the Arizona Trail by Passages",
  immutable: true,
  provenance: `Wayback capture ${waybackTimestampToIso(ts)} of ${path}`,
}));

/** Everything the archive job fetches. */
export const ARCHIVE_TARGETS: readonly ArchiveTarget[] = [...PCT_AND_CDT, ...AZT_TARGETS];

/**
 * Row 1 of these sheets carries the title and the stewards' own currency line,
 * e.g. `Updated 06/27/2026 @ 5:41 pm     by Druid`.
 *
 * Read from the bytes just fetched, never from our expectations, so the label
 * stored beside a snapshot always describes that snapshot. Deliberately
 * tolerant: this is provenance metadata, and a sheet whose header changes shape
 * must still be archived rather than rejected.
 */
export function parseProvenance(csv: string): { title: string | null; updatedLine: string | null } {
  const firstLine = csv.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.trim()) return { title: null, updatedLine: null };

  const cells = splitCsvLine(firstLine);
  const title = cells.find((c) => c.trim().length > 0)?.trim() ?? null;
  const updated = cells.find((c) => /updated/i.test(c)) ?? null;

  return {
    title: title ? title.replace(/^Pacific Crest Trail\s+/i, "").trim() || null : null,
    // Collapse the run-on whitespace the sheets pad this with.
    updatedLine: updated ? updated.replace(/^[\s/]+/, "").replace(/\s+/g, " ").trim() || null : null,
  };
}

/** Minimal RFC 4180 field split — enough for one header row. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Counts dated entries, for the run summary only.
 *
 * PCT report cells stack rigidly formatted entries: `MM/DD/YY (Reporter): text`.
 * This is a health signal — a sheet that suddenly reports zero has changed shape
 * upstream and wants a look — and explicitly not ingestion. Nothing derived from
 * it is stored against a source.
 */
export function countDatedEntries(csv: string): number {
  return (csv.match(/\b\d{2}\/\d{2}\/\d{2}\s*\(/g) ?? []).length;
}

/** Whether a fetched body is worth storing, given what we already hold. */
export function isNewSnapshot(hash: string, lastHash: string | null): boolean {
  return hash !== lastHash;
}
