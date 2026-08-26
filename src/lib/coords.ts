/**
 * Coordinate parsing for whatever a hiker pastes in.
 *
 * Trail reports quote coordinates in at least three conventions, often mixed
 * within one source: decimal degrees from a phone, degrees-decimal-minutes from
 * a GPS unit (`N34 05.142 W111 29.449`), and degrees-minutes-seconds from an
 * older map. The `/water-forecast` skill already normalizes all of these; this
 * mirrors that so the web form is no less forgiving than pasting into Claude.
 *
 * Getting this wrong is not cosmetic. A coordinate is what the engine
 * correlates against — a mis-parsed minute is roughly a mile, which is a
 * different hillside and a different spring.
 */

export type LatLon = { lat: number; lon: number };

export type ParseResult =
  | { ok: true; value: LatLon; format: "decimal" | "ddm" | "dms" }
  | { ok: false; error: string };

const DEG = "[°d\\u00BA]";
const MIN = "['\\u2032\\u2019m]";
const SEC = '["\\u2033\\u201D]';
/**
 * Between two numbers there is either a unit symbol or whitespace. Older map
 * transcriptions drop the symbols entirely ("34 5 9.13 N"), so whitespace alone
 * has to be enough of a separator.
 */
const SEP = (symbol: string) => `\\s*(?:${symbol}\\s*|\\s+)`;

/** One hemisphere letter, in either position. */
function hemisphereSign(token: string | undefined, axis: "lat" | "lon"): number | null {
  if (!token) return null;
  const c = token.toUpperCase();
  if (axis === "lat") {
    if (c === "N") return 1;
    if (c === "S") return -1;
  } else {
    if (c === "E") return 1;
    if (c === "W") return -1;
  }
  return null;
}

/** Degrees + decimal minutes, or degrees + minutes + seconds, into degrees. */
function toDegrees(deg: number, min = 0, sec = 0): number {
  return deg + min / 60 + sec / 3600;
}

type Component = { value: number; hemisphere: string | null };

/**
 * Pull one coordinate component out of a string, whichever notation it uses.
 * Returns null if the text does not look like a coordinate at all.
 */
function parseComponent(raw: string): { component: Component; format: "decimal" | "ddm" | "dms" } | null {
  const text = raw.trim();
  if (!text) return null;

  // Leading or trailing hemisphere letter: "N34...", "34...N"
  const hemiMatch = text.match(/^([NSEW])\s*|\s*([NSEW])$/i);
  const hemisphere = (hemiMatch?.[1] ?? hemiMatch?.[2] ?? null)?.toUpperCase() ?? null;
  const body = text.replace(/^[NSEW]\s*/i, "").replace(/\s*[NSEW]$/i, "").trim();

  // DMS: 34°5'8.5"  /  34 5 8.5.  Tried before DDM because three numbers is the
  // more specific match; DDM's two-number pattern would otherwise claim it.
  const dms = body.match(
    new RegExp(
      `^(-?\\d+(?:\\.\\d+)?)${SEP(DEG)}(\\d+(?:\\.\\d+)?)${SEP(MIN)}(\\d+(?:\\.\\d+)?)\\s*${SEC}?$`,
    ),
  );
  if (dms) {
    const deg = Number(dms[1]);
    const value = Math.sign(deg || 1) * toDegrees(Math.abs(deg), Number(dms[2]), Number(dms[3]));
    return { component: { value, hemisphere }, format: "dms" };
  }

  // DDM: 34°05.142'  /  34 05.142
  const ddm = body.match(
    new RegExp(`^(-?\\d+(?:\\.\\d+)?)\\s*${DEG}?\\s+(\\d+(?:\\.\\d+)?)\\s*${MIN}?$`),
  );
  if (ddm) {
    const deg = Number(ddm[1]);
    const value = Math.sign(deg || 1) * toDegrees(Math.abs(deg), Number(ddm[2]));
    return { component: { value, hemisphere }, format: "ddm" };
  }

  // Decimal: 34.08587  /  34.08587°
  const dec = body.match(new RegExp(`^(-?\\d+(?:\\.\\d+)?)\\s*${DEG}?$`));
  if (dec) {
    return { component: { value: Number(dec[1]), hemisphere }, format: "decimal" };
  }

  return null;
}

/**
 * Parse a full "lat, lon" string. Accepts comma-, slash- or whitespace-separated
 * pairs in any of the three notations, with hemisphere letters optional.
 */
