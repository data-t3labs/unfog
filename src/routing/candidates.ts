/**
 * Candidate generation: shortest path (λ=0) fixes the budget B = (1 + detour) · L0; a λ sweep
 * produces penalised paths; those within budget are deduplicated (shared-segment fraction relative
 * to the smaller set > 0.6 = duplicate) and ranked by never-visited metres. Output ≤ maxCandidates
 * with "Direct" (the shortest) always last.
 *
 * Pins off the network (feedback-1, items 2–3): a pin snaps to the nearest usable street up to
 * SNAP_MAX_M away and the route starts/ends with a straight `offroad` part between the pin and
 * the snap point — you walk to the street. When the two snaps sit in different components of the
 * mode's network (and a re-snap within RESNAP_MAX_M cannot join them), when one pin has no usable
 * street within SNAP_MAX_M, or when the search finds no path (a one-way trap), the result is one
 * Direct candidate: streets from the origin to its component's node nearest the destination, a
 * `straight` gap to the destination component's node nearest that exit, streets from there.
 * Nothing here throws NoRouteError any more; SnapError remains for loops (no street within
 * SNAP_MAX_M of the start).
 */
import { distanceM } from '../grid/cell';
import type { LonLat, RouteCandidate, RoutePart, RouteRequest, RouteResult } from './api';
import { ArcFlag, MODE_BIT, type Mode } from './graph-format';
import type { Graph } from './graph';
import { NoveltyScorer, lineNovelty } from './novelty';
import type { CellLookup } from './cells';
import { Searcher, type PathResult, type SearchOptions } from './search';
import { SpatialIndex, canEnterArc, canLeaveArc, usableFlags, type Snap } from './spatial';

export const LAMBDA_SWEEP = [0.35, 0.7, 1, 1.5, 2, 3, 4, 6, 9] as const;
export const DEDUPE_SHARED = 0.6;
export const SPEED_KMH: Record<Mode, number> = { walk: 4.8, bike: 15, drive: 30 };
/** How far a pin may be from the nearest usable street: beyond this the end is off the graph. */
export const SNAP_MAX_M = 5000;
/**
 * How far an end may be MOVED to join the other end's component (the Green-Wood case: the nearest
 * road is a cemetery's own network, a connected street lies a block away). Further than this the
 * two sides are joined by a straight gap instead — moving a pin a kilometre to avoid a gap would
 * route the "walk to the street" across the water the gap stands for.
 */
export const RESNAP_MAX_M = 300;
/** A snap closer than this is "on the street": no off-road part. */
export const OFFROAD_MIN_M = 12;
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
export interface CandidateContext {
  spatial?: SpatialIndex;
  scorer?: NoveltyScorer;
  searcher?: Searcher;
  /** Diagnostics reported in RouteResult. */
  graphTiles?: number;
}

/** No usable street within SNAP_MAX_M of a point. A→B routing never throws it (the end goes off-graph); loops do. */
export class SnapError extends Error {
  constructor(public which: 'origin' | 'destination', public point: LonLat) {
    super(`No road for this mode within ${SNAP_MAX_M / 1000} km of the ${which} (${point[0].toFixed(5)}, ${point[1].toFixed(5)})`);
    this.name = 'SnapError';
  }
}

export interface ScoredPath extends PathResult {
  lambda: number;
  segments: Set<number>;
}

/**
 * Nearest arc for the mode that the search can actually leave (origin) or arrive on (destination);
 * the nearest usable arc may be an island (an unconnected staircase) that strands the search. When
 * no connected arc lies within SNAP_MAX_M the plain nearest usable arc is taken. With `component`
 * (a label from `Graph.components`) only arcs of that component within RESNAP_MAX_M qualify, and
 * nothing else is tried.
 */
export function snapPoint(spatial: SpatialIndex, p: LonLat, mode: Mode, which: 'origin' | 'destination', component?: number): Snap {
  const mask = MODE_BIT[mode], graph = spatial.graph;
  const connected = which === 'origin' ? (a: number) => canLeaveArc(graph, a, mask) : (a: number) => canEnterArc(graph, a, mask);
  if (component !== undefined) {
    const comp = graph.components(mask);
    const s = spatial.nearestArc(p[0], p[1], mask, RESNAP_MAX_M, (a) => comp[graph.arcFrom[a]] === component && connected(a));
    if (!s) throw new SnapError(which, p);
    return s;
  }
  const s = spatial.nearestArc(p[0], p[1], mask, SNAP_MAX_M, connected) ?? spatial.nearestArc(p[0], p[1], mask, SNAP_MAX_M);
  if (!s) throw new SnapError(which, p);
  return s;
}

