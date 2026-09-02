/**
 * Synthetic "visited streets" for mock mode: a Brooklyn-like street grid (two axes, rotated)
 * around a centre, with visit counts decaying with distance — the same idea as docs/mockups/mock.js
 * but without the Overpass street file. Both the mock grid (fog/heat) and the mock router use the
 * same grid lines so routes follow the same synthetic streets the fog shows.
 */
import { WORLD, cellAreaM2, cellsAlong, lonLatToCell } from '../../grid/cell';
import { LEVELS, type Level } from '../../grid/types';

export type LonLat = [number, number];

const DEG = Math.PI / 180;

export interface StreetGrid {
  center: LonLat;
  /** Rotation of the grid's u axis from east, radians. */
  theta: number;
  /** Spacing of the lines u = i·su (metres) and v = j·sv. */
  su: number;
  sv: number;
  /** Half-extent of the synthetic grid (metres). */
  radius: number;
}

export function makeGrid(center: LonLat): StreetGrid {
  // u runs along the numbered streets (WNW–ESE in Williamsburg), v along the avenues.
  // Lines of constant v (every 85 m) are the numbered streets; lines of constant u (every 200 m) the avenues.
  return { center, theta: -35 * DEG, su: 200, sv: 85, radius: 1500 };
}

export function metresPerDeg(lat: number): [kx: number, ky: number] {
  return [111_320 * Math.cos(lat * DEG), 110_574];
}

/** lon/lat → grid frame (u, v) in metres. */
export function toUV(g: StreetGrid, p: LonLat): [number, number] {
  const [kx, ky] = metresPerDeg(g.center[1]);
  const x = (p[0] - g.center[0]) * kx;
  const y = (p[1] - g.center[1]) * ky;
  const c = Math.cos(g.theta), s = Math.sin(g.theta);
  return [x * c + y * s, -x * s + y * c];
}

export function fromUV(g: StreetGrid, u: number, v: number): LonLat {
  const [kx, ky] = metresPerDeg(g.center[1]);
  const c = Math.cos(g.theta), s = Math.sin(g.theta);
  const x = u * c - v * s;
  const y = u * s + v * c;
  return [g.center[0] + x / kx, g.center[1] + y / ky];
}

