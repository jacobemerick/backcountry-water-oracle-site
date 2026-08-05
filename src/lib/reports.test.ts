import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STATUS, todayIso, validateReport } from "./reports.ts";
import { PRECIP_LAG_DAYS, PRECIP_RECORD_START, RUBRIC, isRubricScore, nearestStep } from "./rubric.ts";

const TODAY = "2026-08-05";
const valid = { observedOn: "2026-06-01", score: 0.4, status: "trickle at the box" };

test("accepts a well-formed report", () => {
  const r = validateReport(valid, TODAY);
  assert.ok(r.ok);
  assert.equal(r.value.observedOn, "2026-06-01");
  assert.equal(r.value.score, 0.4);
  assert.equal(r.value.status, "trickle at the box");
  assert.deepEqual(r.warnings, []);
});

test("rejects a future observation date", () => {
  // Every correlation runs against rainfall antecedent to this date, and
  // rainfall after today does not exist.
  const r = validateReport({ ...valid, observedOn: "2026-08-06" }, TODAY);
  assert.ok(!r.ok);
  assert.match(r.error, /future/i);

  // Today itself is fine — people report from the trailhead.
  assert.ok(validateReport({ ...valid, observedOn: TODAY }, TODAY).ok);
});

test("a very recent report is accepted, with the archive lag explained", () => {
  // The most valuable contributor there is — someone reporting water they saw
  // on Tuesday. Their report cannot be correlated *yet*, which is entirely
  // different from unusable, and silence would look like it was ignored.
  for (const daysAgo of [0, 1, PRECIP_LAG_DAYS - 1]) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = validateReport({ ...valid, observedOn: d }, TODAY);
    assert.ok(r.ok, `${d} should be accepted`);
    assert.equal(r.warnings.length, 1, `${d} should warn once`);
    assert.match(r.warnings[0], /behind|few days/i);
  }

  // Just outside the lag: usable immediately, so nothing to say.
  const settled = new Date(Date.parse(`${TODAY}T00:00:00Z`) - PRECIP_LAG_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const settledResult = validateReport({ ...valid, observedOn: settled }, TODAY);
  assert.ok(settledResult.ok);
  assert.deepEqual(settledResult.warnings, []);
});

test("rejects dates that match the pattern but do not exist", () => {
  for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10"]) {
    const r = validateReport({ ...valid, observedOn: bad }, TODAY);
    assert.ok(!r.ok, `${bad} should be rejected`);
  }
});

test("rejects malformed or missing dates", () => {
  for (const bad of ["", "yesterday", "08/01/2026", "2026-8-1"]) {
    const r = validateReport({ ...valid, observedOn: bad }, TODAY);
    assert.ok(!r.ok, `${JSON.stringify(bad)} should be rejected`);
    assert.match(r.error, /date/i);
  }
});

test("accepts a pre-2007 report but warns it cannot be used", () => {
  // Kept rather than refused: the observation is real, and the engine now
  // reports such exclusions per source instead of dropping them silently.
  const r = validateReport({ ...valid, observedOn: "2001-05-01" }, TODAY);
  assert.ok(r.ok, "should be recorded, not rejected");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /rainfall record/i);
  assert.match(r.warnings[0], new RegExp(PRECIP_RECORD_START));
});

test("only the six rubric anchors are accepted", () => {
  for (const step of RUBRIC) {
    assert.ok(validateReport({ ...valid, score: step.score }, TODAY).ok, `${step.score} should pass`);
  }
  // In range but off-rubric: a client that has drifted. Accepting it silently
  // would let a second, undocumented scale into the corpus.
  for (const off of [0.35, 0.5, 0.75, 0.99]) {
    const r = validateReport({ ...valid, score: off }, TODAY);
    assert.ok(!r.ok, `${off} should be rejected`);
    assert.match(r.error, /rubric/i);
  }
});

test("rejects out-of-range and non-numeric scores", () => {
  for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(!validateReport({ ...valid, score: bad }, TODAY).ok, `${bad} should be rejected`);
  }
});

/** Validate and assert success, returning the value — keeps the narrowing local. */
function accepted(input: Parameters<typeof validateReport>[0], today = TODAY) {
  const r = validateReport(input, today);
  assert.ok(r.ok, `expected acceptance, got: ${r.ok ? "" : r.error}`);
  return r;
}

test("notes are trimmed, capped, and empty becomes null", () => {
  assert.equal(accepted({ ...valid, status: "   " }).value.status, null);
  assert.equal(accepted({ ...valid, status: undefined }).value.status, null);
  assert.equal(accepted({ ...valid, status: null }).value.status, null);

  const long = validateReport({ ...valid, status: "x".repeat(MAX_STATUS + 200) }, TODAY);
  assert.ok(long.ok);
  assert.equal(long.value.status!.length, MAX_STATUS);

  const padded = validateReport({ ...valid, status: "  dry  " }, TODAY);
  assert.ok(padded.ok);
  assert.equal(padded.value.status, "dry");
});

test("the rubric spans dry to raging in even steps", () => {
  assert.equal(RUBRIC.length, 6);
  assert.equal(RUBRIC[0].score, 0);
  assert.equal(RUBRIC[RUBRIC.length - 1].score, 1);
  // Monotonic, so the radio list reads as a scale rather than a menu.
  for (let i = 1; i < RUBRIC.length; i++) {
    assert.ok(RUBRIC[i].score > RUBRIC[i - 1].score);
  }
  for (const step of RUBRIC) {
    assert.ok(step.label.length > 0 && step.detail.length > 0, `${step.score} needs both`);
    assert.ok(isRubricScore(step.score));
  }
});

test("nearestStep maps interpolated import scores onto the scale", () => {
  // Bulk imports interpolate; display still has to pick a label.
  assert.equal(nearestStep(0.0).label, "Dry");
  assert.equal(nearestStep(0.34).score, 0.4);
  assert.equal(nearestStep(0.71).score, 0.8);
  assert.equal(nearestStep(1.0).label, "Raging");
});

test("todayIso is a plain ISO date", () => {
  assert.match(todayIso(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayIso(new Date("2026-08-05T23:30:00Z")), "2026-08-05");
});
