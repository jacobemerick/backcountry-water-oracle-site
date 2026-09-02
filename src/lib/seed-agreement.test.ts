import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./report-import.ts";
import { isRubricScore } from "./rubric.ts";

/**
 * The two seed files describe overlapping reality, and must agree about it.
 *
 * `jacob-field-notes-*.csv` is what goes to production; `mazatzal-wilderness.csv`
 * is the engine's corpus, where the same observation often already appears --
 * scraped from a source page whose free text carried the vocabulary label
 * ("Medium flow", "Quart per minute") that the hand-authored field notes do not.
 *
 * That asymmetry is exactly how #37 happened: four rows were hand-scored on a
 * different scale than the corpus used for the same days, and nothing could see
 * it, because the field-note rows carry no label to check the number against.
 * The corpus is the label. This compares them.
 *
 * Honest disagreement is allowed. Two people can report one spring on one day
 * and see different things, so the corpus legitimately holds several scores for
 * a single (source, date) -- the assertion is that the field-note score is one
 * of them, not that the corpus holds only one.
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

test("every seeded score is on the rubric", () => {
  for (const file of [FIELD_NOTES, CORPUS]) {
    for (const r of readSeed(file)) {
      assert.ok(isRubricScore(r.score), `${file}: ${r.source} ${r.date} scored ${r.score}`);
    }
  }
});

test("field notes and the corpus agree where they describe the same observation", () => {
  const corpus = new Map<string, number[]>();
  for (const r of readSeed(CORPUS)) {
    const key = `${r.source}|${r.date}`;
    corpus.set(key, [...(corpus.get(key) ?? []), r.score]);
  }

  const disagreements: string[] = [];
  let overlapping = 0;
  for (const r of readSeed(FIELD_NOTES)) {
    const seen = corpus.get(`${r.source}|${r.date}`);
    if (!seen) continue;
    overlapping++;
    if (!seen.some((s) => Math.abs(s - r.score) < 1e-9)) {
      disagreements.push(`${r.source} ${r.date}: field notes ${r.score}, corpus ${seen.join("/")}`);
    }
  }

  // A guard that stopped overlapping would pass silently forever.
  assert.ok(overlapping > 0, "the two seed files no longer share an observation");
  assert.deepEqual(disagreements, []);
});