export function cellKey(cx: number, cy: number): number {
  return cy * WORLD + cx;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The synthetic cell store: base-level counts in a Map, overview tiles derived lazily.
 * Mutations (markTrack / applyPayload) go through `bump` which invalidates the overview cache.
 */
export class SynthCells {
  readonly cells = new Map<number, number>();
  private overview = new Map<string, Uint8Array | null>();
  readonly grid: StreetGrid;

  constructor(center: LonLat, seed = 7) {
    this.grid = makeGrid(center);
    this.generate(seed);
  }

  private generate(seed: number): void {
    const g = this.grid;
    const rnd = rng(seed);
    const R = g.radius;
    const segments: Array<[number, number, number, number]> = []; // u0 v0 u1 v1
    const iMax = Math.floor(R / g.su), jMax = Math.floor(R / g.sv);
    for (let i = -iMax; i <= iMax; i++) {
      for (let j = -jMax; j < jMax; j++) segments.push([i * g.su, j * g.sv, i * g.su, (j + 1) * g.sv]);
    }
    for (let j = -jMax; j <= jMax; j++) {
      for (let i = -iMax; i < iMax; i++) segments.push([i * g.su, j * g.sv, (i + 1) * g.su, j * g.sv]);
    }
    for (const [u0, v0, u1, v1] of segments) {
      const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
      if (mu < -620) continue; // the East River starts ~650 m WNW of the default centre — no streets there
      const d = Math.hypot(mu * 0.8, mv);
      const p = 0.94 * Math.exp(-d / 520) + 0.07;
      if (rnd() >= p) continue;
      const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 9 * Math.exp(-d / 450));
      const a = fromUV(g, u0, v0), b = fromUV(g, u1, v1);
      for (const [cx, cy] of cellsAlong([a, b], { stepM: 3 })) {
        const k = cellKey(cx, cy);
        const c = this.cells.get(k) ?? 0;
        if (count > c) this.cells.set(k, count);
      }
    }
  }

  bump(): void {
    this.overview.clear();
  }

  count(cx: number, cy: number): number {
    return this.cells.get(cellKey(cx, cy)) ?? 0;
  }

  /** "Seen" = the cell or any 8-neighbour has a count (the novelty rule of BUILD-PLAN §2.3). */
  seenAt(p: LonLat): boolean {
    const [cx, cy] = lonLatToCell(p[0], p[1]);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.cells.has(cellKey(cx + dx, cy + dy))) return true;
    return false;
  }

  /** +1 on every distinct cell along the polyline (once per track). Returns the touched base tiles. */
  markTrack(points: ReadonlyArray<readonly [number, number]>): Set<number> {
    const touched = new Set<number>();
    const seen = new Set<number>();
    for (const [cx, cy] of cellsAlong(points)) {
      const k = cellKey(cx, cy);
      if (seen.has(k)) continue;
      seen.add(k);
      this.cells.set(k, Math.min(255, (this.cells.get(k) ?? 0) + 1));
      touched.add(((cx >> 8) << 16) | (cy >> 8));
    }
    this.bump();
    return touched;
  }

  /** Merge a base tile of counts with max(). */
  mergeTile(tx: number, ty: number, counts: Uint8Array): void {
    for (let iy = 0; iy < 256; iy++) {
      for (let ix = 0; ix < 256; ix++) {
        const v = counts[iy * 256 + ix];
        if (!v) continue;
        const k = cellKey((tx << 8) + ix, (ty << 8) + iy);
        const c = this.cells.get(k) ?? 0;
        if (v > c) this.cells.set(k, v);
      }
    }
    this.bump();
  }

  stats(): { visitedCells: number; areaM2: number; tiles: number } {
    let area = 0;
    const tiles = new Set<number>();
    for (const k of this.cells.keys()) {
      const cy = Math.floor(k / WORLD), cx = k - cy * WORLD;
      area += cellAreaM2(cy);
      tiles.add(((cx >> 8) << 16) | (cy >> 8));
    }
    return { visitedCells: this.cells.size, areaM2: area, tiles: tiles.size };
  }

  baseTiles(): Array<[number, number]> {
    const tiles = new Map<number, [number, number]>();
    for (const k of this.cells.keys()) {
      const cy = Math.floor(k / WORLD), cx = k - cy * WORLD;
      const key = ((cx >> 8) << 16) | (cy >> 8);
      if (!tiles.has(key)) tiles.set(key, [cx >> 8, cy >> 8]);
    }
    return [...tiles.values()];
  }

  /** 256×256 counts of a tile at any level (max-pooled), or null when empty. */
  tileCounts(level: Level, tx: number, ty: number): Uint8Array | null {
    const key = `${level}/${tx}/${ty}`;
    const cached = this.overview.get(key);
    if (cached !== undefined) return cached;
    const shift = 14 - level; // base cells per level cell = 2^shift
    let out: Uint8Array | null = null;
    // Base-cell range of this tile.
    const span = 256 << shift;
    const x0 = tx * span, y0 = ty * span;
    for (const [k, c] of this.cells) {
      const cy = Math.floor(k / WORLD), cx = k - cy * WORLD;
      if (cx < x0 || cx >= x0 + span || cy < y0 || cy >= y0 + span) continue;
      if (!out) out = new Uint8Array(65536);
      const ix = (cx - x0) >> shift, iy = (cy - y0) >> shift;
      const i = iy * 256 + ix;
      if (c > out[i]) out[i] = c;
    }
    this.overview.set(key, out);
    return out;
  }
}

export { LEVELS };
