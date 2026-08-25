/**
 * Turning a position on a trail into a coordinate.
 *
 * The archived water reports identify a source by where it sits on a trail, not
 * by latitude and longitude. The engine needs the coordinate, because every
 * correlation is against the rain that fell on that exact spot — so this is the
 * step between an archived report and a source the engine can read.
 *
 * The two trails need different joins, and that is a fact about the data rather
 * than a design choice:
 *
 * - **PCT** rows carry a mile. The PCTA publish tenth-mile markers, so a mile
 *   resolves by interpolating between the two nearest.
 * - **AZT** rows carry a passage and a mile, but the ATA also publish the water
 *   sources themselves with coordinates. Their mileage disagrees with the water
 *   report PDFs by up to a mile — different centerline vintages — so AZT joins
 *   on *name*, with passage as a tiebreak, and never on mile alone.
 *
 * Everything here is pure so it can be tested without a network or a database.
 */

export type Marker = { mile: number; lat: number; lon: number };

export type NamedPoint = {
  name: string;
  lat: number;
  lon: number;
  /** The ATA's `ATA_Num`, e.g. `01-079`. */
  externalId?: string | null;
  featureType?: string | null;
  mile?: number | null;
};

/**
 * The furthest a report's mile may sit from the nearest marker before we refuse
 * to place it.
 *
 * Tenth-mile markers are 0.1 apart, so anything beyond a quarter mile means the
 * mile fell in a gap — a reroute, a marker set that does not cover this stretch,
 * or a misparsed number. Guessing across a gap on a trail that switchbacks is
 * how a report ends up correlated against the wrong drainage.
 */
export const MAX_MARKER_GAP_MILES = 0.25;

/**
 * Interpolate a coordinate for a mile, between the markers that bracket it.
 *
 * Linear interpolation over a tenth of a mile is well within the error of the
 * mileage itself — a report saying "mile 100.4" was not measured to the foot.
 * Returns null rather than a nearest-marker guess when the mile falls outside
 * the marker set or in too large a gap: no coordinate is recoverable, a wrong
 * one is not.
 *
 * `markers` must be sorted by mile ascending.
 */
export function coordForMile(
  markers: readonly Marker[],
  mile: number,
): { lat: number; lon: number } | null {
  if (!Number.isFinite(mile) || markers.length === 0) return null;

  // Binary search for the first marker at or after `mile`.
  let lo = 0;
  let hi = markers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (markers[mid].mile < mile) lo = mid + 1;
    else hi = mid;
  }

  const after = markers[lo];
  const before = markers[lo - 1];

  if (after && after.mile === mile) return { lat: after.lat, lon: after.lon };

  // Outside the marker set entirely. Extrapolating past the end of a trail is
  // never right.
  if (!before || !after) {
    const edge = before ?? after;
    if (!edge || Math.abs(edge.mile - mile) > MAX_MARKER_GAP_MILES) return null;
    return { lat: edge.lat, lon: edge.lon };
  }

  if (after.mile - before.mile > MAX_MARKER_GAP_MILES * 2) return null;

  const span = after.mile - before.mile;
  const t = span === 0 ? 0 : (mile - before.mile) / span;
  return {
    lat: before.lat + (after.lat - before.lat) * t,
    lon: before.lon + (after.lon - before.lon) * t,
  };
}

/**
 * `01-079` -> `{ passage: 1, mile: 7.9 }`.
 *
 * The ATA encode passage and tenth-mile into one string. Documented here
 * because it is not written down anywhere upstream and was worked out by
 * comparing the layer against the water-report PDFs.
 */
export function parseAtaNum(value: string): { passage: number; mile: number } | null {
  const m = /^(\d{2})-(\d{3})$/.exec(value.trim());
  if (!m) return null;
  return { passage: Number(m[1]), mile: Number(m[2]) / 10 };
}

/**
 * Normalise a water-source name for matching.
 *
 * The same spring is written a dozen ways across a decade of volunteer reports:
 * "Bathtub Spring (aka Tub Spring)", "bathtub spring", "Bathtub Spr.". This
 * strips the variation that is never meaningful and keeps everything that is.
 *
 * Two things *are* stripped, and both were learned by measuring the match rate
 * against a real archived report rather than guessed:
 *
 * - **A trailing note after a semicolon.** "Bear Spring 0.5 m W; multiple trees"
 *   names one spring and then describes it.
 * - **An off-trail locator**, "0.5 m W", "~0.1mE", "1.6m NW". These say how far
 *   from the trail the water is, which is a fact about the walk rather than
 *   about the spring, and the same spring is written with different distances
 *   in different years as the trail is rerouted.
 *
 * Stripping the locator is only safe because ambiguity is a refusal: if two
 * genuinely different springs both reduce to "bear spring", `matchByName` finds
 * two candidates and returns null rather than picking one.
 *
 * Qualifiers that *do* distinguish water — "upper", "lower", "north" — are kept.
 */
export function normalizeName(raw: string): string {
  // Punctuation goes first, then abbreviations expand on clean word
  // boundaries. Doing it the other way round leaves "spr." as "spring.",
  // because the boundary after the period is not a word boundary.
  const cleaned = raw
    .toLowerCase()
    // "Bear Spring 0.5 m W; multiple trees" — the name, then a description.
    .split(";")[0]
    // Off-trail locator: how far from the trail, not which water.
    .replace(/\s*~?\d+(?:\.\d+)?\s*m\s*[nsew]{1,2}\b\.?/g, " ")
    // The alias parenthetical needs its periods, so it goes before the strip.
    .replace(/\((?:aka|a\.k\.a\.)[^)]*\)/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned
    .replace(/\bspr\b/g, "spring")
    .replace(/\bcyn\b/g, "canyon")
    .replace(/\bck\b/g, "creek")
    .replace(/\b(?:trlhd|th)\b/g, "trailhead")
    .replace(/\s+/g, " ")
    .trim();
}

export type NameMatch = {
  point: NamedPoint;
  /** "exact" on normalised name; "passage" when a passage hint broke a tie. */
  how: "exact" | "passage";
};

/**
 * Find the published point for a reported source name.
 *
 * Returns null on ambiguity rather than picking one. The AZT has several
 * unrelated "Bear Spring"s, and silently choosing the first would correlate a
 * report against rain that fell a hundred miles away — an error invisible in
 * the output and impossible to detect later.
 */
export function matchByName(
  points: readonly NamedPoint[],
  reportedName: string,
  hint?: { passage?: number },
): NameMatch | null {
  const needle = normalizeName(reportedName);
  if (!needle) return null;

  const exact = points.filter((p) => normalizeName(p.name) === needle);
  if (exact.length === 1) return { point: exact[0], how: "exact" };
  if (exact.length === 0) return null;

  if (hint?.passage !== undefined) {
    const inPassage = exact.filter((p) => {
      const parsed = p.externalId ? parseAtaNum(p.externalId) : null;
      return parsed?.passage === hint.passage;
    });
    if (inPassage.length === 1) return { point: inPassage[0], how: "passage" };
  }

  // Several candidates and nothing to choose between them.
  return null;
}
