import {
  gazetteerCoversPoint,
  searchFeatures,
  searchFeaturesNear,
  searchSources,
  searchSourcesNear,
} from "@/lib/db";
import { featurePath } from "@/lib/feature-ref";

export const dynamic = "force-dynamic";

/**
 * The one search endpoint, for all three things the field accepts: a name, a
 * coordinate, or a location fix.
 *
 * It replaces shipping the whole corpus to the browser and substring-matching
 * it there. That was right at four sources and is survivable at 57; it cannot
 * see the gazetteer at all, and the gazetteer is 82,375 findable features —
 * three orders of magnitude past what belongs in a page load.
 *
 * Sources and features come back in separate lists rather than one ranked one.
 * They are different kinds of answer — one has observations behind it, the
 * other is a name on a map — and merging them would rank a spring nobody has
 * ever visited alongside one with a decade of reports, on the strength of its
 * spelling.
 */

/** Per group. Enough to disambiguate 203 Cottonwood Springs by county without
    turning the dropdown into a page. */
const LIMIT = 6;

/** What "near here" means. Matches the field's own lookup radius. */
const NEAR_RADIUS_KM = 25;

const MAX_QUERY = 80;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lon");

  const lat = latRaw === null ? null : Number(latRaw);
  const lon = lonRaw === null ? null : Number(lonRaw);
  const hasPoint =
    lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  if (!hasPoint && q.length === 0) {
    return Response.json({ sources: [], features: [], covered: null });
  }

  try {
    if (hasPoint) {
      const [sources, features, covered] = await Promise.all([
        searchSourcesNear(lat, lon, NEAR_RADIUS_KM, LIMIT),
        searchFeaturesNear(lat, lon, NEAR_RADIUS_KM, LIMIT),
        // Only worth asking when there is nothing to show; resolved eagerly
        // because it is one indexed existence check and saves a round trip.
        gazetteerCoversPoint(lat, lon),
      ]);
      return Response.json({
        sources,
        features: features.map(withPath),
        covered,
        radius_km: NEAR_RADIUS_KM,
      });
    }

    /*
     * Exact first, for both. Guessing is a last resort for the whole query, not
     * per table — otherwise a name that matches 262 features exactly also
     * returns "Cedar Spring" as a source, because trigram similarity on short
     * names clears 0.3 against almost anything.
     */
    let [sources, features] = await Promise.all([
      searchSources(q, LIMIT),
      searchFeatures(q, LIMIT),
    ]);
    let fuzzy = false;
    if (sources.length === 0 && features.rows.length === 0) {
      fuzzy = true;
      [sources, features] = await Promise.all([
        searchSources(q, LIMIT, "fuzzy"),
        searchFeatures(q, LIMIT, "fuzzy"),
      ]);
    }

    return Response.json({
      sources,
      features: features.rows.map(withPath),
      feature_total: features.total,
      // True when nothing contained the typed text and these are the nearest
      // spellings. The field says so rather than presenting guesses as matches.
      fuzzy,
      covered: null,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Search failed." },
      { status: 500 },
    );
  }
}

/** The client links to a path, not to a feed and an id. Built in one place so
    the URL shape lives with `featurePath` rather than being reassembled here. */
function withPath<T extends { feed: string; external_id: string; name: string | null; feature_class: string }>(
  feature: T,
) {
  return { ...feature, path: featurePath(feature) };
}
