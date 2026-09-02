/**
 * Candidate generation: shortest path (λ=0) fixes the budget B = (1 + detour) · L0; a λ sweep
 * produces penalised paths; those within budget are deduplicated (shared-segment fraction relative
 * to the smaller set > 0.6 = duplicate) and ranked by never-visited metres. Output ≤ maxCandidates
 * with "Direct" (the shortest) always last.
 */
import type { LonLat, RouteCandidate, RouteRequest, RouteResult } from './api';
import { ArcFlag, MODE_BIT, type Mode } from './graph-format';
import type { Graph } from './graph';
import { NoveltyScorer } from './novelty';
import type { CellLookup } from './cells';
import { Searcher, type PathResult, type SearchOptions } from './search';
import { SpatialIndex, canEnterArc, canLeaveArc, type Snap } from './spatial';

export const LAMBDA_SWEEP = [0.35, 0.7, 1, 1.5, 2, 3, 4, 6, 9] as const;
export const DEDUPE_SHARED = 0.6;
export const SPEED_KMH: Record<Mode, number> = { walk: 4.8, bike: 15, drive: 30 };
export const SNAP_MAX_M = 300;
/**
 * Default turn penalty per mode (metres-equivalent per 90° turn, see SearchOptions.turnPenaltyM)
 * for the λ > 0 searches — Direct (λ = 0) is never penalised, it stays the distance-shortest
 * path. NYC sweep (route-quality-2): 12 takes walk "Most new" from 2.3 → 1.2 turns/km (p50) and
 * 4.5 → 3.0 (p90), the worst comb from 6.4 → 1.4, for ≤ 3 pct points of novelty on 3 of 19 pairs;
 * 20 and 30 straighten nothing further at p50, cost novelty on one pair (30) and thin loops.
 * Drive: 0 — drivers turn; the sweep showed no drive combs.
 */
export const TURN_PENALTY_M: Record<Mode, number> = { walk: 12, bike: 12, drive: 0 };
/**
 * An alternative must add at least max(MIN_GAIN_M, MIN_GAIN_FRAC · Direct's length) of new road
 * over Direct. Without it a turn-penalised λ search in a never-visited area returns a straighter
 * route that is "newer" only by being a few metres longer (NYC sweep: 6 of 40 walk calls got a
 * "Most new" at 99–100 % vs Direct's 99–100 %); the unpenalised sweep never produced one.
 */
export const MIN_GAIN_M = 50;
export const MIN_GAIN_FRAC = 0.01;

/**
 * Search options for one λ of the sweep: the turn penalty applies to the penalised searches only,
 * so the λ = 0 baseline is the true shortest path. Shared with the loop legs and the sweep tool
 * (which reproduces a candidate's arcs by re-running its search).
 */
export function searchOptions(mode: Mode, lambda: number, budgetM?: number, turnPenaltyM = 0): SearchOptions {
  const opts: SearchOptions = { lambda, mode };
  if (budgetM !== undefined) opts.budget = budgetM;
  if (lambda > 0 && turnPenaltyM > 0) opts.turnPenaltyM = turnPenaltyM;
  return opts;
}
/** How each mode reads in a user-facing message, and the two modes to suggest instead. */
const MODE_WORD: Record<Mode, string> = { walk: 'walking', bike: 'cycling', drive: 'driving' };
const OTHER_MODES: Record<Mode, string> = { walk: 'bike or drive', bike: 'walk or drive', drive: 'walk or bike' };

export interface CandidateContext {
  spatial?: SpatialIndex;
  scorer?: NoveltyScorer;
  searcher?: Searcher;
  /** Diagnostics reported in RouteResult. */
  graphTiles?: number;
}

export class SnapError extends Error {
  constructor(public which: 'origin' | 'destination', public point: LonLat) {
    super(`No road for this mode within ${SNAP_MAX_M} m of the ${which} (${point[0].toFixed(5)}, ${point[1].toFixed(5)})`);
    this.name = 'SnapError';
  }
}