/** snapPoint, but null when nothing usable lies within SNAP_MAX_M (the end is off the graph). */
export function trySnap(spatial: SpatialIndex, p: LonLat, mode: Mode, which: 'origin' | 'destination', component?: number): Snap | null {
  try {
    return snapPoint(spatial, p, mode, which, component);
  } catch {
    return null;
  }
}

/**
 * Snap both ends of a trip. When they land in different components of the mode's network — one
 * pin inside a cemetery, a park or on a pier whose roads do not join the street grid — the end
 * whose re-snap into the other's component moves it the least is moved (within RESNAP_MAX_M).
 * If neither can move the snaps stand: findCandidates then joins the two sides with a straight
 * gap. Either end may be null (off the graph); such an end is returned as is.
 */
export function snapPair(spatial: SpatialIndex, from: LonLat, to: LonLat, mode: Mode): [origin: Snap | null, dest: Snap | null] {
  let origin = trySnap(spatial, from, mode, 'origin');
  let dest = trySnap(spatial, to, mode, 'destination');
  if (!origin || !dest) return [origin, dest];
  const graph = spatial.graph, comp = graph.components(MODE_BIT[mode]);
  const co = comp[graph.arcFrom[origin.arc]], cd = comp[graph.arcFrom[dest.arc]];
  if (co === cd) return [origin, dest];
  const dest2 = trySnap(spatial, to, mode, 'destination', co), origin2 = trySnap(spatial, from, mode, 'origin', cd);
  if (dest2 && (!origin2 || dest2.distM <= origin2.distM)) dest = dest2;
  else if (origin2) origin = origin2;
  return [origin, dest];
}

/** Whether two snaps lie in the same component of the mode's network. */
export function sameComponent(graph: Graph, a: Snap, b: Snap, mode: Mode): boolean {
  const comp = graph.components(MODE_BIT[mode]);
  return comp[graph.arcFrom[a.arc]] === comp[graph.arcFrom[b.arc]];
}

/**
 * A pin further than this from the network walks to the nearby street that gets it there soonest
 * (`chooseSnaps`); nearer, the nearest street is the obvious one and is kept.
 */
export const SNAP_CHOICE_MIN_M = RESNAP_MAX_M;
/** Streets considered for a far-off pin: the nearest SNAP_CHOICE_K within SNAP_CHOICE_FACTOR × the nearest distance. */
export const SNAP_CHOICE_K = 3;
export const SNAP_CHOICE_FACTOR = 1.5;

/** The `k` nearest distinct usable segments within `maxM` that `accept` allows, nearest first. */
export function nearestArcs(spatial: SpatialIndex, p: LonLat, mask: number, maxM: number, k: number, accept: (arc: number) => boolean): Snap[] {
  const graph = spatial.graph, seen = new Set<number>(), out: Snap[] = [];
  for (let i = 0; i < k; i++) {
    const s = spatial.nearestArc(p[0], p[1], mask, maxM, (a) => !seen.has(graph.segmentId(a)) && accept(a));
    if (!s) break;
    seen.add(graph.segmentId(s.arc));
    out.push(s);
  }
  return out;
}

/**
 * An end more than SNAP_CHOICE_MIN_M off the network is re-snapped to whichever of the nearby
 * streets (the SNAP_CHOICE_K nearest connected arcs of the other end's component within
 * SNAP_CHOICE_FACTOR × the nearest distance) gives the shortest leg + street path to the other
 * end — the nearest street as the crow flies may lie across a river. Route-quality sweep 3: a pin
 * 2 km north of the NYC region edge snapped to the Palisades across the Hudson (2.7 km) instead of
 * the Yonkers road (3.0 km) and Direct walked 26 km — over the George Washington Bridge and back
 * up New Jersey — for a 12.6 km trip. The origin is chosen against the destination, then the
 * destination against the chosen origin; an end on the street (≤ SNAP_CHOICE_MIN_M) is never moved.
 */
