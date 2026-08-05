import { sourcesNear } from "@/lib/db";
import { parseLatLon } from "@/lib/coords";

export const dynamic = "force-dynamic";

/**
 * Sources near a point — the duplicate check the picker runs before letting
 * anyone create a new one.
 *
 * Accepts `?lat=&lon=` or `?q=<any coordinate notation>`, so the same endpoint
 * serves a map click and a pasted coordinate.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  let lat: number;
  let lon: number;

  const q = params.get("q");
  if (q) {
    const parsed = parseLatLon(q);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    ({ lat, lon } = parsed.value);
  } else {
    lat = Number(params.get("lat"));
    lon = Number(params.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Provide lat and lon, or q." }, { status: 400 });
    }
  }

  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "Coordinates are out of range." }, { status: 400 });
  }

  // 2 km default: wide enough to catch the same spring pinned from a different
  // trail junction, narrow enough that the list stays readable.
  const radiusKm = Math.min(50, Math.max(0.1, Number(params.get("radius_km")) || 2));

  try {
    return Response.json({ point: { lat, lon }, radius_km: radiusKm, sources: await sourcesNear(lat, lon, radiusKm) });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Lookup failed." },
      { status: 500 },
    );
  }
}
