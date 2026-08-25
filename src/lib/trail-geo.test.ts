import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MARKER_GAP_MILES,
  coordForMile,
  matchByName,
  normalizeName,
  parseAtaNum,
  type Marker,
  type NamedPoint,
} from "./trail-geo.ts";

/** Real PCTA tenth-mile markers around mile 100, as the feature service returns them. */
const MARKERS: Marker[] = [
  { mile: 100.0, lat: 33.2082899, lon: -116.5780463 },
  { mile: 100.1, lat: 33.2078788, lon: -116.5787039 },
  { mile: 100.2, lat: 33.2089546, lon: -116.5795878 },
  { mile: 100.3, lat: 33.2100236, lon: -116.5796700 },
  { mile: 100.4, lat: 33.2105257, lon: -116.5806829 },
  { mile: 100.5, lat: 33.2114249, lon: -116.5818798 },
];

test("an exact marker mile returns that marker, untouched", () => {
  const c = coordForMile(MARKERS, 100.3);
  assert.deepEqual(c, { lat: 33.2100236, lon: -116.5796700 });
});

test("a mile between markers interpolates, and stays between them", () => {
  const c = coordForMile(MARKERS, 100.25)!;
  assert.ok(c.lat > 33.2089546 && c.lat < 33.2100236, `lat ${c.lat} left the bracket`);
  // Halfway between two markers a tenth of a mile apart: about 5m of error at
  // worst, well inside the precision of "mile 100.25" in a trail report.
  assert.ok(Math.abs(c.lat - (33.2089546 + 33.2100236) / 2) < 1e-9);
});

test("a mile outside the marker set is refused, not extrapolated", () => {
  assert.equal(coordForMile(MARKERS, 500), null);
  assert.equal(coordForMile(MARKERS, -3), null);
  // Just past the end is still refused once it exceeds the gap tolerance.
  assert.equal(coordForMile(MARKERS, 100.5 + MAX_MARKER_GAP_MILES + 0.01), null);
  // But a hair past the last marker is fine — that is measurement noise.
  assert.ok(coordForMile(MARKERS, 100.51));
});

test("a mile inside too large a gap is refused", () => {
  // A reroute leaves a hole in the marker set. Interpolating a straight line
  // across a mile of switchbacks would place a report on the wrong drainage.
  const gapped: Marker[] = [
    { mile: 10, lat: 34, lon: -111 },
    { mile: 14, lat: 34.2, lon: -111.2 },
  ];
  assert.equal(coordForMile(gapped, 12), null);
});

test("empty and nonsense input never throw", () => {
  assert.equal(coordForMile([], 100), null);
  assert.equal(coordForMile(MARKERS, Number.NaN), null);
  assert.equal(coordForMile(MARKERS, Number.POSITIVE_INFINITY), null);
});

test("ATA_Num decodes to passage and tenth-mile", () => {
  assert.deepEqual(parseAtaNum("01-079"), { passage: 1, mile: 7.9 });
  assert.deepEqual(parseAtaNum("43-000"), { passage: 43, mile: 0 });
  assert.deepEqual(parseAtaNum("02-095"), { passage: 2, mile: 9.5 });
  assert.equal(parseAtaNum("nonsense"), null);
  assert.equal(parseAtaNum("1-79"), null);
});

test("name normalisation collapses the variation that is not meaningful", () => {
  assert.equal(normalizeName("Bathtub Spring  (aka Tub Spring)"), "bathtub spring");
  assert.equal(normalizeName("bathtub spr."), "bathtub spring");
  assert.equal(normalizeName("Sunnyside Cyn"), "sunnyside canyon");
  assert.equal(normalizeName("Rincon Ck"), "rincon creek");
});

test("name normalisation keeps the variation that is", () => {
  // These distinguish genuinely different water. Collapsing them would merge
  // two sources, which halves both records and is worse than no match.
  assert.notEqual(normalizeName("Upper Bear Spring"), normalizeName("Lower Bear Spring"));
  assert.notEqual(normalizeName("North Fork"), normalizeName("South Fork"));
});

test("an off-trail locator and a trailing note are stripped", () => {
  // "0.5 m W" says how far from the trail, not which water — and the same
  // spring carries different distances in different years as the trail moves.
  // Measured: this and the semicolon rule together lift the AZT match rate on
  // a real archived report from 31.8% to 45.9%.
  assert.equal(normalizeName("Bear Spring 0.5 m W"), "bear spring");
  assert.equal(normalizeName("Trap Tank ~0.1mE"), "trap tank");
  assert.equal(normalizeName("Bear Spring 0.5 m W; multiple trees"), "bear spring");

  // Safe only because ambiguity refuses: two different springs reducing to the
  // same name produce two candidates, and matchByName returns null.
  const two = [
    { name: "Bear Spring", lat: 31, lon: -110, externalId: "01-093" },
    { name: "Bear Spring", lat: 34, lon: -111, externalId: "22-041" },
  ];
  assert.equal(matchByName(two, "Bear Spring 0.5 m W"), null);
});

const POINTS: NamedPoint[] = [
  { name: "Bathtub Spring", lat: 31.4068, lon: -110.30566, externalId: "01-079" },
  { name: "Bear Spring", lat: 31.40633, lon: -110.32394, externalId: "01-093" },
  { name: "Bear Spring", lat: 34.5, lon: -111.5, externalId: "22-041" },
];

test("a single match wins", () => {
  const m = matchByName(POINTS, "Bathtub Spring (aka Tub Spring)");
  assert.equal(m?.how, "exact");
  assert.equal(m?.point.externalId, "01-079");
});

test("an ambiguous name is refused unless a passage breaks the tie", () => {
  // Two unrelated Bear Springs, 200 miles apart. Picking either silently would
  // correlate a report against rain that fell somewhere else entirely.
  assert.equal(matchByName(POINTS, "Bear Spring"), null);

  const m = matchByName(POINTS, "Bear Spring", { passage: 22 });
  assert.equal(m?.how, "passage");
  assert.equal(m?.point.externalId, "22-041");

  // A passage that matches neither is still a refusal.
  assert.equal(matchByName(POINTS, "Bear Spring", { passage: 9 }), null);
});

test("an unknown name is a refusal, not a nearest guess", () => {
  assert.equal(matchByName(POINTS, "Nonexistent Tank"), null);
  assert.equal(matchByName(POINTS, "   "), null);
});
