/**
 * Deployment probe. Answers, in one request, whether the web service can
 * actually reach the engine service over its Vercel binding.
 *
 * Kept rather than deleted along with #3, because it is the only way to verify
 * a binding from outside: the engine service has no public route by design, so
 * it can only be observed through something holding the binding.
 *
 * Its previous job — establishing that the Node runtime has no Python — is
 * done and recorded on #3.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const engineUrl = process.env.ENGINE_URL;

  let engine: unknown;
  if (!engineUrl) {
    engine = {
      ok: false,
      reason:
        "ENGINE_URL is not set. In production Vercel injects it from the service " +
        "binding declared in vercel.json; locally it is absent by design, and the " +
        "engine runs as a subprocess instead.",
    };
  } else {
    try {
      const res = await fetch(new URL("/", engineUrl), {
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      const body = await res.text();
      engine = res.ok
        ? { ok: true, status: res.status, health: JSON.parse(body) }
        : { ok: false, status: res.status, body: body.slice(0, 300) };
    } catch (e) {
      engine = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  const reachable =
    typeof engine === "object" && engine !== null && "ok" in engine && Boolean(engine.ok);

  return Response.json(
    {
      web: {
        node: process.version,
        vercelEnv: process.env.VERCEL_ENV ?? "local",
        region: process.env.VERCEL_REGION ?? null,
      },
      // Presence only, never the value. It is an internal URL rather than a
      // secret, but there is no reason to publish the engine's address.
      engineUrlPresent: Boolean(engineUrl),
      engine,
      verdict: reachable
        ? "Service binding works — the web service reached the engine."
        : "Engine not reachable from the web service.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
