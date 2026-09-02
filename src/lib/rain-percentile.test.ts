import { test } from "node:test";
import assert from "node:assert/strict";
import type { DailySeries } from "./precip.ts";
import {
  MIN_COMPARISON_YEARS,
  WINDOW_DAYS,
  bandOf,
  RAIN_COPY,
  fromEngineRainPercentiles,
  rankAntecedentRain,
  seasonOf,
} from "./rain-percentile.ts";

/**
 * A series from 2007-01-01 through `end`, with `perDay(dayIndex, iso)` inches
 * on each day. Dense and contiguous, exactly as getSeries returns.
 */
function makeSeries(end: string, perDay: (i: number, iso: string) => number): DailySeries {
  const start = "2007-01-01";
  const days =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  const values = Array.from({ length: days }, (_, i) =>
    perDay(i, new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)),
  );
  return { start, values };
}

test("a record-dry window ranks at the bottom, a record-wet one at the top", () => {
  // Every year gets its own flat rate, rising with the year — so 2026 is the
  // wettest on record and its percentile is 100.
  const wettest = makeSeries("2026-08-25", (_, iso) => Number(iso.slice(0, 4)) - 2006);
  const top = rankAntecedentRain(wettest, "2026-08-25");
  assert.ok(top);
  assert.equal(top.percentile, 100);
  assert.equal(top.years, 19);
  assert.equal(top.windowDays, WINDOW_DAYS);

  const driest = makeSeries("2026-08-25", (_, iso) => (iso.startsWith("2026") ? 0 : 1));
  assert.equal(rankAntecedentRain(driest, "2026-08-25")?.percentile, 0);
});

test("the ranking is against the same time of year, not the year as a whole", () => {
  // Winter-wet, summer-dry, every year identical. An August window must come
  // out typical rather than dry — against a year-round distribution it would
  // look like a drought that is really just August.
  const seasonal = makeSeries("2026-08-25", (_, iso) => {
    const month = Number(iso.slice(5, 7));
    return month <= 3 || month === 12 ? 0.5 : 0.01;
  });
  const p = rankAntecedentRain(seasonal, "2026-08-25");
  assert.ok(p);
  assert.equal(bandOf(p), "typical");
});

test("the window ends where the archive ends, not today", () => {
  // ERA5 trails reality by about a week. Treating the missing days as zero rain
  // would manufacture a drought out of a lag.
  const series = makeSeries("2026-08-24", () => 1);
  const p = rankAntecedentRain(series, "2026-08-30");
  assert.ok(p);
  assert.equal(p.asOf, "2026-08-24");
  assert.equal(p.total, WINDOW_DAYS);
});

test("a window tied with the record is typical, not record-dry", () => {
  // The case this actually hits: much of the interior Southwest goes 60 days
  // with no rain most years. Ranked strictly, every one of those years is "much
  // drier than usual" — and a page with no reports would carry a drought
  // warning that is really just August in Arizona.
  const bone = makeSeries("2026-08-25", () => 0);
  const p = rankAntecedentRain(bone, "2026-08-25");
  assert.ok(p);
  assert.equal(p.total, 0);
  assert.equal(p.percentile, 50);
  assert.equal(bandOf(p), "typical");
});

test("too little history, or a gap in it, produces no number at all", () => {
  // A short series cannot be ranked. Silence is the right output — this block
  // is the only number on a page with no reports, so a bad one has nowhere to
  // hide.
  const short = makeSeries("2012-08-25", () => 1);
  assert.equal(rankAntecedentRain(short, "2012-08-25"), null);
  assert.ok(MIN_COMPARISON_YEARS > 5);

  // A hole in the archive is not a dry spell.
  const holed = makeSeries("2026-08-25", (i, iso) => (iso === "2026-08-01" ? NaN : 1));
  assert.equal(rankAntecedentRain(holed, "2026-08-25"), null);
});

test("the summary describes weather and never water", () => {
  const series = makeSeries("2026-08-25", (_, iso) => (iso.startsWith("2026") ? 0 : 1));
  const p = rankAntecedentRain(series, "2026-08-25")!;
  const text = RAIN_COPY.summary(p);

  assert.match(text, /late August/);
  assert.match(text, /0th percentile/);
  assert.match(text, /through 2026-08-24|through 2026-08-25/);
  // The words a flow verdict would use. This block sits on a page with no
  // reports, which makes it the thing most likely to be misread as the answer.
  assert.doesNotMatch(text, /\b(flow|flowing|dry|water|spring|carry)\b/i);
  assert.match(RAIN_COPY.caveat, /not water/i);
});

test("seasons are named the way people say them", () => {
  assert.equal(seasonOf("2026-08-25"), "late August");
  assert.equal(seasonOf("2026-01-05"), "early January");
  assert.equal(seasonOf("2026-12-15"), "mid December");
});

/*
 * fromEngineRainPercentiles — the engine as the producer.
 *
 * Where a source page already has a payload, the engine's own percentile is
 * preferred over recomputing one here, so a coordinate has one answer rather
 * than two. Both sides mid-rank against the same calendar window in prior
 * years; these tests pin the adapter, not the arithmetic.
 */
const enginePayload = (over: Record<string, unknown> = {}) => ({
  "60d": { inches: 1.234, pct: 42.4, n_years: 19, median_in: 1.277, ...over },
});

test("adapts the engine's entry for the copy helpers", () => {
  const r = fromEngineRainPercentiles(enginePayload(), "2026-08-30");
  assert.ok(r);
  assert.equal(r.total, 1.234);
  assert.equal(r.percentile, 42); // whole numbers: 19 years cannot support a decimal
  assert.equal(r.years, 19);
  assert.equal(r.asOf, "2026-08-30");
  assert.equal(r.windowDays, WINDOW_DAYS);
});

test("the same reading yields the same sentence from either producer", () => {
  /*
   * The point of the adapter. A source page and a gazetteer feature page for one
   * spring used to describe it in different words; now the words come from one
   * place and only the arithmetic's origin differs.
   */
  const fromEngine = fromEngineRainPercentiles(enginePayload(), "2026-08-30");
  assert.ok(fromEngine);
  const siteSide = { ...fromEngine, driest: 0.1, wettest: 9.9 };
  assert.equal(RAIN_COPY.summary(fromEngine), RAIN_COPY.summary(siteSide));
  assert.equal(bandOf(fromEngine), bandOf(siteSide));
});

test("says nothing rather than something dishonest", () => {
  // No percentile at all — the engine emits null where no year qualifies.
  assert.equal(fromEngineRainPercentiles(enginePayload({ pct: null }), "2026-08-30"), null);
  // Too few years to rank against, the same floor the site-side path applies.
  assert.equal(
    fromEngineRainPercentiles(
      enginePayload({ n_years: MIN_COMPARISON_YEARS - 1 }),
      "2026-08-30",
    ),
    null,
  );
  // A window the payload does not carry.
  assert.equal(fromEngineRainPercentiles({}, "2026-08-30"), null);
});

test("a different window can be asked for", () => {
  const r = fromEngineRainPercentiles(
    { "180d": { inches: 4.0, pct: 20, n_years: 18 } },
    "2026-08-30",
    180,
  );
  assert.equal(r?.windowDays, 180);
  assert.equal(r?.percentile, 20);
});