export function chooseSnaps(spatial: SpatialIndex, searcher: Searcher, from: LonLat, to: LonLat, mode: Mode, origin: Snap | null, dest: Snap | null): [origin: Snap | null, dest: Snap | null] {
  if (!origin || !dest) return [origin, dest];
  const graph = spatial.graph, mask = MODE_BIT[mode], comp = graph.components(mask);
  const noPenalty = searchOptions(mode, 0);
  const pick = (p: LonLat, snap: Snap, which: 'origin' | 'destination', other: Snap): Snap => {
    if (snap.distM <= SNAP_CHOICE_MIN_M) return snap;
    const want = comp[graph.arcFrom[other.arc]];
    const connected = which === 'origin' ? (a: number) => canLeaveArc(graph, a, mask) : (a: number) => canEnterArc(graph, a, mask);
    const alts = nearestArcs(spatial, p, mask, Math.min(SNAP_MAX_M, snap.distM * SNAP_CHOICE_FACTOR), SNAP_CHOICE_K, (a) => comp[graph.arcFrom[a]] === want && connected(a));
    let best = snap, bestTotal = Infinity;
    for (const s of alts) {
      const path = which === 'origin' ? searcher.run(s, other, noPenalty) : searcher.run(other, s, noPenalty);
      if (!path) continue;
      const total = s.distM + path.lengthM;
      if (total < bestTotal - 0.5) { best = s; bestTotal = total; }
    }
    return best;
  };
  const o = pick(from, origin, 'origin', dest);
  const d = pick(to, dest, 'destination', o);
  return [o, d];
}

/** A straight part between two points, scored like an arc; null when shorter than OFFROAD_MIN_M. */
export function straightPart(a: LonLat, b: LonLat, kind: 'offroad' | 'straight', lookup: CellLookup): RoutePart | null {
  const lengthM = distanceM(a[0], a[1], b[0], b[1]);
  if (lengthM < OFFROAD_MIN_M) return null;
  return { kind, coords: [a, b], lengthM, newM: lengthM * lineNovelty(a, b, lookup) };
}

/**
 * Nearest node of a component to a point, as a Snap the search can start from / arrive at (t = 0
 * on an outgoing usable arc, else t = 1 on an incoming one). Null only for a component with no
 * usable arc at all.
 */
export function nearestNodeInComponent(graph: Graph, component: number, target: LonLat, mode: Mode): Snap | null {
  const comp = graph.components(MODE_BIT[mode]), mask = MODE_BIT[mode];
  const kx = 111_320 * Math.cos(target[1] * (Math.PI / 180)), ky = 110_574;
  let best = -1, bestD = Infinity;
  for (let n = 0; n < graph.nodeCount; n++) {
    if (comp[n] !== component) continue;
    const dx = (graph.nodeLon[n] - target[0]) * kx, dy = (graph.nodeLat[n] - target[1]) * ky;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = n; }
  }
  if (best < 0) return null;
  const point: LonLat = [graph.nodeLon[best], graph.nodeLat[best]];
  for (let a = graph.arcStart[best]; a < graph.arcStart[best + 1]; a++) {
    if (usableFlags(graph.arcFlags[a], mask)) return { arc: a, t: 0, point, distM: Math.sqrt(bestD) };
  }
  // Only incoming usable arcs (a one-way end): arrive at t = 1 of one of them.
  for (let a = 0; a < graph.arcCount; a++) {
    if (graph.arcTo[a] === best && usableFlags(graph.arcFlags[a], mask)) return { arc: a, t: 1, point, distM: Math.sqrt(bestD) };
  }
  return null;
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

/**
 * Two points closer than this (degrees, ≈ 0.1 mm) are the same point: a snap point, a trimmed
 * cut point and a shape vertex meet at a route's joins within floating-point noise, never exactly.
 */
export const SAME_POINT_DEG = 1e-9;
export function samePoint(a: LonLat, b: LonLat): boolean {
  return Math.abs(a[0] - b[0]) < SAME_POINT_DEG && Math.abs(a[1] - b[1]) < SAME_POINT_DEG;
}
/** A cut within this of a shape point IS that point (a pin snapped onto a vertex lands there within noise). */
const TRIM_EPS_M = 0.01;

