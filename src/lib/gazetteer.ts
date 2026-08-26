/**
 * Normalising two gazetteer feeds into one row shape.
 *
 * The I/O lives in `scripts/load-gazetteer.mjs`; everything here is pure, so the
 * decisions that actually shape the corpus -- which feature classes count as
 * water, which rows are refused, how two feeds' vocabularies reconcile -- are
 * testable without a network or a database.
 *
 * Scope is the interior Southwest and nothing else: AZ, CA, CO, NM, NV, UT.
 * `gazetteer.state` carries a CHECK to the same effect, so a widening has to be
 * deliberate in both places.
 */

export const SOUTHWEST_STATES = ["AZ", "CA", "CO", "NM", "NV", "UT"] as const;
export type StateCode = (typeof SOUTHWEST_STATES)[number];

/** GNIS names states in full; the table stores the two-letter code. */
const STATE_NAME_TO_CODE: Record<string, StateCode> = {
  Arizona: "AZ",
  California: "CA",
  Colorado: "CO",
  "New Mexico": "NM",
  Nevada: "NV",
  Utah: "UT",
};

export type GazetteerRow = {
  externalId: string;
  name: string | null;
  featureClass: string;
  rawClass: string;
  state: StateCode;
  county: string | null;
  lat: number;
  lon: number;
};

/** Why a row was refused. Every drop is counted, never silent -- a corpus that
    quietly shrinks looks like a smaller world rather than a bug. */
export type DropReason =
  | "not-water"
  | "out-of-scope-state"
  | "no-coordinate"
  | "null-island"
  | "duplicate-id";

export type ParseResult = {
  rows: GazetteerRow[];
  drops: Record<DropReason, number>;
};

export function emptyDrops(): Record<DropReason, number> {
  return {
    "not-water": 0,
    "out-of-scope-state": 0,
    "no-coordinate": 0,
    "null-island": 0,
    "duplicate-id": 0,
  };
}

// ---------------------------------------------------------------------------
// USGS GNIS
// ---------------------------------------------------------------------------

/**
 * GNIS feature classes that are water a person could drink or filter, mapped to
 * our own vocabulary.
 *
 * Measured across the six state files: Reservoir 21,200 · Spring 18,437 ·
 * Lake 6,632 · Basin 1,994 · Swamp 250. There is no `Well` class -- GNIS
 * retired it -- so wells arrive only from OSM.
 *
 * `Stream` (25,355) is deliberately excluded despite being the second-largest
 * class in the file. A stream's primary coordinate is its *mouth*, so a row for
 * "Oak Creek" would place a 30-mile drainage at one arbitrary end of itself, and
 * a report filed against it would be correlated against rain that fell nowhere
 * near where the hiker stood. Same rule as the trail joins in #66: refuse rather
 * than place a point we cannot defend. Canals are excluded as infrastructure.
 */
const GNIS_WATER_CLASSES: Record<string, string> = {
  Spring: "spring",
  Reservoir: "reservoir",
  Lake: "lake",
  Basin: "basin",
  Swamp: "swamp",
};

/**
 * One row of a DomesticNames_XX.txt file, addressed by column NAME.
 *
 * Positional reads are how #68 nearly filed elevations as waypoint ids: the
 * header row differs between files that look identical. Here the header is
 * stable today, which is exactly when a positional read gets written and exactly
 * why it should not be.
 */
