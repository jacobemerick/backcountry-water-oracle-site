"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistance, formatLatLon, parseLatLon, type LatLon } from "@/lib/coords";

/**
 * The one field. Everything else on this site is the answer page it leads to.
 *
 * It takes three kinds of input and the user never has to say which: a name, a
 * coordinate in any notation `parseLatLon` accepts, or their own position. The
 * mode is inferred, because asking someone to pick "name or coordinates" from a
 * menu before they can type is a question the software can answer itself.
 *
 * Deliberately map-free. This renders on the home page, where mounting Leaflet
 * would be a few hundred kilobytes spent on a component the page does not show
 * — and "near me" needs geolocation, not a map.
 */

type Row = {
  slug: string;
  name: string;
  report_count: number;
  /** Present only for proximity results. */
  distance_km?: number;
};

type Mode =
  | { kind: "idle" }
  | { kind: "name"; query: string }
  | { kind: "coords"; point: LatLon }
  | { kind: "near"; point: LatLon };

/**
 * How far out a coordinate or a "near me" looks before concluding nothing is
 * recorded there. Wider than the picker's 2 km duplicate check, which is asking
 * a different question — that one means "is this the same spring", this one
 * means "is there anything out here at all".
 */
const LOOKUP_RADIUS_KM = 25;

const MAX_RESULTS = 8;

