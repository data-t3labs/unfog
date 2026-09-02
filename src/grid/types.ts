/**
 * Shared contracts for the visited-cell grid. Implemented by src/grid (store) and consumed by
 * the render worker, the routing worker (novelty scoring) and the importers.
 */

/**
 * Overview levels. A level-L cell tile at (tx, ty) (tile coords at zoom L) holds 256×256 cells,
 * each cell being one zoom-(L+8) pixel. Level 14 is the base (z22 cells = Fog of World pixels).
 * Level 10 cells are 16×16 base cells, level 6 cells are 256×256 base cells (= one base tile),
 * level 2 cells are 4096×4096 base cells. Overview counts are the MAX of their children, kept
 * write-through by the store so any map zoom touches ≤ 16 tiles:
 *   level = largest L in LEVELS with L ≤ mapZoom + 2.
 */
export const LEVELS = [14, 10, 6, 2] as const;
export type Level = (typeof LEVELS)[number];

export function levelForZoom(zoom: number): Level {
  for (const l of LEVELS) if (l <= zoom + 2) return l;
  return 2;
}

/** Visit counts for one tile: Uint8Array(65536), row-major (iy * 256 + ix), 0 = never visited, saturates at 255. */
export type CellCounts = Uint8Array;

export interface CellTileRef { level: Level; tx: number; ty: number }

/**
 * Read-only access to cell tiles. The grid worker implements it over IndexedDB with an in-memory
 * cache; the routing worker opens the same database read-only. `null` = no data for that tile.
 */
export interface CellTileProvider {
  getTile(level: Level, tx: number, ty: number): Promise<CellCounts | null>;
  /** Several tiles at once (same semantics, aligned with `refs`); lets the store batch its reads. */
  getTiles?(refs: readonly CellTileRef[]): Promise<Array<CellCounts | null>>;
}

/** Aggregate statistics kept by the store (updated on every write). */
export interface GridStats {
  /** Base cells with count ≥ 1. */
  visitedCells: number;
  /** Σ cell area over visited cells (m²), computed from each cell's latitude. */
  areaM2: number;
  /** Number of base (level 14) tiles with any data. */
  tiles: number;
  /** Monotonic version, bumped on every mutation; used to invalidate map tiles and caches. */
  version: number;
  updatedAt: number;
}

/**
 * A GPS track ready for the grid: ordered fixes. Importers and the recorder produce these; the
 * store rasterises them (cells along the polyline) and increments each touched cell ONCE per
 * track — a "visit" is a track/session/day, never a GPS fix.
 */
export interface Track {
  id: string;
  /** e.g. 'gpx', 'timeline', 'session', 'fow' */
  source: string;
  name?: string;
  /** [lon, lat, timeMs?] */
  points: Array<[number, number, number?]>;
}

/** What an importer hands to the store. FoW imports set cells directly (count = max(count, 1)). */
export interface ImportPayload {
  tracks?: Track[];
  /** Base-level tiles with the cells to mark; values are 0/1 masks (FoW) or counts to merge with max. */
  cellTiles?: Array<{ tx: number; ty: number; counts: CellCounts }>;
  /** Free-form provenance for the Data screen. */
  meta: { source: string; fileName?: string; items: number; note?: string };
}
