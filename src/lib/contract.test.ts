import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ForecastResult } from "./forecast.ts";
import { hasRead } from "./forecast.ts";
import { SMALL_N_THRESHOLD, confidenceOf, monthlyFlow, verdictTone } from "./present.ts";

/**
 * Guards the boundary with the Python engine.
 *
 * The fixtures are real `forecast.py --format json` output, not hand-written — a
 * hand-written fixture only ever encodes what we already believed. This suite
 * exists because `notes` was typed as string[] when the engine actually emits
 * {kind, source, message} objects: everything compiled, the local run happened
 * to have zero notes, and the mistake only surfaced as a prerender crash in
 * production.
 *
 * The CSV inputs are committed beside the fixtures. After ./scripts/bump-engine.sh,
 * run ./scripts/record-fixtures.sh and then this suite: a payload change shows up
 * as a failing assertion here rather than as a 500 in production. It did exactly
 * that on the 0.2.0 bump, which is the whole point.
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

test("a source with no usable reports is present, null, and explained", () => {
  // Changed by engine 0.2.0. It used to be dropped from sources[] and mentioned
  // only in notes; now it is carried with n=0 so it can still offer rain
  // context. Silence either way would read as "no data on that spring" when the
  // truth is "its reports predate the precipitation record".
  const ancient = WITH_NOTES.sources.find((s) => s.name === "Ancient Tank");
  assert.ok(ancient, "a source with no usable reports must still appear");
  assert.equal(ancient.n, 0);
  assert.ok(WITH_NOTES.notes.some((n) => n.source === "Ancient Tank"));

  // The keys are present and null, never absent — nothing should have to test
  // for existence before reading them.
  for (const k of ["verdict", "best", "type", "pct_dry", "mean_flow",
                   "precip_in", "predicted_flow"] as const) {
    assert.ok(k in ancient, `${k} must be present even with no read`);
    assert.equal(ancient[k], null, `${k} must be null with no read`);
  }

  // And the guard the UI relies on actually rejects it.
  assert.equal(hasRead(ancient), false);
});

test("hasRead accepts every source that has a verdict", () => {
  for (const s of THREE.sources) {
    assert.ok(hasRead(s), `${s.name} has a verdict and must narrow`);
  }
});

test("rain context is present even with no reports at all", () => {
  // The only reading an unreported coordinate gets, and explicitly not a flow
  // verdict. Its presence here is what unblocks the rainfall block on the
  // thin-source page (#12).
  const ancient = WITH_NOTES.sources.find((s) => s.name === "Ancient Tank")!;
  const windows = Object.keys(ancient.rain_percentiles);
  assert.ok(windows.length > 0, "rain_percentiles must be populated with n=0");
  for (const w of windows) {
    const p = ancient.rain_percentiles[w];
    assert.ok(isNum(p.inches) && isNum(p.median_in));
    assert.ok(p.pct >= 0 && p.pct <= 100, `${w} percentile out of range: ${p.pct}`);
    assert.ok(p.n_years > 0);
  }
  assert.ok(Array.isArray(ancient.neighbors));
  assert.equal(typeof ancient.neighbors_disagree, "boolean");
});

test("radar is off on this host, in the recorded payload", () => {
  // app.py sets RADAR_PROVIDER = None; the fixtures are recorded with
  // --radar=none to match. If a bump re-enables it, this fails here rather
  // than as a function timeout in production.
  for (const result of [THREE, WITH_NOTES]) {
    for (const s of result.sources) assert.equal(s.radar_check, null, s.name);
  }
});

test("every field the UI reads is present and the right type", () => {
  assert.equal(THREE.sources.length, 3);

  for (const s of THREE.sources) {
    assert.equal(typeof s.name, "string");
    assert.ok(hasRead(s), `${s.name} should have a read in this fixture`);
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

test("report accounting is present and internally consistent", () => {
  for (const result of [THREE, WITH_NOTES]) {
    for (const s of result.sources) {
      const r = s.reports;
      assert.ok(r, `${s.name} has no reports accounting`);

      // `used` is the number every headline stat is computed from, so if it
      // ever diverges from `n` the UI is describing a different sample than it
      // claims to.
      assert.equal(r.used, s.n, `${s.name}: used should equal n`);
      assert.equal(
        r.total,
        r.used + r.excluded_before_precip + r.excluded_after_precip,
        `${s.name}: total should account for every report`,
      );
      assert.ok(r.total >= r.used);

      assert.equal(r.precip_span.length, 2);
      for (const d of r.precip_span) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(r.precip_span[0] < r.precip_span[1]);
    }
  }
});

test("partial exclusions are visible rather than silently shrinking n", () => {
  // Engine #10: reports outside the precipitation record used to vanish, so n
  // (and %dry, mean flow, every correlation) quietly described a subset.
  const chilson = WITH_NOTES.sources.find((s) => s.name === "Chilson Spring")!;
  assert.equal(chilson.reports.total, 3);
  assert.equal(chilson.reports.used, 2);
  assert.equal(chilson.reports.excluded_before_precip, 1);
  assert.ok(
    chilson.reports.total > chilson.n,
    "fixture must exercise the partial-exclusion banner",
  );
});

test("a fully-excluded source is skipped with a note explaining why", () => {
  const note = WITH_NOTES.notes.find((n) => n.source === "Ancient Tank");
  assert.ok(note, "expected a note for the fully-excluded source");
  assert.equal(note.kind, "skip");
  // Should say what happened, not just that nothing happened.
  assert.match(note.message, /usable/);
  assert.match(note.message, /predate/);
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

/**
 * SMALL_N_THRESHOLD mirrors a number that actually lives in the engine, so it
 * is asserted against real engine output rather than trusted. Castersen has
 * n=15 and carries small_n; Big Kahuna has n=160 and does not. If the engine
 * ever moves its threshold, this fails instead of the copy quietly lying.
 */
