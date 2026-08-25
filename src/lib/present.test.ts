import { test } from "node:test";
import assert from "node:assert/strict";
import { RUBRIC } from "./rubric.ts";
import {
  FRESHNESS_NOTE,
  flowLabel,
  MIN_REPORTS_FOR_VERDICT,
  SMALL_N_THRESHOLD,
  THRESHOLD_COPY,
  describeAge,
  freshnessOf,
} from "./present.ts";

const TODAY = new Date("2026-08-05T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(Date.parse("2026-08-05T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

test("freshness is graded around a hiking season", () => {
  assert.equal(freshnessOf(daysAgo(0), TODAY), "fresh");
  assert.equal(freshnessOf(daysAgo(89), TODAY), "fresh");
  assert.equal(freshnessOf(daysAgo(90), TODAY), "recent");
  assert.equal(freshnessOf(daysAgo(364), TODAY), "recent");
  assert.equal(freshnessOf(daysAgo(365), TODAY), "aging");
  assert.equal(freshnessOf(daysAgo(365 * 3 - 1), TODAY), "aging");
  assert.equal(freshnessOf(daysAgo(365 * 3), TODAY), "stale");
  assert.equal(freshnessOf(null, TODAY), "unknown");
});

test("only the concerning grades carry a note", () => {
  // A fresh source needs no explanation; an old one does, and the explanation
  // has to be about the place rather than the statistics. The correlation does
  // not decay — our confidence that the spring is unchanged does.
  assert.equal(FRESHNESS_NOTE.fresh, null);
  assert.equal(FRESHNESS_NOTE.recent, null);
  for (const grade of ["aging", "stale", "unknown"] as const) {
    assert.ok(FRESHNESS_NOTE[grade], `${grade} should explain itself`);
  }
  assert.match(FRESHNESS_NOTE.aging!, /box|channel|fire/i, "should name what changes on the ground");
});

test("freshness is independent of confidence", () => {
  // Two different axes on purpose: a well-sampled stale source and a thin fresh
  // one are genuinely different things, and collapsing them into one number
  // would hide which problem you actually have.
  assert.equal(freshnessOf(daysAgo(5), TODAY), "fresh");
  assert.equal(freshnessOf(daysAgo(2000), TODAY), "stale");
});

test("age reads in the units people think in", () => {
  assert.equal(describeAge(daysAgo(0), TODAY), "today");
  assert.equal(describeAge(daysAgo(1), TODAY), "yesterday");
  assert.equal(describeAge(daysAgo(9), TODAY), "9 days ago");
  assert.equal(describeAge(daysAgo(60), TODAY), "2 months ago");
  assert.equal(describeAge(daysAgo(400), TODAY), "13 months ago");
  assert.equal(describeAge(daysAgo(1100), TODAY), "3 years ago");
  assert.equal(describeAge(null, TODAY), "never");
});

test("a future date does not read as ancient", () => {
  // The report form rejects future dates, but a seeded or imported row could
  // carry one, and "-3 days ago" would be worse than a harmless label.
  const tomorrow = new Date(Date.parse("2026-08-06T00:00:00Z")).toISOString().slice(0, 10);
  assert.equal(freshnessOf(tomorrow, TODAY), "fresh");
  assert.equal(describeAge(tomorrow, TODAY), "today");
});

/**
 * The thresholds are the safety-critical numbers on this site: one decides
 * whether a verdict is shown at all, the other whether it is called weak. The
 * mockups collapsed them into a single "about twenty-five", which described
 * neither. These tests exist so copy can never drift from the constants again.
 */
test("the two thresholds are distinct, and ordered", () => {
  assert.ok(
    MIN_REPORTS_FOR_VERDICT < SMALL_N_THRESHOLD,
    "the no-read floor must sit below the weak-evidence threshold",
  );
});

test("threshold copy is generated from the constants, never typed", () => {
  const floor = String(MIN_REPORTS_FOR_VERDICT);
  const weakAt = String(SMALL_N_THRESHOLD);

  const noRead = THRESHOLD_COPY.noRead(3);
  assert.ok(noRead.includes(floor), "the no-read sentence cites the floor");
  assert.ok(!noRead.includes(weakAt), "the no-read sentence must not cite the weak threshold");
  assert.match(noRead, /no read is issued/);

  const weak = THRESHOLD_COPY.weak(15);
  assert.ok(weak.includes(floor) && weak.includes(weakAt), "the weak sentence cites both");
  assert.match(weak, /weak/i);
  assert.ok(
    !/no read is issued/.test(weak),
    "a weak read is still a read — it must not claim none was issued",
  );
});

test("threshold copy counts singulars and the shortfall correctly", () => {
  assert.match(THRESHOLD_COPY.noRead(1), /^1 report —/);
  assert.match(THRESHOLD_COPY.noRead(0), /^0 reports —/);

  assert.match(THRESHOLD_COPY.needed(MIN_REPORTS_FOR_VERDICT - 1), /^1 more report /);
  assert.match(THRESHOLD_COPY.needed(0), new RegExp(`^${MIN_REPORTS_FOR_VERDICT} more reports `));
  assert.match(THRESHOLD_COPY.needed(MIN_REPORTS_FOR_VERDICT), /enough reports for a read/);
});

/**
 * flowLabel used to carry its own copy of the six rubric labels and one had
 * already drifted. These tests are what stops a second spelling appearing.
 */
test("every flowLabel output is a rubric label", () => {
  const allowed = new Set(RUBRIC.map((step) => step.label));
  for (let i = 0; i <= 100; i++) {
    const label = flowLabel(i / 100);
    assert.ok(allowed.has(label), `flowLabel(${i / 100}) returned "${label}", which is not in RUBRIC`);
  }
});

test("flowLabel spans the whole rubric and stays monotonic", () => {
  assert.equal(flowLabel(0), RUBRIC[0].label);
  assert.equal(flowLabel(1), RUBRIC[RUBRIC.length - 1].label);

  // More water never reads as less. A non-monotonic banding would let a wetter
  // prediction render drier than a drier one.
  let lastIndex = 0;
  for (let i = 0; i <= 100; i++) {
    const index = RUBRIC.findIndex((step) => step.label === flowLabel(i / 100));
    assert.ok(index >= lastIndex, `flowLabel went backwards at ${i / 100}`);
    lastIndex = index;
  }
});

test("ties round down, toward less water", () => {
  // Exactly between two anchors, the drier label wins — overstating a seep is
  // the more expensive error.
  assert.equal(flowLabel(0.1), "Dry");
  assert.equal(flowLabel(0.3), "Pools or dripping");
  assert.equal(flowLabel(0.5), "Trickle");
  assert.equal(flowLabel(0.7), "Moderate");
  assert.equal(flowLabel(0.9), "Strong");
});
