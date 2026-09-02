/**
 * Synchronous visit-count lookup for novelty scoring. The search loop scores arcs lazily and
 * cannot await, so implementations preload whatever they need (see cells-idb.ts) and answer
 * `get` from memory. Unknown cells are 0 (never visited).
 */
import { TILE_SHIFT, TILE_MASK, WORLD, tileKey } from '../grid/cell';

export interface CellLookup {
  /** Visit count of a z22 cell (0 = never). */
  get(cx: number, cy: number): number;
}

/** In-memory lookup for tests and synthetic scenarios. */
export class MapCellLookup implements CellLookup {
  private readonly cells = new Map<number, number>();

  get size(): number {
    return this.cells.size;
  }

  get(cx: number, cy: number): number {
    return this.cells.get(cy * WORLD + cx) ?? 0;
  }

  set(cx: number, cy: number, count: number): void {
    const k = cy * WORLD + cx;
    if (count <= 0) this.cells.delete(k);
    else this.cells.set(k, count);
  }

  /** count = max(count, value); with `dilate` also the 8 neighbours. */
  mark(cx: number, cy: number, value = 1, dilate = 0): void {
    for (let dy = -dilate; dy <= dilate; dy++) {
      for (let dx = -dilate; dx <= dilate; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= WORLD || y >= WORLD) continue;
        const k = y * WORLD + x;
        const c = this.cells.get(k) ?? 0;
        if (value > c) this.cells.set(k, value);
      }
    }
  }

  clear(): void {
    this.cells.clear();
  }
}

/**
 * Lookup over decoded base-level (z14) tiles held in a Map keyed by `tileKey(14, tx, ty)`.
 * Shared by IdbCellLookup; also usable directly when tiles come from elsewhere (tests).
 */
export class TileCellLookup implements CellLookup {
  protected readonly tiles = new Map<number, Uint8Array | null>();

  constructor(protected readonly maxTiles = 512) {}

  get(cx: number, cy: number): number {
    const t = this.tiles.get(tileKey(14, cx >> TILE_SHIFT, cy >> TILE_SHIFT));
    return t ? t[((cy & TILE_MASK) << TILE_SHIFT) | (cx & TILE_MASK)] : 0;
  }

  has(tx: number, ty: number): boolean {
    return this.tiles.has(tileKey(14, tx, ty));
  }

  /** Insert a decoded tile (null = known empty). Evicts the oldest entries beyond maxTiles. */
  setTile(tx: number, ty: number, counts: Uint8Array | null): void {
    const k = tileKey(14, tx, ty);
    this.tiles.delete(k);
    this.tiles.set(k, counts);
    while (this.tiles.size > this.maxTiles) {
      const oldest = this.tiles.keys().next().value as number;
      this.tiles.delete(oldest);
    }
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  clear(): void {
    this.tiles.clear();
  }
}
