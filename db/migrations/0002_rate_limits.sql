-- 0002_rate_limits: fixed-window request counters
--
-- Postgres rather than Redis/KV because the database is already here and this
-- adds no new service to run. The cost is one upsert per limited request,
-- which is dwarfed by what the limits exist to protect: a forecast can trigger
-- several multi-second upstream precipitation fetches.
--
-- Fixed window, not sliding. A fixed window permits up to 2x the limit across a
-- boundary (all of window N late, all of N+1 early). That is a known and
-- acceptable weakness here: these limits exist to stop scripted abuse and to
-- keep us a good citizen of a free weather API, not to enforce a billing quota.
-- Sliding windows cost either a row per request or a second counter, and buy
-- precision nothing here needs.

CREATE TABLE rate_limits (
    -- "<bucket>:<subject>", e.g. "create_source:a91f...". The subject is an
    -- HMAC of the client IP, never the IP itself -- see src/lib/rate-limit.ts.
    -- Storing raw addresses would mean holding personal data to solve a
    -- problem that a keyed digest solves just as well.
    bucket_key   text        NOT NULL,

    -- Start of the fixed window this row counts, truncated to the window size.
    window_start timestamptz NOT NULL,

    count        integer     NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (bucket_key, window_start)
);

-- Supports the retention sweep, which is the only query that is not a
-- primary-key hit.
CREATE INDEX rate_limits_window_start_idx ON rate_limits (window_start);

COMMENT ON TABLE rate_limits IS
    'Fixed-window counters. Rows older than the longest window are garbage and '
    'are swept opportunistically; nothing here is worth retaining.';
