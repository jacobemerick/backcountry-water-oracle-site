import { test } from "node:test";
import assert from "node:assert/strict";
import { toEngineCsv, type EngineRow } from "./engine-csv.ts";

const row = (over: Partial<EngineRow> = {}): EngineRow => ({
  source: "Chilson Spring",
  lat: 34.08587,
  lon: -111.49097,
  date: "2025-10-24",
  score: 1,
  status: null,
  ...over,
});

test("emits the engine's exact header", () => {
  assert.equal(toEngineCsv([]).trim(), "source,lat,lon,date,score,status");
});

test("formats a row the way the engine parses it", () => {
  const [, line] = toEngineCsv([row()]).trim().split("\n");
  assert.equal(line, "Chilson Spring,34.08587,-111.49097,2025-10-24,1.00,");
});

test("quotes commas, quotes and newlines in free text", () => {
  const out = toEngineCsv([
    row({ status: 'Gallon+ per minute, box full; he said "raging"' }),
  ]);
  assert.match(out, /"Gallon\+ per minute, box full; he said ""raging"""/);

  // A name with a comma must not silently become two columns.
  const named = toEngineCsv([row({ source: "Tank, Upper", status: null })]);
  assert.match(named, /^"Tank, Upper",/m);

  const multiline = toEngineCsv([row({ status: "dry\nrock tanks held" })]);
  assert.match(multiline, /"dry\nrock tanks held"/);
});

test("keeps one source under one name across its own reports", () => {
  const out = toEngineCsv([
    row({ date: "2024-01-01" }),
    row({ date: "2024-02-01" }),
    row({ date: "2024-03-01" }),
  ]);
  const names = out.trim().split("\n").slice(1).map((l) => l.split(",")[0]);
  assert.deepEqual(names, ["Chilson Spring", "Chilson Spring", "Chilson Spring"]);
});

test("disambiguates a name shared by two different coordinates", () => {
  // The engine adopts the FIRST row's coordinates for every row sharing a name
  // (engine issue #9), so without this the Oregon reports below would be
  // correlated against Arizona rainfall and the output would look normal.
  const out = toEngineCsv([
    row({ source: "Cottonwood Spring", lat: 34.0, lon: -111.0, date: "2024-01-01" }),
    row({ source: "Cottonwood Spring", lat: 44.0, lon: -121.0, date: "2024-02-01" }),
    row({ source: "Cottonwood Spring", lat: 44.0, lon: -121.0, date: "2024-03-01" }),
  ]);
  const lines = out.trim().split("\n").slice(1);
  const names = lines.map((l) => l.split(",")[0]);

  assert.deepEqual(names, [
    "Cottonwood Spring",
    "Cottonwood Spring (2)",
    "Cottonwood Spring (2)",
  ]);

  // Each emitted name must map to exactly one coordinate pair.
  const coordsByName = new Map<string, Set<string>>();
  for (const line of lines) {
    const [name, lat, lon] = line.split(",");
    (coordsByName.get(name) ?? coordsByName.set(name, new Set()).get(name)!).add(`${lat},${lon}`);
  }
  for (const [name, coords] of coordsByName) {
    assert.equal(coords.size, 1, `${name} spans ${coords.size} coordinates`);
  }
});

test("pads scores and coordinates to a stable precision", () => {
  const [, line] = toEngineCsv([row({ score: 0.2, lat: 34, lon: -111 })]).trim().split("\n");
  assert.equal(line, "Chilson Spring,34.00000,-111.00000,2025-10-24,0.20,");
});
