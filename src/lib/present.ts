import type { ReadableSource, SourceForecast } from "./forecast.ts";
import { hasRead } from "./forecast.ts";
import { nearestStep } from "./rubric.ts";

/**
 * Presentation helpers — the layer that turns the engine's numbers into
 * something a hiker can act on. Deliberately separate from rendering so the
 * judgement calls here (what counts as too little data, what a correlation
 * means in English) are testable and reviewable in one place.
 */

/**
 * Below this many reports we refuse to show a verdict.
 *
 * The engine will happily correlate two observations and report r=+1.00 with
 * "signal check: survives -> genuine rain response". On a CLI, where the
 * operator knows the data, that is fine. On a public site where someone is
 * deciding how much water to carry into the Sonoran desert in June, a
 * confident number built on four observations is the single most dangerous
 * thing this site could render. The engine's own docs call anything under
 * SMALL_N_THRESHOLD "suggestive, not solid"; this is where we stop showing a
 * verdict at all.
 */
export const MIN_REPORTS_FOR_VERDICT = 10;

/**
 * The engine's own weak-evidence threshold — where it sets `small_n`.
 *
 * This is a *different* number from MIN_REPORTS_FOR_VERDICT and the two must
 * never be collapsed into one sentence. Below the floor we issue no read at
 * all; between the floor and here we issue one and say it is weak. The design
 * mockups merged them into "needs about twenty-five", which described neither
 * behaviour, and this is the number that decides whether somebody is shown a
 * verdict about desert water.
 *
 * Declared here so copy can be generated from it rather than typed. It mirrors
 * the engine and is asserted against real engine output in contract.test.ts.
 */
export const SMALL_N_THRESHOLD = 25;

export type Confidence = "none" | "weak" | "moderate";

export function confidenceOf(s: SourceForecast): Confidence {
  // No read at all from the engine is, a fortiori, not enough data.
  if (!hasRead(s) || s.n < MIN_REPORTS_FOR_VERDICT) return "none";
  if (s.small_n) return "weak"; // engine flags n < SMALL_N_THRESHOLD
  return "moderate";
}

/**
 * The two threshold sentences, generated from the constants.
 *
 * They say genuinely different things and both have to exist. Hand-typing
 * either one is how the numbers drifted apart in the first place, so nothing
 * user-facing should ever contain a threshold literal again.
 */
export const THRESHOLD_COPY = {
  /** Below the floor: no read at all. */
  noRead(n: number): string {
    return (
      `${n} report${n === 1 ? "" : "s"} — a correlation needs at least ` +
      `${MIN_REPORTS_FOR_VERDICT} before it means anything, so no read is issued here.`
    );
  },

  /** Above the floor, under the engine's weak-evidence threshold. */
  weak(n: number): string {
    return (
      `${n} reports is above the ${MIN_REPORTS_FOR_VERDICT} needed for a read, but under ` +
      `${SMALL_N_THRESHOLD} the engine flags the evidence as thin. Treat this as weak — ` +
      `suggestive, not solid.`
    );
  },

  /** What a thin source needs to stop being thin. */
  needed(n: number): string {
    const short = Math.max(0, MIN_REPORTS_FOR_VERDICT - n);
    return short === 0
      ? `This source has enough reports for a read.`
      : `${short} more report${short === 1 ? "" : "s"} would reach the ` +
          `${MIN_REPORTS_FOR_VERDICT} needed for a read.`;
  },
} as const;

/** Never "high" — see MIN_REPORTS_FOR_VERDICT. This model does not earn it. */
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: "Not enough data",
  weak: "Weak confidence",
  moderate: "Moderate confidence",
};

/**
 * Maps the engine's predicted flow (0–1) onto the rubric language people report in.
 *
 * The words come from RUBRIC rather than being retyped here. This function used
 * to carry its own copy of the six labels, and one had already drifted — it said
 * "Pools / dripping" where the rubric says "Pools or dripping" — so the site
 * showed one vocabulary on the read and asked for another on the form directly
 * below it. That table is the contract between what a hiker saw and what the
 * model reads; it does not get a second spelling.
 *
 * Banding is `nearestStep`'s, including its round-down tie rule.
 */
export function flowLabel(flow: number): string {
  return nearestStep(flow).label;
}

