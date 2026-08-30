import { slugify } from "./coords.ts";

/**
 * How a gazetteer feature is addressed in a URL.
 *
 * A name cannot be the address. Measured on the loaded corpus: 275 primary rows
 * named "Willow Spring", 256 "Mud Spring", 203 "Cottonwood Spring". A slug
 * alone would collide 275 ways, and picking a winner would mean the URL for one
 * spring silently showed another — which is engine issue #9's failure mode
 * moved into the router.
 *
 * So the feed's own identifier resolves the row and the slug is decorative:
 *
 *     /features/willow-spring-gnis-1938702
 *     /features/spring-osm-node-4471029      ← unnamed OSM row
 *
 * The slug exists because a link gets pasted into a group text before a trip
 * and "gnis-1938702" tells nobody anything. It is never read back, so GNIS
 * restating a name does not break a link that is already out in the world.
 *
 * Promotion — the first report on a feature — creates a `sources` row and this
 * URL redirects there permanently. The identifier is what makes that reliable:
 * `sources.gnis_id` / `sources.osm_id` carry it across, which is the same join
 * 0007 relies on to keep the gazetteer reloadable.
 */

/** The two feeds, as `gazetteer.feed` spells them, keyed by their URL marker. */
export const FEED_MARKERS = {
  gnis: "USGS GNIS DomesticNames",
  osm: "OpenStreetMap",
} as const;

export type FeedMarker = keyof typeof FEED_MARKERS;

export type FeatureRef = { marker: FeedMarker; feed: string; externalId: string };

/**
 * OSM identifiers are `node/12345` — a slash, which would open a path segment
 * of its own. Encoded with a hyphen, which is safe because the type is a fixed
 * vocabulary (`node`, `way`, `relation`) and never itself contains one.
 */
function encodeExternalId(id: string): string {
  return id.replace(/\//g, "-");
}

function decodeExternalId(marker: FeedMarker, encoded: string): string {
  return marker === "osm" ? encoded.replace(/-/g, "/") : encoded;
}

/**
 * The ref for a row: `<marker>-<external id>`. Stable for the life of the
 * feature, and the only part of the URL that is read.
 */
export function featureRef(feed: string, externalId: string): string | null {
  const marker = (Object.keys(FEED_MARKERS) as FeedMarker[]).find(
    (k) => FEED_MARKERS[k] === feed,
  );
  return marker ? `${marker}-${encodeExternalId(externalId)}` : null;
}

/**
 * The whole path, slug included.
 *
 * Unnamed rows — 55% of OSM's water nodes, and most of what OSM contributes —
 * fall back to their feature class, so the URL still reads as something rather
 * than as a bare number.
 */
export function featurePath(feature: {
  feed: string;
  external_id: string;
  name: string | null;
  feature_class: string;
}): string | null {
  const ref = featureRef(feature.feed, feature.external_id);
  if (!ref) return null;
  const slug = slugify(feature.name ?? feature.feature_class);
  return `/features/${slug ? `${slug}-${ref}` : ref}`;
}

/**
 * Read a ref back out of a URL segment.
 *
 * Parsed from the right, because the decorative slug is arbitrary user-ish text
 * that can itself contain the word "spring", digits, or a hyphenated number.
 * The marker is what anchors it: everything from the last `gnis-` or `osm-`
 * boundary onward is the identifier, and everything before it is discarded
 * without being checked. That is what lets the slug drift freely.
 */
export function parseFeatureRef(segment: string): FeatureRef | null {
  // The leading `.*-` is greedy on purpose: it forces the match to the *last*
  // marker in the segment, so a spring genuinely named "Osm Spring" cannot
  // capture the parse ahead of the real identifier at the end.
  const match = /^(?:.*-)?(gnis|osm)-([A-Za-z0-9_-]+)$/.exec(segment);
  if (!match) return null;

  const marker = match[1] as FeedMarker;
  const externalId = decodeExternalId(marker, match[2]);

  // A GNIS feature id is numeric; an OSM id is `type/number`. Anything else is
  // a hand-edited URL, and resolving it loosely would mean serving one spring's
  // page at another spring's address.
  if (marker === "gnis" && !/^\d+$/.test(externalId)) return null;
  if (marker === "osm" && !/^(node|way|relation)\/\d+$/.test(externalId)) return null;

  return { marker, feed: FEED_MARKERS[marker], externalId };
}
