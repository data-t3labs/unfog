/**
 * Loop ("take me somewhere new and back") — GraphHopper-style round trips: a fan of 8 headings;
 * per heading two via-points on a circle of radius targetKm/4 around the start (±45° of the
 * heading); the three legs are routed with the novelty penalty plus a ×5 penalty on arcs already
 * used by earlier legs of the same loop so the way back is not the way out (no turn penalty by
 * default — see LOOP_TURN_PENALTY_M). Loops are ranked by pctNew (never-visited metres per metre;
 * ties towards the target length) and deduplicated; ≤ maxCandidates are returned.
 */
import type { LonLat, LoopRequest, RouteCandidate, RouteResult } from './api';
import type { CellLookup } from './cells';
import {
  RESNAP_MAX_M, dismountMetres, etaMinutes, now, pathCoords, pickDistinct, samePoint, searchOptions, snapPoint,
  type CandidateContext, type ScoredPath,
} from './candidates';
import { MODE_BIT } from './graph-format';
import type { Graph } from './graph';
import { NoveltyScorer } from './novelty';
import { Searcher, type PathResult } from './search';
import { SpatialIndex, canEnterArc, canLeaveArc, isThroughArc, type Snap } from './spatial';

export const LOOP_HEADINGS = 8;
export const LOOP_LAMBDA = 1.5;
export const LOOP_AVOID_FACTOR = 5;
/** Accept loops within [min, max] × target (±25 %). */
export const LOOP_LENGTH_WINDOW: [number, number] = [0.75, 1.25];
/**
 * Via-point circle radius as a fraction of the target length. The three legs of a T/4 circle
 * measure 0.85·T as the crow flies and 1.1–1.3·T on a street grid; 0.22·T lands near 1.0·T, and a
 * loop that still misses the window is retried once with the radius rescaled by target/length.
 */
export const LOOP_RADIUS_FACTOR = 0.22;
/** Reject loops that retrace more than this fraction of their length (out-and-back). */
export const LOOP_MAX_RETRACED = 0.5;
/**
 * Leg length budgets as multiples of the straight-line distance, tried in order: a leg that finds
 * no path inside max(slack·d, d + 400) is retried with the next slack. The first value is the
 * normal city case; the second rescues legs that leave a park or a peninsula by a winding path
 * (a 5 km loop from the middle of Prospect Park found no loop at all with 1.6 alone).
 */
export const LOOP_LEG_SLACKS: readonly number[] = [1.6, 3];
/**
 * Reject loops thinner than this (4πA/L²: 1 = circle, 0.79 = square, 0 = out-and-back). Below
 * 0.1 a loop is a strip narrower than ~1/12 of its length — there and back on parallel streets.
 * NYC sweep: drops 11 of 111 routed attempts and costs no request its loops.
 */
export const LOOP_MIN_COMPACTNESS = 0.1;
/** Via re-snaps per heading when a leg had to double back at a via (a dead-end pocket). */
const LOOP_VIA_RETRIES = 2;
/**
 * Turn penalty for loop legs (see SearchOptions.turnPenaltyM): OFF. Unlike A→B alternatives the
 * NYC sweep showed no win — at the walk default (12) loop turns/km fell 4.0 → 3.7 (p50) but
 * straighter legs run out and back on parallel streets: compactness p50 0.36 → 0.31, pctNew
 * 92 → 90, and a 3 km request lost two clean block loops for a 10.9 turns/km park wiggle.
 * LoopRequest.turnPenaltyM opts in.
 */
export const LOOP_TURN_PENALTY_M = 0;
const DEG = Math.PI / 180;

/** Point at `distM` metres and `bearingDeg` (0 = north, clockwise) from `from`. */
export function offsetPoint(from: LonLat, distM: number, bearingDeg: number): LonLat {
  const b = bearingDeg * DEG;
  const dLat = (distM * Math.cos(b)) / 110_574;
  const dLon = (distM * Math.sin(b)) / (111_320 * Math.cos(from[1] * DEG));
  return [from[0] + dLon, from[1] + dLat];
}