/** Coordinates of a path, with the partial first/last arcs trimmed to the snap points. */
export function pathCoords(graph: Graph, path: PathResult): LonLat[] {
  const out: LonLat[] = [];
  const push = (p: LonLat) => {
    const last = out[out.length - 1];
    if (last && samePoint(last, p)) return;
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

/**
 * Part of a polyline between two length fractions (0..1), interpolating the cut points. A cut
 * within TRIM_EPS_M of a shape point is that point, and the point is not emitted a second time —
 * a pin that snapped onto a vertex cuts the arc there within floating-point noise, and the route
 * used to carry the cut point AND the vertex: two zero-length steps and an a→b→a at the join.
 */
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
    if (Math.abs(cum[i] - d) <= TRIM_EPS_M) return geom[i];
    if (Math.abs(cum[i - 1] - d) <= TRIM_EPS_M) return geom[i - 1];
    const seg = cum[i] - cum[i - 1];
    const u = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i - 1]) / seg)) : 0;
    return [geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * u, geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * u];
  };
  const out: LonLat[] = [at(lo)];
  for (let i = 0; i < geom.length; i++) if (cum[i] > lo + TRIM_EPS_M && cum[i] < hi - TRIM_EPS_M) out.push(geom[i]);
  out.push(at(hi));
  return from <= to ? out : out.reverse();
}

/**
 * Minutes at the mode's speed over `lengthM` of street; `dismountM` (bike on DISMOUNT arcs) and
 * `offRoadM` (the walk between a pin and the street) go at walking speed in every mode, and a
 * `straightM` gap at the mode's speed.
 */
