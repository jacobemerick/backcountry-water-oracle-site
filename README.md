# backcountry-water-oracle-site

Web frontend for [**backcountry-water-oracle**](https://github.com/jacobemerick/backcountry-water-oracle)
— the engine that answers *"will that seep be running?"* by correlating a water
source's historical field reports against ~19 years of daily precipitation for
its coordinates.

Lives at **[backcountrywateroracle.com](https://backcountrywateroracle.com)**.

## Status

Early. The landing page is up; source lookup, report entry, and the comparison
table are being built. **See the pinned [roadmap issue](https://github.com/jacobemerick/backcountry-water-oracle-site/issues/20)**
for what's landed and what's next.

## The two things worth knowing before you contribute

**1. The database is the product.** The engine is built, deterministic, and free.
What nobody has is a corpus of dated, scored field reports — so report entry and
the report-back loop aren't features, they're the whole business.

**2. The engine is a retrospective correlator, not a forecaster.** Every headline
number (`%dry`, correlation, type, the as-of read) is derived from *that source's
own* report history. A coordinate with no reports has no forecast, and no amount
of UI makes one appear. The honest fallback is a rain-percentile-vs-climatology
read, which is useful but is explicitly **not** a flow verdict.

## Architecture

Next.js (App Router) on Vercel · Neon Postgres (+PostGIS) · MapLibre GL.

The Python engine stays the source of truth and is invoked from a serverless
function — `forecast.py` is vendored, **not** ported to TypeScript. It's only
~500 lines of stdlib numerics so porting is tempting, but with pluggable precip
backends and zero-report mode queued as engine work, two implementations of an
empirical-Bayes shrinkage estimator will drift.

Convenient consequence: the `sources` + `reports` join *is* the engine's CSV
contract (`source,lat,lon,date,score,status`), so there's no translation layer.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build
npm run lint
```

## Safety

This is a planning aid built from historical correlation, not a measurement of
anything. It must never present a confident verdict on thin data — see the
minimum-n guardrails in the roadmap. People make desert water decisions with
this.

## License

MIT, matching the engine.
