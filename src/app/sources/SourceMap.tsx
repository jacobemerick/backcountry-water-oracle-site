"use client";

import { useEffect, useRef } from "react";
import type { Circle, CircleMarker, Map as LeafletMap, Marker } from "leaflet";
import type { LatLon } from "@/lib/coords";
import "leaflet/dist/leaflet.css";
import styles from "./SourceMap.module.css";

export type MapSource = {
  id: number;
  name: string;
  slug: string;
  lat: number;
  lon: number;
  report_count: number;
};

/**
 * USGS's National Map, which is public domain, needs no API key, and — the
 * reason it beats a generic street basemap here — is *topographic*. Someone
 * placing a spring is reading terrain: drainages, contours, benches. A road map
 * shows them almost nothing useful.
 *
 * Imagery is offered alongside because a seep is often easier to spot as a
 * green smudge in a dry canyon than as a contour.
 */
const BASEMAPS = {
  topo: {
    label: "Topo",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    attribution:
      '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
  },
  imagery: {
    label: "Imagery",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    attribution:
      '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>',
  },
} as const;

export function SourceMap({
  sources,
  selected,
  onSelect,
  center,
  poolingRadiusKm,
  pooledIds,
}: {
  sources: MapSource[];
  selected: LatLon | null;
  onSelect: (point: LatLon) => void;
  center: LatLon;
  /** Radius of the pooling ring, in km. Drawn only while a pin is placed. */
  poolingRadiusKm?: number;
  /** Ids the server says fall inside that radius — the authoritative set. */
  pooledIds?: number[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const pinRef = useRef<Marker | null>(null);
  const ringRef = useRef<Circle | null>(null);
  // Markers are created once on mount; highlighting them later means reaching
  // for the element rather than rebuilding them, which would drop tooltips and
  // flicker on every pin move.
  const markersRef = useRef<Map<number, CircleMarker>>(new Map());
  // The map is created once and its click handler captured then, so it needs a
  // stable way to reach the latest onSelect. Assigned in an effect rather than
  // during render — a ref write during render is a lie about purity, and React
  // is right to complain.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // Leaflet touches window/document, so it can only be imported in the browser.
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    const markers = markersRef.current;

    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;

      map = L.map(containerRef.current, { scrollWheelZoom: true }).setView(
        [center.lat, center.lon],
        12,
      );
      mapRef.current = map;

      const layers = Object.fromEntries(
        Object.values(BASEMAPS).map((cfg) => [
          cfg.label,
          // USGS serves up to z16; asking for more yields blank tiles rather
          // than an error, so cap it and let Leaflet upscale instead.
          L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: 16 }),
        ]),
      ) as Record<string, ReturnType<typeof L.tileLayer>>;

      layers[BASEMAPS.topo.label].addTo(map);
      L.control.layers(layers, undefined, { position: "topright" }).addTo(map);

      // Existing sources, so people find a spring rather than re-create it.
      for (const s of sources) {
        const marker = L.circleMarker([s.lat, s.lon], {
          radius: 6,
          weight: 2,
          className: styles.sourceMark,
        })
          .addTo(map)
          .bindTooltip(
            `${s.name}<br><span style="opacity:.7">${s.report_count} report${s.report_count === 1 ? "" : "s"}</span>`,
          );
        markersRef.current.set(s.id, marker);
      }

      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        onSelectRef.current({ lat: e.latlng.lat, lon: e.latlng.lng });
      });
    })();

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      pinRef.current = null;
      ringRef.current = null;
      markers.clear();
    };
    // Mount once. `sources` is fetched before this renders and `center` is only
    // an initial view; re-running would tear down the user's pan and zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the dropped pin in step with whatever set it — map click or typed text.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    (async () => {
      const L = await import("leaflet");
      if (!selected) {
        pinRef.current?.remove();
        pinRef.current = null;
        return;
      }
      const icon = L.divIcon({
        className: "",
        html: `<div class="${styles.pin}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      if (pinRef.current) pinRef.current.setLatLng([selected.lat, selected.lon]);
      else pinRef.current = L.marker([selected.lat, selected.lon], { icon }).addTo(map);

      if (!map.getBounds().contains([selected.lat, selected.lon])) {
        map.setView([selected.lat, selected.lon], Math.max(map.getZoom(), 13));
      }
    })();
  }, [selected]);

  const pooledKey = (pooledIds ?? []).join(",");

  /**
   * The pooling ring, and the sources it captures.
   *
   * This is the one thing a map is genuinely best at here. `sourcesNear(lat,
   * lon, 25)` is what lends a thin source statistical strength from neighbours
   * that respond to rain the same way, and until now that radius was invisible
   * — the most distinctive thing the engine does, with nothing on screen.
   *
   * Drawn only while a pin is placed. It is an explanation, not chrome.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Keyed on a string so the effect tracks the *contents* of the set. An
    // array prop is a new identity every render, which would re-run this on
    // each keystroke in the coordinate box.
    const pooled = new Set(pooledKey ? pooledKey.split(",").map(Number) : []);

    (async () => {
      const L = await import("leaflet");
      if (!mapRef.current) return;

      if (!selected || !poolingRadiusKm) {
        ringRef.current?.remove();
        ringRef.current = null;
      } else if (ringRef.current) {
        ringRef.current
          .setLatLng([selected.lat, selected.lon])
          .setRadius(poolingRadiusKm * 1000);
      } else {
        ringRef.current = L.circle([selected.lat, selected.lon], {
          radius: poolingRadiusKm * 1000,
          weight: 1.5,
          className: styles.poolingRing,
          interactive: false,
        }).addTo(mapRef.current);
      }

      // Toggle a class on the existing element rather than rebuilding markers,
      // which would drop their tooltips every time the pin moves.
      for (const [id, marker] of markersRef.current) {
        marker.getElement()?.classList.toggle(styles.pooledMark, pooled.has(id));
      }
    })();
  }, [selected, poolingRadiusKm, pooledKey]);

  return (
    <div
      ref={containerRef}
      className="h-[22rem] w-full overflow-hidden rounded-lg border border-border sm:h-[28rem]"
      role="application"
      aria-label="Map for choosing a water source location"
    />
  );
}
