/**
 * Penalised A* over a Graph.
 *
 *   cost(arc) = len · (1 + λ · (1 − nov)) · dismount(×1.5, bike on DISMOUNT arcs) · avoid(×k)
 *
 * The heuristic is the straight-line distance to the destination snap point, admissible because
 * every multiplier is ≥ 1 so cost ≥ length. Ellipse pruning discards a node when the LENGTH of
 * the path found to it plus the straight-line remainder exceeds `ellipseFactor · budget` (length,
 * not penalised cost — pruning on cost would cut exactly the long never-visited detours a high
 * λ is meant to find). No immediate U-turns: the reverse of the arc a node was reached by is not
 * relaxed. Ties break on (f, node index) so results are deterministic.
 *
 * Origin and destination are virtual: the origin is two initial heap entries (partial forward
 * along the snapped arc, partial backward along its reverse), the destination is a virtual node
 * reached from either endpoint of its snapped arc with a partial cost. Origin and destination on
 * the same arc seed the virtual target directly.
 */
import { ArcFlag, MODE_BIT, type Mode } from './graph-format';
import type { Graph } from './graph';
import type { NoveltyScorer } from './novelty';
import { usableFlags, type Snap } from './spatial';

const DEG = Math.PI / 180;
const HEURISTIC_SAFETY = 0.99;
export const DISMOUNT_FACTOR = 1.5;

export interface SearchOptions {
  lambda: number;
  mode: Mode;
  /** Ellipse budget on path length in metres. Infinity (default) disables pruning. */
  budget?: number;
  /** Default 1.05. */
  ellipseFactor?: number;
  /** Per-arc flags: 1 = multiply the cost by avoidFactor (loop mode: own-route arcs). */
  avoid?: Uint8Array | null;
  /** Default 5. */
  avoidFactor?: number;
}

export interface PathResult {
  /** Arcs in travel order; the first and last are partial (see startFrac/endFrac). */
  arcs: Uint32Array;
  lengthM: number;
  newM: number;
  cost: number;
  /** Fraction along arcs[0]'s geometry where the path starts. */
  startFrac: number;
  /** Fraction along the last arc's geometry where the path ends. */
  endFrac: number;
  /** Nodes settled (diagnostics). */
  settled: number;
}

/** Binary min-heap on typed arrays; ordered by (key, value) for determinism. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2); nk.set(this.keys); this.keys = nk;
      const nv = new Int32Array(this.size * 2); nv.set(this.vals); this.vals = nv;
    }
    const keys = this.keys, vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = keys[p], pv = vals[p];
      if (pk < key || (pk === key && pv <= val)) break;
      keys[i] = pk; vals[i] = pv;
      i = p;
    }
    keys[i] = key; vals[i] = val;
  }

  /** Key of the minimum entry (call before pop). */
  peekKey(): number {
    return this.keys[0];
  }

  /** Remove and return the minimum entry's value. */
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let m = l;
        if (r < n && (keys[r] < keys[l] || (keys[r] === keys[l] && vals[r] < vals[l]))) m = r;
        if (keys[m] > key || (keys[m] === key && vals[m] >= val)) break;
        keys[i] = keys[m]; vals[i] = vals[m];
        i = m;
      }
      keys[i] = key; vals[i] = val;
    }
    return top;
  }
}

export class Searcher {
  private readonly g: Float64Array;
  private readonly glen: Float64Array;
  private readonly prevArc: Int32Array;
  private readonly prevNode: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap = new MinHeap(4096);
  private readonly target: number;

  constructor(readonly graph: Graph, readonly scorer: NoveltyScorer) {
    const n = graph.nodeCount + 1; // + virtual target
    this.target = graph.nodeCount;
    this.g = new Float64Array(n);
    this.glen = new Float64Array(n);
    this.prevArc = new Int32Array(n);
    this.prevNode = new Int32Array(n);
    this.closed = new Uint8Array(n);
  }

  /** Penalised cost of a full arc under the options. */
  arcCost(arc: number, lambda: number, mode: Mode, avoid: Uint8Array | null, avoidFactor: number): number {
    const graph = this.graph;
    const flags = graph.arcFlags[arc];
    let c = graph.arcLen[arc] * (1 + lambda * (1 - this.scorer.get(arc)));
    if (mode === 'bike' && (flags & ArcFlag.DISMOUNT)) c *= DISMOUNT_FACTOR;
    if (avoid && avoid[arc]) c *= avoidFactor;
    return c;
  }

