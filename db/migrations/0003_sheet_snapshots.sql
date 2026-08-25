-- 0003_sheet_snapshots: an immutable mirror of the public water-report sheets
--
-- The PCT Water Report keeps roughly twelve months of updates and drops the
-- rest, so about 1,500 dated observations age out every year. There is no
-- safety net: the Wayback Machine holds zero snapshots of these sheets. Every
-- season nobody mirrors them is gone permanently.
--
-- Archiving only. Parsing these into sources/reports is a separate job gated on
-- a permission conversation with the stewards -- mirroring a public sheet to
-- prevent data loss is a much lower-risk act than republishing it.
--
-- Postgres rather than object storage. R2 is the better shape for large
-- immutable blobs, but a full capture of all eight sheets is ~420 KB, so at
-- weekly cadence with content-hash dedupe this is a handful of megabytes a
-- year. That does not justify a second vendor and a second set of credentials.

-- Raw bytes exactly as fetched. Never parsed on the way in: the parse rules
-- will be wrong at first and will change, and a parser bug must never be able
-- to destroy an observation. These rows are the ground truth everything else
-- is re-derived from, so nothing may update them.
CREATE TABLE sheet_snapshots (
    id            bigserial   PRIMARY KEY,

    -- The Google Sheets document id. Deliberately the key rather than a
    -- human label: three of the seven ids were mislabelled in the issue that
    -- specified this job (Oregon filed as "Part Two", and so on). An id cannot
    -- drift; a label written by hand already had.
    sheet_id      text        NOT NULL,

    -- Title read out of row 1 of this very fetch, so the label always describes
    -- the bytes stored beside it rather than what we expected to receive.
    title         text,

    -- The sheets carry "Updated MM/DD/YYYY @ H:MM am by <steward>" in row 1.
    -- Captured verbatim: it is the stewards' own statement of currency, and it
    -- is how a snapshot is dated when our own clock is not the point.
    updated_line  text,

    retrieved_at  timestamptz NOT NULL DEFAULT now(),
    content_hash  text        NOT NULL,
    byte_size     integer     NOT NULL,
    body          text        NOT NULL,

    -- Response metadata, for provenance a body alone cannot carry.
    http_status   integer     NOT NULL,
    headers       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- The dedupe. These sheets change daily in season and not at all outside it,
-- so hashing the body and skipping an unchanged write keeps the archive small
-- while leaving the timeline honest. A repeat capture of identical bytes tells
-- us nothing a fetch-attempt row does not already record.
CREATE UNIQUE INDEX sheet_snapshots_sheet_hash_idx
    ON sheet_snapshots (sheet_id, content_hash);

CREATE INDEX sheet_snapshots_sheet_time_idx
    ON sheet_snapshots (sheet_id, retrieved_at DESC);

-- Every attempt, successful or not.
--
-- A silent dead cron is the entire failure mode of this job: the archive stops
-- and nothing anywhere says so, and the loss is only discovered when the data
-- is already gone. So the absence of recent rows here is itself the alarm, and
-- it is queryable without reference to whether anything changed.
CREATE TABLE sheet_fetch_attempts (
    id           bigserial   PRIMARY KEY,
    sheet_id     text        NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    ok           boolean     NOT NULL,

    -- True when the fetch succeeded and the bytes matched what we already hold.
    -- The common case in the off season, and not a problem.
    unchanged    boolean     NOT NULL DEFAULT false,

    http_status  integer,
    byte_size    integer,
    duration_ms  integer,
    error        text,
    snapshot_id  bigint      REFERENCES sheet_snapshots (id) ON DELETE SET NULL
);

CREATE INDEX sheet_fetch_attempts_time_idx
    ON sheet_fetch_attempts (attempted_at DESC);

CREATE INDEX sheet_fetch_attempts_sheet_time_idx
    ON sheet_fetch_attempts (sheet_id, attempted_at DESC);
