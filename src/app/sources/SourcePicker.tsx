"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDistance, formatLatLon, parseLatLon, type LatLon } from "@/lib/coords";
import type { MapSource } from "./SourceMap";

const SourceMap = dynamic(() => import("./SourceMap").then((m) => m.SourceMap), {
  ssr: false,
  loading: () => (
    <div className="flex h-[22rem] w-full items-center justify-center rounded-lg border border-border bg-surface-sunk text-sm text-muted sm:h-[28rem]">
      Loading map…
    </div>
  ),
});

type Nearby = {
  id: number;
  name: string;
  slug: string;
  lat: number;
  lon: number;
  distance_km: number;
  report_count: number;
  last_reported: string | null;
};

/** Below this, the picker stops offering to create and insists it is the same source. */
const SAME_SOURCE_KM = 0.05;

export function SourcePicker({ id, sources }: { id?: string; sources: MapSource[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [point, setPoint] = useState<LatLon | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<Nearby[] | null>(null);
  const [checking, setChecking] = useState(false);

  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Centre on the existing corpus, falling back to central Arizona where the
  // seed data lives. An empty map centred on the ocean helps nobody.
  const center = useMemo<LatLon>(() => {
    if (sources.length === 0) return { lat: 34.08, lon: -111.47 };
    const lat = sources.reduce((a, s) => a + s.lat, 0) / sources.length;
    const lon = sources.reduce((a, s) => a + s.lon, 0) / sources.length;
    return { lat, lon };
  }, [sources]);

  const selectPoint = useCallback((next: LatLon) => {
    setPoint(next);
    setText(formatLatLon(next));
    setParseError(null);
    setNearby(null);
  }, []);

  function onTextChange(value: string) {
    setText(value);
    setSubmitError(null);
    if (!value.trim()) {
      setPoint(null);
      setParseError(null);
      setNearby(null);
      return;
    }
    const parsed = parseLatLon(value);
    setNearby(null);
    if (parsed.ok) {
      setPoint(parsed.value);
      setParseError(null);
    } else {
      setPoint(null);
      setParseError(parsed.error);
    }
  }

  // Look up neighbours whenever the point settles.
  useEffect(() => {
    if (!point) return;
    const controller = new AbortController();
    // setChecking moves inside the timer rather than running synchronously in
    // the effect body: a synchronous setState here triggers a cascading render,
    // and it also means a fast typist never sees the spinner flicker.
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch(
          `/api/sources/nearby?lat=${point.lat}&lon=${point.lon}&radius_km=2`,
          { signal: controller.signal },
        );
        const data = await res.json();
        setNearby(res.ok ? (data.sources ?? []) : []);
      } catch {
        if (!controller.signal.aborted) setNearby([]);
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
      setChecking(false);
    };
  }, [point]);

  const certainDuplicate = nearby?.find((s) => s.distance_km <= SAME_SOURCE_KM) ?? null;
  const canSubmit = Boolean(point) && name.trim().length > 0 && !certainDuplicate && !submitting;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!point || !canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), lat: point.lat, lon: point.lon, notes: notes.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? "Could not create the source.");
        return;
      }
      router.push(`/sources/${data.source.slug}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Could not create the source.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div id={id} className="scroll-mt-4 space-y-8">
      <SourceMap sources={sources} selected={point} onSelect={selectPoint} center={center} />

      <div>
        <label htmlFor="coords" className="block text-sm font-medium">
          Coordinates
        </label>
        <p className="mt-1 text-sm text-muted">
          Click the map, or paste from a trail report — decimal, <code>N34 05.142 W111 29.449</code>
          , and <code>34°5&apos;9&quot;N</code> all work.
        </p>
        <input
          id="coords"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="34.08587, -111.49097"
          spellCheck={false}
          autoComplete="off"
          className="mt-3 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        {parseError && <p className="mt-2 text-sm text-warn">{parseError}</p>}
        {point && !parseError && (
          <p className="mt-2 font-mono text-xs text-muted">Reading as {formatLatLon(point)}</p>
        )}
      </div>

      {point && (
        <section aria-live="polite">
          <h2 className="text-sm font-semibold">
            {checking
              ? "Checking for existing sources…"
              : nearby && nearby.length > 0
                ? `${nearby.length} source${nearby.length === 1 ? "" : "s"} already recorded nearby`
                : "Nothing recorded within 2 miles"}
          </h2>

          {nearby && nearby.length > 0 && (
            <>
              <p className="mt-1 text-sm text-muted">
                If one of these is the same water, add your report to it. Splitting one spring
                across two entries halves both records, and neither accumulates enough reports to
                say anything.
              </p>
              <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
                {nearby.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-surface px-4 py-3">
                    <Link href={`/sources/${s.slug}`} className="font-medium hover:text-accent">
                      {s.name}
                    </Link>
                    <span className="font-mono text-xs text-accent">
                      {formatDistance(s.distance_km)} away
                    </span>
                    <span className="text-xs text-muted">
                      {s.report_count} report{s.report_count === 1 ? "" : "s"}
                      {s.last_reported ? `, last ${s.last_reported}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {certainDuplicate && (
            <p className="mt-3 rounded-lg border-l-2 border-warn bg-warn-soft p-4 text-sm leading-relaxed">
              <strong className="font-semibold text-warn">That is an existing source.</strong>{" "}
              <Link href={`/sources/${certainDuplicate.slug}`} className="underline">
                {certainDuplicate.name}
              </Link>{" "}
              is {formatDistance(certainDuplicate.distance_km)} from this point — close enough that
              they are certainly the same water. Add your report there.
            </p>
          )}
        </section>
      )}

      {point && !certainDuplicate && (
        <form onSubmit={onSubmit} className="space-y-4 border-t border-border pt-8">
          <h2 className="text-lg font-semibold tracking-tight">None of those? Add it.</h2>

          <div>
            <label htmlFor="name" className="block text-sm font-medium">
              Name
            </label>
            <p className="mt-1 text-sm text-muted">
              What it is called on the map or in reports. Include the area if the name is a common
              one — there are a great many Cottonwood Springs.
            </p>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Chilson Spring"
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="notes" className="block text-sm font-medium">
              Notes <span className="font-normal text-muted">(optional)</span>
            </label>
            <p className="mt-1 text-sm text-muted">
              What kind of source it is, how to find it, anything a future visitor would want.
            </p>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Hillside seep with a spring box, 100 yards above the trail junction."
              className="mt-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>

          {submitError && (
            <p className="rounded-lg border-l-2 border-warn bg-warn-soft p-3 text-sm">{submitError}</p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Adding…" : "Add this source"}
          </button>
          <p className="text-xs text-muted">
            Adding a source records the location only. It will have no forecast until it has
            reports — the model has nothing to correlate without them.
          </p>
        </form>
      )}
    </div>
  );
}
