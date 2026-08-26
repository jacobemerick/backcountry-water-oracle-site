import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundsOf,
  distanceKm,
  formatDistance,
  isWorthFitting,
  parseLatLon,
  slugify,
  type LatLon,
} from "./coords.ts";

/** Assert a parse lands within ~1 metre of the expected point. */
function assertParses(input: string, lat: number, lon: number, format?: string) {
  const r = parseLatLon(input);
  assert.ok(r.ok, `expected "${input}" to parse, got: ${r.ok ? "" : r.error}`);
  assert.ok(
    Math.abs(r.value.lat - lat) < 1e-4 && Math.abs(r.value.lon - lon) < 1e-4,
    `"${input}" -> ${r.value.lat}, ${r.value.lon} (wanted ${lat}, ${lon})`,
  );
  if (format) assert.equal(r.format, format, `"${input}" format`);
}

test("decimal degrees", () => {
  assertParses("34.08587, -111.49097", 34.08587, -111.49097, "decimal");
  assertParses("34.08587,-111.49097", 34.08587, -111.49097);
  assertParses("34.08587 -111.49097", 34.08587, -111.49097);
  assertParses("34.08587/-111.49097", 34.08587, -111.49097);
});

test("degrees with hemisphere letters instead of signs", () => {
  assertParses("34.08587 N, 111.49097 W", 34.08587, -111.49097);
  assertParses("N 34.08587, W 111.49097", 34.08587, -111.49097);
  assertParses("34.08587°N 111.49097°W", 34.08587, -111.49097);
});

test("degrees and decimal minutes, the format GPS units print", () => {
  // The example from the skill's own rubric.
  assertParses("N34 05.142 W111 29.449", 34.0857, -111.49082, "ddm");
  assertParses("34° 05.142' N, 111° 29.449' W", 34.0857, -111.49082, "ddm");
});

test("degrees, minutes, seconds", () => {
  assertParses(`34°5'9.13"N 111°29'27.5"W`, 34.08587, -111.49097, "dms");
  assertParses(`34 5 9.13 N, 111 29 27.5 W`, 34.08587, -111.49097);
});

test("longitude written first is detected by its hemisphere letter", () => {
  // Some exports emit lon,lat. The letters, not the order, decide.
  assertParses("W111 29.449, N34 05.142", 34.0857, -111.49082);
  assertParses("111.49097 W, 34.08587 N", 34.08587, -111.49097);
});

test("southern and eastern hemispheres", () => {
  assertParses("-33.8688, 151.2093", -33.8688, 151.2093);
  assertParses("33.8688 S, 151.2093 E", -33.8688, 151.2093);
});

test("rejects out-of-range values with a useful message", () => {
  const swapped = parseLatLon("-111.49097, 34.08587");
  assert.ok(!swapped.ok);
  assert.match(swapped.error, /swapped/i, "should suggest the likely cause");

  const badLon = parseLatLon("34.0, 999.0");
  assert.ok(!badLon.ok);
  assert.match(badLon.error, /Longitude/);
});

test("rejects junk rather than guessing", () => {
  for (const junk of ["", "   ", "somewhere near the spring", "34.08587", "abc, def"]) {
    const r = parseLatLon(junk);
    assert.ok(!r.ok, `"${junk}" should not parse, got ${JSON.stringify(r)}`);
    assert.ok(r.error.length > 0);
  }
});

test("distance matches the engine's neighbour spacing", () => {
  // The three Mazatzal sources, whose PostGIS-computed spacing we already know.
  const chilson = { lat: 34.08587, lon: -111.49097 };
  const kahuna = { lat: 34.08716, lon: -111.45293 };
  const castersen = { lat: 34.09059, lon: -111.46653 };

  assert.ok(Math.abs(distanceKm(kahuna, castersen) - 1.31) < 0.02);
  assert.ok(Math.abs(distanceKm(castersen, chilson) - 2.32) < 0.02);
  assert.ok(Math.abs(distanceKm(chilson, kahuna) - 3.51) < 0.02);

  assert.equal(distanceKm(chilson, chilson), 0);
});

