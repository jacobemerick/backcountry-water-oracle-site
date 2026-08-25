import { createHash } from "node:crypto";
import { insertSnapshot, latestSnapshotHash, recordFetchAttempt } from "@/lib/db";
import {
  ARCHIVE_TARGETS,
  countDatedEntries,
  isNewSnapshot,
  parseProvenance,
  type ArchiveTarget,
} from "@/lib/water-archive";

/**
 * Mirror the public water-report sheets.
 *
 * Archiving only. The PCT Water Report keeps about twelve months of updates and
 * drops the rest, so roughly 1,500 dated observations age out every year, and
 * the Wayback Machine has never captured one of these sheets. The cost of not
 * running this is measured in data; the cost of running it is a cron job.
 *
 * Parsing these into sources/reports is a separate job gated on a permission
 * conversation with the stewards. Nothing here writes to sources or reports.
 */

export const dynamic = "force-dynamic";
// Eight sequential fetches with a politeness delay. Well inside the ceiling,
// but the default would be tight if Google were slow.
export const maxDuration = 300;

/** Sequential, with a pause between. We are a guest on someone else's volunteer
    infrastructure, and nothing here is urgent enough to fetch in parallel. */
const PAUSE_MS = 750;

/**
 * Google answers a sheet export in a second or two. The Internet Archive is
 * routinely much slower — it is reconstructing a decade-old capture from cold
 * storage — and 30s was not enough: two of the five AZT PDFs timed out on the
 * first real run while the same fetches succeeded by hand at 150s.
 */
const FETCH_TIMEOUT_MS = { csv: 30_000, pdf: 120_000 } as const;

/**
 * Stop starting new fetches with this much of the function budget left.
 *
 * Being killed mid-run is the one way this job could lose an attempt without
 * recording it, and a truncated run is invisible where a deferred one is not.
 * Deferral is cheap here: every remaining target is either immutable, and will
 * simply be picked up next run, or a sheet that is re-fetched weekly anyway.
 */
const DEADLINE_MARGIN_MS = 45_000;
const RUN_BUDGET_MS = 300_000 - DEADLINE_MARGIN_MS;

type SheetResult = {
  slug: string;
  sheetId: string;
  ok: boolean;
  unchanged?: boolean;
  /** Immutable and already held — not fetched at all. */
  skipped?: boolean;
  /** Not attempted this run: the function budget ran short. */
  deferred?: boolean;
  bytes?: number;
  datedEntries?: number;
  title?: string | null;
  titleSurprise?: boolean;
  error?: string;
};

