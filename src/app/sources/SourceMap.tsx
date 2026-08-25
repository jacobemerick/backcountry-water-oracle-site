"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
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
}: {
  sources: MapSource[];
  selected: LatLon | null;
  onSelect: (point: LatLon) => void;
  center: LatLon;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const pinRef = useRef<Marker | null>(null);
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
        L.circleMarker([s.lat, s.lon], {
          radius: 6,
          weight: 2,
          className: styles.sourceMark,
        })
          .addTo(map)
          .bindTooltip(
            `${s.name}<br><span style="opacity:.7">${s.report_count} report${s.report_count === 1 ? "" : "s"}</span>`,
          );
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

  return (
    <div
      ref={containerRef}
      className="h-[22rem] w-full overflow-hidden rounded-lg border border-border sm:h-[28rem]"
      role="application"
      aria-label="Map for choosing a water source location"
    />
  );
}