/**
 * Both ends snapped, but the network has no path between them for the mode. Crosses Comlink with
 * name + message intact (the UI shows the message as is).
 */
export class NoRouteError extends Error {
  constructor(public mode: Mode) {
    super(`No ${MODE_WORD[mode]} route found between these points. Try ${OTHER_MODES[mode]}, or move the pin.`);
    this.name = 'NoRouteError';
  }
}

export interface ScoredPath extends PathResult {
  lambda: number;
  segments: Set<number>;
}

/**
 * Nearest arc for the mode that the search can actually leave (origin) or arrive on (destination);
 * the nearest usable arc may be an island (an unconnected staircase) that strands the search. When
 * no connected arc lies within SNAP_MAX_M the plain nearest usable arc is taken — a trip along that
 * one arc still routes, anything else ends in NoRouteError. With `component` (a label from
 * `Graph.components`) only arcs of that component qualify, and nothing else is tried.
 */
export function snapPoint(spatial: SpatialIndex, p: LonLat, mode: Mode, which: 'origin' | 'destination', component?: number): Snap {
  const mask = MODE_BIT[mode], graph = spatial.graph;
  const connected = which === 'origin' ? (a: number) => canLeaveArc(graph, a, mask) : (a: number) => canEnterArc(graph, a, mask);
  if (component !== undefined) {
    const comp = graph.components(mask);
    const s = spatial.nearestArc(p[0], p[1], mask, SNAP_MAX_M, (a) => comp[graph.arcFrom[a]] === component && connected(a));
    if (!s) throw new SnapError(which, p);
    return s;
  }
  const s = spatial.nearestArc(p[0], p[1], mask, SNAP_MAX_M, connected) ?? spatial.nearestArc(p[0], p[1], mask, SNAP_MAX_M);
  if (!s) throw new SnapError(which, p);
  return s;
}

/**
 * Snap both ends of a trip. When they land in different components of the mode's network — one
 * pin inside a cemetery, a park or on a pier whose roads do not join the street grid — the end
 * whose re-snap into the other's component moves it the least is moved (within SNAP_MAX_M). If
 * neither can move the snaps stand and the search reports NoRouteError.
 */
export function snapPair(spatial: SpatialIndex, from: LonLat, to: LonLat, mode: Mode): [origin: Snap, dest: Snap] {
  let origin = snapPoint(spatial, from, mode, 'origin');
  let dest = snapPoint(spatial, to, mode, 'destination');
  const graph = spatial.graph, comp = graph.components(MODE_BIT[mode]);
  const co = comp[graph.arcFrom[origin.arc]], cd = comp[graph.arcFrom[dest.arc]];
  if (co === cd) return [origin, dest];
  const tryIn = (p: LonLat, which: 'origin' | 'destination', c: number): Snap | null => {
    try { return snapPoint(spatial, p, mode, which, c); } catch { return null; }
  };
  const dest2 = tryIn(to, 'destination', co), origin2 = tryIn(from, 'origin', cd);
  if (dest2 && (!origin2 || dest2.distM <= origin2.distM)) dest = dest2;
  else if (origin2) origin = origin2;
  return [origin, dest];
}

/** Set of undirected segment ids along a path. */
export function pathSegments(graph: Graph, arcs: ArrayLike<number>): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < arcs.length; i++) out.add(graph.segmentId(arcs[i]));
  return out;
}

/** Shared fraction relative to the smaller set. */
export function sharedFraction(a: Set<number>, b: Set<number>): number {
  const small = a.size <= b.size ? a : b, large = small === a ? b : a;
  if (small.size === 0) return 1;
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / small.size;
}

/** Coordinates of a path, with the partial first/last arcs trimmed to the snap points. */
export function pathCoords(graph: Graph, path: PathResult): LonLat[] {
  const out: LonLat[] = [];
  const push = (p: LonLat) => {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return;
    out.push(p);
  };
  const n = path.arcs.length;
  for (let i = 0; i < n; i++) {
    const geom = graph.arcGeometry(path.arcs[i]);
    const from = i === 0 ? path.startFrac : 0;
    const to = i === n - 1 ? path.endFrac : 1;
    for (const p of trimGeometry(geom, from, to)) push(p);
  }
  return out;
}

