"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
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
 *
 * ## Two kinds of answer, kept apart
 *
 * A **source** has observations behind it. A **feature** is a name on a map
 * from USGS or OSM that nobody has reported on. Merging them into one ranked
 * list would put a spring nobody has ever visited next to one with a decade of
 * reports, sorted by spelling — so they are separate groups, sources first.
 *
 * Searching moved to the server in the same change. This component used to
 * fetch the entire corpus on first focus and substring-match it in the browser,
 * which was right at four sources and cannot see the gazetteer at all.
 */

type SourceHit = {
  kind: "source";
  slug: string;
  name: string;
  report_count: number;
  last_reported: string | null;
  distance_km: number | null;
};

type FeatureHit = {
  kind: "feature";
  path: string | null;
  name: string | null;
  feature_class: string;
  county: string | null;
  state: string;
  distance_km: number | null;
};

type Hit = SourceHit | FeatureHit;

type Results = {
  sources: SourceHit[];
  features: FeatureHit[];
  feature_total: number;
  fuzzy: boolean;
  /** Only meaningful for a coordinate lookup: does the gazetteer reach here. */
  covered: boolean | null;
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

/** The six states the gazetteer covers, as `gazetteer.state`'s CHECK spells
    them. Named here only to say the scope out loud when a search falls outside
    it — "not found" and "not covered" are different sentences. */
const COVERAGE = "Arizona, California, Colorado, Nevada, New Mexico and Utah";

function featureLabel(f: FeatureHit): string {
  return f.name ?? `Unnamed ${f.feature_class.replace(/_/g, " ")}`;
}

function featureWhere(f: FeatureHit): string {
  return f.county ? `${f.county} County, ${f.state}` : f.state;
}

export function SearchField({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const listId = useId();

  const [query, setQuery] = useState("");
  const [activeRaw, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const [results, setResults] = useState<{ key: string; data: Results } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [nearPoint, setNearPoint] = useState<LatLon | null>(null);

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
   * cached rows this way means a stale query's results are simply not the
   * current ones — no effect has to reach back and clear them, which is what
   * the lint rule against synchronous setState in an effect is protecting.
   */
  const searchUrl =
    mode.kind === "idle"
      ? null
      : point
        ? `/api/search?lat=${point.lat}&lon=${point.lon}`
        : `/api/search?q=${encodeURIComponent(mode.kind === "name" ? mode.query : "")}`;

  // Debounced and aborted on change, so a fast typist does not queue a request
  // per keystroke. setBusy lives inside the timer rather than the effect body:
  // a synchronous setState here cascades a render, and it also stops the
  // spinner flickering on every key.
  useEffect(() => {
    if (!searchUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(searchUrl, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed.");
        setResults({ key: searchUrl, data });
        setError(null);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "Search failed.");
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
      setBusy(false);
    };
  }, [searchUrl]);

  const current = results && results.key === searchUrl ? results.data : null;

  // Flat for keyboard navigation, grouped for the eye. Sources first: a page
  // with observations behind it beats a name on a map, always.
  const hits: Hit[] = useMemo(
    () => (current ? [...current.sources, ...current.features] : []),
    [current],
  );

  // Clamped during render rather than reset from an effect. The highlighted row
  // is a view of the current results, so it is derived, not synchronised.
  const active = hits.length ? Math.min(activeRaw, hits.length - 1) : 0;

  /** Where "add it" goes: the picker, pre-aimed, rather than a second copy of
      the duplicate-prevention logic this component has no business owning. */
  const addHref = point
    ? `/sources?at=${point.lat.toFixed(6)},${point.lon.toFixed(6)}#add`
    : "/sources#add";

  const settled = current !== null && !busy;
  const empty = settled && hits.length === 0 && mode.kind !== "idle";

  function hrefFor(hit: Hit): string | null {
    return hit.kind === "source" ? `/sources/${hit.slug}` : hit.path;
  }

  function go(hit: Hit) {
    const href = hrefFor(hit);
    if (href) router.push(href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!hits.length) {
      if (event.key === "Enter" && empty) {
        event.preventDefault();
        router.push(addHref);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(hits[active] ?? hits[0]);
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
  const activeId = listVisible && hits.length ? `${listId}-${active}` : undefined;

  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

  const sourceCount = current?.sources.length ?? 0;

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
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Let a click on an option land before the list is torn down.
            blurTimer.current = setTimeout(() => setOpen(false), 120);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setNearPoint(null);
            setGeoError(null);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border-2 border-foreground bg-surface px-4 py-3 text-lg outline-none placeholder:text-muted focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
        />

        {listVisible && (hits.length > 0 || empty) && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching water sources"
            className="absolute z-20 mt-1 max-h-[70vh] w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
          >
            {current?.fuzzy && hits.length > 0 && (
              <li role="presentation" className="border-b border-border bg-surface-sunk px-4 py-2">
                <p className="text-xs text-muted">
                  Nothing matched that exactly — closest spellings:
                </p>
              </li>
            )}

            {sourceCount > 0 && (
              <li role="presentation" className="bg-surface-sunk px-4 py-1.5">
                <p className="collar-label text-muted">Recorded sources</p>
              </li>
            )}

            {hits.map((hit, i) => {
              const isFirstFeature = hit.kind === "feature" && i === sourceCount;
              return (
                // A Fragment, not a wrapper element: a <ul role="listbox">
                // whose children are divs is invalid markup, and screen readers
                // stop counting the options.
                <Fragment key={hit.kind === "source" ? `s-${hit.slug}` : `f-${hit.path}-${i}`}>
                  {isFirstFeature && (
                    <li role="presentation" className="bg-surface-sunk px-4 py-1.5">
                      <p className="collar-label text-muted">
                        On the map, not yet reported
                        {current && current.feature_total > current.features.length && (
                          <span className="normal-case tracking-normal">
                            {" "}
                            · showing {current.features.length} of {current.feature_total}
                          </span>
                        )}
                      </p>
                    </li>
                  )}
                  <li
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit)}
                    className={`flex cursor-pointer flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 ${
                      i === active ? "bg-accent-soft" : ""
                    }`}
                  >
                    {hit.kind === "source" ? (
                      <>
                        <span className="hydro-inline">{hit.name}</span>
                        <span className="value text-xs text-muted">
                          {hit.distance_km !== null && (
                            <span className="mr-3 text-accent">
                              {formatDistance(hit.distance_km)}
                            </span>
                          )}
                          {hit.report_count} report{hit.report_count === 1 ? "" : "s"}
                        </span>
                      </>
                    ) : (
                      <>
                        <span>{featureLabel(hit)}</span>
                        <span className="value text-xs text-muted">
                          {hit.distance_km !== null && (
                            <span className="mr-3 text-accent">
                              {formatDistance(hit.distance_km)}
                            </span>
                          )}
                          {featureWhere(hit)}
                        </span>
                      </>
                    )}
                  </li>
                </Fragment>
              );
            })}

            {/* Nothing found is a first-class result, not an error. This is how
                the corpus grows: the gaps are the point. */}
            {empty && (
              <li className="px-4 py-3">
                <p className="text-sm leading-relaxed">
                  {mode.kind === "name" ? (
                    <>
                      Nothing by that name in {COVERAGE} — the states this site covers.
                    </>
                  ) : current?.covered === false ? (
                    // Out of coverage is a different sentence from not found,
                    // and saying the wrong one tells somebody their spring does
                    // not exist when the truth is that this site has not
                    // loaded their state.
                    <>
                      That is outside the area this site covers. The gazetteer holds {COVERAGE};
                      there is nothing loaded near{" "}
                      <span className="value">{point ? formatLatLon(point) : ""}</span>.
                    </>
                  ) : (
                    <>
                      Nothing recorded or mapped within{" "}
                      <span className="value">{LOOKUP_RADIUS_KM} km</span> of{" "}
                      <span className="value">{point ? formatLatLon(point) : ""}</span>.
                    </>
                  )}{" "}
                  {current?.covered !== false && (
                    <a
                      href={addHref}
                      className="font-medium text-accent underline decoration-border underline-offset-4"
                    >
                      Add it
                    </a>
                  )}
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

      {error && <p className="mt-2 text-sm text-warn">{error}</p>}
      {geoError && <p className="mt-2 text-sm text-warn">{geoError}</p>}
    </div>
  );
}
