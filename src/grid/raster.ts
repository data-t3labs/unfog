/**
 * Track rasteriser: polyline → the set of base cells it touches, grouped by base tile.
 *
 * A track marks each cell ONCE no matter how many times it crosses it (a "visit" is a
 * track/session, never a GPS fix), so the result is deduplicated per tile. Sampling every 3 m
 * (a cell is ≥ 6 m at city latitudes) guarantees 8-connected coverage with no skipped cells;
 * consecutive fixes further apart than `gapM` are a break (signal loss, transit) and nothing is
 * marked between them.
 */
import { cellsAlong, tileKey, TILE_MASK, TILE_SHIFT, TILE_SIZE } from './cell';

export interface RasterOptions {
  /** Sampling step along the polyline (m). Default 3. */
  stepM?: number;
  /** Consecutive fixes further apart than this are not joined (m). Default 500. */
  gapM?: number;
}

export const DEFAULT_RASTER: Required<RasterOptions> = { stepM: 3, gapM: 500 };

/**
 * Rasterise a polyline of [lon, lat, …] points. Returns a map keyed by `tileKey(14, tx, ty)`
 * whose values are the sorted, distinct cell indices (iy·256 + ix) inside that tile.
 */
export function rasterizeTrack(
  points: ReadonlyArray<readonly [lon: number, lat: number, ...rest: unknown[]]>,
  opts: RasterOptions = {},
): Map<number, Uint32Array> {
  const stepM = opts.stepM ?? DEFAULT_RASTER.stepM;
  const gapM = opts.gapM ?? DEFAULT_RASTER.gapM;
  // cellsAlong only reads [0] and [1]; a 3-tuple is structurally fine but not assignable.
  const cells = cellsAlong(points as ReadonlyArray<readonly [number, number]>, { stepM, gapM });
  const perTile = new Map<number, Set<number>>();
  for (let i = 0; i < cells.length; i++) {
    const cx = cells[i][0], cy = cells[i][1];
    const key = tileKey(14, cx >> TILE_SHIFT, cy >> TILE_SHIFT);
    let set = perTile.get(key);
    if (!set) { set = new Set(); perTile.set(key, set); }
    set.add((cy & TILE_MASK) * TILE_SIZE + (cx & TILE_MASK));
  }
  const out = new Map<number, Uint32Array>();
  for (const [key, set] of perTile) {
    const arr = Uint32Array.from(set);
    arr.sort(); // typed-array sort is numeric; ascending indices = sequential memory access
    out.set(key, arr);
  }
  return out;
}
