/**
 * Loop ("take me somewhere new and back") — GraphHopper-style round trips: a fan of 8 headings;
 * per heading two via-points on a circle of radius targetKm/4 around the start (±45° of the
 * heading); the three legs are routed with the novelty penalty plus a ×5 penalty on arcs already
 * used by earlier legs of the same loop so the way back is not the way out (no turn penalty by
 * default — see LOOP_TURN_PENALTY_M). Loops are ranked by pctNew (never-visited metres per metre;
 * ties towards the target length) and deduplicated; ≤ maxCandidates are returned.
 *
 * When that strict fan finds NOTHING — a rural network, where the roads at the right ROAD distance
 * are not at the right crow-flies distance, so the via circle lands in water, on a ridge or on a
 * dead-end lane (Salt Spring sweep: 10 of 20 requests empty) — a sparse-network fallback runs
 * instead: vias cut from a ROAD-distance ring (a bounded Dijkstra from the origin) by bearing,
 * first as two-via triangles, then as a single turnaround the return leg walks round, and last —
 * only when neither made anything that is actually a loop — as an honest out-and-back through a
 * dead-end lane, marked `outback` so the sheet can say so. The fallback widens the window to
 * ±40 % and drops the compactness floor; a request that already had a loop never reaches it, so
 * city results are untouched.
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
import { MinHeap, Searcher, type PathResult } from './search';
import { SpatialIndex, canEnterArc, canLeaveArc, isThroughArc, usableFlags, type Snap } from './spatial';

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

// --- sparse-network fallback (route-quality sweep 3: 10 of 20 Salt Spring requests found no loop) -

/**
 * The fallback's length window, ±40 % instead of ±25 %. On a sparse network the cycles that exist
 * are the ones the roads make, not the ones the target asks for: the Vesuvius 3 km case has one
 * proper loop of 3.8 km (1.27 ×) and nothing else. Applies to the fallback only.
 */
export const LOOP_FALLBACK_WINDOW: [number, number] = [0.6, 1.4];
/**
 * Fallback compactness floor (LOOP_MIN_COMPACTNESS is 0.1): the real Salt Spring cycles sit at
 * 0.11–0.41 and the strict floor only just excluded them (Fulford 3 km: 0.098). Below this the
 * route is a strip out and back on parallel lanes, and it is labelled as one rather than dropped.
 */
export const LOOP_FALLBACK_MIN_COMPACTNESS = 0.08;
/** Above this retraced fraction (or below the floor above) a fallback loop is an out-and-back, not a loop. */
export const LOOP_FALLBACK_MAX_RETRACED = 0.45;
/** An out-and-back retraces half of itself; more than this is out, back and out again. */
export const LOOP_OUTBACK_MAX_RETRACED = 0.6;
/** Rural legs wind: a third slack over LOOP_LEG_SLACKS (a Salt Spring leg can be 5 × its crow-flies distance). */
export const LOOP_FALLBACK_LEG_SLACKS: readonly number[] = [1.6, 3, 6];
/** A ring point counts for a heading only within this many degrees of it. */
export const LOOP_FALLBACK_BEARING_DEG = 40;
/** Two-via pass: the vias sit this far either side of the heading. */
export const LOOP_FALLBACK_VIA_SPREAD_DEG = 50;
/** The fallback stops after this long (the whole request must stay under ~2 s). */
export const LOOP_FALLBACK_MS = 1200;
/**
 * Fallback passes in order: triangles off the road ring first, then a single turnaround the return
 * leg walks round, then — only if neither made something that is actually a loop — the honest
 * out-and-back, whose via may sit on a dead-end lane (`anyArc`). Radii are fractions of the target;
 * none exceeds 0.5 · T, the radius of the graph box `RouteEngine.loop` loads.
 */
export const LOOP_FALLBACK_PASSES: ReadonlyArray<{ vias: 1 | 2; r: number; anyArc?: boolean }> = [
  { vias: 2, r: 0.24 }, { vias: 2, r: 0.3 }, { vias: 2, r: 0.36 }, { vias: 2, r: 0.42 },
  { vias: 1, r: 0.38 }, { vias: 1, r: 0.44 }, { vias: 1, r: 0.48 },
  { vias: 1, r: 0.42, anyArc: true }, { vias: 1, r: 0.48, anyArc: true },
];

