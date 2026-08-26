-- 0008: link the same feature described by both feeds, so search returns it once
--
-- Measured after the first load of 0007: of 9,972 named OpenStreetMap water
-- nodes in these six states, 8,260 -- 83% -- have a GNIS feature of the same
-- name within 200 m. That is not a coincidence. OSM imported GNIS years ago, so
-- for named features the two feeds are largely the same corpus twice.
--
-- Unnamed OSM nodes are the opposite: only 1,594 of 32,177 sit within 100 m of
-- any GNIS feature. Those 30,583 are genuinely new water, and are most of what
-- OSM contributes here. So dropping either feed would be wrong -- the overlap is
-- almost entirely in the named half.
--
-- Rather than delete, mark. The duplicate row keeps its identifier, its tags and
-- its own coordinate, and search filters on `duplicate_of IS NULL`.
--
-- GNIS is the survivor, for four reasons that happen to agree: it is the origin
-- of the OSM copy, it carries a county, it is the authority for the name, and it
-- is public domain -- so preferring it also means the site displays less
-- ODbL-derived data, and carries the attribution obligation on fewer rows.

ALTER TABLE gazetteer
    ADD COLUMN duplicate_of bigint REFERENCES gazetteer (id) ON DELETE SET NULL;

-- A row cannot be a duplicate of itself, and the survivor of a pair must not
-- itself point at something -- otherwise "filter to duplicate_of IS NULL" stops
-- being the same thing as "one row per feature".
ALTER TABLE gazetteer
    ADD CONSTRAINT gazetteer_duplicate_not_self CHECK (duplicate_of IS DISTINCT FROM id);

-- The search filter. Partial, because the query only ever wants survivors.
CREATE INDEX gazetteer_primary_idx ON gazetteer (feature_class)
    WHERE duplicate_of IS NULL;

COMMENT ON COLUMN gazetteer.duplicate_of IS
    'Set by scripts/load-gazetteer.mjs --link-duplicates when another feed already '
    'describes this feature. Search must filter to duplicate_of IS NULL.';
