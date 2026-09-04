/**
 * Route-quality sweep over the prebuilt regions — a report generator, not a unit test. It is a
 * vitest file only so it can import the TypeScript sources; it is a no-op unless ROUTE_SWEEP=1.
 *
 *   ROUTE_SWEEP=1 ROUTE_SWEEP_OUT=/abs/dir ROUTE_SWEEP_TAG=r3 npx vitest run tools/route-sweep/sweep.test.ts
 *
 * Env: ROUTE_SWEEP_REGIONS=nyc,vancouver,saltspring (default all), ROUTE_SWEEP_SEED (20260902),
 * ROUTE_SWEEP_TURN=<K> (turn penalty override for every request), ROUTE_SWEEP_BASELINE=<sweep.json
 * of an earlier round> (NYC per-pair comparison table), ROUTE_SWEEP_RENDER=id:d0.25,id:loop (extra
 * renders), ROUTE_SWEEP_WAYCACHE_DIR (way-class caches; default the out dir).
 *
 * What it does (see the route-quality reports for the rationale), per region:
 *   1. builds a realistic visited set around two "homes": every arc within 600 m with probability
 *      0.85·exp(−d/400)+0.1, plus the shortest walks to 15 random nearby destinations; cells every
 *      4 m with 8-neighbour dilation (setup.ts);
 *   2. routes the seeded origin→destination pairs (1–8 km, on-street), the region's named cases
 *      (piers, park interiors, pins off the coverage edge, long cross-city trips) and the loops
 *      (round 2's 15 NYC origins + 5 named seeds × 2/3/5/8 km) through findCandidates / findLoops
 *      exactly as RouteEngine does, in the one mode the app requests (walk);
 *   3. checks the structural invariants, flags the quality classes of round 3 (empty candidates,
 *      collapsed spread, over budget, off-road / straight legs > 300 m with a usable arc within
 *      100 m of the pin, loops outside ±25 %, runtime > 2 s) and tables the metrics;
 *   4. renders the named cases, the flagged calls and the worst cases to PNG.
 * Outputs per region: <out>/sweep-<tag>-<region>.md (tables), .json (every row), <tag>-<region>-*.png.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { distanceM } from '../../src/grid/cell';
import type { LonLat, RouteCandidate, RouteResult } from '../../src/routing/api';
import {
  SnapError, TURN_PENALTY_M, chooseSnaps, findCandidates, now, pathSegments, searchOptions, sharedFraction, snapPair,
} from '../../src/routing/candidates';
import { ArcFlag, MODE_BIT } from '../../src/routing/graph-format';
import { Graph } from '../../src/routing/graph';
import { LOOP_TURN_PENALTY_M, findLoops } from '../../src/routing/loop';
import { NoveltyScorer } from '../../src/routing/novelty';
import type { PathResult } from '../../src/routing/search';
import { canEnterArc, canLeaveArc, type SpatialIndex } from '../../src/routing/spatial';
import { encodePng } from '../../tests/fixtures/grid/png';
import { MODE, REGIONS, setup, type LoopSpec, type Pair, type RegionSpec } from './setup';

const ENABLED = process.env.ROUTE_SWEEP === '1';
const OUT = process.env.ROUTE_SWEEP_OUT ?? new URL('../../test-results/route-sweep', import.meta.url).pathname;
const TAG = process.env.ROUTE_SWEEP_TAG ?? 'run';
const SEED = Number(process.env.ROUTE_SWEEP_SEED ?? 20260902);
const WAYCACHE_DIR = process.env.ROUTE_SWEEP_WAYCACHE_DIR ?? OUT;
const REGION_IDS = (process.env.ROUTE_SWEEP_REGIONS ?? REGIONS.map((r) => r.id).join(',')).split(',').filter(Boolean);
const BASELINE = process.env.ROUTE_SWEEP_BASELINE;
/** Turn penalty (metres per 90° turn) for every request; unset = the engine's defaults. */
const TURN = process.env.ROUTE_SWEEP_TURN !== undefined ? Number(process.env.ROUTE_SWEEP_TURN) : undefined;
const turnFor = () => TURN ?? TURN_PENALTY_M[MODE];
const loopTurnFor = () => TURN ?? LOOP_TURN_PENALTY_M;
/** Extra calls to render regardless of score, e.g. `20:d0.25,1001:loop`. */
const RENDER = (process.env.ROUTE_SWEEP_RENDER ?? '').split(',').filter(Boolean).map((s) => s.split(':'));

/** Round-3 flag thresholds. */
const LONG_LEG_M = 300;
const NEARBY_ARC_M = 100;
const SLOW_MS = 2000;
const LOOP_WINDOW: [number, number] = [0.75, 1.25];

// ---------------------------------------------------------------------------------------------
// helpers

function bearing(a: LonLat, b: LonLat): number {
  const kx = 111_320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180), ky = 110_574;
  return (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) * 180) / Math.PI;
}
function turnDeg(b1: number, b2: number): number {
  let d = Math.abs(b2 - b1) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Direction changes at arc joints (graph nodes): > 45° counts as a turn, > 135° as sharp. */
function arcTurns(graph: Graph, arcs: ArrayLike<number>): { turns: number; sharp: number } {
  let turns = 0, sharp = 0;
  for (let i = 1; i < arcs.length; i++) {
    const a = arcs[i - 1], b = arcs[i];
    const na = graph.arcPointCount(a), nb = graph.arcPointCount(b);
    const b1 = bearing(graph.arcPoint(a, na - 2, [0, 0]), graph.arcPoint(a, na - 1, [0, 0]));
    const b2 = bearing(graph.arcPoint(b, 0, [0, 0]), graph.arcPoint(b, Math.min(1, nb - 1), [0, 0]));
    const d = turnDeg(b1, b2);
    if (d > 45) turns++;
    if (d > 135) sharp++;
  }
  return { turns, sharp };
}

/** Direction changes along a polyline with a 10 m look-back / look-ahead (curves do not count). */
function coordTurns(coords: LonLat[]): number {
  const n = coords.length;
  if (n < 3) return 0;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  let turns = 0, lastAt = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    let j = i - 1; while (j > 0 && cum[i] - cum[j] < 10) j--;
    let k = i + 1; while (k < n - 1 && cum[k] - cum[i] < 10) k++;
    const d = turnDeg(bearing(coords[j], coords[i]), bearing(coords[i], coords[k]));
    if (d > 50 && cum[i] - lastAt > 10) { turns++; lastAt = cum[i]; }
  }
  return turns;
}

/** Fraction of a polyline's length whose undirected steps occur more than once. */
function twiceFraction(coords: LonLat[]): number {
  const seen = new Map<string, number>();
  let total = 0, twice = 0;
  for (let i = 1; i < coords.length; i++) {
    const p = `${coords[i - 1][0].toFixed(7)},${coords[i - 1][1].toFixed(7)}`, q = `${coords[i][0].toFixed(7)},${coords[i][1].toFixed(7)}`;
    const k = p < q ? `${p}|${q}` : `${q}|${p}`;
    const d = distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    total += d;
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c > 1) twice += d * (c === 2 ? 2 : 1);
  }
  return total > 0 ? twice / total : 0;
}

/** 4πA/L² of a closed polyline (1 = circle, 0 = out-and-back). */
function compactness(coords: LonLat[]): number {
  if (coords.length < 3) return 0;
  const lat0 = coords[0][1];
  const kx = 111_320 * Math.cos(lat0 * Math.PI / 180), ky = 110_574;
  let area = 0, len = 0;
  for (let i = 0; i < coords.length; i++) {
    const p = coords[i], q = coords[(i + 1) % coords.length];
    const x1 = (p[0] - coords[0][0]) * kx, y1 = (p[1] - coords[0][1]) * ky;
    const x2 = (q[0] - coords[0][0]) * kx, y2 = (q[1] - coords[0][1]) * ky;
    area += x1 * y2 - x2 * y1;
    if (i < coords.length - 1) len += Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }
  area = Math.abs(area) / 2;
  return len > 0 ? (4 * Math.PI * area) / (len * len) : 0;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toString() : '—');
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);