test("SMALL_N_THRESHOLD agrees with the engine's own small_n flag", () => {
  for (const s of THREE.sources) {
    assert.equal(
      s.small_n,
      s.n < SMALL_N_THRESHOLD,
      `${s.name} has n=${s.n}; small_n should be ${s.n < SMALL_N_THRESHOLD}`,
    );
  }
});

/**
 * `analog_n` / `pred_is_constant` — engine 0.3.0.
 *
 * The engine averages the ANALOG_K past reports whose antecedent rain best
 * matched today's. Below that width the "nearest" analogs are the whole
 * history, so the sort selects nothing and the read is the same on every date.
 * These three tests pin the shape, the arithmetic, and — the one that matters —
 * the relationship to this site's own floor.
 */
test("analog_n and pred_is_constant are present, and null exactly where a read is", () => {
  for (const result of [THREE, WITH_NOTES]) {
    for (const s of result.sources) {
      if (hasRead(s)) {
        assert.ok(isNum(s.analog_n), `${s.name}: analog_n should be a number`);
        assert.equal(typeof s.pred_is_constant, "boolean", `${s.name}: pred_is_constant`);
      } else {
        // Null, never absent and never false — false would assert something
        // about a read that does not exist.
        assert.equal(s.analog_n, null, `${s.name}: analog_n should be null`);
        assert.equal(s.pred_is_constant, null, `${s.name}: pred_is_constant should be null`);
      }
    }
  }
});

test("pred_is_constant is exactly 'the pool was the whole history'", () => {
  const seen = new Set<boolean>();
  for (const result of [THREE, WITH_NOTES]) {
    for (const s of result.sources) {
      if (!hasRead(s)) continue;
      assert.ok(s.analog_n <= s.n, `${s.name}: analog_n ${s.analog_n} exceeds n ${s.n}`);
      assert.equal(
        s.pred_is_constant,
        s.analog_n === s.n,
        `${s.name}: n=${s.n}, analog_n=${s.analog_n}`,
      );
      seen.add(s.pred_is_constant);
    }
  }
  // Both branches have to be exercised or this test proves nothing. Chilson at
  // n=2 in the notes fixture is the true case; the three-source fixture is false.
  assert.deepEqual([...seen].sort(), [false, true], "fixtures must cover both");
});

/**
 * The load-bearing one: **the floor still dominates the engine's boundary.**
 *
 * MIN_REPORTS_FOR_VERDICT (10) is a judgement about confidence; the engine's
 * analog width (5) is arithmetic. Today the first is the stricter of the two,
 * so no source we show a verdict for can have a constant read — the copy in
 * TheRead's no-verdict branch is safe to phrase as "the number we are not
 * showing you", and nothing on the site ever renders a verdict the engine
 * considers structurally frozen.
 *
 * That is a relationship between two numbers owned by two repos, and nothing
 * enforces it. If the engine ever raised ANALOG_K to 10 or beyond, this fails —
 * which is the signal that the floor has to move too, not that the test is wrong.
 */
test("no source above the site's floor has a constant read", () => {
  for (const result of [THREE, WITH_NOTES]) {
    for (const s of result.sources) {
      if (!hasRead(s) || !s.pred_is_constant) continue;
      assert.equal(
        confidenceOf(s),
        "none",
        `${s.name} (n=${s.n}) has a frozen read but the site would show it`,
      );
    }
  }
});
