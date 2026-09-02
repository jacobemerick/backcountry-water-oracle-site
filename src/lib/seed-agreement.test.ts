import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./report-import.ts";
import { isRubricScore } from "./rubric.ts";

/**
 * The two seed files record overlapping visits on two different scales.
 *
 * `jacob-field-notes-*.csv` comes from the triplog app, which scores **0-4
 * droplets**, mapped onto the rubric per the note on #73 (0.0 / 0.2 / 0.4 / 0.8 /
 * 1.0 — 0.6 is unused). `mazatzal-wilderness.csv` is the engine corpus, scraped
 * from hikeArizona source pages, which carry the **nine-label flow vocabulary**.
 *
 * The same visit is often in both, and they disagree — five droplet levels cannot
 * separate nine labels, so 3 droplets has been recorded as "Medium flow" (0.6)
 * three times and "Gallon per minute" (0.8) once. **That is lossiness in the
 * coarser instrument, not a bad row.** Engine#37 read it as a scoring error and
 * an earlier version of this file asserted the two must match; both were wrong,
 * and the assertion would have rejected any future batch scored per #73.
 *
 * So this reports the overlap instead of policing it. A disagreement is a fact
 * about two records of one visit, and the useful thing is that it is visible when
 * someone is deciding how to score the next batch — not that CI stops.
 */
const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "seed");

type Row = { source: string; date: string; score: number };

function readSeed(file: string): Row[] {
  const table = parseCsv(readFileSync(join(SEED_DIR, file), "utf8"))
    .filter((r) => r.some((c) => c.trim() !== ""));
  const header = table[0].map((h) => h.trim().toLowerCase());
  const at = (r: string[], key: string) => (r[header.indexOf(key)] ?? "").trim();
  return table
    .slice(1)
    .map((r) => ({ source: at(r, "source"), date: at(r, "date"), score: Number(at(r, "score")) }))
    // Coordinate-only pins carry no date and no score; they are not observations.
    .filter((r) => r.date !== "" && Number.isFinite(r.score));
}

const FIELD_NOTES = "jacob-field-notes-2026-08.csv";
const CORPUS = "mazatzal-wilderness.csv";

/**
 * This one DOES fail. Every score in either file has to land on a rubric anchor
 * whatever scale produced it — that catches a typo or a stray column without
 * taking a position on which record of a visit is right.
 */
test("every seeded score is on the rubric", () => {
  for (const file of [FIELD_NOTES, CORPUS]) {
    for (const r of readSeed(file)) {
      assert.ok(isRubricScore(r.score), `${file}: ${r.source} ${r.date} scored ${r.score}`);
    }
  }
});

test("report where the two scales disagree about one visit", (t) => {
  const corpus = new Map<string, number[]>();
  for (const r of readSeed(CORPUS)) {
    const key = `${r.source}|${r.date}`;
    corpus.set(key, [...(corpus.get(key) ?? []), r.score]);
  }

  let overlapping = 0;
  const differing: string[] = [];
  for (const r of readSeed(FIELD_NOTES)) {
    const seen = corpus.get(`${r.source}|${r.date}`);
    if (!seen) continue;
    overlapping++;
    if (!seen.some((s) => Math.abs(s - r.score) < 1e-9)) {
      differing.push(`${r.source} ${r.date}: triplog ${r.score}, corpus ${seen.join("/")}`);
    }
  }

  // The only assertion: that the comparison still has something to compare. If the
  // files stop overlapping this goes quiet, and quiet would read as agreement.
  assert.ok(overlapping > 0, "the two seed files no longer share an observation");
  t.diagnostic(`${overlapping} visits in both files, ${differing.length} scored differently`);
  for (const d of differing) t.diagnostic(d);
});