/** Bearing from `a` to `b` in degrees, 0 = north, clockwise (the convention `offsetPoint` takes). */
export function bearingTo(a: LonLat, b: LonLat): number {
  const kx = 111_320 * Math.cos(((a[1] + b[1]) / 2) * DEG), ky = 110_574;
  return (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / DEG + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function bearingGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Point at fraction `t` of an arc's geometry by length (the meaning of `Snap.t`). */
export function arcPointAt(graph: Graph, arc: number, t: number): LonLat {
  const geom = graph.arcGeometry(arc);
  if (geom.length < 2) return geom[0] ?? [0, 0];
  const kx = 111_320 * Math.cos(geom[0][1] * DEG), ky = 110_574;
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < geom.length; i++) {
    const l = Math.hypot((geom[i][0] - geom[i - 1][0]) * kx, (geom[i][1] - geom[i - 1][1]) * ky);
    seg.push(l); total += l;
  }
  if (total <= 0) return geom[0];
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const f = seg[i] > 0 ? Math.max(0, Math.min(1, want / seg[i])) : 0;
      return [geom[i][0] + (geom[i + 1][0] - geom[i][0]) * f, geom[i][1] + (geom[i + 1][1] - geom[i][1]) * f];
    }
    want -= seg[i];
  }
  return geom[geom.length - 1];
}

export interface RoadRing {
  /** Road distance from the origin snap to every node within `maxM`; Infinity beyond. */
  distM: Float64Array;
  /** The nodes with a finite distance, nearest first. */
  nodes: Int32Array;
}

/**
 * Dijkstra on plain length from a snap, capped at `maxM` — the road distances the via ring is cut
 * from. Unpenalised on purpose: the ring is a distance, not a route (the legs are still searched
 * with the novelty penalty and the own-route avoid).
 */
export function roadRing(graph: Graph, origin: Snap, modeMask: number, maxM: number): RoadRing {
  const distM = new Float64Array(graph.nodeCount).fill(Infinity);
  const closed = new Uint8Array(graph.nodeCount);
  const heap = new MinHeap(1024);
  const nodes: number[] = [];
  const seed = (arc: number, frac: number) => {
    if (arc < 0 || !usableFlags(graph.arcFlags[arc], modeMask)) return;
    const n = graph.arcTo[arc], d = graph.arcLen[arc] * frac;
    if (d < distM[n]) { distM[n] = d; heap.push(d, n); }
  };
  seed(origin.arc, 1 - origin.t);
  seed(graph.arcReverse[origin.arc], origin.t);
  while (heap.size > 0) {
    const n = heap.pop();
    if (closed[n]) continue;
    closed[n] = 1;
    const d = distM[n];
    if (d > maxM) break;
    nodes.push(n);
    for (let a = graph.arcStart[n]; a < graph.arcStart[n + 1]; a++) {
      if (!usableFlags(graph.arcFlags[a], modeMask)) continue;
      const v = graph.arcTo[a], nd = d + graph.arcLen[a];
      if (nd <= maxM && nd < distM[v]) { distM[v] = nd; heap.push(nd, v); }
    }
  }
  return { distM, nodes: Int32Array.from(nodes) };
}

/** A point of the road network at a chosen ROAD distance from the origin, with its bearing. */
export interface RingPoint {
  snap: Snap;
  bearing: number;
}

/**
 * Every place the network crosses road distance `radiusM`, one per segment: the arc's own point at
 * that distance (mid-arc, not a junction), so a leg can be forbidden from doubling back on it.
 */
export function ringPoints(graph: Graph, ring: RoadRing, from: LonLat, modeMask: number, radiusM: number, ok: (arc: number) => boolean): RingPoint[] {
  const out: RingPoint[] = [];
  const seen = new Set<number>();
  for (const u of ring.nodes) {
    const du = ring.distM[u];
    if (!(du < radiusM)) continue;
    for (let a = graph.arcStart[u]; a < graph.arcStart[u + 1]; a++) {
      if (!usableFlags(graph.arcFlags[a], modeMask)) continue;
      const len = graph.arcLen[a];
      if (len <= 0 || du + len < radiusM) continue;
      const canon = graph.segmentId(a);
      if (seen.has(canon)) continue;
      seen.add(canon);
      if (!ok(canon)) continue;
      const frac = (radiusM - du) / len;
      const t = canon === a ? frac : 1 - frac;
      const point = arcPointAt(graph, canon, t);
      out.push({ snap: { arc: canon, t, point, distM: 0 }, bearing: bearingTo(from, point) });
    }
  }
  return out;
}

