import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESHNESS_NOTE, describeAge, freshnessOf } from "./present.ts";

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
