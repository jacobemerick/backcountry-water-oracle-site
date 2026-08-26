import { PRECIP_RECORD_START, isRubricScore } from "./rubric.ts";

/**
 * Parsing and validating a CSV of field observations for bulk import.
 *
 * The format is the engine's own contract, which is also `db/seed/*.csv` and
 * also the `sources` + `reports` join:
 *
 *     source,lat,lon,date,score,status
 *
 * A new format would need the translation layer 0001 deliberately avoids, so
 * this reads that one, with two optional additions: `lat`/`lon` may be blank
 * when the name can be resolved against the gazetteer, and `gnis_id` may be
 * given to settle a name that resolves to more than one feature.
 *
 * Pure, so every refusal is testable without a database. The I/O and the
 * gazetteer lookup live in `scripts/import-reports.mjs`.
 */

export type ImportRow = {
  source: string;
  lat: number | null;
  lon: number | null;
  observedOn: string;
  score: number;
  status: string | null;
  gnisId: string | null;
};

export type ImportDropReason =
  | "no-source-name"
  | "unparseable-date"
  | "impossible-date"
  | "before-precip-record"
  | "future-date"
  | "score-not-on-rubric"
  | "partial-coordinate"
  | "coordinate-out-of-range";

export type ImportResult = {
  rows: ImportRow[];
  drops: Record<ImportDropReason, number>;
  /** Fatal, not counted: these mean the file is wrong, not that a row is bad. */
  errors: string[];
};

const DROP_REASONS: ImportDropReason[] = [
  "no-source-name",
  "unparseable-date",
  "impossible-date",
  "before-precip-record",
  "future-date",
  "score-not-on-rubric",
  "partial-coordinate",
  "coordinate-out-of-range",
];

function emptyDrops(): Record<ImportDropReason, number> {
  return Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<ImportDropReason, number>;
}

/** RFC4180-ish, matching scripts/seed.mjs: quoted fields may hold commas and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * `YYYY-MM-DD`, and it must be the date it claims to be.
 *
 * `new Date("2026-02-31")` does not throw -- it yields March 3rd. #68 learned
 * this the hard way, and a date silently moved by three days is correlated
 * against three days of the wrong rainfall.
 */
export function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param today ISO date used as the future-date boundary. Passed in rather than
 *   read from the clock so the same file parses the same way in a test, and so
 *   the caller decides what "today" means.
 */
export function parseReportCsv(text: string, today: string): ImportResult {
  const drops = emptyDrops();
  const errors: string[] = [];
  const rows: ImportRow[] = [];

  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (table.length === 0) return { rows, drops, errors: ["file is empty"] };

  // By name, never by position -- #68's lesson, and this file is hand-authored,
  // which is exactly where a column gets inserted without warning.
  const header = table[0].map((h) => h.trim().toLowerCase());
  const need = ["source", "date", "score"];
  for (const col of need) {
    if (!header.includes(col)) errors.push(`missing required column: ${col}`);
  }
  if (errors.length) return { rows, drops, errors };

  const idx = (key: string) => header.indexOf(key);
  const cell = (r: string[], key: string) => {
    const i = idx(key);
    return i === -1 ? "" : (r[i] ?? "").trim();
  };

  for (let i = 1; i < table.length; i++) {
    const r = table[i];

    const source = cell(r, "source");
    if (!source) {
      drops["no-source-name"]++;
      continue;
    }

    const date = cell(r, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      drops["unparseable-date"]++;
      continue;
    }
    if (!isRealDate(date)) {
      drops["impossible-date"]++;
      continue;
    }
    // Nothing to correlate against: every headline number is a correlation
    // with antecedent rain, and the archive starts here.
    if (date < PRECIP_RECORD_START) {
      drops["before-precip-record"]++;
      continue;
    }
    if (date > today) {
      drops["future-date"]++;
      continue;
    }

    const score = Number(cell(r, "score"));
    // On an anchor, not merely inside 0..1. The rubric is the interface between
    // what a hiker saw and what the model reads; a 0.35 was never observed by
    // anyone and cannot be mapped back to rubric language.
    if (!Number.isFinite(score) || !isRubricScore(score)) {
      drops["score-not-on-rubric"]++;
      continue;
    }

    const latRaw = cell(r, "lat");
    const lonRaw = cell(r, "lon");
    let lat: number | null = null;
    let lon: number | null = null;
    if (latRaw !== "" || lonRaw !== "") {
      // One without the other is a typo, not a coordinate. Resolving the name
      // instead would silently discard whichever half was given.
      if (latRaw === "" || lonRaw === "") {
        drops["partial-coordinate"]++;
        continue;
      }
      lat = Number(latRaw);
      lon = Number(lonRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        drops["coordinate-out-of-range"]++;
        continue;
      }
    }

    const status = cell(r, "status");
    rows.push({
      source,
      lat,
      lon,
      observedOn: date,
      score,
      status: status || null,
      gnisId: cell(r, "gnis_id") || null,
    });
  }

  return { rows, drops, errors };
}