export interface LoopPath extends ScoredPath {
  legs: PathResult[];
  heading: number;
  /** Metres travelled on segments the loop had already used (out-and-back stretches). */
  retracedM: number;
  /** Indices of the vias where the next leg could only leave by doubling back (dead-end pocket). */
  uturnVias: number[];
  /** Per entry of `uturnVias`: the nodes the leg reached before giving up — the pocket itself. */
  uturnPockets: number[][];
}

function straightM(a: LonLat, b: LonLat): number {
  const kx = 111_320 * Math.cos(((a[1] + b[1]) / 2) * DEG), ky = 110_574;
  const dx = (a[0] - b[0]) * kx, dy = (a[1] - b[1]) * ky;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Route one loop through the via snaps; null if any leg fails. A leg never starts along the
 * reverse of the arc the previous leg arrived by (no doubling back at the via) unless that is the
 * only way out; a leg that finds nothing inside its length budget is retried with each further
 * slack in `slacks`.
 */
export function routeLoop(searcher: Searcher, origin: Snap, vias: Snap[], mode: LoopRequest['mode'], heading: number, slacks: readonly number[] = LOOP_LEG_SLACKS, turnPenaltyM = LOOP_TURN_PENALTY_M): LoopPath | null {
  const graph = searcher.graph;
  const avoid = new Uint8Array(graph.arcCount);
  const stops = [origin, ...vias, origin];
  const legs: PathResult[] = [];
  const uturnVias: number[] = [], uturnPockets: number[][] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const d = straightM(a.point, b.point);
    const prev = legs[legs.length - 1];
    const arrived = prev ? prev.arcs[prev.arcs.length - 1] : -1;
    const forbid = arrived >= 0 ? graph.arcReverse[arrived] : -1;
    let leg: PathResult | null = null;
    let pocket: number[] | null = null;
    for (const forbidStartArc of forbid >= 0 ? [forbid, -1] : [-1]) {
      for (const slack of slacks) {
        leg = searcher.run(a, b, { ...searchOptions(mode, LOOP_LAMBDA, Math.max(slack * d, d + 400), turnPenaltyM), avoid, avoidFactor: LOOP_AVOID_FACTOR, forbidStartArc });
        if (leg) break;
      }
      if (leg) { if (forbidStartArc < 0 && forbid >= 0) { uturnVias.push(i - 2); uturnPockets.push(pocket ?? []); } break; }
      pocket = Array.from(searcher.lastSettled()); // everything the leg could reach without turning round
    }
    if (!leg) return null;
    legs.push(leg);
    for (let k = 0; k < leg.arcs.length; k++) {
      const arc = leg.arcs[k];
      avoid[arc] = 1;
      const r = graph.arcReverse[arc];
      if (r >= 0) avoid[r] = 1;
    }
  }
  // Combine: length sums; new metres count each segment once; a repeated segment is retraced.
  const segments = new Set<number>();
  let lengthM = 0, newM = 0, cost = 0, retracedM = 0;
  const all: number[] = [];
  for (const leg of legs) {
    lengthM += leg.lengthM; cost += leg.cost;
    for (let k = 0; k < leg.arcs.length; k++) {
      const arc = leg.arcs[k];
      const seg = graph.segmentId(arc);
      let frac = 1;
      if (leg.arcs.length === 1) frac = leg.endFrac - leg.startFrac;
      else if (k === 0) frac = 1 - leg.startFrac;
      else if (k === leg.arcs.length - 1) frac = leg.endFrac;
      const l = graph.arcLen[arc] * frac;
      if (!segments.has(seg)) { segments.add(seg); newM += l * searcher.scorer.get(arc); }
      else retracedM += l;
      all.push(arc);
    }
  }
  return {
    arcs: Uint32Array.from(all), lengthM, newM, cost, retracedM,
    startFrac: legs[0].startFrac, endFrac: legs[legs.length - 1].endFrac,
    settled: legs.reduce((s, l) => s + l.settled, 0),
    lambda: LOOP_LAMBDA, segments, legs, heading, uturnVias, uturnPockets,
  };
}

/**
 * 1 per component label (see `Graph.components`) whose network contains a cycle — some node
 * outside every dead-end tree (`Graph.deadEnds`). A loop can only exist in such a component.
 */