  run(origin: Snap, dest: Snap, opts: SearchOptions): PathResult | null {
    const graph = this.graph;
    const { lambda, mode } = opts;
    const modeMask = MODE_BIT[mode];
    const avoid = opts.avoid ?? null;
    const avoidFactor = opts.avoidFactor ?? 5;
    const ellipse = (opts.budget ?? Infinity) * (opts.ellipseFactor ?? 1.05);
    const g = this.g, glen = this.glen, prevArc = this.prevArc, prevNode = this.prevNode, closed = this.closed, heap = this.heap;
    const T = this.target;
    g.fill(Infinity); glen.fill(0); prevArc.fill(-1); prevNode.fill(-1); closed.fill(0); heap.clear();

    const [dlon, dlat] = dest.point;
    const kx = 111_320 * Math.cos(dlat * DEG) * HEURISTIC_SAFETY, ky = 110_574 * HEURISTIC_SAFETY;
    const nodeLon = graph.nodeLon, nodeLat = graph.nodeLat;
    const heur = (v: number): number => {
      const dx = (nodeLon[v] - dlon) * kx, dy = (nodeLat[v] - dlat) * ky;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const usable = (arc: number): boolean => usableFlags(graph.arcFlags[arc], modeMask);
    const cost = (arc: number): number => this.arcCost(arc, lambda, mode, avoid, avoidFactor);

    // --- origin: partial arcs in both directions ---
    const oa = origin.arc, ora = graph.arcReverse[oa], ot = origin.t;
    const relaxStart = (arc: number, frac: number, node: number) => {
      const c = cost(arc) * frac, l = graph.arcLen[arc] * frac;
      if (c < g[node]) {
        g[node] = c; glen[node] = l; prevArc[node] = arc; prevNode[node] = -1;
        heap.push(c + heur(node), node);
      }
    };
    if (usable(oa)) relaxStart(oa, 1 - ot, graph.arcTo[oa]);
    if (ora >= 0 && usable(ora)) relaxStart(ora, ot, graph.arcTo[ora]);

    // --- destination: virtual target reached from either endpoint of its arc ---
    let da = dest.arc, ds = dest.t;
    if (da === ora) { da = oa; ds = 1 - ds; } // normalise onto the same direction as the origin arc
    const dra = graph.arcReverse[da];
    const dP = graph.arcFrom[da], dQ = graph.arcTo[da];
    const dUsable = usable(da), drUsable = dra >= 0 && usable(dra);
    if (da === oa) {
      // Same arc: direct partial traversal (forward if ds ≥ ot, backward via the reverse arc).
      if (dUsable && ds >= ot) {
        const f = ds - ot;
        g[T] = cost(oa) * f; glen[T] = graph.arcLen[oa] * f; prevArc[T] = oa; prevNode[T] = -2;
        heap.push(g[T], T);
      }
      if (ora >= 0 && usable(ora) && ot >= ds) {
        const f = ot - ds, c = cost(ora) * f;
        if (c < g[T]) { g[T] = c; glen[T] = graph.arcLen[ora] * f; prevArc[T] = ora; prevNode[T] = -2; heap.push(c, T); }
      }
    }

    let settled = 0;
    while (heap.size > 0) {
      const n = heap.pop();
      if (closed[n]) continue;
      closed[n] = 1;
      settled++;
      if (n === T) break;
      const gn = g[n], ln = glen[n];
      const arrival = prevArc[n];
      const forbid = arrival >= 0 ? graph.arcReverse[arrival] : -1;
      const end = graph.arcStart[n + 1];
      for (let a = graph.arcStart[n]; a < end; a++) {
        if (a === forbid || !usable(a)) continue;
        const v = graph.arcTo[a];
        if (closed[v]) continue;
        const ng = gn + cost(a);
        if (ng >= g[v]) continue;
        const nl = ln + graph.arcLen[a];
        const h = heur(v);
        if (nl + h > ellipse) continue;
        g[v] = ng; glen[v] = nl; prevArc[v] = a; prevNode[v] = n;
        heap.push(ng + h, v);
      }
      // Relax the virtual target from the destination arc's endpoints (no U-turn onto it).
      if (n === dP && dUsable && arrival !== dra) {
        const ng = gn + cost(da) * ds;
        if (ng < g[T]) { g[T] = ng; glen[T] = ln + graph.arcLen[da] * ds; prevArc[T] = da; prevNode[T] = n; heap.push(ng, T); }
      }
      if (n === dQ && drUsable && arrival !== da) {
        const ng = gn + cost(dra) * (1 - ds);
        if (ng < g[T]) { g[T] = ng; glen[T] = ln + graph.arcLen[dra] * (1 - ds); prevArc[T] = dra; prevNode[T] = n; heap.push(ng, T); }
      }
    }
    if (!closed[T]) return null;

    // --- reconstruct ---
    const list: number[] = [];
    let node = T;
    let direct = false;
    for (;;) {
      list.push(prevArc[node]);
      const p = prevNode[node];
      if (p === -2) { direct = true; break; }
      if (p < 0) break;
      node = p;
    }
    list.reverse();
    const arcs = Uint32Array.from(list);
    const first = arcs[0], last = arcs[arcs.length - 1];
    let startFrac: number, endFrac: number;
    if (direct) {
      startFrac = first === oa ? ot : 1 - ot;
      endFrac = first === oa ? ds : 1 - ds;
    } else {
      startFrac = first === oa ? ot : 1 - ot;
      endFrac = last === da ? ds : 1 - ds;
    }
    // Length and new metres with the partial ends.
    let lengthM = 0, newM = 0;
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      let frac = 1;
      if (arcs.length === 1) frac = endFrac - startFrac;
      else if (i === 0) frac = 1 - startFrac;
      else if (i === arcs.length - 1) frac = endFrac;
      const l = graph.arcLen[a] * frac;
      lengthM += l;
      newM += l * this.scorer.get(a);
    }
    return { arcs, lengthM, newM, cost: g[T], startFrac, endFrac, settled };
  }
}

/** True if the path contains an arc immediately followed by its reverse (test helper). */
export function hasImmediateUTurn(graph: Graph, arcs: ArrayLike<number>): boolean {
  for (let i = 1; i < arcs.length; i++) if (graph.arcReverse[arcs[i - 1]] === arcs[i]) return true;
  return false;
}
