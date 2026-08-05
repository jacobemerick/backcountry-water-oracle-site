import { createReport, findSourceBySlug, reportsForSource } from "@/lib/db";
import { validateReport } from "@/lib/reports";
import { RULES, limitByIp, rateLimitHeaders, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { slug } = await params;
  const source = await findSourceBySlug(slug);
  if (!source) return Response.json({ error: "No such source." }, { status: 404 });

  try {
    return Response.json({ source, reports: await reportsForSource(source.id) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not load reports." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request, { params }: Params) {
  const limit = await limitByIp(request.headers, "create_report", RULES.createReport);
  if (!limit.allowed) {
    return tooManyRequests(limit, "Too many reports submitted recently. Try again shortly.");
  }

  const { slug } = await params;
  const source = await findSourceBySlug(slug);
  if (!source) return Response.json({ error: "No such source." }, { status: 404 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  const validated = validateReport({
    observedOn: typeof body.observed_on === "string" ? body.observed_on : "",
    score: typeof body.score === "number" ? body.score : Number.NaN,
    status: typeof body.status === "string" ? body.status : null,
  });

  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: 400 });
  }

  try {
    const report = await createReport({
      sourceId: source.id,
      observedOn: validated.value.observedOn,
      score: validated.value.score,
      status: validated.value.status,
    });

    return Response.json(
      { report, warnings: validated.warnings },
      { status: 201, headers: rateLimitHeaders(limit) },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not save the report." },
      { status: 500 },
    );
  }
}