// ---------------------------------------------------------------------------------------------
// rows

interface CandRow {
  region: string;
  kind: 'route' | 'loop';
  id: number;
  detour: number;
  targetKm?: number;
  nearHome: boolean;
  name: string;
  lambda: number;
  lengthM: number;
  newM: number;
  pctNew: number;
  shortestM: number;
  budgetM: number;
  /** Straight-line distance between the pins (routes). */
  straightM: number;
  ms: number;
  /** length / shortest (routes), length / target (loops). */
  ratio: number;
  /** pctNew − Direct's pctNew */
  gain: number;
  /** Parts: street / off-road (pin ↔ snap) / straight gap (network cannot join) metres. */
  streetM: number;
  offroadM: number;
  gapM: number;
  /** Part kinds in order, one letter each (s = street, o = off-road, g = straight gap). */
  parts: string;
  /** A candidate with a straight gap (its arcs are not reproduced). */
  gap: boolean;
  arcTurnsPerKm: number;
  sharpPerKm: number;
  coordTurnsPerKm: number;
  stepsM: number;
  glueM: number;
  classes: Record<string, number>;
  wayRevisits: number;
  wayRevisitM: number;
  coordsN: number;
  twice: number;
  compact: number;
  endGapM: number;
  /** a→b→a in the coordinates (loops: doubling back at a via point). */
  uturns: number;
  maxStepM: number;
  stepNote: string;
  violations: string[];
  coords: LonLat[];
  arcs?: number[];
}

interface CallRow {
  region: string;
  kind: 'route' | 'loop';
  id: number;
  /** Named cases / loop seeds. */
  name?: string;
  why?: string;
  detour: number;
  targetKm?: number;
  from: LonLat;
  to?: LonLat;
  straightM: number;
  nearHome: boolean;
  ms: number;
  wallMs: number;
  shortestM: number;
  budgetM: number;
  candidates: number;
  error?: string;
  /** Per pin: distance to the snapped arc's point; distance to the nearest usable arc of any kind (−1 = none within 5 km). */
  snapM: number[];
  nearestM: number[];
  /** Off-road / straight-gap metres of the Direct candidate. */
  offroadM: number;
  gapM: number;
  pairShare: number[];
  /** Structural invariants broken. */
  violations: string[];
  /** Round-3 quality flags (see the header). */
  flags: string[];
}

// ---------------------------------------------------------------------------------------------

interface Baseline { pairs: Pair[]; calls: Array<{ kind: string; id: number; mode: string; detour: number; ms: number; candidates: number; from: LonLat; targetKm?: number }>; cands: Array<{ kind: string; id: number; mode: string; detour: number; name: string; lengthM: number; pctNew: number; newM: number; arcTurnsPerKm: number; ratio: number }> }

describe.skipIf(!ENABLED)('route-quality sweep (ROUTE_SWEEP=1)', () => {
  it('sweeps the prebuilt regions and writes the reports', { timeout: 1_800_000 }, () => {
    mkdirSync(OUT, { recursive: true });
    const baseline: Baseline | null = BASELINE && existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline) : null;
    for (const spec of REGIONS) if (REGION_IDS.includes(spec.id)) sweepRegion(spec, baseline);
  });
});

