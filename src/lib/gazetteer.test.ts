import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDS,
  OSM_TAG_FILTERS,
  SOUTHWEST_STATES,
  overpassQuery,
  parseGnis,
  parseOverpass,
  type OverpassBody,
} from "./gazetteer.ts";

/**
 * Real lines from DomesticNames_AZ.txt, header included, exactly as USGS ships
 * them -- BOM on the first cell and all. A hand-written approximation of this
 * format would not have caught the BOM, and the BOM is what makes `feature_id`
 * unfindable by name.
 */
const GNIS_HEADER =
  "﻿feature_id|feature_name|feature_class|state_name|state_numeric|county_name|county_numeric|" +
  "map_name|date_created|date_edited|bgn_type|bgn_authority|bgn_date|prim_lat_dms|prim_long_dms|" +
  "prim_lat_dec|prim_long_dec|source_lat_dms|source_long_dms|source_lat_dec|source_long_dec";

const GNIS_SPRING =
  "457|A Ninetysix Spring|Spring|Arizona|04|Gila|007|Carrizo|02/08/1980|04/18/2011||||" +
  "335622N|1101822W|33.9394555|-110.3061979|||0.0|0.0";
const GNIS_TANK =
  "463|A-eighty Tank|Reservoir|Arizona|04|Navajo|017|Whiteriver|02/08/1980|03/19/2019||||" +
  "334909N|1095522W|33.8192993|-109.9228975|||0.0|0.0";
const GNIS_STREAM =
  "399|Agua Sal Creek|Stream|Arizona|04|Apache|001|Fire Dance Mesa|02/08/1980|||||" +
  "362740N|1092842W|36.4611122|-109.4784394|362053N|1090915W|36.3480582|-109.1542662";

const gnis = (...lines: string[]) => parseGnis([GNIS_HEADER, ...lines].join("\n"));

test("a GNIS spring parses to a row, coordinates and county intact", () => {
  const { rows } = gnis(GNIS_SPRING);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    externalId: "457",
    name: "A Ninetysix Spring",
    featureClass: "spring",
    rawClass: "Spring",
    state: "AZ",
    county: "Gila",
    lat: 33.9394555,
    lon: -110.3061979,
  });
});

test("GNIS 'Reservoir' keeps its own wording alongside our class", () => {
  // In Arizona this class is overwhelmingly stock tanks, which is why the feed's
  // own word is kept: normalising is a judgement, and the input to it stays.
  const { rows } = gnis(GNIS_TANK);
  assert.equal(rows[0].featureClass, "reservoir");
  assert.equal(rows[0].rawClass, "Reservoir");
  assert.equal(rows[0].name, "A-eighty Tank");
});

test("streams are refused, and the refusal is counted", () => {
  const { rows, drops } = gnis(GNIS_STREAM);
  assert.equal(rows.length, 0);
  assert.equal(drops["not-water"], 1);
});

