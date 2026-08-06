import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECIP_START, groupKey, roundCoord, seriesEnd, wireKey } from "./precip.ts";

test("coordinates group onto a 2dp grid", () => {
  assert.equal(roundCoord(34.08587), 34.09);
  assert.equal(roundCoord(-111.49097), -111.49);
  assert.equal(roundCoord(34.08716), 34.09);
  assert.equal(roundCoord(-111.45293), -111.45);
  assert.equal(roundCoord(0), 0);
});

test("the wire key is raw, so only Python ever rounds", () => {
  // The bug this prevents: JS Math.round goes away from zero at the half-way
  // point, Python's round goes to even. 34.125 is 34.13 here and 34.12 there.
  // Rounding on both sides meant such a coordinate was stored under one key and
  // looked up under another — and since a miss silently falls back to fetching,
  // the cache would never hit for it and nothing would ever say so.
  assert.equal(roundCoord(34.125), 34.13, "JS rounds half away from zero");
  // Python would say 34.12 for the same input. The wire key sidesteps it:
  assert.equal(wireKey(34.125, -111.455), "34.125,-111.455");
  assert.equal(wireKey(34.08587, -111.49097), "34.08587,-111.49097");

  // Full precision survives, so the service has what it needs to round itself.
  assert.ok(!wireKey(34.08587, -111.49097).includes("34.09"));
});

test("nearby sources share one fetch", () => {
  // groupKey exists only to deduplicate fetches. A disagreement here costs one
  // extra upstream request; that is why it is allowed to be JS-flavoured.
  const chilson = groupKey(34.08587, -111.49097);
  const castersen = groupKey(34.09059, -111.46653);
  const kahuna = groupKey(34.08716, -111.45293);

  assert.equal(chilson, "34.09,-111.49");
  assert.equal(castersen, "34.09,-111.47");
  assert.equal(kahuna, "34.09,-111.45");
  assert.equal(new Set([chilson, castersen, kahuna]).size, 3, "three distinct cells");

  // A source pinned a few metres away shares the cell, so it costs no fetch.
  assert.equal(groupKey(34.0859, -111.49099), chilson);
});

test("seriesEnd derives the last day from start plus length", () => {
  // Dates are implied by position rather than stored, which is what halves the
  // payload; that only works if this arithmetic is right.
  assert.equal(seriesEnd({ start: "2007-01-01", values: [0] }), "2007-01-01");
  assert.equal(seriesEnd({ start: "2007-01-01", values: [0, 0, 0] }), "2007-01-03");

  // Across a leap day.
  assert.equal(seriesEnd({ start: "2024-02-27", values: new Array(4).fill(0) }), "2024-03-01");

  // A full year of 2007 lands where it should.
  assert.equal(seriesEnd({ start: PRECIP_START, values: new Array(365).fill(0) }), "2007-12-31");
});

test("a longer cached series still covers an earlier date", () => {
  // The engine trims to the as-of date itself, so one row per coordinate
  // answers every date — this is why the cache is not keyed on the end date.
  const series = { start: "2007-01-01", values: new Array(7000).fill(0) };
  const end = seriesEnd(series);
  assert.ok(end > "2026-01-01");
  assert.ok(end >= "2020-06-15", "a 2020 as-of date is served by this row");
});
