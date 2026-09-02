/**
 * Per-arc novelty: the fraction of an arc's length that has never been visited. The arc
 * geometry is sampled every SAMPLE_M metres; a sample is "seen" if its cell or any of its 8
 * neighbours has a visit count > 0 (GPS wander / sidewalk offset tolerance). Scores are cached
 * in a Float32Array indexed by arc (NaN = not scored yet) and computed lazily by the search.
 */
import { WORLD, distanceM, lonLatToWorld } from '../grid/cell';
import type { CellLookup } from './cells';
import type { Graph } from './graph';

export const SAMPLE_M = 6;

export class NoveltyScorer {
  /** nov[arc] ∈ [0,1], NaN = unscored. */
  readonly nov: Float32Array;
  private scored = 0;
  private readonly pt: [number, number] = [0, 0];

  constructor(readonly graph: Graph, public lookup: CellLookup) {
    this.nov = new Float32Array(graph.arcCount).fill(NaN);
  }

  /** Number of arcs scored so far (diagnostics). */
  get scoredCount(): number {
    return this.scored;
  }

  /** Forget every score (cell store changed). */
  invalidate(lookup?: CellLookup): void {
    if (lookup) this.lookup = lookup;
    this.nov.fill(NaN);
    this.scored = 0;
  }

  /** Novelty of an arc, scoring it (and its reverse) on first use. */
  get(arc: number): number {
    const v = this.nov[arc];
    if (v === v) return v; // not NaN
    const n = this.score(arc);
    this.nov[arc] = n;
    const r = this.graph.arcReverse[arc];
    if (r >= 0) this.nov[r] = n;
    this.scored++;
    return n;
  }

  /** Never-visited metres of an arc. */
  newMetres(arc: number): number {
    return this.get(arc) * this.graph.arcLen[arc];
  }

  /** Score a set of arcs eagerly (e.g. everything inside a bbox after a cell update). */
  scoreAll(arcs: Iterable<number>): void {
    for (const a of arcs) this.get(a);
  }

  private score(arc: number): number {
    const g = this.graph, lookup = this.lookup, pt = this.pt;
    const count = g.arcPointCount(arc);
    let samples = 0, unseen = 0;
    g.arcPoint(arc, 0, pt);
    let plon = pt[0], plat = pt[1];
    let [px, py] = lonLatToWorld(plon, plat);
    // First sample at the from-node.
    samples++; if (!seen(lookup, px, py)) unseen++;
    for (let i = 1; i < count; i++) {
      g.arcPoint(arc, i, pt);
      const lon = pt[0], lat = pt[1];
      const d = distanceM(plon, plat, lon, lat);
      const [x1, y1] = lonLatToWorld(lon, lat);
      const n = Math.max(1, Math.ceil(d / SAMPLE_M));
      for (let t = 1; t <= n; t++) {
        const x = px + ((x1 - px) * t) / n, y = py + ((y1 - py) * t) / n;
        samples++; if (!seen(lookup, x, y)) unseen++;
      }
      plon = lon; plat = lat; px = x1; py = y1;
    }
    return samples ? unseen / samples : 1;
  }
}

/** Cell at fractional world coords (or any 8-neighbour) has a visit. */
function seen(lookup: CellLookup, x: number, y: number): boolean {
  const cx = Math.floor(x), cy = Math.floor(y);
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= WORLD) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= WORLD) continue;
      if (lookup.get(xx, yy) > 0) return true;
    }
  }
  return false;
}

/**
 * Convenience: score `arcs` into a Float32Array cache (NaN = unscored) and return it.
 * Equivalent to `new NoveltyScorer(graph, lookup).scoreAll(arcs)` but keeps the caller's cache.
 */
export function scoreNovelty(graph: Graph, lookup: CellLookup, arcs: Iterable<number>, cache?: Float32Array): Float32Array {
  const scorer = new NoveltyScorer(graph, lookup);
  if (cache) scorer.nov.set(cache);
  scorer.scoreAll(arcs);
  return scorer.nov;
}