/** The ring point closest to a bearing, or null when the network goes nowhere near it. */
export function nearestBearing(points: RingPoint[], want: number, maxGap = LOOP_FALLBACK_BEARING_DEG): RingPoint | null {
  let best: RingPoint | null = null, bestGap = maxGap;
  for (const p of points) {
    const gap = bearingGap(p.bearing, want);
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return best;
}

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
  /**
   * Sparse-network fallback only: the route walks out and back rather than round (it retraces more
   * than LOOP_FALLBACK_MAX_RETRACED of itself, or is thinner than the fallback compactness floor).
   * Surfaces as `RouteCandidate.kind: 'outback'`; the sheet labels the row "Out and back".
   */
  outback?: boolean;
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
  // Sparse network: the strict fan found nothing at all (Salt Spring, 10 of 20 requests). Nothing
  // above changed, so every request that already had a loop keeps exactly the loops it had.
  let fallback = false;
  if (loops.length === 0) {
    // The out-and-back passes drop `viaOk`'s through-arc rule: the turnaround of an out-and-back
    // IS on a dead-end lane (the Beddis beach road, the Cusheon lake road) — that is the point.
    const anyOk = (a: number) => comp[graph.arcFrom[a]] === originComp && canEnterArc(graph, a, modeMask) && canLeaveArc(graph, a, modeMask);
    const ring = roadRing(graph, origin, modeMask, 0.55 * targetM);
    const rings = new Map<string, RingPoint[]>();
    const pointsAt = (radius: number, anyArc: boolean): RingPoint[] => {
      const key = `${Math.round(radius)}:${anyArc ? 1 : 0}`;
      let p = rings.get(key);
      if (!p) { p = ringPoints(graph, ring, origin.point, modeMask, radius, anyArc ? anyOk : viaOk); rings.set(key, p); }
      return p;
    };
    const inFallbackWindow = (l: LoopPath) => l.lengthM >= LOOP_FALLBACK_WINDOW[0] * targetM && l.lengthM <= LOOP_FALLBACK_WINDOW[1] * targetM;
    const ringAttempt = (heading: number, radius: number, vias: 1 | 2, anyArc: boolean): LoopPath | null => {
      const points = pointsAt(radius, anyArc);
      if (points.length === 0) return null;
      let stops: Snap[];
      if (vias === 1) {
        const v = nearestBearing(points, heading);
        if (!v) return null;
        stops = [v.snap];
      } else {
        const v1 = nearestBearing(points, (heading - LOOP_FALLBACK_VIA_SPREAD_DEG + 360) % 360);
        const v2 = nearestBearing(points, (heading + LOOP_FALLBACK_VIA_SPREAD_DEG) % 360);
        if (!v1 || !v2 || v1.snap.arc === v2.snap.arc) return null;
        stops = [v1.snap, v2.snap];
      }
      return routeLoop(searcher, origin, stops, req.mode, heading, LOOP_FALLBACK_LEG_SLACKS, turnPenaltyM);
    };
    const found: Array<{ loop: LoopPath; coords: LonLat[] }> = [];
    for (const pass of LOOP_FALLBACK_PASSES) {
      const anyArc = pass.anyArc === true;
      // The out-and-back passes are the last resort: skipped while a real loop exists.
      if (anyArc && found.some((f) => !f.loop.outback)) break;
      if (now() - t0 > LOOP_FALLBACK_MS) break;
      for (let k = 0; k < LOOP_HEADINGS; k++) {
        const heading = (360 / LOOP_HEADINGS) * k;
        const first = ringAttempt(heading, pass.r * targetM, pass.vias, anyArc);
        // A ring radius is a guess at a road distance; when the loop it makes is more than 15 %
        // off the target the radius is rescaled by target/length and tried again. Both results
        // are kept — the rescaled one is usually closer, but not always newer.
        const tries = [first];
        if (first && Math.abs(first.lengthM - targetM) > 0.15 * targetM) {
          const scaled = Math.min(0.5, Math.max(0.15, pass.r * (targetM / first.lengthM))) * targetM;
          if (Math.round(scaled) !== Math.round(pass.r * targetM)) tries.push(ringAttempt(heading, scaled, pass.vias, anyArc));
        }
        for (const loop of tries) {
          if (!loop || !inFallbackWindow(loop)) continue;
          const coords = loopCoords(graph, loop);
          const retraced = loop.retracedM / Math.max(1, loop.lengthM);
          loop.outback = retraced > LOOP_FALLBACK_MAX_RETRACED || compactness(coords) < LOOP_FALLBACK_MIN_COMPACTNESS;
          if (loop.outback && retraced > LOOP_OUTBACK_MAX_RETRACED) continue;
          found.push({ loop, coords });
        }
      }
    }
    const real = found.filter((f) => !f.loop.outback);
    for (const f of real.length > 0 ? real : found) { coordsOf.set(f.loop, f.coords); loops.push(f.loop); }
    fallback = loops.length > 0;
  }
  const picked = pickDistinct(rankLoops(loops, targetM), [], max) as LoopPath[];
  // Rank labels: the newest loop is "Most new", every other one "Balanced" — a loop is never
  // "Direct" (the app labels loops A/B/C by position and ignores these).
  const names: RouteCandidate['name'][] = ['Most new', 'Balanced'];
  const candidates = picked.map((l, i) => ({
    name: names[Math.min(i, names.length - 1)],
    ...(l.outback ? { kind: 'outback' as const } : {}),
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
    budgetM: Math.round((fallback ? LOOP_FALLBACK_WINDOW[1] : LOOP_LENGTH_WINDOW[1]) * targetM),
    graphTiles: ctx.graphTiles ?? graph.tileKeys.length,
    ms: Math.round(now() - t0),
  };
}