export type ResolvedSource = {
  name: string;
  slug: string;
  lat: number | null;
  lon: number | null;
  gnisId: string | null;
  reports: number;
};

/**
 * Collapse rows to one entry per source name, and refuse a file that describes
 * one name two ways.
 *
 * This is engine issue #9 defended at the door: the engine groups reports by
 * source NAME and silently adopts the first row's coordinates for all of them.
 * Two different "Bear Spring"s in one file is not a bad row to drop, it is a
 * corrupted correlation to refuse -- so it lands in `errors`, which is fatal,
 * rather than in `drops`, which is a count.
 */
export function collectSources(rows: ImportRow[]): { sources: ResolvedSource[]; errors: string[] } {
  const byName = new Map<string, ResolvedSource>();
  const errors: string[] = [];

  for (const r of rows) {
    const existing = byName.get(r.source);
    if (!existing) {
      byName.set(r.source, {
        name: r.source,
        slug: slugify(r.source),
        lat: r.lat,
        lon: r.lon,
        gnisId: r.gnisId,
        reports: 1,
      });
      continue;
    }
    existing.reports++;
    if (existing.lat === null && r.lat !== null) {
      existing.lat = r.lat;
      existing.lon = r.lon;
    } else if (r.lat !== null && existing.lat !== null &&
               (Math.abs(existing.lat - r.lat) > 1e-6 || Math.abs((existing.lon ?? 0) - (r.lon ?? 0)) > 1e-6)) {
      errors.push(
        `"${r.source}" is given two different coordinates ` +
          `(${existing.lat},${existing.lon} and ${r.lat},${r.lon}). ` +
          `The engine fuses sources by name — rename one, or they will be correlated as one spring.`,
      );
    }
    existing.gnisId ??= r.gnisId;
  }

  // Two names that differ only in punctuation or case collide as one slug, and
  // the slug is the URL and the uniqueness key.
  const bySlug = new Map<string, string>();
  for (const s of byName.values()) {
    const clash = bySlug.get(s.slug);
    if (clash && clash !== s.name) {
      errors.push(`"${s.name}" and "${clash}" both slugify to "${s.slug}".`);
    }
    bySlug.set(s.slug, s.name);
  }

  // The mirror of the check above, and it was missing until real data walked
  // into it: one name with two coordinates was refused, but several names at
  // one coordinate were not. A coordinate repeated to six decimal places --
  // roughly a tenth of a metre -- across different sources is a paste, not a
  // survey, and it is the more dangerous direction. A missing coordinate costs
  // one report; a wrong one correlates a whole source against rain that fell
  // somewhere else, distorts the pooling neighbourhood, and nothing downstream
  // ever shows it (#66).
  const byPoint = new Map<string, string[]>();
  for (const s of byName.values()) {
    if (s.lat === null) continue;
    const key = `${s.lat},${s.lon}`;
    byPoint.set(key, [...(byPoint.get(key) ?? []), s.name]);
  }
  for (const [point, names] of byPoint) {
    if (names.length > 1) {
      errors.push(
        `${names.length} sources share the exact coordinate ${point}: ${names.join(", ")}. ` +
          `Identical to six decimals is a copy-paste, not a measurement — give each its own.`,
      );
    }
  }

  return { sources: [...byName.values()], errors };
}
