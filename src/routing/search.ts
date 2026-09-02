/**
 * Penalised A* over a Graph.
 *
 *   cost(arc) = len · (1 + λ · (1 − nov)) · dismount(×3, bike on DISMOUNT arcs) · avoid(×k)
 *             + turn(arrival arc → arc)            (only with turnPenaltyM > 0)
 *
 * The heuristic is the straight-line distance to the destination snap point, admissible because
 * every multiplier is ≥ 1 and the turn term is ≥ 0, so cost ≥ length. Ellipse pruning discards a
 * node when the LENGTH of the path found to it plus the straight-line remainder exceeds
 * `ellipseFactor · budget` (length, not penalised cost — pruning on cost would cut exactly the
 * long never-visited detours a high λ is meant to find). No immediate U-turns: the reverse of the
 * arc a node was reached by is not relaxed. Ties break on (f, label index) so results are
 * deterministic.
 *
 * Labels: nodes by default. With a turn penalty the search labels ARCS (state = the arc arrived
 * by) — a node label cannot price the turn onto the next arc without losing optimality, because
 * the best way into a node depends on where the path goes next. ~2.5 states per node in a street
 * graph; the arrays are allocated on first use so an unpenalised search never pays for them.
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
/**
 * Bike on a DISMOUNT arc (footway, steps): ×3 ≈ walking speed vs riding speed (4.8 vs 15 km/h),
 * so a pushed metre costs what it takes in time. Was ×1.5 — the NYC sweep then sent "Most new"
 * rides across Prospect Park on footpaths for a kilometre (p90 647 m, max 1,102 m pushed); ×3
 * gives p90 116 m at the same budget and the same novelty gain.
 */
export const DISMOUNT_FACTOR = 3;
/** Heading change below this is straight-through: no turn cost (a bend in the road, a kink at a junction). */
export const TURN_MIN_DEG = 40;
/** Heading change at or above this counts as a full 1.5 turns (a hairpin is not worse than that). */
export const TURN_MAX_DEG = 135;

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
  /**
   * Arc (in travel direction) the search may NOT leave the origin along — the reverse of the arc
   * a loop's previous leg arrived by, so the next leg does not double back on the same street.
   * The other direction of the origin arc stays available; the caller retries without it when
   * the origin is a dead end.
   */
  forbidStartArc?: number;
  /**
   * Metres-equivalent added to the cost per 90° heading change at a node: linear in the angle,
   * free below TURN_MIN_DEG, capped at TURN_MAX_DEG, never on a GLUE connector (its geometry is
   * artificial). Only the cost is penalised — the length the budget and the heuristic bound is
   * untouched. > 0 switches the search to arc labels. Default 0 (off).
   */
  turnPenaltyM?: number;
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
  /** Labels settled (diagnostics; arc labels with a turn penalty, nodes otherwise). */
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

/** What a search core hands back: the arc list in travel order and how the target was reached. */
interface Found {
  arcs: number[];
  /** Origin and destination on the same arc, traversed directly. */
  direct: boolean;
  cost: number;
  settled: number;
}

/** Everything both cores need, computed once per run. */
interface RunSetup {
  modeMask: number;
  ellipse: number;
  forbidStart: number;
  turnK: number;
  heur: (node: number) => number;
  usable: (arc: number) => boolean;
  cost: (arc: number) => number;
  oa: number; ora: number; ot: number;
  da: number; dra: number; ds: number; dP: number; dQ: number;
  dUsable: boolean; drUsable: boolean;
}