export function parseLatLon(input: string): ParseResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter a coordinate." };

  // Split on a comma or slash if present; otherwise on the boundary between the
  // two components, which is wherever the second hemisphere letter or the
  // second sign begins.
  let parts: string[] | null = null;
  if (/[,/;]/.test(text)) {
    parts = text.split(/\s*[,/;]\s*/);
  } else {
    // "N34 05.142 W111 29.449" — split before the longitude's hemisphere letter.
    const split = text.match(/^(.*?[NS].*?|\S+(?:\s+\S+){0,2}?)\s+([EW].*)$/i);
    if (split) parts = [split[1], split[2]];
    else {
      const tokens = text.split(/\s+/);
      // An even token count means the two components are symmetric.
      if (tokens.length % 2 === 0) {
        const half = tokens.length / 2;
        parts = [tokens.slice(0, half).join(" "), tokens.slice(half).join(" ")];
      }
    }
  }

  if (!parts || parts.length !== 2) {
    return { ok: false, error: "Could not find two coordinates. Try `34.08587, -111.49097`." };
  }

  const first = parseComponent(parts[0]);
  const second = parseComponent(parts[1]);
  if (!first || !second) {
    return { ok: false, error: "Could not read that as a coordinate." };
  }

  // Hemisphere letters, when present, decide which component is which — some
  // sources write longitude first.
  let latPart = first;
  let lonPart = second;
  const firstIsLon = first.component.hemisphere === "E" || first.component.hemisphere === "W";
  const secondIsLat = second.component.hemisphere === "N" || second.component.hemisphere === "S";
  if (firstIsLon || secondIsLat) {
    latPart = second;
    lonPart = first;
  }

  const latSign = hemisphereSign(latPart.component.hemisphere ?? undefined, "lat");
  const lonSign = hemisphereSign(lonPart.component.hemisphere ?? undefined, "lon");

  const lat = latSign === null ? latPart.component.value : latSign * Math.abs(latPart.component.value);
  const lon = lonSign === null ? lonPart.component.value : lonSign * Math.abs(lonPart.component.value);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: "Could not read that as a coordinate." };
  }
  if (Math.abs(lat) > 90) {
    return { ok: false, error: `Latitude ${lat} is out of range (-90 to 90). Are they swapped?` };
  }
  if (Math.abs(lon) > 180) {
    return { ok: false, error: `Longitude ${lon} is out of range (-180 to 180).` };
  }

  const format = latPart.format === "decimal" ? lonPart.format : latPart.format;
  return { ok: true, value: { lat, lon }, format };
}

/** Five decimals ≈ 1 metre, which is finer than any field report warrants. */
export function formatLatLon({ lat, lon }: LatLon): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Haversine, matching the engine's own neighbour metric. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

export function formatDistance(km: number): string {
  const miles = km * 0.621371;
  if (km < 0.161) return `${Math.round(km * 3280.84)} ft`;
  if (miles < 10) return `${miles.toFixed(miles < 1 ? 2 : 1)} mi`;
  return `${Math.round(miles)} mi`;
}

/** URL-safe slug, matching what scripts/seed.mjs generates. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-");
}

export type Bounds = { south: number; west: number; north: number; east: number };

/**
 * The tightest box containing every point, or null for none.
 *
 * Kept here rather than reaching for Leaflet's `latLngBounds` so the map's
 * opening view is decided by something testable, and so the caller can ask
 * whether a fit is even worth doing before loading Leaflet at all.
 *
 * No antimeridian handling, deliberately. The corpus is the interior Southwest
 * (see the CHECK on `gazetteer.state`), and code that pretends to handle a case
 * it has never seen is worse than code that plainly does not.
 */
export function boundsOf(points: LatLon[]): Bounds | null {
  if (points.length === 0) return null;
  return points.reduce<Bounds>(
    (b, p) => ({
      south: Math.min(b.south, p.lat),
      west: Math.min(b.west, p.lon),
      north: Math.max(b.north, p.lat),
      east: Math.max(b.east, p.lon),
    }),
    { south: points[0].lat, west: points[0].lon, north: points[0].lat, east: points[0].lon },
  );
}

/**
 * Whether a box is large enough that fitting to it beats simply centring.
 *
 * A single source — or several within a few hundred metres — produces a box so
 * small that fitting it zooms to the tile server's limit and shows a field of
 * grey. Below this, centre at the default zoom instead. 500 m rather than zero
 * because "all the pins are basically one place" is the same situation as "there
 * is one pin".
 */
export const MIN_FIT_SPAN_KM = 0.5;

export function isWorthFitting(bounds: Bounds | null): boolean {
  if (!bounds) return false;
  const diagonal = distanceKm(
    { lat: bounds.south, lon: bounds.west },
    { lat: bounds.north, lon: bounds.east },
  );
  return diagonal >= MIN_FIT_SPAN_KM;
}