function sweepRegion(spec: RegionSpec, baseline: Baseline | null): void {
  const region = spec.id;
  const log = (s: string) => console.log(`[sweep ${region}] ${s}`);
  const t0 = now();
  const S = setup(spec, SEED, join(WAYCACHE_DIR, `${region}-way-classes.json`));
  const { graph, spatial, scorer, searcher, pairs, named, wayClass } = S;
  const lookup = S.visited.lookup, visitedArcs = S.visited.segments, visitedKm = S.visited.km;
  for (const l of S.visited.log) log(l);
  log(`graph: ${S.tiles} tiles, ${graph.nodeCount} nodes, ${graph.arcCount} arcs; way classes ${wayClass.size}; setup ${Math.round(now() - t0)} ms`);
  log(`visited: ${visitedArcs.size} segments, ${visitedKm.toFixed(1)} km, ${lookup.size} cells`);
  log(`pairs: ${pairs.length} seeded (${pairs.filter((p) => p.nearHome).length} near a home) + ${named.length} named; loops ${S.loops.length}`);
  if (baseline && region === 'nyc') {
    const same = pairs.filter((p, i) => baseline.pairs[i] && p.from[0] === baseline.pairs[i].from[0] && p.from[1] === baseline.pairs[i].from[1] && p.to[0] === baseline.pairs[i].to[0] && p.to[1] === baseline.pairs[i].to[1]).length;
    const bl = baseline.calls.filter((c) => c.kind === 'loop');
    const sameLoops = S.loops.filter((l) => bl.some((c) => c.id === l.id && c.from[0] === l.from[0] && c.from[1] === l.from[1])).length;
    log(`baseline ${BASELINE}: ${same}/${pairs.length} seeded pairs identical, ${sameLoops}/${bl.length} legacy loop origins identical`);
  }
  const classOf = (arc: number) => wayClass.get(graph.arcWay[arc]) ?? '?';
  const ctx = { spatial, scorer, searcher };
  const mask = MODE_BIT[MODE];
  const comp = graph.components(mask);
  const compSize = new Map<number, number>();
  for (let n = 0; n < graph.nodeCount; n++) compSize.set(comp[n], (compSize.get(comp[n]) ?? 0) + 1);
  const dead = graph.deadEnds(mask);
  const homes = spec.homes.map((h) => h.p);

  // ---- route + analyse ----
  const cands: CandRow[] = [];
  const calls: CallRow[] = [];

  type Base = Pick<CandRow, 'region' | 'kind' | 'id' | 'detour' | 'targetKm' | 'nearHome' | 'shortestM' | 'budgetM' | 'straightM' | 'ms'>;
  const analyse = (base: Base, c: RouteCandidate, direct: RouteCandidate | null, arcs: number[] | null, fracs: number[] | null): CandRow => {
    const v: string[] = [];
    const km = c.lengthM / 1000;
    // parts
    let streetM = 0, offroadM = 0, gapM = 0;
    const kinds: string[] = [];
    for (const p of c.parts ?? []) {
      kinds.push(p.kind === 'street' ? 's' : p.kind === 'offroad' ? 'o' : 'g');
      if (p.kind === 'street') streetM += p.lengthM; else if (p.kind === 'offroad') offroadM += p.lengthM; else gapM += p.lengthM;
    }
    if (!c.parts) { streetM = c.lengthM; kinds.push('s'); }
    const gap = gapM > 0 || kinds.includes('g');
    // coordinates
    let maxJump = 0, zero = 0;
    for (let i = 1; i < c.coords.length; i++) {
      const d = distanceM(c.coords[i - 1][0], c.coords[i - 1][1], c.coords[i][0], c.coords[i][1]);
      if (d === 0) zero++;
      if (d > maxJump) maxJump = d;
    }
    if (zero) v.push(`zero-length steps ×${zero}`);
    // A > 200 m coordinate step is a violation only when the arc's polyline does not add up to
    // its stored length (a missing shape point); a straight 400 m expressway span is not a hole.
    let holes = 0, maxStepM = maxJump, maxStepClass = '';
    if (arcs) {
      for (const a of arcs) {
        const n = graph.arcPointCount(a);
        let poly = 0, step = 0;
        const p0 = graph.arcPoint(a, 0, [0, 0]);
        let plon = p0[0], plat = p0[1];
        for (let i = 1; i < n; i++) {
          const q = graph.arcPoint(a, i, [0, 0]);
          const d = distanceM(plon, plat, q[0], q[1]);
          poly += d; if (d > step) step = d;
          plon = q[0]; plat = q[1];
        }
        const len = graph.arcLen[a];
        if (len >= 20 && Math.abs(poly - len) > 0.03 * len + 1) holes++;
        if (step > 200 && step >= maxStepM - 1) maxStepClass = `${classOf(a)} way ${graph.arcWay[a]} (${n} pts, ${len} m)`;
      }
    }
    if (holes) v.push(`geometry hole ×${holes} (arc polyline ≠ arcLen)`);
    const stepNote = maxStepM > 200 ? `step ${f0(maxStepM)} m on ${maxStepClass || (gap ? 'a straight part' : 'unknown arc')}` : '';
    if (c.pctNew < 0 || c.pctNew > 100) v.push(`pctNew ${c.pctNew}`);
    if (base.kind === 'route' && c.lengthM > base.budgetM + 1) v.push(`over budget ${c.lengthM} > ${base.budgetM}`);
    if (direct && c !== direct && c.newM < direct.newM) v.push(`newM ${c.newM} < Direct ${direct.newM}`);
    const twice = twiceFraction(c.coords);
    if (base.kind === 'route' && twice > 0) v.push(`segment twice ${f1(100 * twice)} %`);
    // immediate U-turn on coordinates (a→b→a): an invariant for A→B; for loops a quality metric
    // (the legs meet at a via point and the loop doubles back on the same street).
    let uturns = 0;
    for (let i = 2; i < c.coords.length; i++) {
      if (c.coords[i][0] === c.coords[i - 2][0] && c.coords[i][1] === c.coords[i - 2][1]) uturns++;
    }
    if (uturns && base.kind === 'route') v.push('immediate U-turn');
    const last = c.coords[c.coords.length - 1];
    const endGapM = distanceM(c.coords[0][0], c.coords[0][1], last[0], last[1]);
    // arcs
    let stepsM = 0, glueM = 0;
    const classes: Record<string, number> = {};
    let turns = { turns: 0, sharp: 0 };
    let wayRevisits = 0, wayRevisitM = 0;
    if (arcs && fracs) {
      const segs = pathSegments(graph, arcs);
      if (segs.size !== arcs.length) v.push('arc segment twice');
      for (let i = 1; i < arcs.length; i++) if (graph.arcReverse[arcs[i - 1]] === arcs[i]) { v.push('arc U-turn'); break; }
      turns = arcTurns(graph, arcs);
      const runs = new Map<number, number[]>(); // way → run lengths
      let curWay = -1, curLen = 0;
      for (let i = 0; i < arcs.length; i++) {
        const a = arcs[i], l = graph.arcLen[a] * fracs[i], fl = graph.arcFlags[a];
        const cls = classOf(a);
        classes[cls] = (classes[cls] ?? 0) + l;
        if (fl & ArcFlag.STEPS) stepsM += l;
        if (fl & ArcFlag.GLUE) glueM += l;
        const w = graph.arcWay[a];
        if (w === curWay) curLen += l;
        else { if (curWay >= 0) { const r = runs.get(curWay) ?? []; r.push(curLen); runs.set(curWay, r); } curWay = w; curLen = l; }
      }
      if (curWay >= 0) { const r = runs.get(curWay) ?? []; r.push(curLen); runs.set(curWay, r); }
      for (const r of runs.values()) if (r.length >= 2) { wayRevisits++; wayRevisitM += r.slice().sort((x, y) => x - y)[0]; }
    }
    if (base.kind === 'route' && c.name === 'Direct' && c.lengthM < 0.9 * endGapM) v.push(`Direct ${c.lengthM} < 0.9 × chord ${f0(endGapM)}`);
    if (base.kind === 'route' && c.name === 'Direct' && c.lengthM < 0.9 * base.straightM - 600) v.push(`Direct ${c.lengthM} < 0.9 × pins ${f0(base.straightM)}`);
    return {
      ...base,
      name: c.name, lambda: c.lambda, lengthM: c.lengthM, newM: c.newM, pctNew: c.pctNew,
      ratio: base.shortestM > 0 ? c.lengthM / base.shortestM : NaN,
      gain: direct ? c.pctNew - direct.pctNew : NaN,
      streetM, offroadM, gapM, parts: kinds.join(''), gap,
      arcTurnsPerKm: km > 0 ? turns.turns / km : 0, sharpPerKm: km > 0 ? turns.sharp / km : 0,
      coordTurnsPerKm: km > 0 ? coordTurns(c.coords) / km : 0,
      stepsM, glueM, classes, wayRevisits, wayRevisitM,
      coordsN: c.coords.length, twice, compact: base.kind === 'loop' ? compactness(c.coords) : NaN, endGapM,
      uturns, maxStepM, stepNote,
      violations: v, coords: c.coords, arcs: arcs ?? undefined,
    };
  };

  const fracsOf = (p: PathResult): number[] => {
    const n = p.arcs.length;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(n === 1 ? p.endFrac - p.startFrac : i === 0 ? 1 - p.startFrac : i === n - 1 ? p.endFrac : 1);
    return out;
  };

  /** Where a pin stands relative to the network: its snap distance and the nearest usable arc of any kind. */
  const pinInfo = (p: LonLat, snap: { distM: number } | null): [snapM: number, nearestM: number] => {
    const any = spatial.nearestArc(p[0], p[1], mask, 5000);
    return [snap ? snap.distM : -1, any ? any.distM : -1];
  };

  /** Describe the usable arc nearest a pin (for a long off-road leg): class, connectivity, component size. */
  const describeNearby = (p: LonLat, which: 'origin' | 'destination'): string | null => {
    const near = spatial.nearestArc(p[0], p[1], mask, NEARBY_ARC_M);
    if (!near) return null;
    const a = near.arc;
    const conn = which === 'origin' ? canLeaveArc(graph, a, mask) : canEnterArc(graph, a, mask);
    const cs = compSize.get(comp[graph.arcFrom[a]]) ?? 0;
    const dd = dead[graph.arcFrom[a]] || dead[graph.arcTo[a]] ? 'dead-end' : 'through';
    return `${classOf(a)} way ${graph.arcWay[a]} ${f0(near.distM)} m away, ${conn ? 'connected' : 'one-hop island'}, component ${cs} nodes, ${dd}`;
  };

  /** Round-3 flags for the legs of a Direct candidate: off-road > 300 m with a usable arc ≤ 100 m of the pin; straight gaps. */
  const legFlags = (c: RouteCandidate, from: LonLat, to: LonLat, flags: string[], notes: string[]) => {
    const parts = c.parts ?? [];
    parts.forEach((p, i) => {
      if (p.kind === 'offroad' && p.lengthM > LONG_LEG_M) {
        const atStart = i === 0;
        const pin = atStart ? from : to;
        const nearby = describeNearby(pin, atStart ? 'origin' : 'destination');
        if (nearby) flags.push(`long-leg-path-nearby ${f0(p.lengthM)} m ${atStart ? 'at the start' : 'at the end'} (${nearby})`);
        else notes.push(`off-road ${f0(p.lengthM)} m ${atStart ? 'at the start' : 'at the end'}, no usable arc within ${NEARBY_ARC_M} m of the pin`);
      }
      if (p.kind === 'straight') {
        const a = p.coords[0], b = p.coords[p.coords.length - 1];
        const sa = spatial.nearestArc(a[0], a[1], mask, NEARBY_ARC_M), sb = spatial.nearestArc(b[0], b[1], mask, NEARBY_ARC_M);
        const ca = sa ? compSize.get(comp[graph.arcFrom[sa.arc]]) ?? 0 : 0, cb = sb ? compSize.get(comp[graph.arcFrom[sb.arc]]) ?? 0 : 0;
        const sameComp = sa && sb && comp[graph.arcFrom[sa.arc]] === comp[graph.arcFrom[sb.arc]];
        const desc = `straight gap ${f0(p.lengthM)} m (${sa ? `streets at both ends: components ${ca} / ${cb} nodes${sameComp ? ' — SAME component' : ''}` : 'one end off the network'})`;
        if (sameComp || (p.lengthM > LONG_LEG_M && sa && sb && ca > 2000 && cb > 2000)) flags.push(`gap-between-connected-streets ${desc}`);
        else notes.push(desc);
      }
    });
  };

  const routePair = (pair: Pair, detour: number) => {
    const tw = now();
    let res: RouteResult | null = null, error: string | undefined;
    try {
      res = findCandidates(graph, lookup, { from: pair.from, to: pair.to, mode: MODE, detour, turnPenaltyM: turnFor() }, ctx);
    } catch (e) {
      error = e instanceof SnapError ? `${e.name}: ${e.message}` : String(e);
    }
    const wallMs = now() - tw;
    const [o, d] = chooseSnaps(spatial, searcher, pair.from, pair.to, MODE, ...snapPair(spatial, pair.from, pair.to, MODE));
    const po = pinInfo(pair.from, o), pd = pinInfo(pair.to, d);
    const call: CallRow = { region, kind: 'route', id: pair.id, name: pair.name, why: pair.why, detour, from: pair.from, to: pair.to, straightM: pair.straightM, nearHome: pair.nearHome, ms: res?.ms ?? wallMs, wallMs, shortestM: res?.shortestM ?? 0, budgetM: res?.budgetM ?? 0, candidates: res?.candidates.length ?? 0, error, snapM: [po[0], pd[0]], nearestM: [po[1], pd[1]], offroadM: 0, gapM: 0, pairShare: [], violations: [], flags: [] };
    calls.push(call);
    if (!res) { call.violations.push(error ?? 'no result'); call.flags.push('empty (error)'); return; }
    if (res.candidates.length === 0) { call.flags.push('empty'); return; }
    if (call.ms > SLOW_MS) call.flags.push(`slow ${f0(call.ms)} ms`);
    const direct = res.candidates[res.candidates.length - 1];
    if (direct.name !== 'Direct') call.violations.push('Direct not last');
    const notes: string[] = [];
    legFlags(direct, pair.from, pair.to, call.flags, notes);
    // reproduce the arcs of every candidate (deterministic search, same options as sweep()).
    // Candidates carry their off-road legs; the street part is what the search reproduces. A gap
    // candidate (two components / an end off the graph) is not reproduced.
    const s0 = o && d ? searcher.run(o, d, searchOptions(MODE, 0)) : null;
    const budget = s0 ? (1 + detour) * s0.lengthM : 0;
    const rows: CandRow[] = [];
    for (const c of res.candidates) {
      const isGap = (c.parts ?? []).some((p) => p.kind === 'straight');
      const streetM = c.parts ? c.parts.filter((p) => p.kind === 'street').reduce((s, p) => s + p.lengthM, 0) : c.lengthM;
      const p = isGap || !o || !d ? null : c.lambda === 0 ? s0 : searcher.run(o, d, searchOptions(MODE, c.lambda, budget, turnFor()));
      let arcs: number[] | null = null, fracs: number[] | null = null;
      if (p && Math.abs(p.lengthM - streetM) <= 1) { arcs = Array.from(p.arcs); fracs = fracsOf(p); }
      const row = analyse({ region, kind: 'route', id: pair.id, detour, nearHome: pair.nearHome, shortestM: res.shortestM, budgetM: res.budgetM, straightM: pair.straightM, ms: res.ms }, c, direct, arcs, fracs);
      if (!arcs && !isGap) row.violations.push('repro mismatch (arcs unavailable)');
      rows.push(row);
      cands.push(row);
    }
    const dRow = rows[rows.length - 1];
    call.offroadM = dRow.offroadM; call.gapM = dRow.gapM;
    for (const n of notes) call.flags.push(`note: ${n}`);
    // pairwise sharing / collapsed spread
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.lengthM === b.lengthM && a.newM === b.newM && a.coordsN === b.coordsN) call.flags.push(`collapsed ${a.name}/${b.name} identical`);
      if (!a.arcs || !b.arcs) continue;
      const sh = sharedFraction(pathSegments(graph, a.arcs), pathSegments(graph, b.arcs));
      call.pairShare.push(sh);
      if (sh > 0.6) { call.violations.push(`${a.name}/${b.name} share ${f0(100 * sh)} %`); call.flags.push(`collapsed ${a.name}/${b.name} share ${f0(100 * sh)} %`); }
    }
    for (const r of rows) for (const x of r.violations) {
      call.violations.push(`${r.name}: ${x}`);
      if (x.startsWith('over budget')) call.flags.push(`over-budget ${r.name} ${x}`);
    }
  };

  const nSeeded = pairs.length, nDet = spec.detourPairs;
  for (const pair of pairs.slice(0, nSeeded - nDet)) routePair(pair, 0.25);
  for (const pair of pairs.slice(nSeeded - nDet)) for (const detour of [0.1, 0.5]) routePair(pair, detour);
  for (const pair of named) routePair(pair, 0.25);
  log(`routes: ${calls.length} calls, ${cands.length} candidates`);

  // ---- loops ----
  const routeLoop = (lspec: LoopSpec) => {
    const { id: lid, from } = lspec;
    const tw = now();
    let res: RouteResult | null = null, error: string | undefined;
    try { res = findLoops(graph, lookup, { from, mode: MODE, targetKm: lspec.targetKm, turnPenaltyM: loopTurnFor() }, ctx); } catch (e) { error = String(e); }
    const wallMs = now() - tw;
    const any = spatial.nearestArc(from[0], from[1], mask, 5000);
    const call: CallRow = { region, kind: 'loop', id: lid, name: lspec.name, detour: 0, targetKm: lspec.targetKm, from, straightM: 0, nearHome: lspec.nearHome, ms: res?.ms ?? wallMs, wallMs, shortestM: lspec.targetKm * 1000, budgetM: res?.budgetM ?? 0, candidates: res?.candidates.length ?? 0, error, snapM: [], nearestM: [any ? any.distM : -1], offroadM: 0, gapM: 0, pairShare: [], violations: [], flags: [] };
    calls.push(call);
    if (!res) { call.violations.push(error ?? 'no result'); call.flags.push(`loop-empty (${error ?? 'no result'})`); return; }
    if (res.candidates.length === 0) { call.violations.push('no loop found'); call.flags.push('loop-empty'); }
    if (call.ms > SLOW_MS) call.flags.push(`slow ${f0(call.ms)} ms`);
    for (const c of res.candidates) {
      const row = analyse({ region, kind: 'loop', id: lid, detour: 0, targetKm: lspec.targetKm, nearHome: lspec.nearHome, shortestM: lspec.targetKm * 1000, budgetM: res.budgetM, straightM: 0, ms: res.ms }, c, null, null, null);
      const T = lspec.targetKm * 1000;
      if (row.endGapM > 30) row.violations.push(`loop end gap ${f0(row.endGapM)} m`);
      if (c.lengthM < LOOP_WINDOW[0] * T || c.lengthM > LOOP_WINDOW[1] * T) { row.violations.push(`loop length ${c.lengthM} outside ±25 % of ${T}`); call.flags.push(`loop-window ${c.name} ${c.lengthM} m for ${T}`); }
      if (distanceM(c.coords[0][0], c.coords[0][1], from[0], from[1]) > 300) row.violations.push('loop start > 300 m from pin');
      row.ratio = c.lengthM / T;
      cands.push(row);
      for (const x of row.violations) call.violations.push(`${c.name}: ${x}`);
    }
    const rows = cands.filter((r) => r.kind === 'loop' && r.id === lid);
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (rows[i].lengthM === rows[j].lengthM && rows[i].newM === rows[j].newM) call.flags.push(`collapsed ${rows[i].name}/${rows[j].name} identical`);
  };
  for (const l of S.loops) routeLoop(l);
  log(`loops done; total ${calls.length} calls`);

  // ---- tables ----
  const md: string[] = [];
  const seeded = calls.filter((c) => c.kind === 'route' && c.id < 500);
  const namedCalls = calls.filter((c) => c.kind === 'route' && c.id >= 500);
  const loopCalls = calls.filter((c) => c.kind === 'loop');
  md.push(`## Sweep \`${TAG}\` — ${spec.id} — seed ${SEED}, mode ${MODE}, ${pairs.length} seeded pairs + ${named.length} named cases, ${loopCalls.length} loop requests, ${calls.length} calls, ${cands.length} candidates`);
  md.push('');
  md.push(`Turn penalty (m per 90° turn): routes ${turnFor()}, loops ${loopTurnFor()}${TURN !== undefined ? ' (ROUTE_SWEEP_TURN override)' : ' (engine defaults)'}.`);
  md.push('');
  md.push(`Graph: ${S.tiles} tiles, ${graph.nodeCount} nodes, ${graph.arcCount} arcs (${compSize.size} walk components; largest ${max([...compSize.values()])} nodes). Visited set: ${visitedArcs.size} segments / ${visitedKm.toFixed(1)} km around ${spec.homes.map((h) => h.name).join(' + ')} (${lookup.size} cells). Way classes: ${wayClass.size ? wayClass.size : 'none (no PBF)'}.`);
  md.push('');
  const errs = calls.filter((c) => c.error);
  md.push(`Calls with an error: ${errs.length}${errs.length ? ' — ' + errs.map((c) => `#${c.id} ${c.error}`).join('; ') : ''}`);
  const viol = calls.filter((c) => c.violations.length);
  md.push(`Calls with an invariant violation: ${viol.length}${viol.length ? '\n' + viol.map((c) => `- #${c.id} ${c.kind}${c.name ? ` "${c.name}"` : ''} d=${c.detour}: ${c.violations.join('; ')}`).join('\n') : ''}`);
  md.push('');
  const flagged = calls.filter((c) => c.flags.some((f) => !f.startsWith('note:')));
  md.push(`### Flags (round 3): ${flagged.length} calls`);
  md.push('');
  const flagKinds = ['empty', 'collapsed', 'over-budget', 'long-leg-path-nearby', 'gap-between-connected-streets', 'loop-window', 'loop-empty', 'slow'];
  md.push(flagKinds.map((k) => `${k}: ${calls.filter((c) => c.flags.some((f) => f.startsWith(k))).length}`).join(' · '));
  md.push('');
  for (const c of flagged) md.push(`- #${c.id} ${c.kind}${c.name ? ` "${c.name}"` : ''}${c.kind === 'route' ? ` d=${c.detour}` : ` ${c.targetKm} km`}: ${c.flags.filter((f) => !f.startsWith('note:')).join('; ')}`);
  const noted = calls.filter((c) => c.flags.some((f) => f.startsWith('note:')));
  if (noted.length) {
    md.push('');
    md.push('Notes (legs > 300 m with nothing usable within 100 m of the pin, gaps between islands):');
    for (const c of noted) md.push(`- #${c.id}${c.name ? ` "${c.name}"` : ''}: ${c.flags.filter((f) => f.startsWith('note:')).map((f) => f.slice(6)).join('; ')}`);
  }
  md.push('');
  const longSteps = cands.filter((r) => r.maxStepM > 200 && !r.gap);
  md.push(`Candidates with a coordinate step > 200 m on streets (straight arcs, not holes): ${longSteps.length}; longest: ${longSteps.sort((a, b) => b.maxStepM - a.maxStepM).slice(0, 4).map((r) => `#${r.id} ${r.name}: ${r.stepNote}`).join('; ')}`);
  md.push('');

  md.push('### Seeded A→B distributions (all detours; walk)');
  md.push('');
  md.push('| detour | calls | with Most new | Balanced | len ratio Most new p50 / p90 | pctNew Direct p50 | pctNew gain Most new p50 / p90 | gain Balanced p50 | arc turns/km Direct p50 | Most new p50 / p90 | Balanced p50 | ms p50 / p90 / max |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const seededRows = (detour: number, name: string) => cands.filter((r) => r.kind === 'route' && r.id < 500 && r.detour === detour && r.name === name);
  for (const detour of [0.1, 0.25, 0.5]) {
    const cs = seeded.filter((c) => c.detour === detour && !c.error);
    if (!cs.length) continue;
    const most = seededRows(detour, 'Most new'), bal = seededRows(detour, 'Balanced'), dir = seededRows(detour, 'Direct');
    md.push(`| ${detour} | ${cs.length} | ${most.length} | ${bal.length} | ${f2(quantile(most.map((r) => r.ratio), 0.5))} / ${f2(quantile(most.map((r) => r.ratio), 0.9))} | ${f0(quantile(dir.map((r) => r.pctNew), 0.5))} | ${f0(quantile(most.map((r) => r.gain), 0.5))} / ${f0(quantile(most.map((r) => r.gain), 0.9))} | ${f0(quantile(bal.map((r) => r.gain), 0.5))} | ${f1(quantile(dir.map((r) => r.arcTurnsPerKm), 0.5))} | ${f1(quantile(most.map((r) => r.arcTurnsPerKm), 0.5))} / ${f1(quantile(most.map((r) => r.arcTurnsPerKm), 0.9))} | ${f1(quantile(bal.map((r) => r.arcTurnsPerKm), 0.5))} | ${f0(quantile(cs.map((c) => c.ms), 0.5))} / ${f0(quantile(cs.map((c) => c.ms), 0.9))} / ${f0(max(cs.map((c) => c.ms)))} |`);
  }
  md.push('');
  md.push('### Quality metrics (seeded, detour 0.25; Most new vs Direct)');
  md.push('');
  md.push('| metric | Direct p50 / p90 / max | Most new p50 / p90 / max | Balanced p50 / p90 / max |');
  md.push('|---|---|---|---|');
  const q3 = (rows: CandRow[], f: (r: CandRow) => number) => `${f1(quantile(rows.map(f), 0.5))} / ${f1(quantile(rows.map(f), 0.9))} / ${f1(max(rows.map(f)))}`;
  {
    const D = seededRows(0.25, 'Direct'), M = seededRows(0.25, 'Most new'), B = seededRows(0.25, 'Balanced');
    const metrics: Array<[string, (r: CandRow) => number]> = [
      ['arc turns / km', (r) => r.arcTurnsPerKm],
      ['sharp (>135°) / km', (r) => r.sharpPerKm],
      ['coord turns / km', (r) => r.coordTurnsPerKm],
      ['steps m', (r) => r.stepsM],
      ['glue m', (r) => r.glueM],
      ['way revisits (same way, ≥2 runs)', (r) => r.wayRevisits],
      ['way revisit m (shorter run)', (r) => r.wayRevisitM],
      ['off-road m (both ends)', (r) => r.offroadM],
    ];
    for (const [label, f] of metrics) md.push(`| ${label} | ${q3(D, f)} | ${q3(M, f)} | ${q3(B, f)} |`);
  }
  md.push('');
  md.push('### Legs (off-road pin ↔ street, straight gaps)');
  md.push('');
  {
    const routeCalls = calls.filter((c) => c.kind === 'route' && !c.error && c.candidates > 0);
    const withOff = routeCalls.filter((c) => c.offroadM > 0), withGap = routeCalls.filter((c) => c.gapM > 0);
    const seededOff = seeded.filter((c) => c.offroadM > 0);
    md.push(`- Calls whose Direct has an off-road leg (≥ 12 m): ${withOff.length} of ${routeCalls.length} (seeded: ${seededOff.length} of ${seeded.length}); off-road metres p50 / p90 / max = ${f0(quantile(withOff.map((c) => c.offroadM), 0.5))} / ${f0(quantile(withOff.map((c) => c.offroadM), 0.9))} / ${f0(max(withOff.map((c) => c.offroadM)))} (seeded max ${f0(max(seededOff.map((c) => c.offroadM)))}). Off-road share of Direct length, all calls: ${f1(100 * routeCalls.reduce((s, c) => s + c.offroadM, 0) / Math.max(1, cands.filter((r) => r.kind === 'route' && r.name === 'Direct').reduce((s, r) => s + r.lengthM, 0)))} %.`);
    md.push(`- Calls whose Direct has a straight gap: ${withGap.length} of ${routeCalls.length}${withGap.length ? ' — ' + withGap.map((c) => `#${c.id}${c.name ? ` "${c.name}"` : ''} ${f0(c.gapM)} m`).join('; ') : ''}.`);
    md.push(`- Pin distance to the nearest usable arc (any), seeded pairs: p50 / p90 / max = ${f0(quantile(seeded.flatMap((c) => c.nearestM), 0.5))} / ${f0(quantile(seeded.flatMap((c) => c.nearestM), 0.9))} / ${f0(max(seeded.flatMap((c) => c.nearestM)))} m; snap distance p90 / max = ${f0(quantile(seeded.flatMap((c) => c.snapM), 0.9))} / ${f0(max(seeded.flatMap((c) => c.snapM)))} m.`);
  }
  md.push('');
  if (wayClass.size) {
    md.push('### Road-class mix (seeded, detour 0.25, metres summed over all candidates of the name)');
    md.push('');
    const classTotals = (name: string) => {
      const t: Record<string, number> = {};
      for (const r of cands) if (r.kind === 'route' && r.id < 500 && r.detour === 0.25 && r.name === name) for (const k in r.classes) t[k] = (t[k] ?? 0) + r.classes[k];
      return t;
    };
    const D = classTotals('Direct'), M = classTotals('Most new');
    const keys = [...new Set([...Object.keys(D), ...Object.keys(M)])].sort((a, b) => (M[b] ?? 0) + (D[b] ?? 0) - (M[a] ?? 0) - (D[a] ?? 0));
    const sumD = Object.values(D).reduce((a, b) => a + b, 0), sumM = Object.values(M).reduce((a, b) => a + b, 0);
    md.push(`- Direct ${f0(sumD / 1000)} km, Most new ${f0(sumM / 1000)} km: ` + keys.slice(0, 12).map((k) => `${k} ${f0(100 * (D[k] ?? 0) / sumD)}→${f0(100 * (M[k] ?? 0) / sumM)} %`).join(', '));
    md.push('');
  }

  md.push('### Named cases (detour 0.25)');
  md.push('');
  md.push('| id | case | straight m | shortest m | budget m | ms | pin→arc m (origin / dest) | candidates: name len (ratio) new% parts [off-road / gap m] | flags | why |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of namedCalls) {
    const rows = cands.filter((r) => r.kind === 'route' && r.id === c.id && r.detour === c.detour);
    md.push(`| ${c.id} | ${c.name} | ${f0(c.straightM)} | ${c.shortestM} | ${c.budgetM} | ${f0(c.ms)} | ${c.nearestM.map((x) => (x < 0 ? '>5 km' : f0(x))).join(' / ')} | ${c.error ? c.error : rows.map((r) => `${r.name} ${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} % ${r.parts} [${f0(r.offroadM)} / ${f0(r.gapM)}]`).join(' · ')} | ${c.flags.join('; ')} | ${c.why ?? ''} |`);
  }
  md.push('');

  md.push('### Loops');
  md.push('');
  {
    const L = cands.filter((r) => r.kind === 'loop'), L1 = L.filter((r) => r.name === 'Most new');
    const ratios = L.map((r) => r.ratio), off = L.map((r) => Math.abs(r.ratio - 1));
    const empty = loopCalls.filter((c) => c.candidates === 0);
    md.push(`${loopCalls.length} requests, ${empty.length} with no loop${empty.length ? ` (${empty.map((c) => `#${c.id}${c.name ? ` ${c.name}` : ''} ${c.targetKm} km`).join(', ')})` : ''}; ${L.length} loops (${L1.length} first picks): length/target p10 / p50 / p90 = ${f2(quantile(ratios, 0.1))} / ${f2(quantile(ratios, 0.5))} / ${f2(quantile(ratios, 0.9))}; |ratio − 1| p50 / p90 = ${f2(quantile(off, 0.5))} / ${f2(quantile(off, 0.9))}; loops at ≥ 1.19 × target: ${L.filter((r) => r.ratio >= 1.19).length} (first picks ${L1.filter((r) => r.ratio >= 1.19).length}); pctNew p50 all / first picks = ${f0(quantile(L.map((r) => r.pctNew), 0.5))} / ${f0(quantile(L1.map((r) => r.pctNew), 0.5))}; coord turns/km p50 / p90 = ${f1(quantile(L.map((r) => r.coordTurnsPerKm), 0.5))} / ${f1(quantile(L.map((r) => r.coordTurnsPerKm), 0.9))}; compactness p50 = ${f2(quantile(L.map((r) => r.compact), 0.5))}; via U-turns: ${L.filter((r) => r.uturns > 0).length} loops; loop ms p50 / p90 / max = ${f0(quantile(loopCalls.map((c) => c.ms), 0.5))} / ${f0(quantile(loopCalls.map((c) => c.ms), 0.9))} / ${f0(max(loopCalls.map((c) => c.ms)))}.`);
    md.push('');
    md.push('| id | seed | target km | near home | loops | ms | per loop: name len (ratio) pctNew twice% compact turns/km via-U-turns endGap | flags |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const c of loopCalls) {
      const rows = cands.filter((r) => r.kind === 'loop' && r.id === c.id);
      md.push(`| ${c.id} | ${c.name ?? (S.loops.find((l) => l.id === c.id)?.legacyMode ? `legacy (${S.loops.find((l) => l.id === c.id)!.legacyMode})` : 'legacy')} | ${c.targetKm} | ${c.nearHome ? 'y' : 'n'} | ${c.candidates} | ${f0(c.ms)} | ${rows.map((r) => `${r.name} ${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} % ${f0(100 * r.twice)} % ${f2(r.compact)} ${f1(r.coordTurnsPerKm)} ${r.uturns} ${f0(r.endGapM)} m${r.violations.length ? ' **' + r.violations.join('; ') + '**' : ''}`).join(' · ') || (c.error ?? '—')} | ${c.flags.join('; ')} |`);
    }
    md.push('');
  }

  md.push('### Every seeded A→B call');
  md.push('');
  md.push('| id | detour | near | straight m | shortest m | budget m | ms | pin→arc m | candidates: name λ len (ratio) new% turns/km parts [off-road m] | share | violations / flags |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of seeded) {
    const rows = cands.filter((r) => r.kind === 'route' && r.id === c.id && r.detour === c.detour);
    md.push(`| ${c.id} | ${c.detour} | ${c.nearHome ? 'y' : 'n'} | ${f0(c.straightM)} | ${c.shortestM} | ${c.budgetM} | ${f0(c.ms)} | ${c.nearestM.map(f0).join(' / ')} | ${c.error ? c.error : rows.map((r) => `${r.name} λ${r.lambda} ${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} % ${f1(r.arcTurnsPerKm)} ${r.parts} [${f0(r.offroadM)}]`).join(' · ')} | ${c.pairShare.map((s) => f0(100 * s)).join('/')} | ${[...c.violations, ...c.flags.filter((f) => !f.startsWith('note:'))].join('; ')} |`);
  }
  md.push('');

  // ---- baseline comparison (NYC, round 2 json) ----
  if (baseline && region === 'nyc') {
    md.push(`### Round-2 comparison (baseline ${BASELINE}; walk, same pairs)`);
    md.push('');
    md.push('| id | detour | Direct len before → now | Direct pct before → now | Most new len (ratio) pct before → now | Balanced before → now | ms before → now |');
    md.push('|---|---|---|---|---|---|---|');
    const bc = (id: number, detour: number, name: string) => baseline.cands.find((r) => r.kind === 'route' && r.mode === 'walk' && r.id === id && r.detour === detour && r.name === name);
    const nc = (id: number, detour: number, name: string) => cands.find((r) => r.kind === 'route' && r.id === id && r.detour === detour && r.name === name);
    const show = (r: { lengthM: number; pctNew: number; ratio: number } | undefined) => (r ? `${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} %` : '—');
    let changedMost = 0, changedDirect = 0, changedBal = 0;
    for (const c of seeded) {
      const bcall = baseline.calls.find((x) => x.kind === 'route' && x.mode === 'walk' && x.id === c.id && x.detour === c.detour);
      const bD = bc(c.id, c.detour, 'Direct'), nD = nc(c.id, c.detour, 'Direct');
      const bM = bc(c.id, c.detour, 'Most new'), nM = nc(c.id, c.detour, 'Most new');
      const bB = bc(c.id, c.detour, 'Balanced'), nB = nc(c.id, c.detour, 'Balanced');
      if ((bM?.lengthM ?? -1) !== (nM?.lengthM ?? -1) || (bM?.pctNew ?? -1) !== (nM?.pctNew ?? -1)) changedMost++;
      if ((bD?.lengthM ?? -1) !== (nD?.lengthM ?? -1) || (bD?.pctNew ?? -1) !== (nD?.pctNew ?? -1)) changedDirect++;
      if ((bB?.lengthM ?? -1) !== (nB?.lengthM ?? -1)) changedBal++;
      md.push(`| ${c.id} | ${c.detour} | ${bD?.lengthM ?? '—'} → ${nD?.lengthM ?? '—'} | ${bD?.pctNew ?? '—'} → ${nD?.pctNew ?? '—'} | ${show(bM)} → ${show(nM)} | ${show(bB)} → ${show(nB)} | ${bcall ? f0(bcall.ms) : '—'} → ${f0(c.ms)} |`);
    }
    md.push('');
    md.push(`Changed vs round 2 (walk): Direct ${changedDirect} of ${seeded.length} calls, Most new ${changedMost}, Balanced ${changedBal}.`);
    md.push('');
    md.push('Legacy loops (ids 1000–1014; round 2 routed 1010–1014 as bike / drive, now all walk):');
    md.push('');
    md.push('| id | target km | mode before | loops before → now | first pick len (ratio) pct before → now |');
    md.push('|---|---|---|---|---|');
    for (const c of loopCalls.filter((x) => x.id < 2000)) {
      const bcall = baseline.calls.find((x) => x.kind === 'loop' && x.id === c.id);
      const bF = baseline.cands.find((r) => r.kind === 'loop' && r.id === c.id && r.name === 'Most new');
      const nF = cands.find((r) => r.kind === 'loop' && r.id === c.id && r.name === 'Most new');
      md.push(`| ${c.id} | ${c.targetKm} | ${bcall?.mode ?? '—'} | ${bcall?.candidates ?? '—'} → ${c.candidates} | ${show(bF)} → ${show(nF)} |`);
    }
    md.push('');
  }

  // ---- renders: named cases, flagged calls, worst cases ----
  interface Worst { key: string; score: number; why: string; row: CandRow; siblings: CandRow[]; pins: LonLat[] }
  const sib = (r: CandRow) => cands.filter((x) => x.kind === r.kind && x.id === r.id && x.detour === r.detour);
  const callOf = (r: CandRow) => calls.find((x) => x.kind === r.kind && x.id === r.id && x.detour === r.detour)!;
  const pinsOf = (r: CandRow) => { const c = callOf(r); return c.to ? [c.from, c.to] : [c.from]; };
  const fileFor = (prefix: string, r: CandRow) => `${TAG}-${region}-${prefix}-${r.kind}${r.id}${r.kind === 'route' ? `-d${r.detour}` : `-${r.targetKm}km`}.png`;
  md.push('### Rendered');
  md.push('');
  md.push('Named cases (every one), flagged calls, then the worst cases by category. Orange = Most new, blue = Balanced, black = Direct (dashed parts are drawn like the rest), light blue = visited streets, green = home, black / red = pins.');
  md.push('');
  const rendered = new Set<string>();
  const renderCall = (label: string, r: CandRow, why: string) => {
    const file = fileFor(label, r);
    if (rendered.has(file)) return;
    rendered.add(file);
    render(join(OUT, file), graph, scorer, visitedArcs, sib(r), pinsOf(r), homes);
    md.push(`- \`${file}\` — #${r.id}${callOf(r).name ? ` "${callOf(r).name}"` : ''}: ${why}`);
  };
  for (const c of namedCalls) {
    const rows = cands.filter((r) => r.kind === 'route' && r.id === c.id && r.detour === c.detour);
    if (rows.length) renderCall('named', rows[0], rows.map((r) => `${r.name} ${r.lengthM} m ${r.pctNew} % ${r.parts}`).join(' · '));
  }
  for (const c of flagged) {
    const rows = cands.filter((r) => r.kind === c.kind && r.id === c.id && r.detour === c.detour);
    if (rows.length) renderCall('flag', rows[0], c.flags.filter((f) => !f.startsWith('note:')).join('; '));
  }
  const worst: Worst[] = [];
  for (const r of cands) {
    if (r.violations.length) worst.push({ key: 'violation', score: 1000, why: r.violations.join('; '), row: r, siblings: sib(r), pins: pinsOf(r) });
  }
  const directOf = (r: CandRow) => sib(r).find((x) => x.name === 'Direct');
  for (const r of cands.filter((r) => r.kind === 'route' && r.name === 'Most new')) {
    const d = directOf(r);
    const dTurns = d ? d.arcTurnsPerKm : 0;
    worst.push({ key: 'stair-step', score: (r.arcTurnsPerKm - dTurns) * 10 + r.sharpPerKm * 30, why: `arc turns/km ${f1(r.arcTurnsPerKm)} vs Direct ${f1(dTurns)}, sharp/km ${f1(r.sharpPerKm)}, +${f0(r.gain)} pct new for ratio ${f2(r.ratio)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
    worst.push({ key: 'steps', score: r.stepsM, why: `steps ${f0(r.stepsM)} m`, row: r, siblings: sib(r), pins: pinsOf(r) });
    worst.push({ key: 'way-revisit', score: r.wayRevisitM / 20 + r.wayRevisits * 3, why: `${r.wayRevisits} ways revisited (${f0(r.wayRevisitM)} m in the shorter runs)`, row: r, siblings: sib(r), pins: pinsOf(r) });
  }
  for (const r of cands.filter((r) => r.kind === 'route' && r.name === 'Direct' && r.id < 500)) {
    worst.push({ key: 'long-leg', score: r.offroadM + r.gapM * 2, why: `off-road ${f0(r.offroadM)} m, gap ${f0(r.gapM)} m (${r.parts})`, row: r, siblings: sib(r), pins: pinsOf(r) });
  }
  for (const r of cands.filter((r) => r.kind === 'loop')) {
    worst.push({ key: 'loop-shape', score: (0.5 - r.compact) * 60 + r.twice * 100 + r.uturns * 15, why: `compactness ${f2(r.compact)}, twice ${f0(100 * r.twice)} %, via U-turns ${r.uturns}, turns/km ${f1(r.coordTurnsPerKm)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
  }
  worst.sort((a, b) => b.score - a.score);
  const picked: Worst[] = [];
  const usedCall = new Set<string>(), usedKey = new Map<string, number>();
  for (const w of worst) {
    const ck = `${w.row.kind}/${w.row.id}/${w.row.detour}`;
    if (usedCall.has(ck) || (usedKey.get(w.key) ?? 0) >= 2) continue;
    usedCall.add(ck); usedKey.set(w.key, (usedKey.get(w.key) ?? 0) + 1);
    picked.push(w);
    if (picked.length >= 6) break;
  }
  picked.forEach((w) => renderCall(`worst-${w.key}`, w.row, w.why));
  for (const [id, what] of RENDER) {
    const row = cands.find((r) => r.id === Number(id) && (what === 'loop' ? r.kind === 'loop' : r.kind === 'route' && r.detour === Number(what.replace(/^d/, ''))));
    if (!row) { md.push(`- render ${id}:${what}: no such call in ${region}`); continue; }
    renderCall('pick', row, sib(row).map((r) => `${r.name} ${r.lengthM} m ${r.pctNew} % ${f1(r.arcTurnsPerKm || r.coordTurnsPerKm)} turns/km`).join(' · '));
  }
  md.push('');
  md.push('Top 12 by category score (not all rendered):');
  md.push('');
  for (const w of worst.slice(0, 12)) md.push(`- ${w.key} ${f1(w.score)}: #${w.row.id} ${w.row.kind} d=${w.row.detour} ${w.row.name} — ${w.why}`);
  md.push('');

  writeFileSync(join(OUT, `sweep-${TAG}-${region}.md`), md.join('\n') + '\n');
  writeFileSync(join(OUT, `sweep-${TAG}-${region}.json`), JSON.stringify({ seed: SEED, region, mode: MODE, pairs, named, loops: S.loops, calls, cands: cands.map((r) => ({ ...r, coords: undefined, arcs: undefined })) }, null, 0));
  log(`wrote ${join(OUT, `sweep-${TAG}-${region}.md`)} (${Math.round(now() - t0)} ms total)`);
}

// ---------------------------------------------------------------------------------------------
// rendering

const COLORS: Record<string, [number, number, number]> = {
  'Most new': [255, 120, 40],
  Balanced: [60, 120, 255],
  Direct: [70, 70, 70],
};

function render(file: string, graph: Graph, scorer: NoveltyScorer, visited: Set<number>, rows: CandRow[], pins: LonLat[], homes: LonLat[]): void {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const r of rows) for (const p of r.coords) { if (p[0] < west) west = p[0]; if (p[0] > east) east = p[0]; if (p[1] < south) south = p[1]; if (p[1] > north) north = p[1]; }
  for (const p of pins) { if (p[0] < west) west = p[0]; if (p[0] > east) east = p[0]; if (p[1] < south) south = p[1]; if (p[1] > north) north = p[1]; }
  const lat0 = (south + north) / 2;
  const kx = 111_320 * Math.cos(lat0 * Math.PI / 180), ky = 110_574;
  const padM = Math.max(250, 0.12 * Math.max((east - west) * kx, (north - south) * ky));
  west -= padM / kx; east += padM / kx; south -= padM / ky; north += padM / ky;
  const wM = (east - west) * kx, hM = (north - south) * ky;
  const W = 1400, H = Math.max(400, Math.min(1400, Math.round((W * hM) / wM)));
  const sx = W / wM, sy = H / hM, s = Math.min(sx, sy);
  const px = (p: LonLat): [number, number] => [(p[0] - west) * kx * s, (north - p[1]) * ky * s];
  const img = new Uint8Array(W * H * 4).fill(255);
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; img[o + 3] = 255;
  };
  const disc = (x: number, y: number, r: number, c: [number, number, number]) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) set(x + dx, y + dy, c);
  };
  const line = (a: [number, number], b: [number, number], w: number, c: [number, number, number]) => {
    let x0 = Math.round(a[0]), y0 = Math.round(a[1]);
    const x1 = Math.round(b[0]), y1 = Math.round(b[1]);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), ix = x0 < x1 ? 1 : -1, iy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const r = Math.max(0, Math.floor(w / 2));
    for (let guard = 0; guard < 100000; guard++) {
      if (r === 0) set(x0, y0, c); else disc(x0, y0, r, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += ix; }
      if (e2 <= dx) { err += dx; y0 += iy; }
    }
  };
  // graph
  const pt: [number, number] = [0, 0];
  for (let a = 0; a < graph.arcCount; a++) {
    if (graph.segmentId(a) !== a) continue;
    const u = graph.arcFrom[a], v = graph.arcTo[a];
    const lonU = graph.nodeLon[u], latU = graph.nodeLat[u], lonV = graph.nodeLon[v], latV = graph.nodeLat[v];
    if ((lonU < west && lonV < west) || (lonU > east && lonV > east) || (latU < south && latV < south) || (latU > north && latV > north)) continue;
    const fl = graph.arcFlags[a];
    const nov = scorer.get(a);
    const c: [number, number, number] = fl & ArcFlag.GLUE ? [238, 238, 238] : visited.has(a) || nov < 0.5 ? [150, 175, 235] : fl & ArcFlag.STEPS ? [200, 160, 200] : [205, 205, 205];
    const n = graph.arcPointCount(a);
    let prev = px(graph.arcPoint(a, 0, pt) as LonLat);
    for (let i = 1; i < n; i++) { const q = px(graph.arcPoint(a, i, pt) as LonLat); line(prev, q, visited.has(a) ? 3 : 1, c); prev = q; }
  }
  // routes: Direct first (under), then Balanced, then Most new on top
  const order = ['Direct', 'Balanced', 'Most new'];
  for (const name of order) for (const r of rows) {
    if (r.name !== name) continue;
    const col = COLORS[name];
    for (let i = 1; i < r.coords.length; i++) line(px(r.coords[i - 1]), px(r.coords[i]), name === 'Most new' ? 5 : 4, col);
  }
  for (const h of homes) { const q = px(h); if (q[0] >= 0 && q[1] >= 0 && q[0] < W && q[1] < H) disc(Math.round(q[0]), Math.round(q[1]), 9, [30, 160, 60]); }
  pins.forEach((p, i) => { const q = px(p); disc(Math.round(q[0]), Math.round(q[1]), 8, i === 0 ? [0, 0, 0] : [200, 0, 0]); });
  // legend: swatches top-left
  let ly = 12;
  for (const name of ['Most new', 'Balanced', 'Direct']) { line([12, ly], [60, ly], 5, COLORS[name]); ly += 12; }
  line([12, ly], [60, ly], 3, [150, 175, 235]); ly += 12; // visited
  // scale bar: 500 m
  const barPx = Math.round(500 * s);
  line([W - 20 - barPx, H - 16], [W - 20, H - 16], 3, [0, 0, 0]);
  writeFileSync(file, encodePng(img, W, H));
}
