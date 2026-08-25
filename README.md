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

Next.js (App Router) on Vercel · Neon Postgres (+PostGIS) · Leaflet.

The basemap is USGS's National Map — public domain, no API key, and, the reason
it beats a generic street basemap here, *topographic*. Someone placing a spring
is reading terrain: drainages, contours, benches. A road map shows them almost
nothing useful. Imagery is offered alongside, because a seep is often easier to
spot as a green smudge in a dry canyon than as a contour.

The Python engine stays the source of truth and is invoked from a serverless
function — `forecast.py` is vendored, **not** ported to TypeScript. It's only
~500 lines of stdlib numerics so porting is tempting, but with pluggable precip
backends and zero-report mode queued as engine work, two implementations of an
empirical-Bayes shrinkage estimator will drift.

Convenient consequence: the `sources` + `reports` join *is* the engine's CSV
contract (`source,lat,lon,date,score,status`), so there's no translation layer.

## What is archived, and why

A scheduled job mirrors the public water-report sheets to Postgres, weekly.
This is **preservation only** — nothing it captures is parsed into `sources` or
`reports`.

The PCT Water Report keeps roughly twelve months of updates and drops the rest,
so about 1,500 dated observations age out every year. There is no safety net:
the Wayback Machine has never captured these sheets, and a check of the CDX
index for both the legacy and current export URLs returns zero snapshots. Every
season nobody mirrors them is gone permanently.

Raw bytes are stored immutably and deduplicated by content hash, so the sheets'
daily in-season edits cost one row each and their long off-season silence costs
nothing. Snapshots are keyed on the Google document id rather than a name,
because the labels are the part that drifts — three of the seven were misfiled
in the spec this was built from. The title and the stewards' own
`Updated … by <steward>` line are read from each fetch, so a snapshot's label
always describes the bytes beside it.

Every attempt is recorded whether or not it succeeded. A silent dead cron is
this job's whole failure mode, so the absence of recent rows in
`sheet_fetch_attempts` is the alarm, and a partial failure returns a non-2xx so
it shows up red rather than silently green.

**Attribution.** The PCT Water Report is volunteer work with a documented
lineage — Halfmile originally, stewarded now by Druid and others. It carries no
licence grant, only a warranty disclaimer. Mirroring for preservation is
defensible; anything public-facing needs a permission conversation first, and
the stewards get credited by name wherever this data eventually surfaces.

## Development

```bash
npm install
npm run engine:install   # venv at services/engine/.venv from the pinned engine
npm run dev              # http://localhost:3000
npm run build
npm run lint
npm test                 # typecheck + node:test + the engine parity suite
```

`engine:install` is needed because the engine is a dependency rather than a
checked-in file. Locally the site shells out to that venv's `water-forecast`;
in production it calls the engine service over `ENGINE_URL` instead.

To move to a different engine release:

```bash
./scripts/bump-engine.sh            # latest release
./scripts/bump-engine.sh v0.2.0     # a specific tag
npm run engine:install && npm test  # fixtures are recorded from the engine, so
                                    # a contract change fails here — the point
```

### Database

Create a Neon project, then:

```bash
cp .env.example .env.local     # paste your DATABASE_URL
npm run db:migrate -- --dry    # show pending migrations
npm run db:migrate             # apply them
```

Migrations are plain SQL in `db/migrations/`, applied forward-only in filename
order and recorded in `_migrations`. There is no rollback — to undo something,
write a new migration. The runner refuses to proceed if an already-applied file
has been edited, since that means the file and the database have quietly
diverged.

To try the schema without Neon:

```bash
docker run -d --rm --name bwo-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=bwo \
  -p 55433:5432 postgis/postgis:16-3.4
docker exec -i bwo-pg psql -U postgres -d bwo < db/migrations/0001_init.sql
```

PostGIS is required — `sources.geog` is a generated column, and the neighbor
lookups behind pooling and route mode are `ST_DWithin` queries against it.

## Safety

This is a planning aid built from historical correlation, not a measurement of
anything. It must never present a confident verdict on thin data — see the
minimum-n guardrails in the roadmap. People make desert water decisions with
this.

## License

MIT, matching the engine.
