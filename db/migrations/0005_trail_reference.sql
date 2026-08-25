-- 0005_trail_reference: published trail geometry, for geolocating imported reports
--
-- The water reports we archive identify a source by position on a trail, not by
-- coordinate. PCT rows carry a mile and a Halfmile waypoint id; AZT rows carry a
-- passage and a mile. The engine needs a coordinate for every report, because a
-- correlation is against the rain that fell on that exact spot.
--
-- So this is the join table between the two. Reference data only: published by
-- the trail organisations, re-derivable at any time by re-running the loader,
-- and deliberately kept out of `sources` so an import can be redone without a
-- gazetteer row ever having been mistaken for a real water source somebody
-- reported on.
--
-- Provenance and licence differ per feed and are recorded per row, because they
-- are not the same. PCTA publish under CC BY 4.0. The ATA's layer is public but
-- states no licence, which is the same footing as their water-report PDFs and
-- wants the same conversation before anything derived from it is republished.

CREATE TABLE trail_waypoints (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- 'PCT' | 'AZT'
    trail        text NOT NULL,

    -- 'mile_marker'  — a point at a known distance along the trail
    -- 'waypoint'     — a named point from the trail's own waypoint set
    -- 'water_source' — a water feature the trail organisation itself publishes
    kind         text NOT NULL,

    -- The feed this row came from, verbatim, e.g.
    -- 'PCTA Tenthmile_Marker_2026'. Two feeds can describe the same feature
    -- differently and a later import needs to know which one it trusted.
    feed         text NOT NULL,
    licence      text NOT NULL,

    -- The feed's own identifier: a Halfmile waypoint name (WR001), or the ATA's
    -- ATA_Num (01-079 = passage 1, mile 7.9). Null for bare mile markers, which
    -- are identified by their mile.
    external_id  text,

    name         text,
    -- The feed's own classification: Spring, Creek, Dirt Tank, Windmill.
    feature_type text,

    -- Cumulative trail mile, south to north. Null where a feed does not state
    -- one. Note the AZT's ATA_Num mileage and the water-report PDF's mileage
    -- disagree by up to a mile -- they were measured against different
    -- centerline vintages -- which is precisely why AZT joins on name and only
    -- uses mile to disambiguate.
    mile         numeric(7,2),

    lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon          double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    geog         geography(Point, 4326)
                 GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,

    loaded_at    timestamptz NOT NULL DEFAULT now()
);

-- Reloading a feed must be idempotent: the loader upserts on this, so re-running
-- it after an annual centerline update corrects coordinates in place rather than
-- doubling every marker.
CREATE UNIQUE INDEX trail_waypoints_feed_ext_idx
    ON trail_waypoints (feed, external_id) WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX trail_waypoints_feed_mile_idx
    ON trail_waypoints (feed, mile) WHERE external_id IS NULL AND mile IS NOT NULL;

-- The mile lookup: find the markers bracketing a report's mile.
CREATE INDEX trail_waypoints_trail_mile_idx ON trail_waypoints (trail, kind, mile);

-- The name lookup, and the "is this the same spring" check against `sources`.
CREATE INDEX trail_waypoints_geog_idx ON trail_waypoints USING gist (geog);
CREATE INDEX trail_waypoints_name_idx ON trail_waypoints (trail, lower(name));
