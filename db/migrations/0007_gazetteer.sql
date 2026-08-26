-- 0007_gazetteer: named water features, so search stops meaning "paste coordinates"
--
-- This table exists because of the shape of the problem stated in #13: a
-- gazetteer supplies a name and a coordinate and *zero reports*. It solves the
-- picker and does nothing for the corpus. Those are different jobs, so they get
-- different tables -- the same call 0005 made for `trail_waypoints`, and for the
-- same reason: reference data is re-derivable by re-running its loader, and a
-- row nobody has ever reported on must never be mistaken for water somebody saw.
--
-- A `sources` row is therefore created only when a real observation arrives.
-- `sources.gnis_id` / `sources.osm_id` (0001) are how the two are reconciled:
-- promotion copies the identifier, so the gazetteer can be reloaded wholesale
-- afterwards without touching anything a human contributed.
--
-- The other reason not to load these into `sources` is engine issue #9: the
-- engine groups reports by source NAME and silently adopts the first row's
-- coordinates for all of them. Measured across these six states, GNIS holds
-- 264 features named "Willow Spring", 246 "Mud Spring", 198 "Cottonwood
-- Spring". In `sources` that is not a search inconvenience, it is a correlation
-- against rain that fell three hundred miles from the spring.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE gazetteer (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The feed, verbatim, and its licence. Recorded per row because they
    -- genuinely differ and the difference has consequences: GNIS is a US
    -- government work in the public domain, OSM is ODbL and requires
    -- attribution wherever a derived row is displayed.
    feed          text NOT NULL,
    licence       text NOT NULL,

    -- The feed's own identifier: a GNIS feature_id, or an OSM 'node/12345'.
    -- Never null -- both feeds always have one, and 0006 is the lesson about
    -- what a nullable external id costs.
    external_id   text NOT NULL,

    -- Nullable, and measured: 55% of OSM's water nodes in these six states carry
    -- no name at all (in Arizona: 8,638 nodes, 3,879 named). Dropping them would
    -- discard the majority of OSM's contribution to answer a question -- "search
    -- by name" -- that is only half of what this table is for. The other half is
    -- proximity: #12 is literally a user dropping a pin on a spring nobody has
    -- reported, and an unnamed spring 300 m away is a real thing to tell them.
    -- Name search simply never matches these; NULL is not LIKE anything.
    name          text,

    -- Ours, normalised across feeds: 'spring', 'reservoir', 'lake', 'basin',
    -- 'swamp', 'well', 'drinking_water', 'hot_spring', 'cistern'.
    feature_class text NOT NULL,

    -- The feed's own wording, kept verbatim. GNIS says 'Reservoir' for what
    -- Arizona calls a stock tank; OSM says 'natural=spring'. Normalising is a
    -- judgement, so the input to that judgement stays on the row.
    raw_class     text,

    -- Two-letter state. The CHECK is the scope: this import is deliberately the
    -- interior Southwest and nothing else. Widening it is a migration, which is
    -- the point -- an accidental national or global load should fail loudly at
    -- the first row rather than quietly write four million features.
    state         text NOT NULL CHECK (state IN ('AZ', 'CA', 'CO', 'NM', 'NV', 'UT')),
    county        text,

    lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon           double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    geog          geography(Point, 4326)
                  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,

    loaded_at     timestamptz NOT NULL DEFAULT now()
);

-- Reloading a feed is an upsert, not an append: GNIS restates coordinates as
-- features are re-surveyed, and OSM changes daily.
CREATE UNIQUE INDEX gazetteer_feed_external_idx ON gazetteer (feed, external_id);

-- "What is near this coordinate", and the promotion check: does a gazetteer
-- feature already exist within a few hundred metres of this new source.
CREATE INDEX gazetteer_geog_idx ON gazetteer USING gist (geog);

-- Name search. Trigram rather than a prefix index because the queries people
-- actually type are misremembered and partial -- "cottonwd spg", "bear sprng".
-- 90k rows is far past the point where the front page can ship the whole corpus
-- to the browser and substring-match it, which is what SearchField does today.
CREATE INDEX gazetteer_name_trgm_idx ON gazetteer USING gin (name gin_trgm_ops)
    WHERE name IS NOT NULL;
CREATE INDEX gazetteer_class_idx ON gazetteer (feature_class);

COMMENT ON TABLE gazetteer IS
    'Named water features from USGS GNIS (public domain) and OpenStreetMap (ODbL). '
    'Reference data with no reports attached. Displaying an OSM-derived row requires '
    'attributing OpenStreetMap contributors.';
