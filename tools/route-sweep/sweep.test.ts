/**
 * Route-quality sweep over the prebuilt NYC graph — a report generator, not a unit test. It is a
 * vitest file only so it can import the TypeScript sources; it is a no-op unless ROUTE_SWEEP=1.
 *
 *   ROUTE_SWEEP=1 ROUTE_SWEEP_OUT=/abs/dir ROUTE_SWEEP_TAG=before npx vitest run tools/route-sweep/sweep.test.ts
 *
 * What it does (see the route-quality report for the rationale):
 *   1. builds a realistic visited set around two "homes" (Park Slope, Upper West Side): every
 *      arc within 600 m with probability 0.85·exp(−d/400)+0.1, plus the shortest walks to 15
 *      random nearby destinations; cells sampled every 4 m with 8-neighbour dilation;
 *   2. generates seeded origin→destination pairs (1–8 km straight-line, on-street snaps) and
 *      loops, and routes them through findCandidates / findLoops exactly as RouteEngine does;
 *   3. checks the structural invariants and tables the quality metrics per mode;
 *   4. renders the worst cases to PNG.
 * Outputs: <out>/sweep-<tag>.md (tables), <out>/sweep-<tag>.json (every row), <out>/<tag>-worst-N-*.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { distanceM } from '../../src/grid/cell';
import type { LonLat, RouteCandidate, RouteResult } from '../../src/routing/api';
import {
  NoRouteError, SnapError, TURN_PENALTY_M, findCandidates, now, pathSegments, searchOptions, sharedFraction, snapPair,
} from '../../src/routing/candidates';
import { ArcFlag, type Mode } from '../../src/routing/graph-format';
import { Graph } from '../../src/routing/graph';
import { LOOP_TURN_PENALTY_M, findLoops } from '../../src/routing/loop';
import { NoveltyScorer } from '../../src/routing/novelty';
import type { PathResult } from '../../src/routing/search';
import { encodePng } from '../../tests/fixtures/grid/png';
import { HOMES, MODES, setup, type Pair } from './setup';

const ENABLED = process.env.ROUTE_SWEEP === '1';
const OUT = process.env.ROUTE_SWEEP_OUT ?? new URL('../../test-results/route-sweep', import.meta.url).pathname;
const TAG = process.env.ROUTE_SWEEP_TAG ?? 'run';
const SEED = Number(process.env.ROUTE_SWEEP_SEED ?? 20260902);
const WAY_CACHE = process.env.ROUTE_SWEEP_WAYCACHE ?? join(OUT, 'nyc-way-classes.json');
/** Turn penalty (metres per 90° turn) for every request, all modes; unset = the engine's per-mode default. */
const TURN = process.env.ROUTE_SWEEP_TURN !== undefined ? Number(process.env.ROUTE_SWEEP_TURN) : undefined;
const turnFor = (mode: Mode) => TURN ?? TURN_PENALTY_M[mode];
const loopTurnFor = () => TURN ?? LOOP_TURN_PENALTY_M;
/** Extra calls to render regardless of score, e.g. `20:walk:0.25,1001:walk` (loops: id:mode). */
const RENDER = (process.env.ROUTE_SWEEP_RENDER ?? '').split(',').filter(Boolean).map((s) => s.split(':'));

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

// ---------------------------------------------------------------------------------------------
// rows

interface CandRow {
  kind: 'route' | 'loop';
  id: number;
  mode: Mode;
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
  straightM: number;
  ms: number;
  /** length / shortest */
  ratio: number;
  /** pctNew − Direct's pctNew */
  gain: number;
  arcTurnsPerKm: number;
  sharpPerKm: number;
  coordTurnsPerKm: number;
  stepsM: number;
  dismountM: number;
  dismountRunM: number;
  glueM: number;
  serviceM: number;
  serviceInteriorM: number;
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
  kind: 'route' | 'loop';
  id: number;
  mode: Mode;
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
  pairShare: number[];
  violations: string[];
}

// ---------------------------------------------------------------------------------------------

