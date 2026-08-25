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

export type WaterSheet = {
  /** Google Sheets document id — the stable key. */
  id: string;
  /** Our slug, for logs and README prose. Never the storage key. */
  slug: string;
  /** Expected title, used only to flag a surprise. Never trusted as the label. */
  expectTitle: string;
  /**
   * One-shot captures are fetched too, but they are unmaintained upstream, so a
   * run that finds them unchanged forever is working correctly.
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
export const WATER_SHEETS: readonly WaterSheet[] = [
  {
    id: "1gEyz3bw__aPvNXpqqHcs7KRwmwYrTH2L0DEMW3RbHes",
    slug: "pct-part-one-campo-to-idyllwild",
    expectTitle: "Part One: Campo to Idyllwild",
  },
  {
    id: "150zc_EiTZiiQTLXDogsICTRWtj1UF2Rp4hycYntHHfI",
    slug: "pct-part-two-idyllwild-to-agua-dulce",
    expectTitle: "Part Two: Idyllwild to Agua Dulce",
  },
  {
    id: "1LcPeF9tEZ83YHm4-0K8QsH8bUc785h8nqQuTDQbzPJI",
    slug: "pct-part-three-agua-dulce-to-cottonwood",
    expectTitle: "Part Three: Agua Dulce to Cottonwood Pass",
  },
  {
    id: "1Tk7yDPd9JWAm7sbbad9idZxcDJlv7ilMz6qZa6pal8w",
    slug: "pct-northern-california",
    expectTitle: "Northern California",
  },
  {
    id: "1XxD94O2HwyTCvehX5ZiYJkLNK53Xw-S1Z7ATHyYDfr8",
    slug: "pct-oregon",
    expectTitle: "Oregon",
  },
  {
    id: "1LJAdNkL2EXwIiRnOfZe1jYptEgWzJlc5N_tyGQfS258",
    slug: "pct-washington",
    expectTitle: "Washington",
  },
  {
    id: "1lqdNvriapux8sB90ufG4oYyxMJTisg3vB3ra2WUIrIw",
    slug: "pct-snow-and-ford",
    expectTitle: "Snow & Ford Report",
  },
  {
    // cdtwaterreport.org now serves the FarOut bundle; this 2019 sheet is an
    // unmaintained orphan. Worth one capture, not a pipeline.
    id: "1xXhkxoCDn06hjcc17z2xoGi-7FaIc-muCcv9ZEp5xI4",
    slug: "cdt-2019-orphan",
    expectTitle: "CDT Water Report",
    oneShot: true,
  },
] as const;

/** Google's keyless CSV export. No API key, no OAuth, no scraping. */
export function sheetCsvUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
}

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
