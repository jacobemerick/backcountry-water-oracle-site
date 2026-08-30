import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import {
  findGazetteerFeature,
  findSourceByExternalId,
  gazetteerFeatureById,
  sourcesNear,
} from "@/lib/db";
import type { GazetteerFeature } from "@/lib/db";
import { getSeries } from "@/lib/precip";
import { RAIN_COPY, bandOf, rankAntecedentRain } from "@/lib/rain-percentile";
import type { RainPercentile } from "@/lib/rain-percentile";
import { featurePath, parseFeatureRef } from "@/lib/feature-ref";
import { formatDistance, formatLatLon } from "@/lib/coords";
import { MIN_REPORTS_FOR_VERDICT } from "@/lib/present";
import { todayIso } from "@/lib/reports";
import { SiteShell } from "@/components/SiteShell";
import { BlockLabel } from "@/components/SourceRead";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }> };

/** Feed vocabulary, in the words a hiker uses. GNIS says "Reservoir" for what
    Arizona calls a stock tank, so the raw class stays visible alongside. */
const CLASS_LABEL: Record<string, string> = {
  spring: "Spring",
  hot_spring: "Hot spring",
  reservoir: "Reservoir or tank",
  lake: "Lake",
  basin: "Basin",
  swamp: "Swamp or marsh",
  well: "Well",
  drinking_water: "Drinking water",
  cistern: "Cistern",
};

function classLabel(feature: GazetteerFeature): string {
  return CLASS_LABEL[feature.feature_class] ?? feature.feature_class;
}

function displayName(feature: GazetteerFeature): string {
  // 55% of OSM's water nodes carry no name. An unnamed feature is still a real
  // thing to stand in front of, so it gets its class and its coordinate rather
  // than being hidden.
  return feature.name ?? `Unnamed ${classLabel(feature).toLowerCase()}`;
}

/**
 * Resolve a URL segment to the feature it addresses, following a duplicate to
 * its survivor.
 *
 * Returns the row plus whether the caller should redirect. Duplicates are real
 * traffic, not a theoretical case: 8,260 named OSM nodes duplicate a GNIS
 * feature within 200 m, and any of them may already be linked to from
 * somewhere.
 */
async function resolve(segment: string) {
  const ref = parseFeatureRef(segment);
  if (!ref) return null;

  const feature = await findGazetteerFeature(ref.feed, ref.externalId);
  if (!feature) return null;

  if (feature.duplicate_of !== null) {
    const survivor = await gazetteerFeatureById(feature.duplicate_of);
    if (survivor) return { feature: survivor, canonical: featurePath(survivor) };
  }
  return { feature, canonical: null as string | null };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ref } = await params;
  const resolved = await resolve(ref).catch(() => null);
  if (!resolved) return { title: "Feature not found" };

  const name = displayName(resolved.feature);
  const title = `${name} · Backcountry Water Oracle`;
  const description =
    `${name} is a recorded water feature at ${formatLatLon(resolved.feature)}, but nobody has ` +
    `reported what the water was doing. No forecast is possible until somebody does.`;

  return {
    title: name,
    description,
    openGraph: { title, description, siteName: "Backcountry Water Oracle", type: "article" },
    twitter: { card: "summary", title, description },
    // Nothing here is worth a search result until it has reports; the page is
    // for someone who searched for this spring, not for a crawler building an
    // index of 90,000 pages that all say "no reports".
    robots: { index: false, follow: true },
  };
}

