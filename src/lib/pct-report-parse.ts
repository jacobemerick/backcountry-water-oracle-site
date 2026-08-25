import { PRECIP_RECORD_START } from "./rubric.ts";

/**
 * Parsing the PCT Water Report sheets into dated observations.
 *
 * Structural extraction only, and no model required: the report cells are
 * rigidly formatted stacks of `MM/DD/YY (Reporter): free text`, which is a
 * regex. Turning that free text into a 0–1 rubric score is the one step that
 * genuinely needs a model, and it is deliberately not done here — this module
 * hands back the text and lets the scoring seam decide.
 *
 * Nothing here writes anywhere. It reads archived bytes and returns structure,
 * so it can be run, reviewed and argued about long before anything is imported.
 */

export type WaterReportEntry = {
  /** Cumulative trail mile, from the sheet's own Mile column. */
  mile: number;
  /** Halfmile and official ids from the Waypoint cell, e.g. ["WR001", "PCTAID_1"]. */
  waypoints: string[];
  location: string;
  /** ISO date. Every entry has one; undated text is dropped, never guessed. */
  observedOn: string;
  reporter: string | null;
  /** Verbatim. Scoring this is a separate, model-shaped problem. */
  text: string;
};

export type DropReason =
  | "no-date"
  | "unparseable-date"
  | "future"
  | "before-precip-record"
  | "no-mile"
  | "empty-text";

export type ParseResult = {
  entries: WaterReportEntry[];
  /** Every row and entry that did not survive, and why. Counted, not silent. */
  dropped: Record<DropReason, number>;
  /** Rows that looked like data but had no report cell content at all. */
  rowsScanned: number;
};

const EMPTY_DROPS = (): Record<DropReason, number> => ({
  "no-date": 0,
  "unparseable-date": 0,
  future: 0,
  "before-precip-record": 0,
  "no-mile": 0,
  "empty-text": 0,
});

/**
 * RFC 4180 with the one feature that matters here: a quoted field may contain
 * newlines, and the report cells always do — a stack of a dozen dated entries
 * lives inside a single cell.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Locate the header and map its columns by name.
 *
 * By name rather than position, because the sheets do not agree: the header sits
 * on row 6 in some and row 7 in others, and the Snow & Ford Report puts
 * Elevation where the water sheets put Waypoint. Reading column 2 blind would
 * silently file elevations as waypoint ids.
 */
export function findColumns(rows: string[][]): Record<string, number> | null {
  for (const row of rows.slice(0, 20)) {
    const idx: Record<string, number> = {};
    row.forEach((cell, i) => {
      const key = cell.trim().toLowerCase();
      if (key) idx[key] = i;
    });
    if ("mile" in idx && "report" in idx && "location" in idx) return idx;
  }
  return null;
}

/**
 * Resolve a two-digit year against the sheet's own update date.
 *
 * `03/15/26` is 2026 because the sheet says it was updated in 2026. The naive
 * `2000 + yy` is right for every value these sheets actually carry, but a typo
 * or a stray row can produce a date after the sheet was written, which cannot
 * be an observation — and a future date fed to the engine would be correlated
 * against rainfall that has not happened.
 */
export function resolveYear(
  month: number,
  day: number,
  yy: number,
  sheetDate: string,
): string | null {
  const year = 2000 + yy;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Reject impossible calendar dates: 02/31 is a typo, not a leap-year subtlety.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) {
    return null;
  }
  return iso > sheetDate ? null : iso;
}

/** `MM/DD/YY (Reporter): text` — the boundary between stacked entries. */
const ENTRY_HEAD = /(\d{1,2})\/(\d{1,2})\/(\d{2})\s*\(([^)]*)\)\s*:?/g;

/**
 * Split one report cell into its stacked entries.
 *
 * Splits on the date-and-reporter head rather than on newlines, because an
 * entry's free text routinely wraps across several lines and splitting on "\n"
 * would shred one observation into several fragments with no date.
 */
export function splitEntries(cell: string): { m: number; d: number; yy: number; who: string; text: string }[] {
  const out: { m: number; d: number; yy: number; who: string; text: string }[] = [];
  const heads = [...cell.matchAll(ENTRY_HEAD)];
  heads.forEach((head, i) => {
    const start = head.index! + head[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : cell.length;
    out.push({
      m: Number(head[1]),
      d: Number(head[2]),
      yy: Number(head[3]),
      who: head[4].trim(),
      text: cell.slice(start, end).trim(),
    });
  });
  return out;
}

/** Halfmile and official ids share a cell, one per line: "WR001\nPCTAID_1". */
function parseWaypoints(cell: string): string[] {
  return cell
    .split(/[\n,]/)
    .map((w) => w.trim())
    .filter((w) => /^[A-Za-z][\w-]*$/.test(w));
}

/**
 * Parse one sheet.
 *
 * `sheetDate` is the sheet's own "Updated MM/DD/YYYY" line, as ISO — the
 * stewards' statement of when this edition was written, which is what a
 * two-digit year has to be resolved against.
 */
export function parseWaterReport(csv: string, sheetDate: string): ParseResult {
  const rows = parseCsv(csv);
  const cols = findColumns(rows);
  const dropped = EMPTY_DROPS();
  if (!cols) return { entries: [], dropped, rowsScanned: 0 };

  const entries: WaterReportEntry[] = [];
  let rowsScanned = 0;

  for (const row of rows) {
    const cell = (i: number | undefined) => (i === undefined ? "" : (row[i] ?? ""));
    const rawMile = cell(cols["mile"]).trim();
    const report = cell(cols["report"]);
    if (!report.trim()) continue;

    // "~112.3" — the sheets mark approximate mileage. The tilde is a statement
    // about precision we cannot act on, so it is dropped and the number kept.
    const mile = Number(rawMile.replace(/^~/, "").replace(/,/g, ""));
    if (!Number.isFinite(mile)) { dropped["no-mile"]++; continue; }

    rowsScanned++;
    const location = cell(cols["location"]).replace(/\s+/g, " ").trim();
    const waypoints = parseWaypoints(cell(cols["waypoint"]));

    const stacked = splitEntries(report);
    if (stacked.length === 0) { dropped["no-date"]++; continue; }

    for (const s of stacked) {
      const iso = resolveYear(s.m, s.d, s.yy, sheetDate);
      if (iso === null) {
        // Distinguish a nonsense calendar date from a real one that is simply
        // after the sheet was written: they are different upstream problems.
        const plausible = s.m >= 1 && s.m <= 12 && s.d >= 1 && s.d <= 31;
        dropped[plausible ? "future" : "unparseable-date"]++;
        continue;
      }
      if (iso < PRECIP_RECORD_START) { dropped["before-precip-record"]++; continue; }
      if (!s.text) { dropped["empty-text"]++; continue; }

      entries.push({
        mile,
        waypoints,
        location,
        observedOn: iso,
        reporter: s.who || null,
        text: s.text,
      });
    }
  }

  return { entries, dropped, rowsScanned };
}

/** `Updated 06/27/2026 @ 5:46 pm  by Druid` -> `2026-06-27`. */
export function sheetDateFrom(updatedLine: string | null): string | null {
  if (!updatedLine) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(updatedLine);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const iso = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}
