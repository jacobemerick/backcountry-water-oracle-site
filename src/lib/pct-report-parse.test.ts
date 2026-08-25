import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECIP_RECORD_START } from "./rubric.ts";
import {
  findColumns,
  parseCsv,
  parseWaterReport,
  resolveYear,
  sheetDateFrom,
  splitEntries,
} from "./pct-report-parse.ts";

/** The real shape: header on row 6, report cells stacking dated entries. */
const SHEET = `" Pacific Crest Trail Water Report ",,,,,Updated 06/27/2026 @ 5:46 pm  by Druid,
Campo CA to Idyllwild CA,,,,,,
Map,Mile,Waypoint,Location,Report,Date,Reported By
California Section A,,,,,,
A1,0.5,"WR001
PCTAID_1",Camp Lockett faucets,"03/15/26 (SoloNotSolo): faucets on
09/19/24 (Monty T): all faucets flowing
02/06/23 (Erin G): water is on",3/15/26,SoloNotSolo
A2,~12.3,PCTAID_7,Hauser Creek,"04/01/26 (Roadrunner): flowing well
    still good two days later",4/1/26,Roadrunner
`;

test("csv parsing keeps newlines inside quoted cells", () => {
  const rows = parseCsv(SHEET);
  const data = rows.find((r) => r[0] === "A1")!;
  assert.ok(data[4].includes("\n"), "the report cell must survive as one field");
  assert.equal(data[2], "WR001\nPCTAID_1");
});

test("columns are found by name, at whatever row they sit on", () => {
  const cols = findColumns(parseCsv(SHEET))!;
  assert.equal(cols["mile"], 1);
  assert.equal(cols["report"], 4);
  assert.equal(cols["waypoint"], 2);
});

test("a sheet with Elevation where others have Waypoint still parses", () => {
  // The Snow & Ford Report does exactly this. Reading column 2 blind would
  // file elevations as waypoint ids.
  const odd = SHEET.replace("Map,Mile,Waypoint,", "Map,Mile,Elevation,");
  const cols = findColumns(parseCsv(odd))!;
  assert.equal(cols["waypoint"], undefined);
  assert.equal(cols["elevation"], 2);
  const r = parseWaterReport(odd, "2026-06-27");
  assert.ok(r.entries.length > 0);
  assert.deepEqual(r.entries[0].waypoints, [], "elevation must not become a waypoint");
});

test("entries split on the date head, not on newlines", () => {
  // An entry's text wraps. Splitting on "\n" would shred one observation into
  // fragments, most of them dateless.
  const cell = `04/01/26 (Roadrunner): flowing well
    still good two days later
03/15/26 (Erin G): a trickle`;
  const parts = splitEntries(cell);
  assert.equal(parts.length, 2);
  assert.match(parts[0].text, /flowing well\s+still good two days later/);
  assert.equal(parts[1].who, "Erin G");
});

test("two-digit years resolve against the sheet's own date", () => {
  assert.equal(resolveYear(3, 15, 26, "2026-06-27"), "2026-03-15");
  assert.equal(resolveYear(12, 20, 25, "2026-06-27"), "2025-12-20");
});

test("a date after the sheet was written is refused", () => {
  // It cannot be an observation, and fed to the engine it would be correlated
  // against rainfall that has not happened yet.
  assert.equal(resolveYear(12, 20, 26, "2026-06-27"), null);
});

test("impossible calendar dates are refused, not rolled over", () => {
  // Date() would happily turn 02/31 into March 3rd.
  assert.equal(resolveYear(2, 31, 26, "2026-12-31"), null);
  assert.equal(resolveYear(13, 1, 26, "2026-12-31"), null);
  assert.equal(resolveYear(2, 29, 24, "2026-12-31"), "2024-02-29", "a real leap day survives");
});

test("the whole sheet parses to dated observations", () => {
  const r = parseWaterReport(SHEET, "2026-06-27");
  // Three stacked entries on the first row, one on the second — the wrapped
  // "still good two days later" is continuation text, not a fourth entry.
  assert.equal(r.entries.length, 4);

  const first = r.entries[0];
  assert.equal(first.mile, 0.5);
  assert.deepEqual(first.waypoints, ["WR001", "PCTAID_1"]);
  assert.equal(first.observedOn, "2026-03-15");
  assert.equal(first.reporter, "SoloNotSolo");
  assert.equal(first.text, "faucets on");

  // "~12.3" — the tilde is a precision claim we cannot act on; the mile is real.
  const hauser = r.entries.find((e) => e.location === "Hauser Creek")!;
  assert.equal(hauser.mile, 12.3);
});

test("reports before the precipitation record are dropped and counted", () => {
  // Not silently: n, %dry and every correlation describe what was used, so a
  // quiet drop makes the corpus look different from what it is.
  const old = SHEET.replace("02/06/23 (Erin G): water is on", "02/06/03 (Erin G): water is on");
  const r = parseWaterReport(old, "2026-06-27");
  assert.equal(r.dropped["before-precip-record"], 1);
  assert.ok(PRECIP_RECORD_START > "2003-02-06");
});

test("undated prose is dropped rather than guessed at", () => {
  const prose = SHEET.replace(
    "03/15/26 (SoloNotSolo): faucets on",
    "faucets were on when I passed",
  );
  const r = parseWaterReport(prose, "2026-06-27");
  assert.ok(!r.entries.some((e) => e.text.includes("when I passed")));
});

test("the sheet's own updated line gives the reference date", () => {
  assert.equal(sheetDateFrom("Updated 06/27/2026 @ 5:46 pm by Druid"), "2026-06-27");
  assert.equal(sheetDateFrom("Updated 08/24/26 9:11 pm by Druid"), "2026-08-24");
  assert.equal(sheetDateFrom(null), null);
  assert.equal(sheetDateFrom("no date here"), null);
});
