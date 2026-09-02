/**
 * Synthetic visited-cell data for grid/render tests: an in-memory CellTileProvider with a street
 * grid around a lon/lat, plus helpers to place cells by hand. Overview levels are max-pooled on
 * demand, exactly like the store maintains them.
 */
import { lonLatToCell, TILE_SIZE } from '../../../src/grid/cell';
import type { CellCounts, CellTileProvider, Level } from '../../../src/grid/types';

const TILE_CELLS = TILE_SIZE * TILE_SIZE;

export class MemoryProvider implements CellTileProvider {
  private readonly base = new Map<string, Uint8Array>();
  private readonly overviews = new Map<string, Uint8Array | null>();
  /** Number of getTile calls (tests assert on fetch fan-out). */
  calls = 0;

  set(cx: number, cy: number, count: number): void {
    const key = `${cx >> 8}/${cy >> 8}`;
    let t = this.base.get(key);
    if (!t) { t = new Uint8Array(TILE_CELLS); this.base.set(key, t); }
    const i = (cy & 255) * TILE_SIZE + (cx & 255);
    if (count > t[i]) t[i] = count;
    this.overviews.clear();
  }

  get(cx: number, cy: number): number {
    const t = this.base.get(`${cx >> 8}/${cy >> 8}`);
    return t ? t[(cy & 255) * TILE_SIZE + (cx & 255)] : 0;
  }

  /** Mark a straight line of cells (Bresenham-free: axis-aligned or sampled) with a count. */
  line(x0: number, y0: number, x1: number, y1: number, count: number): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), count);
  }

  baseTiles(): Array<{ tx: number; ty: number; counts: Uint8Array }> {
    return [...this.base].map(([k, counts]) => { const [tx, ty] = k.split('/').map(Number); return { tx, ty, counts }; });
  }

  async getTile(level: Level, tx: number, ty: number): Promise<CellCounts | null> {
    this.calls++;
    if (level === 14) return this.base.get(`${tx}/${ty}`) ?? null;
    const key = `${level}/${tx}/${ty}`;
    if (this.overviews.has(key)) return this.overviews.get(key) as Uint8Array | null;
    // Max-pool: a level-L cell is 2^(14−L) base cells; this tile covers 256·2^(14−L) base cells.
    const f = 1 << (14 - level);
    const out = new Uint8Array(TILE_CELLS);
    let any = false;
    for (const [k, counts] of this.base) {
      const [btx, bty] = k.split('/').map(Number);
      // base tile origin in base cells → level cell → this tile?
      const lx = Math.floor((btx * TILE_SIZE) / f), ly = Math.floor((bty * TILE_SIZE) / f);
      if ((lx >> 8) !== tx || (ly >> 8) !== ty) continue;
      for (let i = 0; i < TILE_CELLS; i++) {
        const v = counts[i];
        if (!v) continue;
        const cx = btx * TILE_SIZE + (i & 255), cy = bty * TILE_SIZE + (i >> 8);
        const oi = ((Math.floor(cy / f)) & 255) * TILE_SIZE + ((Math.floor(cx / f)) & 255);
        if (v > out[oi]) { out[oi] = v; any = true; }
      }
    }
    const res = any ? out : null;
    this.overviews.set(key, res);
    return res;
  }
}

/** Bedford Av & N 7th St, Williamsburg — the mockup's HOME. */
export const HOME: [number, number] = [-73.9568, 40.7176];

/**
 * A Manhattan-style street grid of visited cells: streets every `blockCells` cells in both axes
 * over a square of `spanCells`, centred on `centre`, with visit counts that decay from the
 * centre (1…8) like the mockup. Returns the provider and the centre cell.
 */
export function syntheticCity(opts: { centre?: [number, number]; spanCells?: number; blockCells?: number; seed?: number } = {}): { provider: MemoryProvider; cx: number; cy: number } {
  const centre = opts.centre ?? HOME;
  const [cx, cy] = lonLatToCell(centre[0], centre[1]);
  const provider = new MemoryProvider();
  drawStreetGrid(provider, cx, cy, opts.spanCells ?? 700, opts.blockCells ?? 12, opts.seed ?? 7);
  return { provider, cx, cy };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Draw a street grid of visited cells into `provider`: streets every `block` cells over a square
 * of `span`, with the probability of a segment being walked and its visit count decaying from
 * the centre (`decay` cells), like the mockup's neighbourhood.
 */
export function drawStreetGrid(provider: MemoryProvider, cx: number, cy: number, span: number, block: number, seed: number, decay = 220, floor = 0.07): void {
  const rnd = rng(seed);
  const half = span >> 1;
  for (let a = -half; a <= half; a += block) {
    // one horizontal + one vertical street per block line, each split into block-length segments
    for (let b = -half; b < half; b += block) {
      const d = Math.hypot(a, b + block / 2);
      const p = 0.92 * Math.exp(-d / decay) + floor;
      if (rnd() < p) {
        const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 8 * Math.exp(-d / (decay * 0.9)));
        provider.line(cx + b, cy + a, cx + b + block, cy + a, count);
      }
      if (rnd() < p) {
        const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 8 * Math.exp(-d / (decay * 0.9)));
        provider.line(cx + a, cy + b, cx + a, cy + b + block, count);
      }
    }
  }
}

/**
 * A multi-scale "where I've been" dataset for overview-zoom tests (z 6–13): the home
 * neighbourhood (dense grid), a second neighbourhood ~3 km away, a town ~40 km away, and
 * single-cell tracks between them (commutes, a long drive), all around `centre`. Distances are
 * in cells (≈7.2 m each at the default NYC latitude).
 */
export function syntheticRegion(opts: { centre?: [number, number] } = {}): { provider: MemoryProvider; cx: number; cy: number } {
  const centre = opts.centre ?? HOME;
  const [cx, cy] = lonLatToCell(centre[0], centre[1]);
  const provider = new MemoryProvider();
  drawStreetGrid(provider, cx, cy, 700, 12, 7); // home: dense, 5 km
  drawStreetGrid(provider, cx + 420, cy - 300, 400, 16, 11, 150); // 3 km NE: sparser
  drawStreetGrid(provider, cx - 5200, cy + 2400, 300, 20, 23, 120, 0.03); // 40 km SW: a town
  drawStreetGrid(provider, cx + 2600, cy + 900, 160, 24, 5, 60, 0.02); // 20 km E: a few streets
  // commutes: home → NE neighbourhood (walked often), home → east (a few times)
  provider.line(cx + 100, cy - 60, cx + 420, cy - 300, 4);
  provider.line(cx + 300, cy + 200, cx + 2600, cy + 900, 2);
  // one long drive south-west to the town and a day trip north (single-cell tracks, count 1)
  provider.line(cx - 200, cy + 300, cx - 5200, cy + 2400, 1);
  provider.line(cx, cy - 350, cx + 900, cy - 9000, 1);
  return { provider, cx, cy };
}
