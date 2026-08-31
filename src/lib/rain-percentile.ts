import type { DailySeries } from "./precip.ts";
import { seriesEnd } from "./precip.ts";

/**
 * Antecedent rainfall at a coordinate, ranked against that coordinate's own
 * history for the same time of year.
 *
 * This is what can be said honestly about a place nobody has ever reported on.
 * It is emphatically **not** a flow verdict: it describes weather, not water.
 * A spring fed by deep groundwater can run through a record-dry autumn and a
 * runoff channel can be bone dry a fortnight after a wet one. The engine
 * exists precisely because the link between the two is a per-source empirical
 * question, and at n = 0 there is no answer to that question — only this.
 *
 * ## Computed here, in one language
 *
 * Engine issue #8 would compute this in Python. It must not also compute it
 * here: Node's `Math.round` goes away from zero, Python's `round` goes to even,
 * and a percentile is exactly the kind of boundary where that surfaces as a
 * number the user watches change for no reason. The site owns this arithmetic;
 * if the engine ever ships its own, this module is deleted the same day.
 */

/**
 * The antecedent window.
 *
 * Sixty days is the engine's own middle window — long enough that a single
 * thunderstorm does not dominate, short enough to still describe this season
 * rather than this year.
 */
export const WINDOW_DAYS = 60;

/**
 * Below this many comparison years the ranking is not worth stating. ERA5 from
 * 2007 gives about nineteen, so this only bites on a series that failed to load
 * or a coordinate the archive does not cover.
 */
export const MIN_COMPARISON_YEARS = 10;

export type RainPercentile = {
  /** Inches over the window ending on `asOf`. */
  total: number;
  /** Mid-rank position among prior years over the same calendar window: years
      drier, plus half the years tied, as a percentage. */
  percentile: number;
  /** Years compared, excluding the one being ranked. */
  years: number;
  /** Last day the window covers — the archive's end, not necessarily today. */
  asOf: string;
  windowDays: number;
  /** Driest and wettest the same window has been, for scale. */
  driest: number;
  wettest: number;
};

function dayIndex(series: DailySeries, iso: string): number {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${series.start}T00:00:00Z`)) / 86_400_000,
  );
}

/** Total over the `WINDOW_DAYS` ending on `endIso`, or null if not fully covered. */
function windowTotal(series: DailySeries, endIso: string, windowDays: number): number | null {
  const end = dayIndex(series, endIso);
  const start = end - windowDays + 1;
  if (start < 0 || end >= series.values.length) return null;

  let sum = 0;
  for (let i = start; i <= end; i++) {
    const v = series.values[i];
    // A gap in the archive is not a dry day. Refuse the window rather than
    // report a drought that is actually a missing row.
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum;
}

/**
 * Rank the window ending on `asOf` against the same calendar window in every
 * earlier year the series covers.
 *
 * Same calendar window, not a rolling one: "wetter than usual" only means
 * anything against the same time of year, and in the Southwest, where the
 * monsoon dominates the annual total, comparing late August against a
 * year-round distribution would say almost nothing.
 *
 * Percentile is a mid-rank against those years — years drier plus half the
 * years tied — so 12 means "drier than most of the record" and 0 means "drier
 * than every year since 2007". The current year is excluded from its own
 * comparison set. See the tie note below for why halves rather than a strict
 * count.
 */
export function rankAntecedentRain(
  series: DailySeries,
  asOf?: string,
  windowDays = WINDOW_DAYS,
): RainPercentile | null {
  // The archive trails reality by about a week (PRECIP_LAG_DAYS), so the window
  // ends where the data ends. Saying "through the 24th" is honest; silently
  // treating six missing days as zero rain is not.
  const end = asOf && asOf < seriesEnd(series) ? asOf : seriesEnd(series);
  const total = windowTotal(series, end, windowDays);
  if (total === null) return null;

  const thisYear = Number(end.slice(0, 4));
  const startYear = Number(series.start.slice(0, 4));
  const comparisons: number[] = [];

  for (let year = startYear; year < thisYear; year++) {
    // Same month and day, in an earlier year. A window ending 29 February
    // simply has no counterpart in most years and is skipped, which costs one
    // comparison out of nineteen.
    const sameDay = `${year}${end.slice(4)}`;
    if (dayIndex(series, sameDay) < 0) continue;
    const t = windowTotal(series, sameDay, windowDays);
    if (t !== null) comparisons.push(t);
  }

  if (comparisons.length < MIN_COMPARISON_YEARS) return null;

  /*
   * Mid-rank, not a strict "how many were drier".
   *
   * Ties are not an edge case here. This is the interior Southwest: a 60-day
   * window that caught no rain at all is an ordinary year in much of it, and
   * with a strict comparison every one of those years ranks at the 0th
   * percentile — "much drier than usual" — when the truth is that it is tied
   * with half the record. Counting ties as half a year each puts an entirely
   * typical dry spell at the middle of the distribution, where it belongs.
   */
  const drier = comparisons.filter((t) => t < total).length;
  const tied = comparisons.filter((t) => t === total).length;
  return {
    total,
    percentile: Math.round(((drier + tied / 2) / comparisons.length) * 100),
    years: comparisons.length,
    asOf: end,
    windowDays,
    driest: Math.min(...comparisons),
    wettest: Math.max(...comparisons),
  };
}

/** The season a window ending on this date describes, in the words people use. */
export function seasonOf(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const part = day <= 10 ? "early" : day <= 20 ? "mid" : "late";
  return `${part} ${names[month - 1]}`;
}

/**
 * The band, for a page that must not read as a verdict.
 *
 * Deliberately coarse. A percentile is a rank over nineteen values, so 34th and
 * 41st are the same statement, and rendering the difference would invite a
 * precision the number does not have.
 */
export type RainBand = "much drier" | "drier" | "typical" | "wetter" | "much wetter";

export function bandOf(p: RainPercentile): RainBand {
  if (p.percentile <= 15) return "much drier";
  if (p.percentile <= 35) return "drier";
  if (p.percentile < 65) return "typical";
  if (p.percentile < 85) return "wetter";
  return "much wetter";
}

const BAND_COPY: Record<RainBand, string> = {
  "much drier": "much drier than usual",
  drier: "drier than usual",
  typical: "about usual",
  wetter: "wetter than usual",
  "much wetter": "much wetter than usual",
};

export const RAIN_COPY = {
  /** The headline. Weather, stated as weather. */
  summary(p: RainPercentile): string {
    return (
      `The last ${p.windowDays} days here have been ${BAND_COPY[bandOf(p)]} for ` +
      `${seasonOf(p.asOf)} — ${ordinal(p.percentile)} percentile against ${p.years} years ` +
      `of rainfall at this coordinate, through ${p.asOf}.`
    );
  },

  /**
   * The disclaimer, and it is not boilerplate: this block is the only number on
   * a page that has no reports, which makes it the thing most likely to be read
   * as the answer. It has to say what it is not.
   */
  caveat:
    "This is rainfall, not water. It says what the weather has done here, not what is in the ground — a spring fed from deep water can run through a dry autumn, and a runoff channel can be empty two weeks after a wet one. Which of those this is takes reports to find out.",
} as const;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