test("distance is formatted at a resolution hikers use", () => {
  assert.match(formatDistance(0.03), /ft$/); // close enough to be the same spring
  assert.match(formatDistance(0.5), /mi$/);
  assert.equal(formatDistance(3.21869), "2.0 mi");
  assert.equal(formatDistance(80.4672), "50 mi");
  // Sub-mile gets two decimals, because 0.3 vs 0.35 mi is a real difference
  // when you are deciding whether two pins are the same water source.
  assert.equal(formatDistance(0.804672), "0.50 mi");
});

test("slugify matches the seed script", () => {
  assert.equal(slugify("Big Kahuna Falls - Mazatzal Wilderness"), "big-kahuna-falls-mazatzal-wilderness");
  assert.equal(slugify("Chilson Spring"), "chilson-spring");
  assert.equal(slugify("O'Haco Tank"), "ohaco-tank");
});

// ---------------------------------------------------------------------------
// boundsOf / isWorthFitting — the map's opening view
// ---------------------------------------------------------------------------

/** The eight sources of the 2026-08 backfill, as they actually sit in prod. */
const CORPUS: LatLon[] = [
  { lat: 34.09059, lon: -111.46653 }, // Castersen Seep, Mazatzals
  { lat: 34.08716, lon: -111.45293 }, // Big Kahuna Falls
  { lat: 34.087157, lon: -111.444733 }, // Hawaiian Mist
  { lat: 34.092008, lon: -111.434932 }, // Garden Seep
  { lat: 33.416778, lon: -111.349032 }, // Barks Canyon, Superstitions
  { lat: 33.398729, lon: -111.337641 }, // Bark at Dutchman Crossing
  { lat: 33.900657, lon: -110.935416 }, // McFadden Horse Mtn Gully
  { lat: 33.867269, lon: -110.943174 }, // Cienega Spring
];

test("bounds contain every source", () => {
  const b = boundsOf(CORPUS)!;
  for (const p of CORPUS) {
    assert.ok(p.lat >= b.south && p.lat <= b.north, `${p.lat} outside ${b.south}..${b.north}`);
    assert.ok(p.lon >= b.west && p.lon <= b.east, `${p.lon} outside ${b.west}..${b.east}`);
  }
});

test("bounds are the tightest box, not padded", () => {
  const b = boundsOf(CORPUS)!;
  assert.equal(b.south, 33.398729);
  assert.equal(b.north, 34.092008);
  assert.equal(b.west, -111.46653);
  assert.equal(b.east, -110.935416);
});

test("no points means no bounds, and nothing to fit", () => {
  assert.equal(boundsOf([]), null);
  assert.equal(isWorthFitting(null), false);
});

test("one point has bounds, but fitting them is not worth it", () => {
  // Fitting a zero-span box zooms to the tile server's limit and shows grey.
  const b = boundsOf([{ lat: 34.09059, lon: -111.46653 }])!;
  assert.equal(b.south, b.north);
  assert.equal(isWorthFitting(b), false);
});

test("pins a few hundred metres apart are treated as one place", () => {
  const b = boundsOf([
    { lat: 34.09059, lon: -111.46653 },
    { lat: 34.09159, lon: -111.46753 },
  ])!;
  assert.equal(isWorthFitting(b), false);
});

test("the real corpus is worth fitting — that is the whole bug", () => {
  // ~90 km across. At the old fixed zoom 12 the Superstitions and McFadden
  // sources were off-screen with nothing to say so.
  const b = boundsOf(CORPUS)!;
  assert.ok(isWorthFitting(b));
  assert.ok(
    distanceKm({ lat: b.south, lon: b.west }, { lat: b.north, lon: b.east }) > 80,
  );
});

test("order does not change the bounds", () => {
  assert.deepEqual(boundsOf(CORPUS), boundsOf([...CORPUS].reverse()));
});