test("columns are found by name, so a reordered header still parses", () => {
  // The read has to survive USGS moving a column. Positional reads look correct
  // right up until the day the file changes, and then read a date as a latitude.
  const reordered = "﻿feature_class|feature_id|feature_name|state_name|county_name|prim_lat_dec|prim_long_dec";
  const { rows } = parseGnis(
    [reordered, "Spring|457|A Ninetysix Spring|Arizona|Gila|33.9394555|-110.3061979"].join("\n"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, "457");
  assert.equal(rows[0].lat, 33.9394555);
});

test("a feature outside the six states is refused, not silently relabelled", () => {
  const { rows, drops } = gnis(GNIS_SPRING.replace("|Arizona|", "|Wyoming|"));
  assert.equal(rows.length, 0);
  assert.equal(drops["out-of-scope-state"], 1);
});

test("0,0 is refused — GNIS uses it for 'unknown'", () => {
  const { rows, drops } = gnis(GNIS_SPRING.replace("|33.9394555|-110.3061979|", "|0.0|0.0|"));
  assert.equal(rows.length, 0);
  assert.equal(drops["null-island"], 1);
});

test("a missing coordinate is refused rather than parsed as NaN", () => {
  const { rows, drops } = gnis(GNIS_SPRING.replace("|33.9394555|-110.3061979|", "||-110.3061979|"));
  assert.equal(rows.length, 0);
  assert.equal(drops["no-coordinate"], 1);
});

test("a repeated feature_id is collapsed before the write, not by it", () => {
  // A single INSERT cannot touch the same conflict key twice. #66 learned this
  // from an ArcGIS feed; the guard belongs in the parser either way.
  const { rows, drops } = gnis(GNIS_SPRING, GNIS_SPRING);
  assert.equal(rows.length, 1);
  assert.equal(drops["duplicate-id"], 1);
});

// ---------------------------------------------------------------------------
// OpenStreetMap
// ---------------------------------------------------------------------------

/** Real nodes as Overpass returns them for `area["ISO3166-2"="US-AZ"]`. */
const OSM_BODY: OverpassBody = {
  elements: [
    { type: "node", id: 358637901, lat: 34.4813, lon: -111.3323, tags: { natural: "spring", name: "Black Bear Spring" } },
    { type: "node", id: 358637902, lat: 34.4901, lon: -111.3401, tags: { natural: "spring" } },
    { type: "node", id: 900000001, lat: 33.4, lon: -112.0, tags: { amenity: "drinking_water" } },
    { type: "node", id: 900000002, lat: 33.5, lon: -112.1, tags: { man_made: "water_well", name: "Windmill Well" } },
    { type: "node", id: 900000003, lat: 33.6, lon: -112.2, tags: { amenity: "bench" } },
  ],
};

test("OSM nodes map onto the same row shape as GNIS", () => {
  const { rows } = parseOverpass(OSM_BODY, "AZ");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    externalId: "node/358637901",
    name: "Black Bear Spring",
    featureClass: "spring",
    rawClass: "natural=spring",
    state: "AZ",
    county: null,
    lat: 34.4813,
    lon: -111.3323,
  });
});

test("an unnamed spring is kept with a null name", () => {
  // 55% of OSM's water nodes in these states are unnamed. They are invisible to
  // name search and are the whole point of proximity search.
  const { rows } = parseOverpass(OSM_BODY, "AZ");
  const unnamed = rows.find((r) => r.externalId === "node/358637902");
  assert.equal(unnamed?.name, null);
  assert.equal(unnamed?.featureClass, "spring");
});

test("a bench is not water", () => {
  const { drops } = parseOverpass(OSM_BODY, "AZ");
  assert.equal(drops["not-water"], 1);
});

test("the state is stamped from the query area, never inferred", () => {
  // Overpass returns no administrative context on a node, and a bounding box
  // would file every eastern-Sierra spring in the wrong state.
  const { rows } = parseOverpass(OSM_BODY, "NV");
  assert.ok(rows.every((r) => r.state === "NV"));
});

test("the Overpass query is generated from the same table the parser classifies with", () => {
  const q = overpassQuery("UT");
  for (const f of OSM_TAG_FILTERS) {
    assert.ok(q.includes(`node["${f.key}"="${f.value}"](area.a);`), `${f.key}=${f.value} missing`);
  }
  assert.ok(q.includes('area["ISO3166-2"="US-UT"]'));
});

test("OSM's licence is recorded as ODbL, because attribution travels with the row", () => {
  assert.match(FEEDS.osm.licence, /ODbL/);
  assert.match(FEEDS.osm.licence, /OpenStreetMap contributors/);
  assert.match(FEEDS.gnis.licence, /Public domain/);
});

test("the scope is six states", () => {
  assert.deepEqual([...SOUTHWEST_STATES], ["AZ", "CA", "CO", "NM", "NV", "UT"]);
});
