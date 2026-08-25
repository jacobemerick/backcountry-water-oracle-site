import { createHash } from "node:crypto";
import { insertSnapshot, latestSnapshotHash, recordFetchAttempt } from "@/lib/db";
import {
  WATER_SHEETS,
  countDatedEntries,
  isNewSnapshot,
  parseProvenance,
  sheetCsvUrl,
  type WaterSheet,
} from "@/lib/water-sheets";

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
const FETCH_TIMEOUT_MS = 30_000;

type SheetResult = {
  slug: string;
  sheetId: string;
  ok: boolean;
  unchanged?: boolean;
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

async function archiveSheet(sheet: WaterSheet): Promise<SheetResult> {
  const started = Date.now();
  const base = { slug: sheet.slug, sheetId: sheet.id };

  try {
    const response = await fetch(sheetCsvUrl(sheet.id), {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "backcountrywateroracle.com archive (preservation mirror)" },
      cache: "no-store",
    });

    const body = await response.text();
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

    // A sheet that has been unshared returns 200 with an HTML sign-in page.
    // Storing that as a snapshot would overwrite nothing but would record a
    // capture that contains no data, and dedupe would then treat the real
    // bytes as "changed" forever after.
    if (/^\s*</.test(body)) {
      await recordFetchAttempt({
        sheetId: sheet.id,
        ok: false,
        httpStatus: response.status,
        byteSize: body.length,
        durationMs,
        error: "Response was HTML, not CSV — the sheet may no longer be public",
      });
      return { ...base, ok: false, error: "HTML, not CSV — sheet may no longer be public" };
    }

    const contentHash = createHash("sha256").update(body).digest("hex");
    const lastHash = await latestSnapshotHash(sheet.id);
    const { title, updatedLine } = parseProvenance(body);

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
        byteSize: body.length,
        durationMs,
      });
      return { ...base, ok: true, unchanged: true, bytes: body.length, title };
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
      byteSize: body.length,
      body,
      httpStatus: response.status,
      headers,
    });

    await recordFetchAttempt({
      sheetId: sheet.id,
      ok: true,
      unchanged: snapshotId === null,
      httpStatus: response.status,
      byteSize: body.length,
      durationMs,
      snapshotId,
    });

    return {
      ...base,
      ok: true,
      unchanged: snapshotId === null,
      bytes: body.length,
      datedEntries: countDatedEntries(body),
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

  const results: SheetResult[] = [];
  for (const [i, sheet] of WATER_SHEETS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    results.push(await archiveSheet(sheet));
  }

  const stored = results.filter((r) => r.ok && !r.unchanged).length;
  const failed = results.filter((r) => !r.ok);

  return Response.json(
    {
      ran_at: new Date().toISOString(),
      sheets: results.length,
      stored,
      unchanged: results.filter((r) => r.ok && r.unchanged).length,
      failed: failed.length,
      surprises: results.filter((r) => r.titleSurprise).map((r) => r.slug),
      results,
    },
    // A partial failure is a real failure: a non-2xx is what makes a dead or
    // degraded archive visible in Vercel's cron log rather than silently green.
    { status: failed.length > 0 ? 500 : 200 },
  );
}
