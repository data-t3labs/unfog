/**
 * Which overlay raster tiles a change to a z14 cell tile can alter — for `map.refreshTiles`
 * after a recording checkpoint (src/map/map.ts refreshOverlay). Pure: no MapLibre import, so
 * it runs in Node tests.
 *
 * A fog tile reads its own cells plus a margin of neighbours for the blur (docs/BUILD-PLAN.md
 * §2.2, src/render/tiles.ts): ≈ 3σ of the widest feather (6 cells → 18) plus the 1-cell core
 * dilation at base level, and at low zoom the pixel floor's ribbon (10 of 512 px ≈ 2 % of a
 * tile ≈ 5 z14 cells). MARGIN_CELLS covers all of those with room to spare.
 */
import { TILE_SIZE, WORLD } from '../grid/cell';

export const MARGIN_CELLS = 32;

export interface TileId {
  x: number;
  y: number;
  z: number;
}

/**
 * Canonical tile ids at every zoom in [minZoom, maxZoom] whose ground (plus the blur margin)
 * overlaps any of the touched z14 tiles. Deduplicated; order unspecified.
 */
export function overlayTileIdsFor(touched: Iterable<{ tx: number; ty: number }>, minZoom = 2, maxZoom = 18): TileId[] {
  const seen = new Set<string>();
  const out: TileId[] = [];
  for (const { tx, ty } of touched) {
    // Inclusive z22 cell range of the tile plus its margin, clamped to the world.
    const x0 = Math.max(0, tx * TILE_SIZE - MARGIN_CELLS), y0 = Math.max(0, ty * TILE_SIZE - MARGIN_CELLS);
    const x1 = Math.min(WORLD - 1, (tx + 1) * TILE_SIZE - 1 + MARGIN_CELLS), y1 = Math.min(WORLD - 1, (ty + 1) * TILE_SIZE - 1 + MARGIN_CELLS);
    for (let z = minZoom; z <= maxZoom; z++) {
      const shift = 22 - z; // z22 cells per tile side = 2^shift
      const ax0 = x0 >> shift, ax1 = x1 >> shift, ay0 = y0 >> shift, ay1 = y1 >> shift;
      for (let y = ay0; y <= ay1; y++) {
        for (let x = ax0; x <= ax1; x++) {
          const key = `${z}/${x}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ x, y, z });
        }
      }
    }
  }
  return out;
}