/** Tone for the verdict banner. Dry and unknown are both "don't count on it". */
export function verdictTone(s: SourceForecast): "dry" | "marginal" | "wet" | "unknown" {
  if (confidenceOf(s) === "none" || !hasRead(s)) return "unknown";
  if (s.predicted_flow < 0.1) return "dry";
  if (s.predicted_flow < 0.5) return "marginal";
  return "wet";
}

/**
 * Plain-English gloss on a source's classification. "Spearman r = +0.62" means
 * nothing to someone planning a water carry; "rain over the last 90 days
 * predicts this one well" does.
 */
export function explainType(s: ReadableSource): string {
  const w = s.best.days;
  const strength = Math.abs(s.best.r);

  if (s.type.startsWith("Reliable")) {
    return (
      `Dry only ${s.pct_dry}% of the time, and rainfall barely moves it. That decoupling ` +
      `is exactly why it is dependable — it is fed by groundwater, not by last month's weather.`
    );
  }
  if (s.type.startsWith("Flashy")) {
    return (
      `Driven by recent rain: the last ${w} days predict it better than any longer window ` +
      `(${strength >= 0.5 ? "strongly" : "moderately"}). It turns on fast after storms and ` +
      `off just as fast, and it is dry ${s.pct_dry}% of the time.`
    );
  }
  return (
    `Medium memory — the last ${w} days of rain predict it best. Typical of creeks with rock ` +
    `tanks that hold water after the flow itself stops. Dry ${s.pct_dry}% of the time.`
  );
}

