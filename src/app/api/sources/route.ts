import {
  createSource,
  findGazetteerFeature,
  findSourceByExternalId,
  findSourceBySlug,
  listSourcesWithCounts,
  sourcesNear,
} from "@/lib/db";
import { distanceKm, parseLatLon, slugify } from "@/lib/coords";
import { parseFeatureRef } from "@/lib/feature-ref";
import { RULES, limitByIp, rateLimitHeaders, sweepRateLimits, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Every source, for the map. The corpus is small; pagination can wait. */
export async function GET() {
  try {
    return Response.json({ sources: await listSourcesWithCounts() });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not load sources." },
      { status: 500 },
    );
  }
}

const MAX_NAME = 120;
const MAX_NOTES = 2000;

/**
 * Anything closer than this is treated as certainly the same water source and
 * refused outright. Two distinct springs 50 m apart is possible but rare; two
 * people pinning one spring 50 m apart is the common case, and a split source
 * is worse than a merged one — it halves both records and neither accumulates
 * enough reports to say anything.
 */
const SAME_SOURCE_KM = 0.05;

/**
 * How far a promoted source may sit from the gazetteer feature it claims.
 *
 * Promotion copies the feed's identifier onto the new row, and that identifier
 * is what every later reconciliation trusts. The picker lets someone adjust the
 * pin before saving — correcting a GNIS coordinate by a couple of hundred
 * metres is legitimate and common — but past a quarter kilometre they are
 * pinning different water, and carrying the identifier across would tell the
 * next gazetteer reload that this spring is somewhere it is not.
 */
const PROMOTION_RADIUS_KM = 0.25;

export async function POST(request: Request) {
  // Before parsing anything: a write is the expensive, hard-to-undo action, and
  // a junk source pollutes a corpus whose entire value is that it is real.
  const limit = await limitByIp(request.headers, "create_source", RULES.createSource);
  if (!limit.allowed) {
    return tooManyRequests(
      limit,
      "Too many sources added recently. This is a slow, human-paced dataset — try again shortly.",
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, MAX_NOTES) : null;

  if (!name) return Response.json({ error: "A name is required." }, { status: 400 });
  if (name.length > MAX_NAME) {
    return Response.json({ error: `Name must be ${MAX_NAME} characters or fewer.` }, { status: 400 });
  }

  // Accept either a parsed pair (from the map) or raw text (from the box).
  let lat: number;
  let lon: number;
  if (typeof body.lat === "number" && typeof body.lon === "number") {
    lat = body.lat;
    lon = body.lon;
  } else if (typeof body.coordinates === "string") {
    const parsed = parseLatLon(body.coordinates);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    lat = parsed.value.lat;
    lon = parsed.value.lon;
  } else {
    return Response.json({ error: "Coordinates are required." }, { status: 400 });
  }

  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    return Response.json({ error: "Coordinates are out of range." }, { status: 400 });
  }

  try {
    // Refuse a near-certain duplicate even if the client skipped the check.
    // The client shows nearby sources first; this is the backstop, because a
    // duplicate is not a cosmetic problem — see engine issue #9.
    const nearby = await sourcesNear(lat, lon, 1);
    const same = nearby.find((s) => s.distance_km <= SAME_SOURCE_KM);
    if (same) {
      return Response.json(
        {
          error: `"${same.name}" is already recorded ${Math.round(same.distance_km * 1000)} m away. Add reports to it instead of creating a second entry.`,
          existing: same,
        },
        { status: 409 },
      );
    }

    let slug = slugify(name);
    if (!slug) return Response.json({ error: "That name has no usable characters." }, { status: 400 });

    // Same name, different place is legitimate — there are many Cottonwood
    // Springs. Distinguish them in the slug rather than rejecting.
    if (await findSourceBySlug(slug)) {
      const suffix = `${Math.abs(lat).toFixed(3)}-${Math.abs(lon).toFixed(3)}`.replace(/\./g, "");
      slug = `${slug}-${suffix}`;
      if (await findSourceBySlug(slug)) {
        return Response.json({ error: "A source with that name and location already exists." }, { status: 409 });
      }
    }

    /*
     * Promotion. A gazetteer feature has no `sources` row until somebody
     * reports on it — that is the whole point of keeping the two tables apart
     * (0007) — and this is where the row is created, carrying the feed's
     * identifier so the gazetteer can still be reloaded wholesale afterwards.
     */
    let gnisId: string | null = null;
    let osmId: string | null = null;
    if (typeof body.feature_ref === "string") {
      const ref = parseFeatureRef(body.feature_ref);
      if (!ref) return Response.json({ error: "That is not a valid feature reference." }, { status: 400 });

      const feature = await findGazetteerFeature(ref.feed, ref.externalId);
      if (!feature) return Response.json({ error: "No such feature." }, { status: 404 });

      // Already promoted: send them to the source rather than creating a second
      // row for one spring.
      const column = ref.marker === "gnis" ? "gnis_id" : "osm_id";
      const promoted = await findSourceByExternalId(column, ref.externalId);
      if (promoted) {
        return Response.json(
          {
            error: `"${promoted.name}" already records this feature. Add your report there.`,
            existing: promoted,
          },
          { status: 409 },
        );
      }

      const drift = distanceKm({ lat, lon }, { lat: feature.lat, lon: feature.lon });
      if (drift > PROMOTION_RADIUS_KM) {
        return Response.json(
          {
            error:
              `That point is ${Math.round(drift * 1000)} m from the feature it claims to be. ` +
              "Add it as a new source without the feature link, or move the pin back.",
          },
          { status: 400 },
        );
      }

      if (ref.marker === "gnis") gnisId = ref.externalId;
      else osmId = ref.externalId;
    }

    const source = await createSource({ name, slug, lat, lon, notes, gnisId, osmId });

    // Opportunistic housekeeping on a path that is already writing and is
    // rare by design. A cron would be tidier; a stale counter row costs
    // nothing, so it does not warrant one.
    if (Math.random() < 0.05) void sweepRateLimits();

    return Response.json({ source, nearby }, { status: 201, headers: rateLimitHeaders(limit) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not create the source." },
      { status: 500 },
    );
  }
}