export function SearchField({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const listId = useId();

  const [query, setQuery] = useState("");
  const [activeRaw, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const [corpus, setCorpus] = useState<Row[] | null>(null);
  const [corpusError, setCorpusError] = useState<string | null>(null);

  const [proximity, setProximity] = useState<{ key: string; rows: Row[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [nearPoint, setNearPoint] = useState<LatLon | null>(null);

  const corpusRequested = useRef(false);

  /** Fetched once, on first focus. The home page should not pay for a lookup
      nobody has asked for, and the corpus is small enough that substring
      matching in the browser beats a round trip per keystroke. */
  const loadCorpus = useCallback(async () => {
    if (corpusRequested.current) return;
    corpusRequested.current = true;
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load sources.");
      setCorpus(data.sources ?? []);
      setCorpusError(null);
    } catch (e) {
      setCorpusError(e instanceof Error ? e.message : "Could not load sources.");
      setCorpus([]);
    }
  }, []);

  const parsed = useMemo(() => (query.trim() ? parseLatLon(query) : null), [query]);

  const mode: Mode = useMemo(() => {
    if (nearPoint) return { kind: "near", point: nearPoint };
    if (!query.trim()) return { kind: "idle" };
    if (parsed?.ok) return { kind: "coords", point: parsed.value };
    return { kind: "name", query: query.trim() };
  }, [query, parsed, nearPoint]);

  const point = mode.kind === "coords" || mode.kind === "near" ? mode.point : null;

  /**
   * The request URL doubles as the identity of its own result. Keying the
   * cached rows this way means a stale point's results are simply not the
   * current ones — no effect has to reach back and clear them, which is what
   * the lint rule against synchronous setState in an effect is protecting.
   */
  const nearbyUrl = point
    ? `/api/sources/nearby?lat=${point.lat}&lon=${point.lon}&radius_km=${LOOKUP_RADIUS_KM}`
    : null;

  // Debounced and aborted on change, so a fast typist does not queue a request
  // per digit. setBusy lives inside the timer rather than the effect body for
  // the same reason it does in SourcePicker: a synchronous setState here
  // cascades a render, and it also stops the spinner flickering on every key.
  useEffect(() => {
    if (!nearbyUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(nearbyUrl, { signal: controller.signal });
        const data = await res.json();
        setProximity({ key: nearbyUrl, rows: res.ok ? (data.sources ?? []) : [] });
      } catch {
        if (!controller.signal.aborted) setProximity({ key: nearbyUrl, rows: [] });
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
      setBusy(false);
    };
  }, [nearbyUrl]);

  const proximityRows = proximity && proximity.key === nearbyUrl ? proximity.rows : null;

  const results: Row[] = useMemo(() => {
    if (mode.kind === "name") {
      const needle = mode.query.toLowerCase();
      return (corpus ?? [])
        .filter((s) => s.name.toLowerCase().includes(needle))
        .slice(0, MAX_RESULTS);
    }
    if (mode.kind === "coords" || mode.kind === "near") {
      return (proximityRows ?? []).slice(0, MAX_RESULTS);
    }
    return [];
  }, [mode, corpus, proximityRows]);

  // Clamped during render rather than reset from an effect. The highlighted row
  // is a view of the current results, so it is derived, not synchronised.
  const active = results.length ? Math.min(activeRaw, results.length - 1) : 0;

  /** Where "add it" goes: the picker, pre-aimed, rather than a second copy of
      the duplicate-prevention logic this component has no business owning. */
  const addHref = point
    ? `/sources?at=${point.lat.toFixed(6)},${point.lon.toFixed(6)}#add`
    : "/sources#add";

  const settled = mode.kind === "name" ? corpus !== null : proximityRows !== null && !busy;
  const empty = settled && results.length === 0 && mode.kind !== "idle";

  function go(row: Row) {
    router.push(`/sources/${row.slug}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!results.length) {
      if (event.key === "Enter" && empty) {
        event.preventDefault();
        router.push(addHref);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active] ?? results[0]);
    }
  }

  function useMyLocation() {
    setGeoError(null);
    if (!navigator.geolocation) {
      setGeoError("This browser will not share a location.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setNearPoint(next);
        setQuery(formatLatLon(next));
        setOpen(true);
        setBusy(false);
      },
      (err) => {
        setBusy(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied — type a name or a coordinate instead."
            : "Could not get a location fix. Type a name or a coordinate instead.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  const listVisible = open && mode.kind !== "idle";
  const activeId = listVisible && results.length ? `${listId}-${active}` : undefined;

  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  return (
    <div className="w-full">
      <label htmlFor={inputId} className="collar-label block text-muted">
        Find a water source
      </label>

      <div className="relative mt-2">
        {/* Bordered in --foreground rather than --border: on a quad the input is
            the one place the sheet invites a mark. */}
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={listVisible}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={`${inputId}-hint`}
          autoComplete="off"
          autoFocus={autoFocus}
          value={query}
          placeholder="A name, or 34.0891 -111.4672"
          onFocus={() => {
            setOpen(true);
            void loadCorpus();
          }}
          onBlur={() => {
            // Let a click on an option land before the list is torn down.
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setNearPoint(null);
            setGeoError(null);
            setOpen(true);
            void loadCorpus();
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border-2 border-foreground bg-surface px-4 py-3 text-lg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
        />

        {listVisible && (results.length > 0 || empty) && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching water sources"
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-lg"
          >
            {results.map((row, i) => (
              <li
                key={row.slug}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(row)}
                className={`flex cursor-pointer flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 ${
                  i === active ? "bg-accent-soft" : ""
                }`}
              >
                <span className="hydro-inline">{row.name}</span>
                <span className="value text-xs text-muted">
                  {row.distance_km !== undefined && (
                    <span className="mr-3 text-accent">{formatDistance(row.distance_km)}</span>
                  )}
                  {row.report_count} report{row.report_count === 1 ? "" : "s"}
                </span>
              </li>
            ))}

            {/* Nothing found is a first-class result, not an error. This is how
                the corpus grows: the gaps are the point. */}
            {empty && (
              <li className="px-4 py-3">
                <p className="text-sm leading-relaxed">
                  {mode.kind === "name" ? (
                    <>No source recorded under that name.</>
                  ) : (
                    <>
                      No source recorded within{" "}
                      <span className="value">{LOOKUP_RADIUS_KM} km</span> of{" "}
                      <span className="value">{point ? formatLatLon(point) : ""}</span>.
                    </>
                  )}{" "}
                  <a
                    href={addHref}
                    className="font-medium text-accent underline decoration-border underline-offset-4"
                  >
                    Add it
                  </a>
                  .
                </p>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
        <button
          type="button"
          onClick={useMyLocation}
          className="text-accent underline decoration-border underline-offset-4 hover:decoration-accent"
        >
          Use my location
        </button>
        <p id={`${inputId}-hint`} className="text-muted">
          Type a name, paste a coordinate in any notation, or use your location.
        </p>
      </div>

      {busy && <p className="mt-2 text-sm text-muted">Looking&hellip;</p>}

      {/* A coordinate that does not parse is worth saying out loud — the parser
          accepts three notations, so a rejection usually means a real typo. */}
      {parsed && !parsed.ok && /[0-9]/.test(query) && mode.kind === "name" && (
        <p className="mt-2 text-sm text-muted">
          Not a coordinate ({parsed.error}) — searching names instead.
        </p>
      )}

      {corpusError && <p className="mt-2 text-sm text-warn">{corpusError}</p>}
      {geoError && <p className="mt-2 text-sm text-warn">{geoError}</p>}
    </div>
  );
}
