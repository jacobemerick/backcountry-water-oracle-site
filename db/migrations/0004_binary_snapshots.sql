-- 0004_binary_snapshots: let the mirror hold artifacts that are not CSV
--
-- The archive was built for Google Sheets CSV exports. The Arizona Trail's
-- water report was never a sheet: the ATA published it as a PDF, and what
-- survives of it are Wayback captures of that PDF. Same job -- preserve the
-- bytes someone else published before they disappear -- so it belongs in the
-- same table rather than a parallel one.
--
-- Text and binary are separate columns rather than everything moving to bytea.
-- A CSV body is worth reading in a query, and forcing an encode() around every
-- future inspection of one would be paying for the PDFs at the CSVs' expense.

ALTER TABLE sheet_snapshots
    ADD COLUMN body_bytes   bytea,
    ADD COLUMN content_type text;

ALTER TABLE sheet_snapshots
    ALTER COLUMN body DROP NOT NULL;

-- Exactly one representation, never both and never neither. Without this, a
-- bug that wrote the wrong column would produce a row that looks archived and
-- holds nothing -- the failure this whole table exists to prevent.
ALTER TABLE sheet_snapshots
    ADD CONSTRAINT sheet_snapshots_one_body
    CHECK ((body IS NULL) <> (body_bytes IS NULL));

-- Existing rows are all CSV.
UPDATE sheet_snapshots SET content_type = 'text/csv' WHERE content_type IS NULL;
