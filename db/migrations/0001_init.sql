-- 0001_init: sources, reports, precip_cache
--
-- Design note that governs this whole file: the `sources` + `reports` join IS
-- the forecast engine's CSV contract --
--
--     source,lat,lon,date,score,status
--
-- so a forecast request is `SELECT ... ORDER BY name, observed_on` piped
-- straight to stdin. Keep it that way. If a column here stops lining up with
-- the contract, the translation layer we avoided starts growing.

CREATE EXTENSION IF NOT EXISTS postgis;

-- --------------------------------------------------------------------------
-- sources
-- --------------------------------------------------------------------------
CREATE TABLE sources (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,

    -- Plain lat/lon are the source of truth: they are what the engine consumes
    -- and what every upstream report format speaks. `geog` is derived, purely
    -- so PostGIS can answer "within X km" for pooling neighborhoods and route
    -- corridors without us hand-rolling haversine in SQL.
    lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    geog        geography(Point, 4326)
                GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,

    -- Gazetteer linkage, populated when a source is matched to or imported from
    -- USGS GNIS / OpenStreetMap. Nullable: user-pinned sources have neither.
    gnis_id     text,
    osm_id      text,

    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The neighbor lookup behind pooling, and the corridor query behind route mode.
CREATE INDEX sources_geog_idx ON sources USING gist (geog);

-- Gazetteer ids identify a real-world feature, so they must not repeat --
-- but only when present.
CREATE UNIQUE INDEX sources_gnis_id_idx ON sources (gnis_id) WHERE gnis_id IS NOT NULL;
CREATE UNIQUE INDEX sources_osm_id_idx  ON sources (osm_id)  WHERE osm_id  IS NOT NULL;

COMMENT ON COLUMN sources.lat IS
    'Authoritative coordinate. The engine groups reports by source NAME and silently '
    'adopts the first row''s coordinates for all of them (engine issue #9), so two '
    'distinct springs must never share a name in one forecast request.';

-- --------------------------------------------------------------------------
-- reports
-- --------------------------------------------------------------------------
CREATE TABLE reports (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id   bigint NOT NULL REFERENCES sources (id) ON DELETE CASCADE,

    -- The date the water was SEEN, never the date it was submitted. Every
    -- correlation is against rainfall antecedent to this date, so an undated
    -- or misdated observation is worse than no observation at all.
    observed_on date NOT NULL,

    -- 0.00 dry .. 1.00 raging. Two decimals rather than one because importers
    -- interpolate between the six rubric anchors.
    score       numeric(3,2) NOT NULL CHECK (score >= 0 AND score <= 1),

    -- Original wording, kept verbatim for provenance. The engine ignores it;
    -- humans auditing a surprising verdict do not.
    status      text,

    provenance  text NOT NULL DEFAULT 'user'
                CHECK (provenance IN ('user', 'import', 'seed')),
    submitter   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The forecast query: every report for a set of sources, in engine order.
CREATE INDEX reports_source_observed_idx ON reports (source_id, observed_on);

-- Freshness badges and the "last reported" sort.
CREATE INDEX reports_observed_idx ON reports (observed_on DESC);

-- DELIBERATELY NOT UNIQUE on (source_id, observed_on): two people can report the
-- same spring on the same day and disagree, and that disagreement is real signal
-- about a marginal source. The seed data does exactly this -- Big Kahuna Falls
-- has two rows for 2013-03-16 scored 0.6 and 0.8. Both count.

COMMENT ON COLUMN reports.observed_on IS
    'Future dates must be rejected in the application layer -- a CHECK constraint '
    'cannot reference current_date (not immutable).';

-- --------------------------------------------------------------------------
-- precip_cache
-- --------------------------------------------------------------------------
-- Fixes engine issue #6 by construction. The engine caches to a local file
-- named {lat}_{lon}_{end_date}.json, and since end_date advances daily, that
-- key misses every single day -- redownloading ~19 years per source per day
-- (measured: 17.5s for a "warm" 3-source run). Here the key is the coordinate
-- and the backend, never the end date; a stale row gets its tail topped up
-- rather than replaced.
CREATE TABLE precip_cache (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Rounded to 2dp to match the engine's own cache granularity (~1.1 km),
    -- which is finer than any backend's grid, so neighboring sources share rows.
    lat_r       numeric(5,2) NOT NULL,
    lon_r       numeric(6,2) NOT NULL,

    -- Anticipates the engine's planned pluggable --precip flag. Rows from
    -- different backends must never be mixed: ERA5 (~9-11 km) and MRMS (1 km)
    -- disagree precisely where it matters, on isolated monsoon cells.
    backend     text NOT NULL DEFAULT 'open-meteo-era5',

    -- Dense daily series in inches. Element i is the total for
    -- start_date + i days; no gaps, so window sums stay simple offset math.
    start_date  date NOT NULL,
    end_date    date NOT NULL,
    daily_in    real[] NOT NULL,

    fetched_at  timestamptz NOT NULL DEFAULT now(),

    CHECK (end_date >= start_date),
    CHECK (array_length(daily_in, 1) = (end_date - start_date) + 1),
    UNIQUE (lat_r, lon_r, backend)
);

-- --------------------------------------------------------------------------
-- Convenience view: the engine's CSV contract, verbatim.
-- --------------------------------------------------------------------------
CREATE VIEW engine_rows AS
SELECT s.id   AS source_id,
       s.name AS source,
       s.lat,
       s.lon,
       r.observed_on AS date,
       r.score,
       r.status
FROM reports r
JOIN sources s ON s.id = r.source_id;
