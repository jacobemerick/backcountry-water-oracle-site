import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_TARGETS,
  countDatedEntries,
  isNewSnapshot,
  parseProvenance,
  waybackTimestampToIso,
  waybackUrl,
} from "./water-archive.ts";

/** Row 1 as the sheets actually emit it, padding and all. */
const REAL_HEADER =
  "Pacific Crest Trail Water Report -- Part One: Campo to Idyllwild ,,,,,Updated 06/27/2026 @ 5:41 pm     by Druid,";

test("the registry is keyed on document id, with no collisions", () => {
  const ids = ARCHIVE_TARGETS.map((s) => s.id);
  const slugs = ARCHIVE_TARGETS.map((s) => s.slug);
  assert.equal(new Set(ids).size, ids.length, "duplicate sheet id");
  assert.equal(new Set(slugs).size, slugs.length, "duplicate slug");
  for (const s of ARCHIVE_TARGETS) {
    assert.ok(s.id.length > 20, `${s.slug} has an implausible id`);
    assert.match(s.slug, /^[a-z0-9-]+$/);
  }
});

test("every target fetches over https and carries no credentials", () => {
  for (const t of ARCHIVE_TARGETS) {
    assert.ok(t.url.startsWith("https://"), `${t.slug} must fetch over https`);
    assert.ok(!/key=|token=|api_key/i.test(t.url), `${t.slug} must not carry credentials`);
  }
});

test("sheets export keylessly; PDFs come from the Wayback Machine", () => {
  const csv = ARCHIVE_TARGETS.filter((t) => t.format === "csv");
  const pdf = ARCHIVE_TARGETS.filter((t) => t.format === "pdf");
  assert.ok(csv.length >= 8 && pdf.length >= 5);

  for (const t of csv) {
    assert.ok(t.url.startsWith("https://docs.google.com/spreadsheets/d/"));
    assert.ok(t.url.endsWith("/export?format=csv"));
  }
  for (const t of pdf) {
    assert.ok(t.url.startsWith("https://web.archive.org/web/"));
    // `id_` asks for the original bytes rather than a rewritten page.
    assert.match(t.url, /\/\d{14}id_\//, `${t.slug} must request raw bytes`);
    assert.equal(t.immutable, true, "a fixed capture must never be re-fetched");
    assert.ok(t.provenance, "a PDF cannot state its own provenance");
  }
});

test("only immutable targets may be skipped once held", () => {
  // A live sheet marked immutable would freeze the archive at its first capture
  // and nothing would say so, which is the quietest possible failure here.
  for (const t of ARCHIVE_TARGETS) {
    if (t.immutable) assert.equal(t.format, "pdf");
    if (t.url.includes("docs.google.com")) assert.notEqual(t.immutable, true);
  }
});

test("wayback timestamps convert to real instants", () => {
  assert.equal(waybackTimestampToIso("20160418174702"), "2016-04-18T17:47:02Z");
  assert.equal(waybackTimestampToIso("20180205035808"), "2018-02-05T03:58:08Z");
  assert.throws(() => waybackTimestampToIso("2016"), /Not a Wayback timestamp/);
  assert.ok(waybackUrl("20160418174702", "http://x/y.pdf").includes("20160418174702id_/"));
});

test("provenance comes off the fetched row, padding and all", () => {
  const { title, updatedLine } = parseProvenance(REAL_HEADER);
  assert.equal(title, "Water Report -- Part One: Campo to Idyllwild");
  // The run-on spaces the sheet pads with are collapsed, the content is not.
  assert.equal(updatedLine, "Updated 06/27/2026 @ 5:41 pm by Druid");
});

test("provenance survives a quoted title containing commas", () => {
  const quoted =
    '"Pacific Crest Trail Water Report -- Oregon : Ashland, OR to Cascade Locks, OR",,,,,/Updated 08/24/26 by woodglue,';
  const { title, updatedLine } = parseProvenance(quoted);
  assert.equal(title, "Water Report -- Oregon : Ashland, OR to Cascade Locks, OR");
  assert.equal(updatedLine, "Updated 08/24/26 by woodglue");
});

test("a sheet whose header changes shape is still archivable", () => {
  // Provenance is metadata. Failing to read it must never block the capture --
  // the bytes are the thing worth keeping.
  //
  // ",,,,,,,,," is not hypothetical: it is row 1 of the orphaned CDT sheet,
  // whose CSV export carries no title at all. Null is the honest answer there,
  // and falling back to the expected title would defeat the point of reading
  // the label off the bytes.
  for (const odd of ["", "\n", "no header at all\n1,2,3", ",,,,,", ",,,,,,,,,"]) {
    const p = parseProvenance(odd);
    assert.ok(p.title === null || typeof p.title === "string");
    assert.ok(p.updatedLine === null || typeof p.updatedLine === "string");
  }
});

test("dated entries are counted, not parsed", () => {
  const cell = `03/15/26 (SoloNotSolo): faucets on
09/19/24 (Monty T): all faucets flowing
02/06/23 (Erin G): water is on`;
  assert.equal(countDatedEntries(cell), 3);
  assert.equal(countDatedEntries("no dates here"), 0);
  // A bare date with no reporter is not an entry in this format.
  assert.equal(countDatedEntries("03/15/26 faucets on"), 0);
});

test("dedupe skips identical bytes and keeps changed ones", () => {
  assert.equal(isNewSnapshot("abc", "abc"), false);
  assert.equal(isNewSnapshot("abc", "def"), true);
  // Nothing held yet is always new -- the first capture must never be skipped.
  assert.equal(isNewSnapshot("abc", null), true);
});