/** Part of a polyline between two length fractions (0..1), interpolating the cut points. */
export function trimGeometry(geom: LonLat[], from: number, to: number): LonLat[] {
  if (from <= 0 && to >= 1) return geom;
  if (geom.length < 2) return geom;
  const lat0 = geom[0][1];
  const kx = 111_320 * Math.cos(lat0 * (Math.PI / 180)), ky = 110_574;
  const cum: number[] = [0];
  for (let i = 1; i < geom.length; i++) {
    const dx = (geom[i][0] - geom[i - 1][0]) * kx, dy = (geom[i][1] - geom[i - 1][1]) * ky;
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return [geom[0]];
  const lo = Math.max(0, Math.min(from, to)) * total, hi = Math.min(1, Math.max(from, to)) * total;
  const at = (d: number): LonLat => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    const u = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0;
    return [geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * u, geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * u];
  };
  const out: LonLat[] = [at(lo)];
  for (let i = 0; i < geom.length; i++) if (cum[i] > lo && cum[i] < hi) out.push(geom[i]);
  out.push(at(hi));
  return from <= to ? out : out.reverse();
}

/** Minutes at the mode's speed; `dismountM` (bike on DISMOUNT arcs) is walked at walking speed. */
export function etaMinutes(lengthM: number, mode: Mode, dismountM = 0): number {
  const walked = mode === 'bike' ? Math.min(dismountM, lengthM) : 0;
  return Math.round(((lengthM - walked) / 1000 / SPEED_KMH[mode] + walked / 1000 / SPEED_KMH.walk) * 60);
}

/** Metres of DISMOUNT arcs along a path, honouring the partial first/last arcs. */
export function dismountMetres(graph: Graph, path: PathResult): number {
  const n = path.arcs.length;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = path.arcs[i];
    if (!(graph.arcFlags[a] & ArcFlag.DISMOUNT)) continue;
    const frac = n === 1 ? path.endFrac - path.startFrac : i === 0 ? 1 - path.startFrac : i === n - 1 ? path.endFrac : 1;
    m += graph.arcLen[a] * frac;
  }
  return m;
}

export function toCandidate(graph: Graph, path: ScoredPath, name: RouteCandidate['name'], mode: Mode): RouteCandidate {
  return {
    name,
    coords: pathCoords(graph, path),
    lengthM: Math.round(path.lengthM),
    newM: Math.round(path.newM),
    pctNew: path.lengthM > 0 ? Math.round((100 * path.newM) / path.lengthM) : 0,
    lambda: path.lambda,
    etaMin: etaMinutes(path.lengthM, mode, mode === 'bike' ? dismountMetres(graph, path) : 0),
  };
}

/**
 * Shortest path + λ sweep between two snaps. Returns the shortest path, the budget and the
 * feasible, deduplicated sweep results (best first). Shared by A→B routing and the loop legs.
 */
export function sweep(
  searcher: Searcher,
  origin: Snap,
  dest: Snap,
  mode: Mode,
  detour: number,
  lambdas: readonly number[] = LAMBDA_SWEEP,
  turnPenaltyM = TURN_PENALTY_M[mode],
): { shortest: ScoredPath; budgetM: number; feasible: ScoredPath[]; searches: number } | null {
  const graph = searcher.graph;
  const s0 = searcher.run(origin, dest, searchOptions(mode, 0));
  if (!s0) return null;
  const shortest: ScoredPath = { ...s0, lambda: 0, segments: pathSegments(graph, s0.arcs) };
  const budgetM = (1 + detour) * shortest.lengthM;
  const feasible: ScoredPath[] = [];
  let over = 0, searches = 1;
  for (const lambda of lambdas) {
    const r = searcher.run(origin, dest, searchOptions(mode, lambda, budgetM, turnPenaltyM));
    searches++;
    if (!r) break;
    if (r.lengthM > budgetM + 0.5) {
      if (++over >= 2) break;
      continue;
    }
    over = 0;
    feasible.push({ ...r, lambda, segments: pathSegments(graph, r.arcs) });
  }
  feasible.sort((a, b) => b.newM - a.newM || a.lengthM - b.lengthM || a.lambda - b.lambda);
  return { shortest, budgetM, feasible, searches };
}

