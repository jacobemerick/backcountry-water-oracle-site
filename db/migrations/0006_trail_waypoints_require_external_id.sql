-- 0006: every trail waypoint must carry the feed's own identifier
--
-- 0005 allowed external_id to be null and gave those rows a separate uniqueness
-- rule on (feed, mile). That left a gap between the two rules: a row with an id
-- and a row without could describe the same marker and neither index would
-- object. An interrupted first load did exactly that, leaving a full duplicate
-- set of 26,600 PCT markers -- every mile present twice, and the table silently
-- twice the size it should be.
--
-- A mile marker's identity is its mile, so it can always have an id. With that
-- true, one uniqueness rule covers every row and the gap closes.

DELETE FROM trail_waypoints WHERE external_id IS NULL;

ALTER TABLE trail_waypoints ALTER COLUMN external_id SET NOT NULL;

-- Now unreachable: no row can have a null external_id.
DROP INDEX IF EXISTS trail_waypoints_feed_mile_idx;
