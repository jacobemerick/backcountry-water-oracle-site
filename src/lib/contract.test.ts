import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ForecastResult } from "./forecast.ts";
import { byReliability, confidenceOf, monthlyFlow, verdictTone } from "./present.ts";

/**
 * Guards the boundary with the Python engine.
 *
 * The fixtures are real `forecast.py --json` output, not hand-written — a
 * hand-written fixture only ever encodes what we already believed. This suite
 * exists because `notes` was typed as string[] when the engine actually emits
 * {kind, source, message} objects: everything compiled, the local run happened
 * to have zero notes, and the mistake only surfaced as a prerender crash in
 * production. Re-record the fixtures whenever scripts/sync-engine.sh moves the
 * pinned commit.
 */

const fixture = (name: string): ForecastResult =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", `${name}.json`), "utf8"));

const THREE = fixture("engine-three-sources");
const WITH_NOTES = fixture("engine-with-notes");

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

test("envelope shape", () => {
  for (const result of [THREE, WITH_NOTES]) {
    assert.match(result.asof, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(result.sources));
    assert.ok(Array.isArray(result.notes));
    assert.equal(typeof result.params.pool, "boolean");
    assert.ok(isNum(result.params.pool_radius_km));
    assert.ok(Array.isArray(result.params.windows));
  }
});

test("notes are {kind, source, message} objects, never strings", () => {
  assert.ok(WITH_NOTES.notes.length > 0, "fixture must exercise the notes path");

  for (const note of WITH_NOTES.notes) {
    assert.equal(typeof note, "object", "a note must not be a bare string");
    assert.notEqual(note, null);
    assert.equal(typeof note.kind, "string");
    assert.equal(typeof note.message, "string");
    // null for whole-run failures, a source name otherwise
    assert.ok(note.source === null || typeof note.source === "string");
  }

  const skip = WITH_NOTES.notes.find((n) => n.kind === "skip");
  assert.ok(skip, "expected a skip note");
  assert.equal(skip.source, "Ancient Tank");
});

test("a skipped source is absent from sources but reported in notes", () => {
  // Silence here would read as "no data on that spring" when the truth is
  // "its reports predate the precipitation record".
  const names = WITH_NOTES.sources.map((s) => s.name);
  assert.ok(!names.includes("Ancient Tank"));
  assert.ok(WITH_NOTES.notes.some((n) => n.source === "Ancient Tank"));
});

test("every field the UI reads is present and the right type", () => {
  assert.equal(THREE.sources.length, 3);

  for (const s of THREE.sources) {
    assert.equal(typeof s.name, "string");
    for (const k of ["lat", "lon", "n", "pct_dry", "mean_flow", "annual_precip_in",
                     "predicted_flow", "precip_in", "harmonics"] as const) {
      assert.ok(isNum(s[k]), `${s.name}.${k} should be a finite number, got ${s[k]}`);
    }
    assert.equal(typeof s.small_n, "boolean");
    assert.equal(typeof s.type, "string");
    assert.equal(typeof s.verdict, "string");
    assert.match(s.asof, /^\d{4}-\d{2}-\d{2}$/);

    assert.ok(s.correlations.length > 0);
    for (const c of s.correlations) {
      assert.match(c.window, /^\d+d$/);
      assert.ok(isNum(c.days) && isNum(c.raw_r) && isNum(c.ctrl_r));
      assert.ok(Math.abs(c.ctrl_r) <= 1 && Math.abs(c.raw_r) <= 1, "correlations are bounded");
    }

    assert.match(s.best.window, /^\d+d$/);
    assert.ok(isNum(s.best.r) && isNum(s.best.borrowed) && isNum(s.best.group_n));
    assert.ok(s.best.borrowed >= 0 && s.best.borrowed <= 1, "borrowed is a fraction");
    assert.equal(typeof s.best.signal_check, "string");

    // The best window must be one the engine actually reported on.
    assert.ok(s.correlations.some((c) => c.window === s.best.window));
  }
});

test("mean_flow_by_month is keyed by month number and may have gaps", () => {
  for (const s of THREE.sources) {
    for (const [k, v] of Object.entries(s.mean_flow_by_month)) {
      const m = Number(k);
      assert.ok(Number.isInteger(m) && m >= 1 && m <= 12, `bad month key ${k}`);
      assert.ok(isNum(v) && v >= 0 && v <= 1, `bad flow ${v}`);
    }
  }

  // A month with no reports must stay null, never collapse to 0 — an unvisited
  // month is not a dry month.
  const kahuna = THREE.sources.find((s) => s.name.startsWith("Big Kahuna"))!;
  const months = monthlyFlow(kahuna);
  assert.equal(months.length, 12);
  assert.ok(
    months.some((m) => m.flow === null),
    "this fixture has a month with no reports",
  );
});

test("presentation logic holds against real data", () => {
  const ordered = byReliability(THREE.sources);
  assert.deepEqual(
    ordered.map((s) => s.pct_dry),
    [...ordered.map((s) => s.pct_dry)].sort((a, b) => a - b),
    "most reliable first",
  );
  assert.ok(ordered[0].name.startsWith("Chilson"), "Chilson is driest-proof at 3%");

  const castersen = THREE.sources.find((s) => s.name === "Castersen Seep")!;
  assert.equal(castersen.n, 15);
  assert.equal(confidenceOf(castersen), "weak", "n=15 is above the floor but flagged");

  const kahuna = THREE.sources.find((s) => s.name.startsWith("Big Kahuna"))!;
  assert.equal(confidenceOf(kahuna), "moderate");
  assert.ok(["wet", "marginal", "dry"].includes(verdictTone(kahuna)));
});

test("the minimum-n floor suppresses a verdict on thin data", () => {
  // The engine happily reports r=+1.00 from two observations; the site must not.
  const thin = { ...THREE.sources[0], n: 4, small_n: true };
  assert.equal(confidenceOf(thin), "none");
  assert.equal(verdictTone(thin), "unknown");
});