export function cyclicComponents(graph: Graph, modeMask: number): Uint8Array {
  const comp = graph.components(modeMask), dead = graph.deadEnds(modeMask);
  const out = new Uint8Array(graph.nodeCount);
  for (let n = 0; n < graph.nodeCount; n++) if (!dead[n]) out[comp[n]] = 1;
  return out;
}

/** 4πA/L² of a closed polyline (1 = circle, 0.79 = square, 0 = out-and-back). */
export function compactness(coords: LonLat[]): number {
  if (coords.length < 3) return 0;
  const kx = 111_320 * Math.cos(coords[0][1] * DEG), ky = 110_574;
  let area = 0, len = 0;
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i], q = coords[(i + 1) % coords.length];
    const x1 = (p[0] - coords[0][0]) * kx, y1 = (p[1] - coords[0][1]) * ky;
    const x2 = (q[0] - coords[0][0]) * kx, y2 = (q[1] - coords[0][1]) * ky;
    area += x1 * y2 - x2 * y1;
    if (i < coords.length - 1) len += Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }
  return len > 0 ? (4 * Math.PI * Math.abs(area) / 2) / (len * len) : 0;
}

/** Integer pctNew of a loop, the ranking key (what the UI shows). */
export function loopPct(l: { lengthM: number; newM: number }): number {
  return l.lengthM > 0 ? Math.round((100 * l.newM) / l.lengthM) : 0;
}

/**
 * Rank loops by new metres per metre, not new metres: by new metres the longest loop in the
 * window won (NYC sweep: "Most new" at 1.19–1.24 × target in 5 of 15 requests). Integer points,
 * as the UI shows them, so loops that read the same are ordered by closeness to the target;
 * then by heading for determinism. Sorts in place and returns the array.
 */
export function rankLoops<T extends { lengthM: number; newM: number; heading: number }>(loops: T[], targetM: number): T[] {
  return loops.sort((a, b) => loopPct(b) - loopPct(a) || Math.abs(a.lengthM - targetM) - Math.abs(b.lengthM - targetM) || a.heading - b.heading);
}

export function loopCoords(graph: Graph, loop: LoopPath): LonLat[] {
  const out: LonLat[] = [];
  for (const leg of loop.legs) {
    for (const p of pathCoords(graph, leg)) {
      const last = out[out.length - 1];
      if (last && samePoint(last, p)) continue;
      out.push(p);
    }
  }
  return out;
}