export class Searcher {
  private readonly g: Float64Array;
  private readonly glen: Float64Array;
  private readonly prevArc: Int32Array;
  private readonly prevNode: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap = new MinHeap(4096);
  private readonly target: number;
  /**
   * Nodes settled by the last run, in order (diagnostics; loop mode reads a failed leg's pocket).
   * Sized for nodes; grown to arcCount + 1 on the first arc-labelled run (one entry per state).
   */
  private settledList: Int32Array;
  private settledN = 0;
  /** Arc-labelled workspace (turn penalty), allocated on first use. Index arcCount = the target. */
  private gA: Float64Array | null = null;
  private glenA: Float64Array | null = null;
  private prevA: Int32Array | null = null;
  private closedA: Uint8Array | null = null;
  /** Heading (radians, 0 = north, clockwise) of an arc's first / last segment; NaN = not computed. */
  private headOut: Float32Array | null = null;
  private headIn: Float32Array | null = null;
  private readonly pt: [number, number] = [0, 0];

  constructor(readonly graph: Graph, readonly scorer: NoveltyScorer) {
    const n = graph.nodeCount + 1; // + virtual target
    this.target = graph.nodeCount;
    this.g = new Float64Array(n);
    this.glen = new Float64Array(n);
    this.prevArc = new Int32Array(n);
    this.prevNode = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.settledList = new Int32Array(n);
  }

  /** Graph nodes the last run settled (excluding the virtual target). Valid until the next run. */
  lastSettled(): Int32Array {
    return this.settledList.subarray(0, this.settledN);
  }

  /**
   * Penalised cost of a full arc under the options. λ = 0 never touches the novelty scorer (the
   * shortest-path search must not cache scores for arcs it merely brushes past); GLUE connectors
   * are neutral — plain length, neither rewarded nor penalised.
   */
  arcCost(arc: number, lambda: number, mode: Mode, avoid: Uint8Array | null, avoidFactor: number): number {
    const graph = this.graph;
    const flags = graph.arcFlags[arc];
    let c = graph.arcLen[arc];
    if (lambda > 0 && !(flags & ArcFlag.GLUE)) c *= 1 + lambda * (1 - this.scorer.get(arc));
    if (mode === 'bike' && (flags & ArcFlag.DISMOUNT)) c *= DISMOUNT_FACTOR;
    if (avoid && avoid[arc]) c *= avoidFactor;
    return c;
  }

  /**
   * Heading of an arc's first (`out`) or last segment in travel direction, skipping zero-length
   * steps in the geometry. Cached per arc.
   */
  private heading(arc: number, out: boolean): number {
    const cache = out
      ? (this.headOut ??= new Float32Array(this.graph.arcCount).fill(NaN))
      : (this.headIn ??= new Float32Array(this.graph.arcCount).fill(NaN));
    const cached = cache[arc];
    if (cached === cached) return cached;
    const g = this.graph, pt = this.pt, n = g.arcPointCount(arc);
    let lon0: number, lat0: number, lon1: number, lat1: number;
    if (out) {
      g.arcPoint(arc, 0, pt); lon0 = pt[0]; lat0 = pt[1];
      let i = 1;
      do { g.arcPoint(arc, i, pt); i++; } while (i < n && pt[0] === lon0 && pt[1] === lat0);
      lon1 = pt[0]; lat1 = pt[1];
    } else {
      g.arcPoint(arc, n - 1, pt); lon1 = pt[0]; lat1 = pt[1];
      let i = n - 2;
      do { g.arcPoint(arc, i, pt); i--; } while (i >= 0 && pt[0] === lon1 && pt[1] === lat1);
      lon0 = pt[0]; lat0 = pt[1];
    }
    const h = Math.atan2((lon1 - lon0) * Math.cos(lat0 * DEG), lat1 - lat0);
    cache[arc] = h;
    return h;
  }

  /** Turn cost (metres-equivalent) for continuing from arc `a` onto arc `b` at their shared node. */
  turnCost(a: number, b: number, penaltyM: number): number {
    const flags = this.graph.arcFlags;
    if ((flags[a] | flags[b]) & ArcFlag.GLUE) return 0;
    let d = Math.abs(this.heading(b, true) - this.heading(a, false));
    if (d > Math.PI) d = 2 * Math.PI - d;
    const deg = d / DEG;
    if (deg < TURN_MIN_DEG) return 0;
    return (penaltyM * Math.min(deg, TURN_MAX_DEG)) / 90;
  }