describe.skipIf(!ENABLED)('route-quality sweep (ROUTE_SWEEP=1)', () => {
  it('sweeps the NYC graph and writes the report', { timeout: 900_000 }, () => {
    mkdirSync(OUT, { recursive: true });
    const log = (s: string) => console.log(`[sweep] ${s}`);
    const t0 = now();
    const S = setup(SEED, WAY_CACHE);
    const { graph, spatial, scorer, searcher, pairs, wayClass } = S;
    const lookup = S.visited.lookup, visitedArcs = S.visited.segments, visitedKm = S.visited.km, tiles = { length: S.tiles };
    for (const l of S.visited.log) log(l);
    log(`graph: ${S.tiles} tiles, ${graph.nodeCount} nodes, ${graph.arcCount} arcs; way classes ${wayClass.size}; setup ${Math.round(now() - t0)} ms`);
    log(`visited: ${visitedArcs.size} segments, ${visitedKm.toFixed(1)} km, ${lookup.size} cells`);
    log(`pairs: ${pairs.length} (${pairs.filter((p) => p.nearHome).length} near a home)`);
    const classOf = (arc: number) => wayClass.get(graph.arcWay[arc]) ?? '?';
    const ctx = { spatial, scorer, searcher };

    // ---- 3. route + analyse ----
    const cands: CandRow[] = [];
    const calls: CallRow[] = [];

    const analyse = (base: Omit<CandRow, 'name' | 'lambda' | 'lengthM' | 'newM' | 'pctNew' | 'ratio' | 'gain' | 'arcTurnsPerKm' | 'sharpPerKm' | 'coordTurnsPerKm' | 'stepsM' | 'dismountM' | 'dismountRunM' | 'glueM' | 'serviceM' | 'serviceInteriorM' | 'classes' | 'wayRevisits' | 'wayRevisitM' | 'coordsN' | 'twice' | 'compact' | 'endGapM' | 'uturns' | 'maxStepM' | 'stepNote' | 'violations' | 'coords' | 'arcs'>, c: RouteCandidate, direct: RouteCandidate | null, arcs: number[] | null, fracs: number[] | null): CandRow => {
      const v: string[] = [];
      const km = c.lengthM / 1000;
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
      const stepNote = maxStepM > 200 ? `step ${f0(maxStepM)} m on ${maxStepClass || 'unknown arc'}` : '';
      if (c.pctNew < 0 || c.pctNew > 100) v.push(`pctNew ${c.pctNew}`);
      if (base.kind === 'route' && c.lengthM > base.budgetM + 1) v.push(`over budget ${c.lengthM} > ${base.budgetM}`);
      if (direct && c !== direct && c.newM < direct.newM) v.push(`newM ${c.newM} < Direct ${direct.newM}`);
      const twice = twiceFraction(c.coords);
      if (base.kind === 'route' && base.mode !== 'drive' && twice > 0) v.push(`segment twice ${f1(100 * twice)} %`);
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
      let stepsM = 0, dismountM = 0, dismountRunM = 0, run = 0, glueM = 0, serviceM = 0, serviceInteriorM = 0;
      const classes: Record<string, number> = {};
      let turns = { turns: 0, sharp: 0 };
      let wayRevisits = 0, wayRevisitM = 0;
      if (arcs && fracs) {
        const segs = pathSegments(graph, arcs);
        if (base.mode !== 'drive' && segs.size !== arcs.length) v.push('arc segment twice');
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
          if (base.mode === 'bike' && (fl & ArcFlag.DISMOUNT)) { dismountM += l; run += l; if (run > dismountRunM) dismountRunM = run; } else run = 0;
          if (cls.startsWith('service')) { serviceM += l; if (i > 0 && i < arcs.length - 1) serviceInteriorM += l; }
          const w = graph.arcWay[a];
          if (w === curWay) curLen += l;
          else { if (curWay >= 0) { const r = runs.get(curWay) ?? []; r.push(curLen); runs.set(curWay, r); } curWay = w; curLen = l; }
        }
        if (curWay >= 0) { const r = runs.get(curWay) ?? []; r.push(curLen); runs.set(curWay, r); }
        for (const r of runs.values()) if (r.length >= 2) { wayRevisits++; wayRevisitM += r.slice().sort((x, y) => x - y)[0]; }
      }
      const straightEnds = endGapM;
      if (base.kind === 'route' && c.name === 'Direct' && c.lengthM < 0.9 * straightEnds) v.push(`Direct ${c.lengthM} < 0.9 × chord ${f0(straightEnds)}`);
      if (base.kind === 'route' && c.name === 'Direct' && c.lengthM < 0.9 * base.straightM - 600) v.push(`Direct ${c.lengthM} < 0.9 × pins ${f0(base.straightM)}`);
      return {
        ...base,
        name: c.name, lambda: c.lambda, lengthM: c.lengthM, newM: c.newM, pctNew: c.pctNew,
        ratio: base.shortestM > 0 ? c.lengthM / base.shortestM : NaN,
        gain: direct ? c.pctNew - direct.pctNew : NaN,
        arcTurnsPerKm: km > 0 ? turns.turns / km : 0, sharpPerKm: km > 0 ? turns.sharp / km : 0,
        coordTurnsPerKm: km > 0 ? coordTurns(c.coords) / km : 0,
        stepsM, dismountM, dismountRunM, glueM, serviceM, serviceInteriorM, classes, wayRevisits, wayRevisitM,
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

    const routePair = (pair: Pair, mode: Mode, detour: number) => {
      const tw = now();
      let res: RouteResult | null = null, error: string | undefined;
      try {
        res = findCandidates(graph, lookup, { from: pair.from, to: pair.to, mode, detour, turnPenaltyM: turnFor(mode) }, ctx);
      } catch (e) {
        error = e instanceof SnapError || e instanceof NoRouteError ? `${e.name}: ${e.message}` : String(e);
      }
      const wallMs = now() - tw;
      const call: CallRow = { kind: 'route', id: pair.id, mode, detour, from: pair.from, to: pair.to, straightM: pair.straightM, nearHome: pair.nearHome, ms: res?.ms ?? wallMs, wallMs, shortestM: res?.shortestM ?? 0, budgetM: res?.budgetM ?? 0, candidates: res?.candidates.length ?? 0, error, pairShare: [], violations: [] };
      calls.push(call);
      if (!res) { call.violations.push(error ?? 'no result'); return; }
      const direct = res.candidates[res.candidates.length - 1];
      if (direct.name !== 'Direct') call.violations.push('Direct not last');
      // reproduce the arcs of every candidate (deterministic search, same options as sweep())
      const [o, d] = snapPair(spatial, pair.from, pair.to, mode);
      const s0 = searcher.run(o, d, searchOptions(mode, 0));
      const budget = s0 ? (1 + detour) * s0.lengthM : 0;
      const rows: CandRow[] = [];
      for (const c of res.candidates) {
        const p = c.lambda === 0 ? s0 : searcher.run(o, d, searchOptions(mode, c.lambda, budget, turnFor(mode)));
        let arcs: number[] | null = null, fracs: number[] | null = null;
        if (p && Math.abs(p.lengthM - c.lengthM) <= 1) { arcs = Array.from(p.arcs); fracs = fracsOf(p); }
        const row = analyse({ kind: 'route', id: pair.id, mode, detour, nearHome: pair.nearHome, shortestM: res.shortestM, budgetM: res.budgetM, straightM: pair.straightM, ms: res.ms }, c, direct, arcs, fracs);
        if (!arcs) row.violations.push('repro mismatch (arcs unavailable)');
        rows.push(row);
        cands.push(row);
      }
      // pairwise sharing
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        if (!rows[i].arcs || !rows[j].arcs) continue;
        const sh = sharedFraction(pathSegments(graph, rows[i].arcs!), pathSegments(graph, rows[j].arcs!));
        call.pairShare.push(sh);
        if (sh > 0.6) call.violations.push(`${rows[i].name}/${rows[j].name} share ${f0(100 * sh)} %`);
      }
      for (const r of rows) for (const x of r.violations) call.violations.push(`${r.name}: ${x}`);
    };

    for (const pair of pairs.slice(0, 40)) for (const mode of MODES) routePair(pair, mode, 0.25);
    for (const pair of pairs.slice(40, 50)) for (const mode of MODES) for (const detour of [0.1, 0.5]) routePair(pair, mode, detour);
    log(`routes: ${calls.length} calls, ${cands.length} candidates`);

    // ---- loops ----
    for (const spec of S.loops) {
      const { id: lid, from } = spec;
      const tw = now();
      let res: RouteResult | null = null, error: string | undefined;
      try { res = findLoops(graph, lookup, { from, mode: spec.mode, targetKm: spec.targetKm, turnPenaltyM: loopTurnFor() }, ctx); } catch (e) { error = String(e); }
      const wallMs = now() - tw;
      const call: CallRow = { kind: 'loop', id: lid, mode: spec.mode, detour: 0, targetKm: spec.targetKm, from, straightM: 0, nearHome: spec.nearHome, ms: res?.ms ?? wallMs, wallMs, shortestM: spec.targetKm * 1000, budgetM: res?.budgetM ?? 0, candidates: res?.candidates.length ?? 0, error, pairShare: [], violations: [] };
      calls.push(call);
      if (res) {
        if (res.candidates.length === 0) call.violations.push('no loop found');
        for (const c of res.candidates) {
          const row = analyse({ kind: 'loop', id: lid, mode: spec.mode, detour: 0, targetKm: spec.targetKm, nearHome: spec.nearHome, shortestM: spec.targetKm * 1000, budgetM: res.budgetM, straightM: 0, ms: res.ms }, c, null, null, null);
          const T = spec.targetKm * 1000;
          if (row.endGapM > 30) row.violations.push(`loop end gap ${f0(row.endGapM)} m`);
          if (c.lengthM < 0.75 * T || c.lengthM > 1.25 * T) row.violations.push(`loop length ${c.lengthM} outside ±25 % of ${T}`);
          if (distanceM(c.coords[0][0], c.coords[0][1], from[0], from[1]) > 300) row.violations.push('loop start > 300 m from pin');
          row.ratio = c.lengthM / T;
          cands.push(row);
          for (const x of row.violations) call.violations.push(`${c.name}: ${x}`);
        }
      } else call.violations.push(error ?? 'no result');
    }
    log(`loops done; total ${calls.length} calls`);

    // ---- 4. tables ----
    const md: string[] = [];
    md.push(`## Sweep \`${TAG}\` — seed ${SEED}, ${pairs.length} pairs, ${calls.length} calls, ${cands.length} candidates`);
    md.push('');
    md.push(`Turn penalty (m per 90° turn): ${MODES.map((m) => `${m} ${turnFor(m)}`).join(', ')}, loops ${loopTurnFor()}${TURN !== undefined ? ' (ROUTE_SWEEP_TURN override)' : ' (engine defaults)'}.`);
    md.push('');
    md.push(`Graph: ${tiles.length} tiles, ${graph.nodeCount} nodes, ${graph.arcCount} arcs. Visited set: ${visitedArcs.size} segments / ${visitedKm.toFixed(1)} km around ${HOMES.map((h) => h.name).join(' + ')} (${lookup.size} cells).`);
    md.push('');
    const errs = calls.filter((c) => c.error);
    md.push(`Calls with an error: ${errs.length}${errs.length ? ' — ' + errs.map((c) => `#${c.id} ${c.mode} ${c.error}`).join('; ') : ''}`);
    const viol = calls.filter((c) => c.violations.length);
    md.push(`Calls with an invariant violation: ${viol.length}${viol.length ? '\n' + viol.map((c) => `- #${c.id} ${c.kind} ${c.mode} d=${c.detour}: ${c.violations.join('; ')}`).join('\n') : ''}`);
    md.push('');
    const longSteps = cands.filter((r) => r.maxStepM > 200);
    md.push(`Candidates with a coordinate step > 200 m (straight arcs, not holes): ${longSteps.length}; longest: ${longSteps.sort((a, b) => b.maxStepM - a.maxStepM).slice(0, 6).map((r) => `#${r.id} ${r.mode} ${r.name}: ${r.stepNote}`).join('; ')}`);
    md.push('');
    md.push('### Per-mode distributions (A→B, all detours)');
    md.push('');
    md.push('| mode | detour | calls | with Most new | Balanced | len ratio Most new p50 / p90 | pctNew Direct p50 | pctNew gain Most new p50 / p90 | gain Balanced p50 | arc turns/km Direct p50 | Most new p50 / p90 | Balanced p50 | ms p50 / p90 / max |');
    md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const mode of MODES) for (const detour of [0.1, 0.25, 0.5]) {
      const cs = calls.filter((c) => c.kind === 'route' && c.mode === mode && c.detour === detour && !c.error);
      if (!cs.length) continue;
      const most = cands.filter((r) => r.kind === 'route' && r.mode === mode && r.detour === detour && r.name === 'Most new');
      const bal = cands.filter((r) => r.kind === 'route' && r.mode === mode && r.detour === detour && r.name === 'Balanced');
      const dir = cands.filter((r) => r.kind === 'route' && r.mode === mode && r.detour === detour && r.name === 'Direct');
      md.push(`| ${mode} | ${detour} | ${cs.length} | ${most.length} | ${bal.length} | ${f2(quantile(most.map((r) => r.ratio), 0.5))} / ${f2(quantile(most.map((r) => r.ratio), 0.9))} | ${f0(quantile(dir.map((r) => r.pctNew), 0.5))} | ${f0(quantile(most.map((r) => r.gain), 0.5))} / ${f0(quantile(most.map((r) => r.gain), 0.9))} | ${f0(quantile(bal.map((r) => r.gain), 0.5))} | ${f1(quantile(dir.map((r) => r.arcTurnsPerKm), 0.5))} | ${f1(quantile(most.map((r) => r.arcTurnsPerKm), 0.5))} / ${f1(quantile(most.map((r) => r.arcTurnsPerKm), 0.9))} | ${f1(quantile(bal.map((r) => r.arcTurnsPerKm), 0.5))} | ${f0(quantile(cs.map((c) => c.ms), 0.5))} / ${f0(quantile(cs.map((c) => c.ms), 0.9))} / ${f0(Math.max(...cs.map((c) => c.ms)))} |`);
    }
    md.push('');
    md.push('### Quality metrics per mode (A→B, detour 0.25; Most new vs Direct)');
    md.push('');
    md.push('| mode | metric | Direct p50 / p90 / max | Most new p50 / p90 / max | Balanced p50 / p90 / max |');
    md.push('|---|---|---|---|---|');
    const q3 = (rows: CandRow[], f: (r: CandRow) => number) => `${f1(quantile(rows.map(f), 0.5))} / ${f1(quantile(rows.map(f), 0.9))} / ${f1(rows.length ? Math.max(...rows.map(f)) : NaN)}`;
    for (const mode of MODES) {
      const sel = (name: string) => cands.filter((r) => r.kind === 'route' && r.mode === mode && r.detour === 0.25 && r.name === name);
      const D = sel('Direct'), M = sel('Most new'), B = sel('Balanced');
      const metrics: Array<[string, (r: CandRow) => number]> = [
        ['arc turns / km', (r) => r.arcTurnsPerKm],
        ['sharp (>135°) / km', (r) => r.sharpPerKm],
        ['coord turns / km', (r) => r.coordTurnsPerKm],
        ['steps m', (r) => r.stepsM],
        ['glue m', (r) => r.glueM],
        ['way revisits (same way, ≥2 runs)', (r) => r.wayRevisits],
        ['way revisit m (shorter run)', (r) => r.wayRevisitM],
      ];
      if (mode === 'bike') metrics.push(['dismount m', (r) => r.dismountM], ['longest dismount run m', (r) => r.dismountRunM]);
      if (mode === 'drive') metrics.push(['service m', (r) => r.serviceM], ['service m (interior)', (r) => r.serviceInteriorM]);
      for (const [label, f] of metrics) md.push(`| ${mode} | ${label} | ${q3(D, f)} | ${q3(M, f)} | ${q3(B, f)} |`);
    }
    md.push('');
    md.push('### Road-class mix (detour 0.25, metres summed over all candidates of the name)');
    md.push('');
    const classTotals = (mode: Mode, name: string) => {
      const t: Record<string, number> = {};
      for (const r of cands) if (r.kind === 'route' && r.mode === mode && r.detour === 0.25 && r.name === name) for (const k in r.classes) t[k] = (t[k] ?? 0) + r.classes[k];
      return t;
    };
    for (const mode of MODES) {
      const D = classTotals(mode, 'Direct'), M = classTotals(mode, 'Most new');
      const keys = [...new Set([...Object.keys(D), ...Object.keys(M)])].sort((a, b) => (M[b] ?? 0) + (D[b] ?? 0) - (M[a] ?? 0) - (D[a] ?? 0));
      const sumD = Object.values(D).reduce((a, b) => a + b, 0), sumM = Object.values(M).reduce((a, b) => a + b, 0);
      md.push(`- **${mode}** (Direct ${f0(sumD / 1000)} km, Most new ${f0(sumM / 1000)} km): ` + keys.slice(0, 12).map((k) => `${k} ${f0(100 * (D[k] ?? 0) / sumD)}→${f0(100 * (M[k] ?? 0) / sumM)} %`).join(', '));
    }
    md.push('');
    md.push('### Loops');
    md.push('');
    {
      const L = cands.filter((r) => r.kind === 'loop'), L1 = L.filter((r) => r.name === 'Most new');
      const ratios = L.map((r) => r.ratio), off = L.map((r) => Math.abs(r.ratio - 1));
      md.push(`Distribution over ${L.length} loops (${L1.length} first picks): length/target p10 / p50 / p90 = ${f2(quantile(ratios, 0.1))} / ${f2(quantile(ratios, 0.5))} / ${f2(quantile(ratios, 0.9))}; |ratio − 1| p50 / p90 = ${f2(quantile(off, 0.5))} / ${f2(quantile(off, 0.9))}; loops at ≥ 1.19 × target: ${L.filter((r) => r.ratio >= 1.19).length} (first picks ${L1.filter((r) => r.ratio >= 1.19).length}); pctNew p50 all / first picks = ${f0(quantile(L.map((r) => r.pctNew), 0.5))} / ${f0(quantile(L1.map((r) => r.pctNew), 0.5))}; coord turns/km p50 / p90 = ${f1(quantile(L.map((r) => r.coordTurnsPerKm), 0.5))} / ${f1(quantile(L.map((r) => r.coordTurnsPerKm), 0.9))}; compactness p50 = ${f2(quantile(L.map((r) => r.compact), 0.5))}; loop ms p50 / max = ${f0(quantile(calls.filter((c) => c.kind === 'loop').map((c) => c.ms), 0.5))} / ${f0(Math.max(...calls.filter((c) => c.kind === 'loop').map((c) => c.ms)))}.`);
      md.push('');
    }
    md.push('| id | mode | target km | near home | loops | ms | per loop: name len (ratio) pctNew twice% compact turns/km via-U-turns endGap |');
    md.push('|---|---|---|---|---|---|---|');
    for (const c of calls.filter((c) => c.kind === 'loop')) {
      const rows = cands.filter((r) => r.kind === 'loop' && r.id === c.id);
      md.push(`| ${c.id} | ${c.mode} | ${c.targetKm} | ${c.nearHome ? 'y' : 'n'} | ${c.candidates} | ${f0(c.ms)} | ${rows.map((r) => `${r.name} ${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} % ${f0(100 * r.twice)} % ${f2(r.compact)} ${f1(r.coordTurnsPerKm)} ${r.uturns} ${f0(r.endGapM)} m${r.violations.length ? ' **' + r.violations.join('; ') + '**' : ''}`).join(' · ') || (c.error ?? '—')} |`);
    }
    md.push('');
    md.push('### Every A→B call');
    md.push('');
    md.push('| id | mode | detour | near | straight m | shortest m | budget m | ms | candidates: name λ len (ratio) new% turns/km [steps/dismount/service m] | share | violations |');
    md.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of calls.filter((c) => c.kind === 'route')) {
      const rows = cands.filter((r) => r.kind === 'route' && r.id === c.id && r.mode === c.mode && r.detour === c.detour);
      md.push(`| ${c.id} | ${c.mode} | ${c.detour} | ${c.nearHome ? 'y' : 'n'} | ${f0(c.straightM)} | ${c.shortestM} | ${c.budgetM} | ${f0(c.ms)} | ${c.error ? c.error : rows.map((r) => `${r.name} λ${r.lambda} ${r.lengthM} (${f2(r.ratio)}) ${r.pctNew} % ${f1(r.arcTurnsPerKm)} [${f0(r.stepsM)}/${f0(r.dismountM)}/${f0(r.serviceInteriorM)}]`).join(' · ')} | ${c.pairShare.map((s) => f0(100 * s)).join('/')} | ${c.violations.join('; ')} |`);
    }
    md.push('');

    // ---- worst cases ----
    interface Worst { key: string; score: number; why: string; row: CandRow; siblings: CandRow[]; pins: LonLat[] }
    const worst: Worst[] = [];
    const sib = (r: CandRow) => cands.filter((x) => x.kind === r.kind && x.id === r.id && x.mode === r.mode && x.detour === r.detour);
    const pinsOf = (r: CandRow) => { const c = calls.find((x) => x.kind === r.kind && x.id === r.id && x.mode === r.mode && x.detour === r.detour)!; return c.to ? [c.from, c.to] : [c.from]; };
    for (const r of cands) {
      if (r.violations.length) worst.push({ key: 'violation', score: 1000, why: r.violations.join('; '), row: r, siblings: sib(r), pins: pinsOf(r) });
    }
    const directOf = (r: CandRow) => sib(r).find((x) => x.name === 'Direct');
    for (const r of cands.filter((r) => r.kind === 'route' && r.name === 'Most new')) {
      const d = directOf(r);
      const dTurns = d ? d.arcTurnsPerKm : 0;
      if (r.mode === 'walk' || r.mode === 'bike') worst.push({ key: 'stair-step', score: (r.arcTurnsPerKm - dTurns) * 10 + r.sharpPerKm * 30, why: `arc turns/km ${f1(r.arcTurnsPerKm)} vs Direct ${f1(dTurns)}, sharp/km ${f1(r.sharpPerKm)}, +${f0(r.gain)} pct new for ratio ${f2(r.ratio)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
      if (r.mode === 'bike') worst.push({ key: 'dismount', score: r.dismountRunM / 10 + r.stepsM, why: `dismount ${f0(r.dismountM)} m (longest run ${f0(r.dismountRunM)} m), steps ${f0(r.stepsM)} m`, row: r, siblings: sib(r), pins: pinsOf(r) });
      if (r.mode === 'walk') worst.push({ key: 'steps', score: r.stepsM, why: `steps ${f0(r.stepsM)} m`, row: r, siblings: sib(r), pins: pinsOf(r) });
      if (r.mode === 'drive') worst.push({ key: 'service', score: r.serviceInteriorM / 10 + r.sharpPerKm * 30, why: `interior service ${f0(r.serviceInteriorM)} m (Direct ${f0(d?.serviceInteriorM ?? 0)}), sharp/km ${f1(r.sharpPerKm)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
      worst.push({ key: 'way-revisit', score: r.wayRevisitM / 20 + r.wayRevisits * 3, why: `${r.wayRevisits} ways revisited (${f0(r.wayRevisitM)} m in the shorter runs)`, row: r, siblings: sib(r), pins: pinsOf(r) });
    }
    for (const r of cands.filter((r) => r.kind === 'route' && r.name === 'Direct')) {
      if (r.mode === 'drive') worst.push({ key: 'service-direct', score: r.serviceInteriorM / 10 + r.sharpPerKm * 30, why: `Direct interior service ${f0(r.serviceInteriorM)} m, sharp/km ${f1(r.sharpPerKm)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
    }
    for (const r of cands.filter((r) => r.kind === 'loop')) {
      worst.push({ key: 'loop-shape', score: (0.5 - r.compact) * 60 + r.twice * 100 + r.uturns * 15, why: `compactness ${f2(r.compact)}, twice ${f0(100 * r.twice)} %, via U-turns ${r.uturns}, turns/km ${f1(r.coordTurnsPerKm)}`, row: r, siblings: sib(r), pins: pinsOf(r) });
    }
    worst.sort((a, b) => b.score - a.score);
    // one per (key) at most twice, distinct call
    const picked: Worst[] = [];
    const usedCall = new Set<string>(), usedKey = new Map<string, number>();
    for (const w of worst) {
      const ck = `${w.row.kind}/${w.row.id}/${w.row.mode}/${w.row.detour}`;
      if (usedCall.has(ck) || (usedKey.get(w.key) ?? 0) >= 2) continue;
      usedCall.add(ck); usedKey.set(w.key, (usedKey.get(w.key) ?? 0) + 1);
      picked.push(w);
      if (picked.length >= 6) break;
    }
    md.push('### Worst cases (rendered)');
    md.push('');
    md.push('| # | file | kind | call | why |');
    md.push('|---|---|---|---|---|');
    picked.forEach((w, i) => {
      const file = `${TAG}-worst-${i + 1}-${w.key}-${w.row.kind}${w.row.id}-${w.row.mode}.png`;
      render(join(OUT, file), graph, scorer, visitedArcs, w.siblings, w.pins, HOMES.map((h) => h.p));
      md.push(`| ${i + 1} | ${file} | ${w.key} | #${w.row.id} ${w.row.kind} ${w.row.mode} d=${w.row.detour}${w.row.targetKm ? ` ${w.row.targetKm} km` : ''} | ${w.why} |`);
    });
    md.push('');
    for (const [id, mode, detour] of RENDER) {
      const row = cands.find((r) => r.id === Number(id) && r.mode === mode && (detour === undefined ? r.kind === 'loop' : r.detour === Number(detour)));
      if (!row) { md.push(`- render ${id}:${mode}:${detour ?? 'loop'}: no such call`); continue; }
      const file = `${TAG}-pick-${row.kind}${row.id}-${row.mode}${row.kind === 'route' ? `-d${row.detour}` : ''}.png`;
      render(join(OUT, file), graph, scorer, visitedArcs, sib(row), pinsOf(row), HOMES.map((h) => h.p));
      md.push(`- rendered ${file}: ${sib(row).map((r) => `${r.name} ${r.lengthM} m ${r.pctNew} % ${f1(r.arcTurnsPerKm || r.coordTurnsPerKm)} turns/km`).join(' · ')}`);
    }
    md.push('');
    md.push('Top 15 by category score (not all rendered):');
    md.push('');
    for (const w of worst.slice(0, 15)) md.push(`- ${w.key} ${f1(w.score)}: #${w.row.id} ${w.row.kind} ${w.row.mode} d=${w.row.detour} ${w.row.name} — ${w.why}`);
    md.push('');

    writeFileSync(join(OUT, `sweep-${TAG}.md`), md.join('\n') + '\n');
    writeFileSync(join(OUT, `sweep-${TAG}.json`), JSON.stringify({ seed: SEED, pairs, calls, cands: cands.map((r) => ({ ...r, coords: undefined, arcs: undefined })) }, null, 0));
    log(`wrote ${join(OUT, `sweep-${TAG}.md`)} (${Math.round(now() - t0)} ms total)`);
  });
});

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