export default async function FeaturePage({ params }: Props) {
  const { ref } = await params;
  const resolved = await resolve(ref);
  if (!resolved) notFound();

  const { feature, canonical } = resolved;
  if (canonical && canonical !== `/features/${ref}`) permanentRedirect(canonical);

  /*
   * Promoted features do not have a page here. Once somebody reports on this
   * spring the answer lives at /sources/[slug] — one spring, one canonical
   * URL — and a link already out in the world has to arrive at the reports
   * rather than at a page still claiming nobody has been.
   */
  const promoted = await findSourceByExternalId(
    feature.feed === "OpenStreetMap" ? "osm_id" : "gnis_id",
    feature.external_id,
  );
  if (promoted) redirect(`/sources/${promoted.slug}`);

  const neighbours = await sourcesNear(feature.lat, feature.lon, 25);
  const reported = neighbours.find((n) => n.report_count >= MIN_REPORTS_FOR_VERDICT);
  const nearest = neighbours[0] ?? null;

  // The one honest number at n = 0. A failure here is silence, never a
  // placeholder: on a page with no reports this block is the only figure, so an
  // empty or hedged version of it is exactly the "there's something here,
  // probably fine" glance the layout exists to prevent.
  let rain: RainPercentile | null = null;
  try {
    const { series } = await getSeries(feature.lat, feature.lon, todayIso(), { timeoutMs: 8_000 });
    rain = rankAntecedentRain(series);
  } catch {
    rain = null;
  }

  const addHref =
    `/sources?at=${feature.lat.toFixed(5)},${feature.lon.toFixed(5)}` +
    `&name=${encodeURIComponent(feature.name ?? "")}&feature=${encodeURIComponent(ref)}#add`;

  return (
    <SiteShell context={<span className="value">{formatLatLon(feature)}</span>}>
      <div className="py-8">
        <h1 className="hydro-display text-3xl sm:text-4xl">{displayName(feature)}</h1>
        <p className="value mt-2 text-sm text-muted">{formatLatLon(feature)}</p>
        <p className="mt-2 text-sm text-muted">
          {classLabel(feature)}
          {feature.raw_class && feature.raw_class !== classLabel(feature) && (
            <span className="text-muted"> · {feature.raw_class} in the feed</span>
          )}
          {feature.county ? ` · ${feature.county} County, ${feature.state}` : ` · ${feature.state}`}
        </p>
      </div>

      <div className="space-y-8">
        {/*
          Not a verdict slot, and not the thin-source page's dashed "no read"
          stamp either. That stamp is a statement about a record; this is a
          feature with no record to make a statement about. Saying "no reports"
          plainly, once, is the whole content.
        */}
        <div className="rounded-lg border-2 border-dashed border-overprint bg-surface px-5 py-6">
          <p className="collar-label text-overprint">Not yet reported</p>
          <p className="mt-2 text-2xl font-semibold">Nobody has reported this</p>
          <p className="mt-3 max-w-xl leading-relaxed text-muted">
            This feature is in the gazetteer — it is real, and it is where you think it is. But
            this site forecasts from a source&rsquo;s own report history, and there is none, so
            there is nothing to forecast from.
          </p>
        </div>

        {rain && (
          <section>
            <BlockLabel>Rainfall here</BlockLabel>
            <p className="mt-3 max-w-2xl text-lg leading-relaxed">{RAIN_COPY.summary(rain)}</p>
            <div className="mt-4 max-w-2xl rounded-lg border-l-2 border-overprint bg-surface p-4">
              <p className="text-sm leading-relaxed text-muted">{RAIN_COPY.caveat}</p>
            </div>
            <p className="mt-3 max-w-2xl text-xs text-muted">
              <span className="value">{rain.total.toFixed(2)}&Prime;</span> over{" "}
              {rain.windowDays} days, against {rain.years} years at this coordinate — the same
              window has run from <span className="value">{rain.driest.toFixed(2)}&Prime;</span> to{" "}
              <span className="value">{rain.wettest.toFixed(2)}&Prime;</span>. Band:{" "}
              {bandOf(rain)}.
            </p>
          </section>
        )}

        <section>
          <p className="collar-label text-accent">This is the fix</p>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted">
            One dated observation turns this from a name on a map into a source that can
            eventually be forecast — and it sharpens every source around it, because nearby
            sources lend each other statistical strength.
          </p>
          <Link
            href={addHref}
            className="mt-5 inline-block rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Be the first to report this
          </Link>
          <p className="mt-3 max-w-2xl text-xs text-muted">
            The pin and name come pre-filled. You will see anything already recorded nearby before
            it is added, because two entries for one spring halve both records.
          </p>
        </section>

        {reported && (
          <section>
            <BlockLabel>Nearest source with a record</BlockLabel>
            <div className="mt-3 rounded-lg border border-border bg-surface p-5">
              <p>
                <Link href={`/sources/${reported.slug}`} className="hydro-inline text-lg">
                  {reported.name}
                </Link>{" "}
                <span className="value ml-1 text-sm text-accent">
                  {formatDistance(reported.distance_km)} away
                </span>{" "}
                <span className="value text-sm text-muted">{reported.report_count} reports</span>
              </p>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
                A neighbour, <strong className="font-semibold">not a substitute</strong>. Two
                sources this close can behave completely differently — one fed by groundwater that
                barely notices the weather, the other by runoff that is gone a week after the
                storm.
              </p>
            </div>
          </section>
        )}

        {!reported && nearest && (
          <section>
            <BlockLabel>Nearby</BlockLabel>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              The closest recorded source is{" "}
              <Link href={`/sources/${nearest.slug}`} className="hydro-inline">
                {nearest.name}
              </Link>
              , {formatDistance(nearest.distance_km)} away, and it has{" "}
              <span className="value">{nearest.report_count}</span> report
              {nearest.report_count === 1 ? "" : "s"} — not enough for a read of its own.
            </p>
          </section>
        )}

        {/*
          ODbL. `gazetteer.licence` carries the obligation per row precisely so
          that a page rendering the row can discharge it, and this is the page
          that renders the row.
        */}
        <p className="border-t border-border pt-6 text-xs text-muted">
          Feature data: {feature.licence}. Identifier{" "}
          <span className="value">{feature.external_id}</span>.
        </p>
      </div>
    </SiteShell>
  );
}