export function etaMinutes(lengthM: number, mode: Mode, dismountM = 0, offRoadM = 0, straightM = 0): number {
  const walked = mode === 'bike' ? Math.min(dismountM, lengthM) : 0;
  return Math.round(((lengthM - walked + straightM) / 1000 / SPEED_KMH[mode] + (walked + offRoadM) / 1000 / SPEED_KMH.walk) * 60);
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

/** The off-road parts at the two ends of a trip (null = the pin is on the street). */
export interface EndLegs {
  start: RoutePart | null;
  end: RoutePart | null;
}

const NO_LEGS: EndLegs = { start: null, end: null };

/** Street part of a path (its geometry trimmed to the snaps). */
function streetPart(graph: Graph, path: PathResult): RoutePart {
  return { kind: 'street', coords: pathCoords(graph, path), lengthM: path.lengthM, newM: path.newM };
}

/** Candidate from parts in order: geometry concatenated, totals summed, ETA per part kind. */
export function assembleCandidate(parts: RoutePart[], name: RouteCandidate['name'], mode: Mode, lambda: number, dismountM = 0): RouteCandidate {
  const coords: LonLat[] = [];
  let lengthM = 0, newM = 0, streetM = 0, offRoadM = 0, straightM = 0;
  for (const p of parts) {
    for (const c of p.coords) {
      const last = coords[coords.length - 1];
      if (last && samePoint(last, c)) continue;
      coords.push(c);
    }
    lengthM += p.lengthM;
    newM += p.newM;
    if (p.kind === 'street') streetM += p.lengthM;
    else if (p.kind === 'offroad') offRoadM += p.lengthM;
    else straightM += p.lengthM;
  }
  return {
    name,
    coords,
    lengthM: Math.round(lengthM),
    newM: Math.round(newM),
    pctNew: lengthM > 0 ? Math.round((100 * newM) / lengthM) : 0,
    lambda,
    etaMin: etaMinutes(streetM, mode, dismountM, offRoadM, straightM),
    parts,
  };
}

export function toCandidate(graph: Graph, path: ScoredPath, name: RouteCandidate['name'], mode: Mode, legs: EndLegs = NO_LEGS): RouteCandidate {
  const parts: RoutePart[] = [];
  if (legs.start) parts.push(legs.start);
  parts.push(streetPart(graph, path));
  if (legs.end) parts.push(legs.end);
  return assembleCandidate(parts, name, mode, path.lambda, mode === 'bike' ? dismountMetres(graph, path) : 0);
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
  const mode = req.mode;
  const [origin, dest] = chooseSnaps(spatial, searcher, req.from, req.to, mode, ...snapPair(spatial, req.from, req.to, mode));
  const legs: EndLegs = {
    start: origin ? straightPart(req.from, origin.point, 'offroad', lookup) : null,
    end: dest ? straightPart(dest.point, req.to, 'offroad', lookup) : null,
  };
  const legsM = (legs.start?.lengthM ?? 0) + (legs.end?.lengthM ?? 0);
  const done = (candidates: RouteCandidate[], shortestM: number, budgetM: number): RouteResult => ({
    candidates,
    shortestM: Math.round(shortestM),
    budgetM: Math.round(budgetM),
    graphTiles: ctx.graphTiles ?? graph.tileKeys.length,
    ms: Math.round(now() - t0),
  });
  if (origin && dest && sameComponent(graph, origin, dest, mode)) {
    const max = Math.max(1, req.maxCandidates ?? 3);
    const sw = sweep(searcher, origin, dest, mode, req.detour, LAMBDA_SWEEP, req.turnPenaltyM ?? TURN_PENALTY_M[mode]);
    if (sw) {
      const { shortest, budgetM, feasible } = sw;
      const alts = selectAlternatives(shortest, feasible, max - 1);
      const candidates: RouteCandidate[] = [];
      if (alts.length >= 1) candidates.push(toCandidate(graph, alts[0], 'Most new', mode, legs));
      for (let i = 1; i < alts.length; i++) candidates.push(toCandidate(graph, alts[i], 'Balanced', mode, legs));
      candidates.push(toCandidate(graph, shortest, 'Direct', mode, legs));
      // The budget bounds the street part; the legs are the same on every candidate.
      return done(candidates, shortest.lengthM + legsM, budgetM + legsM);
    }
  }
  // The network cannot join the two ends: streets to the edge, a straight gap, streets from the edge.
  const direct = gapCandidate(graph, lookup, searcher, req, origin, dest, legs);
  return done([direct], direct.lengthM, direct.lengthM * (1 + req.detour));
}

/**
 * One Direct candidate for ends the network does not join. Each snapped end contributes the
 * shortest street path between its snap and the node of its component nearest the other side
 * (nearest the far pin for the origin; nearest the origin's exit for the destination), and the
 * two exits are joined by a straight gap. A street path that fails (a one-way trap) drops that
 * side's street part: the gap then starts at that end's snap point. An end with no snap at all
 * (nothing within SNAP_MAX_M) is joined to the gap directly.
 */
export function gapCandidate(graph: Graph, lookup: CellLookup, searcher: Searcher, req: RouteRequest, origin: Snap | null, dest: Snap | null, legs: EndLegs): RouteCandidate {
  const mode = req.mode, comp = graph.components(MODE_BIT[mode]);
  const parts: RoutePart[] = [];
  const noPenalty = searchOptions(mode, 0);
  let dismountM = 0;
  // Origin side.
  let gapFrom: LonLat = req.from;
  if (origin) {
    if (legs.start) parts.push(legs.start);
    gapFrom = origin.point;
    const target = dest ? dest.point : req.to;
    const exit = nearestNodeInComponent(graph, comp[graph.arcFrom[origin.arc]], target, mode);
    const path = exit && !(exit.arc === origin.arc && exit.t === origin.t) ? searcher.run(origin, exit, noPenalty) : null;
    if (path && path.lengthM > 0) {
      parts.push(streetPart(graph, path));
      dismountM += mode === 'bike' ? dismountMetres(graph, path) : 0;
      gapFrom = exit!.point;
    }
  }
  // Destination side.
  let gapTo: LonLat = req.to;
  let entryPath: PathResult | null = null;
  if (dest) {
    gapTo = dest.point;
    const entry = nearestNodeInComponent(graph, comp[graph.arcFrom[dest.arc]], gapFrom, mode);
    entryPath = entry && !(entry.arc === dest.arc && entry.t === dest.t) ? searcher.run(entry, dest, noPenalty) : null;
    if (entryPath && entryPath.lengthM > 0) gapTo = entry!.point;
    else entryPath = null;
  }
  const gap = straightPart(gapFrom, gapTo, 'straight', lookup);
  if (gap) parts.push(gap);
  if (entryPath) {
    parts.push(streetPart(graph, entryPath));
    dismountM += mode === 'bike' ? dismountMetres(graph, entryPath) : 0;
  }
  if (dest && legs.end) parts.push(legs.end);
  if (parts.length === 0) parts.push({ kind: 'straight', coords: [req.from, req.to], lengthM: 0, newM: 0 });
  return assembleCandidate(parts, 'Direct', mode, 0, dismountM);
}

/** The straight line between the pins as one Direct candidate — "Route anyway" when no graph tile exists. */
export function straightLineResult(req: RouteRequest, lookup: CellLookup): RouteResult {
  const t0 = now();
  const part = straightPart(req.from, req.to, 'straight', lookup) ?? { kind: 'straight' as const, coords: [req.from, req.to], lengthM: distanceM(req.from[0], req.from[1], req.to[0], req.to[1]), newM: 0 };
  const direct = assembleCandidate([part], 'Direct', req.mode, 0);
  return { candidates: [direct], shortestM: direct.lengthM, budgetM: Math.round(direct.lengthM * (1 + req.detour)), graphTiles: 0, ms: Math.round(now() - t0) };
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