  run(origin: Snap, dest: Snap, opts: SearchOptions): PathResult | null {
    const graph = this.graph;
    const { lambda, mode } = opts;
    const modeMask = MODE_BIT[mode];
    const avoid = opts.avoid ?? null;
    const avoidFactor = opts.avoidFactor ?? 5;
    const forbidStart = opts.forbidStartArc ?? -1;
    const turnK = opts.turnPenaltyM ?? 0;
    const ellipse = (opts.budget ?? Infinity) * (opts.ellipseFactor ?? 1.05);
    this.settledN = 0;

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
    // --- destination: virtual target reached from either endpoint of its arc ---
    let da = dest.arc, ds = dest.t;
    if (da === ora) { da = oa; ds = 1 - ds; } // normalise onto the same direction as the origin arc
    const dra = graph.arcReverse[da];
    const dP = graph.arcFrom[da], dQ = graph.arcTo[da];
    const dUsable = usable(da), drUsable = dra >= 0 && usable(dra);
    const setup: RunSetup = { modeMask, ellipse, forbidStart, turnK, heur, usable, cost, oa, ora, ot, da, dra, ds, dP, dQ, dUsable, drUsable };

    const found = turnK > 0 ? this.searchArcs(setup) : this.searchNodes(setup);
    if (!found) return null;

    const arcs = Uint32Array.from(found.arcs);
    const first = arcs[0], last = arcs[arcs.length - 1];
    const startFrac = first === oa ? ot : 1 - ot;
    const endFrac = found.direct ? (first === oa ? ds : 1 - ds) : (last === da ? ds : 1 - ds);
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
    return { arcs, lengthM, newM, cost: found.cost, startFrac, endFrac, settled: found.settled };
  }