export function findLoops(graph: Graph, lookup: CellLookup, req: LoopRequest, ctx: CandidateContext = {}): RouteResult {
  const t0 = now();
  const spatial = ctx.spatial ?? new SpatialIndex(graph);
  const scorer = ctx.scorer ?? new NoveltyScorer(graph, lookup);
  const searcher = ctx.searcher ?? new Searcher(graph, scorer);
  const modeMask = MODE_BIT[req.mode];
  const comp = graph.components(modeMask);
  let origin = snapPoint(spatial, req.from, req.mode, 'origin');
  // A loop needs a cycle. When the nearest road is an island without one — a stub of two ways by a
  // ferry dock (Salt Spring sweep: Vesuvius, no loop at any length), a pier — that the one-hop
  // check accepts, the start moves to the nearest road of a component that has a cycle, within
  // RESNAP_MAX_M; further than that the island stands and the result is honestly empty.
  const cyclic = cyclicComponents(graph, modeMask);
  if (!cyclic[comp[graph.arcFrom[origin.arc]]]) {
    const moved = spatial.nearestArc(req.from[0], req.from[1], modeMask, RESNAP_MAX_M, (a) => cyclic[comp[graph.arcFrom[a]]] === 1 && canLeaveArc(graph, a, modeMask));
    if (moved) origin = moved;
  }
  const targetM = req.targetKm * 1000;
  const max = Math.max(1, req.maxCandidates ?? 3);
  const turnPenaltyM = req.turnPenaltyM ?? LOOP_TURN_PENALTY_M;
  const loops: LoopPath[] = [];
  // A via is arrived on and then left: skip island arcs that would sink a leg, anything the
  // origin's component cannot reach at all (a cemetery's or a park's own roads), and dead-end
  // segments (a stub path, the last block of a cul-de-sac) that force a walk-in-and-turn-round.
  const originComp = comp[graph.arcFrom[origin.arc]];
  const viaOk = (a: number) => comp[graph.arcFrom[a]] === originComp && isThroughArc(graph, a, modeMask) && canEnterArc(graph, a, modeMask) && canLeaveArc(graph, a, modeMask);
  const inWindow = (l: LoopPath) => l.lengthM >= LOOP_LENGTH_WINDOW[0] * targetM && l.lengthM <= LOOP_LENGTH_WINDOW[1] * targetM;
  // A via whose only way on is back (a dead-end pocket the one-hop check cannot see: a pier, a
  // plaza's paths, an estate's walkways) is re-snapped outside the pocket the leg explored; the
  // doubling-back loop is kept only if nothing better comes.
  const attempt = (heading: number, radius: number): LoopPath | null => {
    const p1 = offsetPoint(origin.point, radius, heading - 45);
    const p2 = offsetPoint(origin.point, radius, heading + 45);
    const excludeArcs = new Set<number>(), excludeNodes = new Set<number>();
    let fallback: LoopPath | null = null;
    for (let tries = 0; tries <= LOOP_VIA_RETRIES; tries++) {
      const ok = (a: number) => !excludeArcs.has(a) && !excludeNodes.has(graph.arcFrom[a]) && !excludeNodes.has(graph.arcTo[a]) && viaOk(a);
      const s1 = spatial.nearestArc(p1[0], p1[1], modeMask, radius / 2, ok);
      const s2 = spatial.nearestArc(p2[0], p2[1], modeMask, radius / 2, ok);
      if (!s1 || !s2 || s1.arc === s2.arc) break;
      const loop = routeLoop(searcher, origin, [s1, s2], req.mode, heading, LOOP_LEG_SLACKS, turnPenaltyM);
      if (!loop) break;
      if (loop.uturnVias.length === 0) return loop;
      fallback ??= loop;
      loop.uturnVias.forEach((v, k) => {
        excludeArcs.add([s1, s2][v].arc);
        for (const n of loop.uturnPockets[k]) excludeNodes.add(n);
      });
    }
    return fallback;
  };
  const coordsOf = new Map<LoopPath, LonLat[]>();
  for (let k = 0; k < LOOP_HEADINGS; k++) {
    const heading = (360 / LOOP_HEADINGS) * k;
    const radius = targetM * LOOP_RADIUS_FACTOR;
    let loop = attempt(heading, radius);
    if (!loop) loop = attempt(heading, radius * 0.6); // via point in water / off the network: pull it in
    if (loop && !inWindow(loop)) loop = attempt(heading, radius * Math.min(2, Math.max(0.5, targetM / loop.lengthM)));
    if (!loop || !inWindow(loop) || loop.retracedM > LOOP_MAX_RETRACED * loop.lengthM) continue;
    const coords = loopCoords(graph, loop);
    if (compactness(coords) < LOOP_MIN_COMPACTNESS) continue;
    coordsOf.set(loop, coords);
    loops.push(loop);
  }
  const picked = pickDistinct(rankLoops(loops, targetM), [], max) as LoopPath[];
  // Rank labels: the newest loop is "Most new", every other one "Balanced" — a loop is never
  // "Direct" (the app labels loops A/B/C by position and ignores these).
  const names: RouteCandidate['name'][] = ['Most new', 'Balanced'];
  const candidates = picked.map((l, i) => ({
    name: names[Math.min(i, names.length - 1)],
    coords: coordsOf.get(l)!,
    lengthM: Math.round(l.lengthM),
    newM: Math.round(l.newM),
    pctNew: loopPct(l),
    lambda: l.lambda,
    etaMin: etaMinutes(l.lengthM, req.mode, req.mode === 'bike' ? l.legs.reduce((m, leg) => m + dismountMetres(graph, leg), 0) : 0),
  }));
  return {
    candidates,
    shortestM: Math.round(targetM),
    budgetM: Math.round(LOOP_LENGTH_WINDOW[1] * targetM),
    graphTiles: ctx.graphTiles ?? graph.tileKeys.length,
    ms: Math.round(now() - t0),
  };
}
