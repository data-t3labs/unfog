/**
 * Candidate generation: shortest path (λ=0) fixes the budget B = (1 + detour) · L0; a λ sweep
 * produces penalised paths; those within budget are deduplicated (shared-segment fraction relative
 * to the smaller set > 0.6 = duplicate) and ranked by never-visited metres. Output ≤ maxCandidates
 * with "Direct" (the shortest) always last.
 */
import type { LonLat, RouteCandidate, RouteRequest, RouteResult } from './api';
import { MODE_BIT, type Mode } from './graph-format';
import type { Graph } from './graph';
import { NoveltyScorer } from './novelty';
import type { CellLookup } from './cells';
import { Searcher, type PathResult } from './search';
import { SpatialIndex, type Snap } from './spatial';

export const LAMBDA_SWEEP = [0.35, 0.7, 1, 1.5, 2, 3, 4, 6, 9] as const;
export const DEDUPE_SHARED = 0.6;
export const SPEED_KMH: Record<Mode, number> = { walk: 4.8, bike: 15, drive: 30 };
export const SNAP_MAX_M = 300;

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

export interface ScoredPath extends PathResult {
  lambda: number;
  segments: Set<number>;
}

export function snapPoint(spatial: SpatialIndex, p: LonLat, mode: Mode, which: 'origin' | 'destination'): Snap {
  const s = spatial.nearestArc(p[0], p[1], MODE_BIT[mode], SNAP_MAX_M);
  if (!s) throw new SnapError(which, p);
  return s;
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

export function etaMinutes(lengthM: number, mode: Mode): number {
  return Math.round((lengthM / 1000 / SPEED_KMH[mode]) * 60);
}

export function toCandidate(graph: Graph, path: ScoredPath, name: RouteCandidate['name'], mode: Mode): RouteCandidate {
  return {
    name,
    coords: pathCoords(graph, path),
    lengthM: Math.round(path.lengthM),
    newM: Math.round(path.newM),
    pctNew: path.lengthM > 0 ? Math.round((100 * path.newM) / path.lengthM) : 0,
    lambda: path.lambda,
    etaMin: etaMinutes(path.lengthM, mode),
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
): { shortest: ScoredPath; budgetM: number; feasible: ScoredPath[]; searches: number } | null {
  const graph = searcher.graph;
  const s0 = searcher.run(origin, dest, { lambda: 0, mode });
  if (!s0) return null;
  const shortest: ScoredPath = { ...s0, lambda: 0, segments: pathSegments(graph, s0.arcs) };
  const budgetM = (1 + detour) * shortest.lengthM;
  const feasible: ScoredPath[] = [];
  let over = 0, searches = 1;
  for (const lambda of lambdas) {
    const r = searcher.run(origin, dest, { lambda, mode, budget: budgetM });
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

/** Pick up to `slots` mutually distinct paths (distinct from `against` too) from a ranked list. */
export function pickDistinct(ranked: ScoredPath[], against: ScoredPath[], slots: number, minNewM = -Infinity): ScoredPath[] {
  const picked: ScoredPath[] = [];
  for (const r of ranked) {
    if (picked.length >= slots) break;
    if (r.newM <= minNewM) continue;
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
 * Direct on new metres and shares ≤ DEDUPE_SHARED of its segments with every other pick.
 */
export function selectAlternatives(shortest: ScoredPath, feasible: ScoredPath[], slots: number): ScoredPath[] {
  if (slots <= 0) return [];
  const minNew = shortest.newM + 1e-6;
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
  const origin = snapPoint(spatial, req.from, req.mode, 'origin');
  const dest = snapPoint(spatial, req.to, req.mode, 'destination');
  const max = Math.max(1, req.maxCandidates ?? 3);
  const sw = sweep(searcher, origin, dest, req.mode, req.detour);
  if (!sw) {
    return { candidates: [], shortestM: 0, budgetM: 0, graphTiles: ctx.graphTiles ?? graph.tileKeys.length, ms: now() - t0 };
  }
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
