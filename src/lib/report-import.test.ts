import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECIP_RECORD_START } from "./rubric.ts";
import { collectSources, isRealDate, parseReportCsv, slugify } from "./report-import.ts";

const TODAY = "2026-08-25";
const HEADER = "source,lat,lon,date,score,status";
const csv = (...lines: string[]) => parseReportCsv([HEADER, ...lines].join("\n"), TODAY);

/** Real rows from the 2026-08 field-notes backfill. */
const REAL = [
  "Castersen Seep,34.09059,-111.46653,2025-10-16,1.0,\"Tons of water flowing down both creeks, plus there was a surprise seep seeping, tasted wonderful.\"",
  "Big Kahuna Falls - Mazatzal Wilderness,34.08716,-111.45293,2026-05-15,0.2,\"Barely a trickle over the falls. Small stagnant pools under the falls above the trail.\"",
];

test("a real row parses, with the note kept verbatim", () => {
  const { rows, drops, errors } = csv(...REAL);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    source: "Castersen Seep",
    lat: 34.09059,
    lon: -111.46653,
    observedOn: "2025-10-16",
    score: 1.0,
    status: "Tons of water flowing down both creeks, plus there was a surprise seep seeping, tasted wonderful.",
    gnisId: null,
  });
  assert.equal(Object.values(drops).reduce((a, b) => a + b, 0), 0);
});

test("a blank coordinate is allowed — the name resolves against the gazetteer", () => {
  const { rows, drops } = csv("Hawaiian Mist,,,2026-06-30,0.0,");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, null);
  assert.equal(rows[0].status, null);
  assert.equal(drops["partial-coordinate"], 0);
});

test("half a coordinate is a typo, not a coordinate", () => {
  // Resolving the name instead would silently discard the half that was given.
  const { rows, drops } = csv("Garden Seep,34.0928657,,2026-05-15,0.0,");
  assert.equal(rows.length, 0);
  assert.equal(drops["partial-coordinate"], 1);
});

test("a score off the rubric is refused, even inside 0..1", () => {
  const { rows, drops } = csv("Castersen Seep,34.09,-111.46,2026-05-15,0.35,");
  assert.equal(rows.length, 0);
  assert.equal(drops["score-not-on-rubric"], 1);
});

test("every rubric anchor is accepted", () => {
  const lines = [0, 0.2, 0.4, 0.6, 0.8, 1].map(
    (s, i) => `Castersen Seep,34.09,-111.46,2026-0${i + 1}-05,${s},`,
  );
  assert.equal(csv(...lines).rows.length, 6);
});

test("February 31st is refused rather than quietly becoming March 3rd", () => {
  assert.equal(isRealDate("2026-02-31"), false);
  const { rows, drops } = csv("Castersen Seep,34.09,-111.46,2026-02-31,0.4,");
  assert.equal(rows.length, 0);
  assert.equal(drops["impossible-date"], 1);
});

test("a date before the rainfall record cannot be correlated, so it is dropped", () => {
  assert.equal(PRECIP_RECORD_START, "2007-01-01");
  const { rows, drops } = csv("Castersen Seep,34.09,-111.46,2006-12-31,0.4,");
  assert.equal(rows.length, 0);
  assert.equal(drops["before-precip-record"], 1);
});

test("a date after today is refused — it cannot be an observation", () => {
  const { rows, drops } = csv("Castersen Seep,34.09,-111.46,2026-08-26,0.4,");
  assert.equal(rows.length, 0);
  assert.equal(drops["future-date"], 1);
});

test("columns are found by name, so an extra column ahead of them is harmless", () => {
  const { rows } = parseReportCsv(
    ["trip,source,date,score,lat,lon,status", "Mazatzal 2025,Castersen Seep,2025-10-16,1.0,34.09,-111.46,big"].join("\n"),
    TODAY,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "Castersen Seep");
  assert.equal(rows[0].score, 1);
});

test("a missing required column is fatal, not a per-row drop", () => {
  const { errors } = parseReportCsv(["source,lat,lon,status", "x,1,2,y"].join("\n"), TODAY);
  assert.equal(errors.length, 2);
  assert.match(errors.join(" "), /date/);
  assert.match(errors.join(" "), /score/);
});

// ---------------------------------------------------------------------------
// collectSources — engine issue #9 defended at the door
// ---------------------------------------------------------------------------

test("many reports collapse to one source", () => {
  const { rows } = csv(
    "Castersen Seep,34.09059,-111.46653,2025-10-16,1.0,",
    "Castersen Seep,34.09059,-111.46653,2025-11-28,0.8,",
    "Castersen Seep,,,2025-12-06,0.6,",
  );
  const { sources, errors } = collectSources(rows);
  assert.deepEqual(errors, []);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].reports, 3);
  assert.equal(sources[0].lat, 34.09059);
});

test("one name with two coordinates is fatal — the engine would fuse them", () => {
  const { rows } = csv(
    "Bear Spring,34.09,-111.46,2025-10-16,1.0,",
    "Bear Spring,33.10,-110.20,2025-11-28,0.2,",
  );
  const { errors } = collectSources(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /fuses sources by name/);
});

test("two names that collide as one slug are refused", () => {
  const { rows } = csv(
    // Distinct coordinates, so this isolates the slug check from the
    // shared-coordinate one below.
    "Garden Seep,34.09,-111.46,2025-10-16,1.0,",
    "Garden  seep!,34.10,-111.47,2025-11-28,0.2,",
  );
  const { errors } = collectSources(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /slugify/);
});

test("slugs match the ones already in the database", () => {
  assert.equal(slugify("Big Kahuna Falls - Mazatzal Wilderness"), "big-kahuna-falls-mazatzal-wilderness");
  assert.equal(slugify("Castersen Seep"), "castersen-seep");
});

test("several names at one exact coordinate is fatal — a paste, not a survey", () => {
  // The real 2026-08 backfill did exactly this: one Mazatzal coordinate ended up
  // on Hawaiian Mist, Barks Canyon, Bark at Dutchman Crossing and McFadden Horse
  // Mtn Gully. The last three are 50-77 km away from where their names put them.
  const { rows } = csv(
    "Hawaiian Mist,34.087157,-111.444733,2026-06-30,0.0,",
    "Barks Canyon,34.087157,-111.444733,2026-08-09,0.2,",
    "McFadden Horse Mtn Gully,34.087157,-111.444733,2026-08-16,0.8,",
  );
  const { errors } = collectSources(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /3 sources share the exact coordinate/);
  assert.match(errors[0], /Hawaiian Mist/);
});

test("two sources at genuinely different coordinates are fine", () => {
  const { rows } = csv(
    "Castersen Seep,34.09059,-111.46653,2026-06-30,0.0,",
    "Big Kahuna Falls - Mazatzal Wilderness,34.08716,-111.45293,2026-06-30,0.0,",
  );
  assert.deepEqual(collectSources(rows).errors, []);
});

test("a space instead of a comma between lat and lon shifts every column", () => {
  // How two rows of the real backfill went missing: "34.09 -111.43" is one
  // field, so `date` reads the score column and the row is refused.
  const { rows, drops } = csv("Garden Seep,34.092008 -111.434932,2026-05-15,0.0,At least along the trail.");
  assert.equal(rows.length, 0);
  assert.equal(drops["unparseable-date"], 1);
});