  /** Node-labelled core (no turn penalty). */
  private searchNodes(s: RunSetup): Found | null {
    const graph = this.graph;
    const { ellipse, forbidStart, heur, usable, cost, oa, ora, ot, da, dra, ds, dP, dQ, dUsable, drUsable } = s;
    const g = this.g, glen = this.glen, prevArc = this.prevArc, prevNode = this.prevNode, closed = this.closed, heap = this.heap;
    const T = this.target;
    g.fill(Infinity); glen.fill(0); prevArc.fill(-1); prevNode.fill(-1); closed.fill(0); heap.clear();

    const relaxStart = (arc: number, frac: number, node: number) => {
      const c = cost(arc) * frac, l = graph.arcLen[arc] * frac;
      if (c < g[node]) {
        g[node] = c; glen[node] = l; prevArc[node] = arc; prevNode[node] = -1;
        heap.push(c + heur(node), node);
      }
    };
    if (usable(oa) && oa !== forbidStart) relaxStart(oa, 1 - ot, graph.arcTo[oa]);
    if (ora >= 0 && usable(ora) && ora !== forbidStart) relaxStart(ora, ot, graph.arcTo[ora]);

    if (da === oa) {
      // Same arc: direct partial traversal (forward if ds ≥ ot, backward via the reverse arc).
      if (dUsable && ds >= ot && oa !== forbidStart) {
        const f = ds - ot;
        g[T] = cost(oa) * f; glen[T] = graph.arcLen[oa] * f; prevArc[T] = oa; prevNode[T] = -2;
        heap.push(g[T], T);
      }
      if (ora >= 0 && usable(ora) && ot >= ds && ora !== forbidStart) {
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
      this.settledList[this.settledN++] = n;
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
    return { arcs: list, direct, cost: g[T], settled };
  }

  /**
   * Arc-labelled core (turn penalty): state = the arc just traversed, so the turn onto the next
   * arc is priced exactly. State arcCount is the virtual target; `prevA[T]` = the arc the target
   * was reached from (−2 = direct traversal of the shared origin/destination arc) and `tArc` the
   * (partial) destination arc taken.
   */
  private searchArcs(s: RunSetup): Found | null {
    const graph = this.graph;
    const { ellipse, forbidStart, turnK, heur, usable, cost, oa, ora, ot, da, dra, ds, dP, dQ, dUsable, drUsable } = s;
    const nA = graph.arcCount + 1, T = graph.arcCount;
    const g = (this.gA ??= new Float64Array(nA)), glen = (this.glenA ??= new Float64Array(nA));
    const prev = (this.prevA ??= new Int32Array(nA)), closed = (this.closedA ??= new Uint8Array(nA));
    if (this.settledList.length < nA) this.settledList = new Int32Array(nA);
    const heap = this.heap;
    g.fill(Infinity); glen.fill(0); prev.fill(-1); closed.fill(0); heap.clear();
    const arcTo = graph.arcTo, arcLen = graph.arcLen, arcStart = graph.arcStart, arcReverse = graph.arcReverse;
    let tArc = -1;

    const relaxStart = (arc: number, frac: number) => {
      const c = cost(arc) * frac, l = arcLen[arc] * frac;
      if (c < g[arc]) { g[arc] = c; glen[arc] = l; prev[arc] = -1; heap.push(c + heur(arcTo[arc]), arc); }
    };
    if (usable(oa) && oa !== forbidStart) relaxStart(oa, 1 - ot);
    if (ora >= 0 && usable(ora) && ora !== forbidStart) relaxStart(ora, ot);

    if (da === oa) {
      if (dUsable && ds >= ot && oa !== forbidStart) {
        const f = ds - ot;
        g[T] = cost(oa) * f; glen[T] = arcLen[oa] * f; prev[T] = -2; tArc = oa;
        heap.push(g[T], T);
      }
      if (ora >= 0 && usable(ora) && ot >= ds && ora !== forbidStart) {
        const f = ot - ds, c = cost(ora) * f;
        if (c < g[T]) { g[T] = c; glen[T] = arcLen[ora] * f; prev[T] = -2; tArc = ora; heap.push(c, T); }
      }
    }

    let settled = 0;
    while (heap.size > 0) {
      const a = heap.pop();
      if (closed[a]) continue;
      closed[a] = 1;
      settled++;
      if (a === T) break;
      const n = arcTo[a];
      this.settledList[this.settledN++] = n;
      const ga = g[a], la = glen[a];
      const forbid = arcReverse[a];
      const end = arcStart[n + 1];
      for (let b = arcStart[n]; b < end; b++) {
        if (b === forbid || closed[b] || !usable(b)) continue;
        const ng = ga + cost(b) + this.turnCost(a, b, turnK);
        if (ng >= g[b]) continue;
        const v = arcTo[b];
        const nl = la + arcLen[b];
        const h = heur(v);
        if (nl + h > ellipse) continue;
        g[b] = ng; glen[b] = nl; prev[b] = a;
        heap.push(ng + h, b);
      }
      if (n === dP && dUsable && a !== dra) {
        const ng = ga + cost(da) * ds + this.turnCost(a, da, turnK);
        if (ng < g[T]) { g[T] = ng; glen[T] = la + arcLen[da] * ds; prev[T] = a; tArc = da; heap.push(ng, T); }
      }
      if (n === dQ && drUsable && a !== da) {
        const ng = ga + cost(dra) * (1 - ds) + this.turnCost(a, dra, turnK);
        if (ng < g[T]) { g[T] = ng; glen[T] = la + arcLen[dra] * (1 - ds); prev[T] = a; tArc = dra; heap.push(ng, T); }
      }
    }
    if (!closed[T]) return null;

    const list: number[] = [tArc];
    const direct = prev[T] === -2;
    for (let a = prev[T]; a >= 0; a = prev[a]) list.push(a);
    list.reverse();
    return { arcs: list, direct, cost: g[T], settled };
  }
}

/** True if the path contains an arc immediately followed by its reverse (test helper). */
export function hasImmediateUTurn(graph: Graph, arcs: ArrayLike<number>): boolean {
  for (let i = 1; i < arcs.length; i++) if (graph.arcReverse[arcs[i - 1]] === arcs[i]) return true;
  return false;
}