/** Pick up to `slots` mutually distinct paths (distinct from `against` too) from a ranked list, each with ≥ `minNewM` new metres. */
export function pickDistinct(ranked: ScoredPath[], against: ScoredPath[], slots: number, minNewM = -Infinity): ScoredPath[] {
  const picked: ScoredPath[] = [];
  for (const r of ranked) {
    if (picked.length >= slots) break;
    if (r.newM < minNewM) continue;
    let dup = false;
    for (const c of against) if (sharedFraction(r.segments, c.segments) > DEDUPE_SHARED) { dup = true; break; }
    if (!dup) for (const c of picked) if (sharedFraction(r.segments, c.segments) > DEDUPE_SHARED) { dup = true; break; }
    if (!dup) picked.push(r);
  }
  return picked;
}

/**
 * Alternatives to Direct, best first: "Most new" = the newest distinct feasible path; "Balanced" =
 * the distinct path with the best gain in new metres per extra metre over Direct (the runner-up by
 * new metres is usually a near-clone of Most new); further slots by new metres. Every pick beats
 * Direct on new metres by at least the MIN_GAIN margin and shares ≤ DEDUPE_SHARED of its
 * segments with every other pick.
 */
export function selectAlternatives(shortest: ScoredPath, feasible: ScoredPath[], slots: number): ScoredPath[] {
  if (slots <= 0) return [];
  const minNew = shortest.newM + Math.max(MIN_GAIN_M, MIN_GAIN_FRAC * shortest.lengthM);
  const most = pickDistinct(feasible, [shortest], 1, minNew);
  if (slots === 1 || most.length === 0) return most;
  const efficiency = (p: ScoredPath) => (p.newM - shortest.newM) / Math.max(1, p.lengthM - shortest.lengthM);
  const byEfficiency = feasible.filter((p) => p !== most[0]).sort((a, b) => efficiency(b) - efficiency(a) || b.newM - a.newM || a.lambda - b.lambda);
  const balanced = pickDistinct(byEfficiency, [shortest, ...most], 1, minNew);
  const rest = pickDistinct(feasible, [shortest, ...most, ...balanced], slots - 1 - balanced.length, minNew);
  return [...most, ...balanced, ...rest];
}

export function findCandidates(graph: Graph, lookup: CellLookup, req: RouteRequest, ctx: CandidateContext = {}): RouteResult {
  const t0 = now();
  const spatial = ctx.spatial ?? new SpatialIndex(graph);
  const scorer = ctx.scorer ?? new NoveltyScorer(graph, lookup);
  const searcher = ctx.searcher ?? new Searcher(graph, scorer);
  const [origin, dest] = snapPair(spatial, req.from, req.to, req.mode);
  const max = Math.max(1, req.maxCandidates ?? 3);
  const sw = sweep(searcher, origin, dest, req.mode, req.detour, LAMBDA_SWEEP, req.turnPenaltyM ?? TURN_PENALTY_M[req.mode]);
  if (!sw) throw new NoRouteError(req.mode);
  const { shortest, budgetM, feasible } = sw;
  const alts = selectAlternatives(shortest, feasible, max - 1);
  const candidates: RouteCandidate[] = [];
  if (alts.length >= 1) candidates.push(toCandidate(graph, alts[0], 'Most new', req.mode));
  for (let i = 1; i < alts.length; i++) candidates.push(toCandidate(graph, alts[i], 'Balanced', req.mode));
  candidates.push(toCandidate(graph, shortest, 'Direct', req.mode));
  return {
    candidates,
    shortestM: Math.round(shortest.lengthM),
    budgetM: Math.round(budgetM),
    graphTiles: ctx.graphTiles ?? graph.tileKeys.length,
    ms: Math.round(now() - t0),
  };
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