export function parseGnis(text: string): ParseResult {
  const drops = emptyDrops();
  const rows: GazetteerRow[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);
  // A BOM on the first cell of the first line would otherwise make the
  // `feature_id` column unfindable by name.
  const header = (lines[0] ?? "").replace(/^﻿/, "").split("|");
  const at = (cols: string[], key: string): string => {
    const i = header.indexOf(key);
    return i === -1 ? "" : (cols[i] ?? "").trim();
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split("|");

    const rawClass = at(cols, "feature_class");
    const featureClass = GNIS_WATER_CLASSES[rawClass];
    if (!featureClass) {
      drops["not-water"]++;
      continue;
    }

    const state = STATE_NAME_TO_CODE[at(cols, "state_name")];
    if (!state) {
      drops["out-of-scope-state"]++;
      continue;
    }

    const lat = Number(at(cols, "prim_lat_dec"));
    const lon = Number(at(cols, "prim_long_dec"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || at(cols, "prim_lat_dec") === "") {
      drops["no-coordinate"]++;
      continue;
    }
    // GNIS uses 0,0 for "unknown" on a handful of features. Off the coast of
    // Ghana is not a refusal the database would ever make for us.
    if (lat === 0 && lon === 0) {
      drops["null-island"]++;
      continue;
    }

    const externalId = at(cols, "feature_id");
    if (!externalId || seen.has(externalId)) {
      drops["duplicate-id"]++;
      continue;
    }
    seen.add(externalId);

    const name = at(cols, "feature_name");
    const county = at(cols, "county_name");
    rows.push({
      externalId,
      name: name || null,
      featureClass,
      rawClass,
      state,
      county: county || null,
      lat,
      lon,
    });
  }

  return { rows, drops };
}

// ---------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------

/**
 * The tags queried from Overpass, in precedence order. A node carrying two of
 * them (a named spring that is also tagged as drinking water) takes the first
 * match, so the classification is deterministic rather than dependent on key
 * order in the JSON.
 */
export const OSM_TAG_FILTERS: readonly { key: string; value: string; featureClass: string }[] = [
  { key: "natural", value: "spring", featureClass: "spring" },
  { key: "natural", value: "hot_spring", featureClass: "hot_spring" },
  { key: "man_made", value: "water_well", featureClass: "well" },
  { key: "man_made", value: "cistern", featureClass: "cistern" },
  { key: "amenity", value: "drinking_water", featureClass: "drinking_water" },
  { key: "man_made", value: "water_tap", featureClass: "drinking_water" },
];

export type OverpassElement = {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
};

export type OverpassBody = { elements?: OverpassElement[] };

/**
 * Overpass JSON for one state. The state is passed in rather than read from the
 * response because the query is issued per state area -- Overpass returns no
 * administrative context on a node, and inferring one from a bounding box would
 * put Nevada springs in California along the whole eastern border.
 */
export function parseOverpass(body: OverpassBody, state: StateCode): ParseResult {
  const drops = emptyDrops();
  const rows: GazetteerRow[] = [];
  const seen = new Set<string>();

  for (const el of body.elements ?? []) {
    if (el.type !== "node" || typeof el.id !== "number") continue;
    const tags = el.tags ?? {};

    const match = OSM_TAG_FILTERS.find((f) => tags[f.key] === f.value);
    if (!match) {
      drops["not-water"]++;
      continue;
    }

    const { lat, lon } = el;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      drops["no-coordinate"]++;
      continue;
    }
    if (lat === 0 && lon === 0) {
      drops["null-island"]++;
      continue;
    }

    const externalId = `node/${el.id}`;
    if (seen.has(externalId)) {
      drops["duplicate-id"]++;
      continue;
    }
    seen.add(externalId);

    const name = (tags.name ?? "").trim();
    rows.push({
      externalId,
      name: name || null,
      featureClass: match.featureClass,
      rawClass: `${match.key}=${match.value}`,
      state,
      county: null,
      lat: lat as number,
      lon: lon as number,
    });
  }

  return { rows, drops };
}

/** The Overpass QL for one state, built from the same filter table the parser
    classifies with, so the two can never drift apart. */
export function overpassQuery(state: StateCode, timeoutSeconds = 300): string {
  const clauses = OSM_TAG_FILTERS.map((f) => `node["${f.key}"="${f.value}"](area.a);`).join("");
  return (
    `[out:json][timeout:${timeoutSeconds}];` +
    `area["ISO3166-2"="US-${state}"]->.a;` +
    `(${clauses});` +
    `out body;`
  );
}

export const FEEDS = {
  gnis: {
    feed: "USGS GNIS DomesticNames",
    // A work of the United States government. No permission conversation
    // needed, which after #14 is worth saying out loud.
    licence: "Public domain — U.S. Geological Survey",
  },
  osm: {
    feed: "OpenStreetMap",
    // ODbL is not public domain. Attribution is required wherever a derived row
    // is shown, and that obligation travels with the data into any page that
    // renders it.
    licence: "ODbL 1.0 — © OpenStreetMap contributors",
  },
} as const;