/**
 * Vercel signs cron invocations with CRON_SECRET. Without this check the route
 * is an open proxy that anyone can use to hammer a volunteer's spreadsheet from
 * our IP, which is precisely the way to lose the goodwill this whole archive
 * depends on.
 *
 * When CRON_SECRET is unset the route refuses rather than running unprotected:
 * an archive that quietly stops is recoverable, an abuse complaint is not.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function archiveSheet(sheet: ArchiveTarget): Promise<SheetResult> {
  const started = Date.now();
  const base = { slug: sheet.slug, sheetId: sheet.id };

  try {
    // A Wayback capture is a fixed snapshot at a fixed timestamp: the bytes
    // cannot change, so once held there is nothing to ask for. Checked before
    // the fetch rather than after, because the politeness is the point.
    if (sheet.immutable && (await latestSnapshotHash(sheet.id)) !== null) {
      return { ...base, ok: true, unchanged: true, skipped: true };
    }

    const response = await fetch(sheet.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS[sheet.format]),
      headers: { "user-agent": "backcountrywateroracle.com archive (preservation mirror)" },
      cache: "no-store",
    });

    // Read once, as bytes. Text is decoded from those bytes rather than the
    // other way round, so a PDF is never put through a UTF-8 decode that would
    // silently corrupt it before hashing.
    const raw = Buffer.from(await response.arrayBuffer());
    const durationMs = Date.now() - started;

    if (!response.ok) {
      await recordFetchAttempt({
        sheetId: sheet.id,
        ok: false,
        httpStatus: response.status,
        durationMs,
        error: `HTTP ${response.status}`,
      });
      return { ...base, ok: false, error: `HTTP ${response.status}` };
    }

    // Both formats have a way of failing that returns 200 with the wrong body:
    // an unshared sheet serves an HTML sign-in page, and a Wayback miss serves
    // an HTML error page. Storing either would record a capture containing no
    // data, and dedupe would then treat the real bytes as "changed" ever after.
    const looksWrong =
      sheet.format === "pdf"
        ? raw.subarray(0, 5).toString("latin1") !== "%PDF-"
        : /^\s*</.test(raw.subarray(0, 512).toString("utf8"));

    if (looksWrong) {
      const detail =
        sheet.format === "pdf"
          ? "Response was not a PDF — the capture may no longer be retrievable"
          : "Response was HTML, not CSV — the sheet may no longer be public";
      await recordFetchAttempt({
        sheetId: sheet.id,
        ok: false,
        httpStatus: response.status,
        byteSize: raw.length,
        durationMs,
        error: detail,
      });
      return { ...base, ok: false, error: detail };
    }

    const isText = sheet.format === "csv";
    const body = isText ? raw.toString("utf8") : null;

    const contentHash = createHash("sha256").update(raw).digest("hex");
    const lastHash = await latestSnapshotHash(sheet.id);

    // A CSV states its own title and currency in row 1. A PDF cannot be read
    // here, so its provenance is the archived URL and capture time it came
    // from — which describes those exact bytes just as well.
    const { title, updatedLine } = body
      ? parseProvenance(body)
      : { title: null, updatedLine: sheet.provenance ?? null };

    // The title is recorded from the bytes, never assumed. `expectTitle` only
    // raises a flag: three of these ids arrived mislabelled from the issue that
    // specified this job, so a mismatch is worth surfacing rather than trusting.
    const titleSurprise = Boolean(
      title && !title.toLowerCase().includes(sheet.expectTitle.toLowerCase().slice(0, 12)),
    );

    if (!isNewSnapshot(contentHash, lastHash)) {
      await recordFetchAttempt({
        sheetId: sheet.id,
        ok: true,
        unchanged: true,
        httpStatus: response.status,
        byteSize: raw.length,
        durationMs,
      });
      return { ...base, ok: true, unchanged: true, bytes: raw.length, title };
    }

    const headers: Record<string, string> = {};
    for (const key of ["content-type", "last-modified", "etag", "date"]) {
      const value = response.headers.get(key);
      if (value) headers[key] = value;
    }

    const snapshotId = await insertSnapshot({
      sheetId: sheet.id,
      title,
      updatedLine,
      contentHash,
      byteSize: raw.length,
      body,
      bodyBytes: body === null ? raw : null,
      contentType: response.headers.get("content-type") ?? (isText ? "text/csv" : "application/pdf"),
      httpStatus: response.status,
      headers,
    });

    await recordFetchAttempt({
      sheetId: sheet.id,
      ok: true,
      unchanged: snapshotId === null,
      httpStatus: response.status,
      byteSize: raw.length,
      durationMs,
      snapshotId,
    });

    return {
      ...base,
      ok: true,
      unchanged: snapshotId === null,
      bytes: raw.length,
      datedEntries: body ? countDatedEntries(body) : undefined,
      title,
      titleSurprise,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Recording the failure is the point of this job's alarm, so it must not
    // itself be able to take the run down.
    await recordFetchAttempt({
      sheetId: sheet.id,
      ok: false,
      durationMs: Date.now() - started,
      error,
    }).catch(() => {});
    return { ...base, ok: false, error };
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized." }, { status: 401 });
  }

  const startedAt = Date.now();
  const results: SheetResult[] = [];

  for (const [i, sheet] of ARCHIVE_TARGETS.entries()) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      results.push({ slug: sheet.slug, sheetId: sheet.id, ok: true, deferred: true });
      continue;
    }
    // No pause before a target we are about to skip without fetching.
    if (i > 0 && !(sheet.immutable && results.length)) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    results.push(await archiveSheet(sheet));
  }

  const stored = results.filter((r) => r.ok && !r.unchanged && !r.deferred).length;
  const failed = results.filter((r) => !r.ok);

  return Response.json(
    {
      ran_at: new Date().toISOString(),
      sheets: results.length,
      stored,
      unchanged: results.filter((r) => r.ok && r.unchanged && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
      deferred: results.filter((r) => r.deferred).length,
      failed: failed.length,
      surprises: results.filter((r) => r.titleSurprise).map((r) => r.slug),
      results,
    },
    // A partial failure is a real failure: a non-2xx is what makes a dead or
    // degraded archive visible in Vercel's cron log rather than silently green.
    { status: failed.length > 0 ? 500 : 200 },
  );
}
