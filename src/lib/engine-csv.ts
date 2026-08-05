/**
 * Serialization into the forecast engine's one and only input format:
 *
 *     source,lat,lon,date,score,status
 *
 * Pure, dependency-free, and deliberately separate from the database layer --
 * this is the contract boundary with the Python engine, so it should be
 * testable without a connection string.
 */

/** One row of the engine's CSV contract. */
export type EngineRow = {
  source: string;
  lat: number;
  lon: number;
  date: string;
  score: number;
  status: string | null;
};

const NEEDS_QUOTING = /[",\r\n]/;

function csvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Guards engine issue #9: the engine groups reports by source NAME and silently
 * adopts the first row's coordinates for every row sharing it. Two different
 * springs both called "Cottonwood Spring" in one request would be fused into
 * one, with half the observations correlated against the wrong location's
 * rainfall -- and the output would look completely normal. So a name that maps
 * to more than one coordinate gets disambiguated here, before the engine can
 * ever see the collision.
 *
 * Note this keys on the exact coordinate pair: sub-metre GPS scatter on what is
 * really one spring would split it. Dedupe belongs upstream, at source creation.
 */
export function toEngineCsv(rows: EngineRow[]): string {
  const nameByCoord = new Map<string, string>();
  const usedNames = new Set<string>();

  const lines = ["source,lat,lon,date,score,status"];
  for (const row of rows) {
    const coordKey = `${row.source}@${row.lat},${row.lon}`;
    let name = nameByCoord.get(coordKey);
    if (name === undefined) {
      name = row.source;
      for (let n = 2; usedNames.has(name); n++) name = `${row.source} (${n})`;
      usedNames.add(name);
      nameByCoord.set(coordKey, name);
    }
    lines.push(
      [
        csvField(name),
        row.lat.toFixed(5),
        row.lon.toFixed(5),
        row.date,
        row.score.toFixed(2),
        csvField(row.status ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