/** How much of the headline correlation was borrowed from neighboring sources. */
export function explainPooling(s: ReadableSource): string | null {
  if (s.best.group_n <= 1) return null;
  const pct = Math.round(s.best.borrowed * 100);
  const neighbors = s.best.group_n - 1;
  const n = `${neighbors} nearby source${neighbors === 1 ? "" : "s"}`;

  if (pct < 15) {
    return `Has enough of its own data to stand alone — only ${pct}% of this correlation is borrowed from ${n}.`;
  }
  if (pct < 50) {
    return `${pct}% of this correlation is borrowed from ${n} that respond to rain the same way.`;
  }
  return (
    `${pct}% of this correlation is borrowed from ${n}. On its own the record is too thin to ` +
    `trust, so the reading leans on neighbors that demonstrably behave alike.`
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Twelve months, with gaps preserved as null — a month with no reports is not a dry month. */
export function monthlyFlow(s: SourceForecast): { month: string; flow: number | null }[] {
  return MONTHS.map((month, i) => {
    const v = s.mean_flow_by_month[String(i + 1)];
    return { month, flow: v === undefined ? null : v };
  });
}

export const signed = (n: number, digits = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

/**
 * Report freshness.
 *
 * A source last seen in 2019 and one seen last week must not look alike, and
 * the engine says nothing about this — its numbers describe how flow tracks
 * rainfall, a relationship that does not decay. What decays is our confidence
 * that the *place* is unchanged. Springs get developed, boxes collapse, roads
 * wash out, a wildfire changes a whole catchment's runoff. None of that shows
 * up in a correlation.
 *
 * So this is deliberately not folded into the confidence rating: it is a
 * separate axis, and a well-sampled stale source is a genuinely different thing
 * from a thinly-sampled fresh one.
 */
export type Freshness = "fresh" | "recent" | "aging" | "stale" | "unknown";

/** Thresholds in days, chosen around how a hiking season works. */
const FRESHNESS_DAYS: [Freshness, number][] = [
  ["fresh", 90], // within a season
  ["recent", 365], // within a year — the same season, last year
  ["aging", 365 * 3],
];

export function freshnessOf(lastReported: string | null, today = new Date()): Freshness {
  if (!lastReported) return "unknown";
  const days = Math.floor(
    (Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${lastReported}T00:00:00Z`)) /
      86_400_000,
  );
  if (days < 0) return "fresh";
  for (const [label, limit] of FRESHNESS_DAYS) if (days < limit) return label;
  return "stale";
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: "Reported this season",
  recent: "Reported within a year",
  aging: "Nothing recent",
  stale: "Long unreported",
  unknown: "Never reported",
};

/** Why it matters, in terms of what could have changed on the ground. */
export const FRESHNESS_NOTE: Record<Freshness, string | null> = {
  fresh: null,
  recent: null,
  aging:
    "Nobody has reported this in over a year. The rainfall relationship does not go stale, but the place can — spring boxes fail, channels move, fire changes how a catchment sheds water.",
  stale:
    "Nothing reported here in years. Treat the read as a statement about rainfall, not about what is on the ground now.",
  unknown: "No reports at all, so there is nothing to forecast from.",
};

/** How long ago, in the units people actually think in. */
export function describeAge(lastReported: string | null, today = new Date()): string {
  if (!lastReported) return "never";
  const days = Math.floor(
    (Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${lastReported}T00:00:00Z`)) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(days / 365.25)} years ago`;
}

/**
 * What a source's own observations say, for a page that is not issuing a read.
 *
 * Below the floor the site refuses a verdict, and until now that refusal *was*
 * the page: two blocks explaining what cannot be said, with the observations
 * themselves pushed below the form as a bare list of dates and bare decimals.
 * That is a page sitting on real field data and leading with its absence.
 *
 * A record is not a forecast, so everything here is past tense and dated. It
 * describes what people found on particular days; it never says what is there
 * now. The whole design of the thin-source page rests on that line not being
 * crossed, so the summary must not be composable into a present-tense claim.
 */
export type RecordDigest = {
  n: number;
  /** Earliest and most recent observation dates. */
  first: string;
  last: string;
  /** The most recent observation — the single most decision-relevant row. */
  latest: { date: string; score: number; label: string };
  /** Range across the record, in rubric words. Equal when every row agrees. */
  driest: string;
  wettest: string;
  /** Every observation landed on the same rubric step. */
  uniform: boolean;
  /**
   * Somebody found this completely dry at least once.
   *
   * Surfaced on its own rather than left to the range, because it is the one
   * fact in a thin record that changes what you carry. A source that has been
   * dry can be dry again, and averaging that into "Dry to Strong" buries it.
   */
  everDry: boolean;
};

export function digestRecord(
  rows: readonly { date: string; score: number }[],
): RecordDigest | null {
  if (rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const scores = sorted.map((r) => r.score);
  const driest = nearestStep(Math.min(...scores));
  const wettest = nearestStep(Math.max(...scores));

  return {
    n: sorted.length,
    first: sorted[0].date,
    last: latest.date,
    latest: { date: latest.date, score: latest.score, label: nearestStep(latest.score).label },
    driest: driest.label,
    wettest: wettest.label,
    uniform: driest.label === wettest.label,
    everDry: scores.some((s) => s <= 0),
  };
}

export const RECORD_COPY = {
  /**
   * The record in one sentence.
   *
   * Every clause is anchored to a date, and there is no verb about the present.
   * "Reported Moderate on 2024-03-11" is a fact; "runs moderate" would be a
   * verdict the record cannot support, and this page exists to not issue one.
   */
  summary(d: RecordDigest, today = new Date()): string {
    const age = describeAge(d.last, today);

    if (d.n === 1) {
      return `One observation, ${age}: ${d.latest.label.toLowerCase()} on ${d.latest.date}.`;
    }
    if (d.uniform) {
      return (
        `${d.n} observations between ${d.first} and ${d.last}, every one ` +
        `${d.driest.toLowerCase()}. The most recent was ${age}.`
      );
    }
    return (
      `${d.n} observations between ${d.first} and ${d.last}, ranging from ` +
      `${d.driest.toLowerCase()} to ${d.wettest.toLowerCase()}. Most recently ` +
      `${d.latest.label.toLowerCase()}, ${age}.`
    );
  },

  /**
   * Said plainly, or not at all.
   *
   * Only where it adds something: the case this exists for is a record that
   * reads wet overall and contains one zero, which the range alone buries. On a
   * single-observation source the summary sentence directly above already says
   * "dry" and the list below says it again — a third copy in a warning box is
   * noise, and noise is what makes real warnings skippable.
   */
  everDry(d: RecordDigest): string | null {
    if (!d.everDry || d.n < 2) return null;
    return (
      "Somebody found this completely dry. A source that has been dry can be dry again, " +
      "whatever the rest of the record says."
    );
  },

  /**
   * The frame the list sits in. Without it a table of dates and scores on a
   * page that refuses a verdict invites exactly the reading the refusal is
   * there to prevent — that the numbers add up to an answer.
   */
  framing:
    "These are the observations themselves, not a forecast. Too few to correlate against rainfall, but they are what people actually found.",
} as const;
