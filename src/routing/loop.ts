/**
 * Loop ("take me somewhere new and back") — GraphHopper-style round trips: a fan of 8 headings;
 * per heading two via-points on a circle of radius targetKm/4 around the start (±45° of the
 * heading); the three legs are routed with the novelty penalty plus a ×5 penalty on arcs already
 * used by earlier legs of the same loop so the way back is not the way out. Loops are ranked by
 * never-visited metres and deduplicated; ≤ maxCandidates are returned.
 */
import type { LonLat, LoopRequest, RouteCandidate, RouteResult } from './api';
import type { CellLookup } from './cells';
import {
  etaMinutes, now, pathCoords, pickDistinct, snapPoint, type CandidateContext, type ScoredPath,
} from './candidates';
import type { Graph } from './graph';
import { NoveltyScorer } from './novelty';
import { Searcher, type PathResult } from './search';
import { SpatialIndex, type Snap } from './spatial';

export const LOOP_HEADINGS = 8;
export const LOOP_LAMBDA = 1.5;
export const LOOP_AVOID_FACTOR = 5;
/** Accept loops within [min, max] × target. */
export const LOOP_LENGTH_WINDOW: [number, number] = [0.6, 1.5];
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
}

function straightM(a: LonLat, b: LonLat): number {
  const kx = 111_320 * Math.cos(((a[1] + b[1]) / 2) * DEG), ky = 110_574;
  const dx = (a[0] - b[0]) * kx, dy = (a[1] - b[1]) * ky;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Route one loop through the via snaps; null if any leg fails. */
export function routeLoop(searcher: Searcher, origin: Snap, vias: Snap[], mode: LoopRequest['mode'], heading: number): LoopPath | null {
  const graph = searcher.graph;
  const avoid = new Uint8Array(graph.arcCount);
  const stops = [origin, ...vias, origin];
  const legs: PathResult[] = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const d = straightM(a.point, b.point);
    const leg = searcher.run(a, b, { lambda: LOOP_LAMBDA, mode, budget: Math.max(1.6 * d, d + 400), avoid, avoidFactor: LOOP_AVOID_FACTOR });
    if (!leg) return null;
    legs.push(leg);
    for (let k = 0; k < leg.arcs.length; k++) {
      const arc = leg.arcs[k];
      avoid[arc] = 1;
      const r = graph.arcReverse[arc];
      if (r >= 0) avoid[r] = 1;
    }
  }
  // Combine: length sums; new metres count each segment once.
  const segments = new Set<number>();
  let lengthM = 0, newM = 0, cost = 0;
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
      if (!segments.has(seg)) { segments.add(seg); newM += graph.arcLen[arc] * frac * searcher.scorer.get(arc); }
      all.push(arc);
    }
  }
  return {
    arcs: Uint32Array.from(all), lengthM, newM, cost,
    startFrac: legs[0].startFrac, endFrac: legs[legs.length - 1].endFrac,
    settled: legs.reduce((s, l) => s + l.settled, 0),
    lambda: LOOP_LAMBDA, segments, legs, heading,
  };
}

export function loopCoords(graph: Graph, loop: LoopPath): LonLat[] {
  const out: LonLat[] = [];
  for (const leg of loop.legs) {
    for (const p of pathCoords(graph, leg)) {
      const last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
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
  const origin = snapPoint(spatial, req.from, req.mode, 'origin');
  const targetM = req.targetKm * 1000;
  const radius = targetM / 4;
  const max = Math.max(1, req.maxCandidates ?? 3);
  const loops: LoopPath[] = [];
  const modeMask = { walk: 1, bike: 2, drive: 4 }[req.mode];
  for (let k = 0; k < LOOP_HEADINGS; k++) {
    const heading = (360 / LOOP_HEADINGS) * k;
    const p1 = offsetPoint(origin.point, radius, heading - 45);
    const p2 = offsetPoint(origin.point, radius, heading + 45);
    const s1 = spatial.nearestArc(p1[0], p1[1], modeMask, radius / 2);
    const s2 = spatial.nearestArc(p2[0], p2[1], modeMask, radius / 2);
    if (!s1 || !s2 || s1.arc === s2.arc) continue;
    const loop = routeLoop(searcher, origin, [s1, s2], req.mode, heading);
    if (!loop) continue;
    if (loop.lengthM < LOOP_LENGTH_WINDOW[0] * targetM || loop.lengthM > LOOP_LENGTH_WINDOW[1] * targetM) continue;
    loops.push(loop);
  }
  loops.sort((a, b) => b.newM - a.newM || Math.abs(a.lengthM - targetM) - Math.abs(b.lengthM - targetM) || a.heading - b.heading);
  const picked = pickDistinct(loops, [], max) as LoopPath[];
  const names: RouteCandidate['name'][] = ['Most new', 'Balanced', 'Direct'];
  const candidates = picked.map((l, i) => ({
    name: names[Math.min(i, names.length - 1)],
    coords: loopCoords(graph, l),
    lengthM: Math.round(l.lengthM),
    newM: Math.round(l.newM),
    pctNew: l.lengthM > 0 ? Math.round((100 * l.newM) / l.lengthM) : 0,
    lambda: l.lambda,
    etaMin: etaMinutes(l.lengthM, req.mode),
  }));
  return {
    candidates,
    shortestM: Math.round(targetM),
    budgetM: Math.round(LOOP_LENGTH_WINDOW[1] * targetM),
    graphTiles: ctx.graphTiles ?? graph.tileKeys.length,
    ms: Math.round(now() - t0),
  };
}
