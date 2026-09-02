import { beforeAll, describe, expect, it } from 'vitest';
import { cellsAlong } from '../grid/cell';
import { ALL_MODES, makeLattice, type Lattice } from '../../tests/fixtures/routing/lattice';
import { buildTestTiles, type TestWay } from '../../tests/fixtures/routing/tile-builder';
import { ArcFlag, encodeGraphTile, decodeGraphTile, type GraphTile } from './graph-format';
import { Graph } from './graph';
import { MapCellLookup } from './cells';
import { NoveltyScorer } from './novelty';
import { Searcher, TURN_MIN_DEG, hasImmediateUTurn } from './search';
import { LAMBDA_SWEEP, MIN_GAIN_M, TURN_PENALTY_M, findCandidates, selectAlternatives, snapPoint, sweep, type ScoredPath } from './candidates';
import { SpatialIndex } from './spatial';
import { LOOP_MIN_COMPACTNESS, LOOP_RADIUS_FACTOR, compactness, findLoops, loopCoords, loopPct, offsetPoint, rankLoops, routeLoop } from './loop';

let lattice: Lattice;
let tiles: GraphTile[];
let graph: Graph;
let lookup: MapCellLookup;
let scorer: NoveltyScorer;
let searcher: Searcher;
let spatial: SpatialIndex;
const ROW = 15;

const midpoint = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Heading changes > TURN_MIN_DEG at the joints of a path, skipping a zero-length partial arc at either end. */
function arcTurns(arcs: ArrayLike<number>): number {
  const bearing = (i: number, j: number) => Math.atan2((graph.nodeLon[j] - graph.nodeLon[i]) * Math.cos(graph.nodeLat[i] * Math.PI / 180), graph.nodeLat[j] - graph.nodeLat[i]);
  let turns = 0;
  for (let i = 1; i < arcs.length; i++) {
    const a = arcs[i - 1], b = arcs[i];
    let d = Math.abs(bearing(graph.arcFrom[b], graph.arcTo[b]) - bearing(graph.arcFrom[a], graph.arcTo[a]));
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d * 180 / Math.PI > TURN_MIN_DEG) turns++;
  }
  return turns;
}

beforeAll(() => {
  lattice = makeLattice({ size: 30, spacingM: 100 });
  tiles = [...lattice.tiles.values()].map((t) => decodeGraphTile(encodeGraphTile(t)));
  graph = new Graph(tiles);
  lookup = new MapCellLookup();
  // Visited stripe: the whole of row 15 (the direct west→east route), 3 cells wide.
  const line = [] as Array<[number, number]>;
  for (let c = 0; c < lattice.size; c++) line.push(lattice.at(c, ROW));
  for (const [cx, cy] of cellsAlong(line, { stepM: 3 })) lookup.mark(cx, cy, 1, 1);
  scorer = new NoveltyScorer(graph, lookup);
  searcher = new Searcher(graph, scorer);
  spatial = new SpatialIndex(graph);
});

describe('lattice across a tile boundary', () => {
  it('merges tiles and dedupes foreign nodes', () => {
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    const foreign = tiles.reduce((s, t) => s + t.nodeFlags.reduce((a, f) => a + (f & 1), 0), 0);
    expect(foreign).toBeGreaterThan(0);
    expect(graph.nodeCount).toBe(30 * 30);
    expect(graph.arcCount).toBe(2 * 2 * 30 * 29);
    for (let a = 0; a < graph.arcCount; a++) expect(graph.arcReverse[a]).toBeGreaterThanOrEqual(0);
  });

  it('shortest path is the visited row; the λ sweep finds a longer, newer route within budget', () => {
    const from = lattice.at(0, ROW), to = lattice.at(29, ROW);
    const res = findCandidates(graph, lookup, { from, to, mode: 'walk', detour: 0.25 }, { spatial, scorer, searcher });
    expect(res.shortestM).toBe(2900);
    expect(res.budgetM).toBe(Math.round(2900 * 1.25));
    const direct = res.candidates[res.candidates.length - 1];
    expect(direct.name).toBe('Direct');
    expect(direct.lengthM).toBe(2900);
    expect(direct.newM).toBeLessThan(100);
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    const most = res.candidates[0];
    expect(most.name).toBe('Most new');
    expect(most.lengthM).toBeLessThanOrEqual(res.budgetM);
    expect(most.lengthM).toBeGreaterThanOrEqual(3100);
    expect(most.newM).toBeGreaterThan(direct.newM + 2000);
    expect(most.pctNew).toBeGreaterThan(90);
    expect(most.coords[0][0]).toBeCloseTo(from[0], 6);
    expect(most.coords[most.coords.length - 1][0]).toBeCloseTo(to[0], 6);
    expect(most.etaMin).toBe(Math.round((most.lengthM / 1000 / 4.8) * 60));
    if (res.candidates.length === 3) expect(res.candidates[1].name).toBe('Balanced');
  });

  it('λ monotonicity: length never decreases and visited metres never increase as λ grows (no pruning)', () => {
    const o = snapPoint(spatial, lattice.at(0, ROW), 'walk', 'origin');
    const d = snapPoint(spatial, lattice.at(29, ROW), 'walk', 'destination');
    let prevLen = -Infinity, prevVisited = Infinity;
    for (const lambda of [0, ...LAMBDA_SWEEP]) {
      const r = searcher.run(o, d, { lambda, mode: 'walk' })!;
      expect(r).not.toBeNull();
      const visited = r.lengthM - r.newM;
      expect(r.lengthM).toBeGreaterThanOrEqual(prevLen - 1e-6);
      expect(visited).toBeLessThanOrEqual(prevVisited + 1e-6);
      expect(hasImmediateUTurn(graph, r.arcs)).toBe(false);
      prevLen = r.lengthM; prevVisited = visited;
    }
  });

  it('ellipse pruning never changes the λ=0 result and is deterministic', () => {
    const pairs: Array<[[number, number], [number, number]]> = [
      [lattice.at(0, ROW), lattice.at(29, ROW)],
      [lattice.at(3, 2), lattice.at(27, 26)],
      [lattice.at(10, 20), lattice.at(11, 5)],
    ];
    for (const [a, b] of pairs) {
      const o = snapPoint(spatial, a, 'walk', 'origin'), d = snapPoint(spatial, b, 'walk', 'destination');
      const free = searcher.run(o, d, { lambda: 0, mode: 'walk' })!;
      const pruned = searcher.run(o, d, { lambda: 0, mode: 'walk', budget: free.lengthM * 1.25 })!;
      const again = searcher.run(o, d, { lambda: 0, mode: 'walk', budget: free.lengthM * 1.25 })!;
      expect(Array.from(pruned.arcs)).toEqual(Array.from(free.arcs));
      expect(Array.from(again.arcs)).toEqual(Array.from(pruned.arcs));
      expect(pruned.settled).toBeLessThanOrEqual(free.settled);
    }
  });

  it('sweep stops early when λ overshoots the budget twice and keeps only feasible paths', () => {
    const o = snapPoint(spatial, lattice.at(0, ROW), 'walk', 'origin');
    const d = snapPoint(spatial, lattice.at(29, ROW), 'walk', 'destination');
    const sw = sweep(searcher, o, d, 'walk', 0.05)!; // tight budget: 3045 m — the 3100 m detour is out
    expect(sw.shortest.lengthM).toBeCloseTo(2900, 1);
    for (const f of sw.feasible) expect(f.lengthM).toBeLessThanOrEqual(sw.budgetM + 0.5);
    expect(sw.searches).toBeLessThan(1 + LAMBDA_SWEEP.length);
  });

  it('"Balanced" is the distinct alternative with the best new metres per extra metre, not the runner-up by new metres (review F5)', () => {
    const sp = (lengthM: number, newM: number, segs: number[], lambda = 1): ScoredPath =>
      ({ arcs: Uint32Array.from(segs), lengthM, newM, cost: 0, startFrac: 0, endFrac: 1, settled: 0, lambda, segments: new Set(segs) });
    const direct = sp(1000, 0, [1, 2, 3, 4, 5], 0);
    const most = sp(1250, 900, [11, 12, 13, 14, 15]);
    const nearClone = sp(1240, 850, [21, 22, 23, 24, 25]); // nearly as long, less new: a poor third option
    const cheap = sp(1010, 400, [31, 32, 33, 34, 35]); // 400 new metres for 10 extra metres
    const dup = sp(1230, 880, [11, 12, 13, 14, 45]); // shares 80 % with Most new
    const feasible = [most, dup, nearClone, cheap]; // ranked by new metres, as sweep() returns them
    expect(selectAlternatives(direct, feasible, 1)).toEqual([most]);
    expect(selectAlternatives(direct, feasible, 2)).toEqual([most, cheap]);
    expect(selectAlternatives(direct, feasible, 3)).toEqual([most, cheap, nearClone]);
    expect(selectAlternatives(direct, [sp(1100, 0, [51, 52])], 2)).toEqual([]); // nothing beats Direct
    // A pick must add a margin of new road (max(MIN_GAIN_M, 1 %)): a route "newer" by a few metres
    // only because it is a few metres longer (a turn-penalised path in a never-visited area) is not
    // an alternative. Direct 4,000 m all new; +40 m new is under the 50 m floor, +60 m over it.
    const allNew = sp(4000, 4000, [1, 2, 3, 4, 5], 0);
    expect(selectAlternatives(allNew, [sp(4060, 4040, [61, 62, 63, 64, 65])], 2)).toEqual([]);
    expect(selectAlternatives(allNew, [sp(4060, 4000 + MIN_GAIN_M, [61, 62, 63, 64, 65])], 2)).toHaveLength(1);
    // Direct 20 km: the 1 % rule (200 m) governs, not the 50 m floor.
    const far = sp(20_000, 15_000, [1, 2, 3, 4, 5], 0);
    expect(selectAlternatives(far, [sp(20_100, 15_150, [61, 62, 63, 64, 65])], 2)).toEqual([]);
    expect(selectAlternatives(far, [sp(20_100, 15_200, [61, 62, 63, 64, 65])], 2)).toHaveLength(1);
  });

  // Route-quality sweep (NYC): walk "Most new" made 2.3 turns/km (p50) / 4.5 (p90) against Direct's
  // 1.9 — combs through the visited blocks (#20: 4.9 vs 1.8). The turn penalty is a new cost term
  // on a new (arc-labelled) search core; nothing covered turn costs before.
  it('turn penalty: admissible and exact — never over the ellipse, never shorter than the shortest path, cost = arcs + turns, and the node-labelled optimum when the penalty vanishes', () => {
    const pairs: Array<[[number, number], [number, number]]> = [
      [lattice.at(0, ROW), lattice.at(29, ROW)],
      [lattice.at(3, 2), lattice.at(27, 26)],
      [lattice.at(10, 20), lattice.at(11, 5)],
      [lattice.at(2, 14), lattice.at(27, 16)],
    ];
    const recomputed = (r: { arcs: Uint32Array; startFrac: number; endFrac: number }, lambda: number, K: number) => {
      let c = 0;
      for (let i = 0; i < r.arcs.length; i++) {
        const frac = r.arcs.length === 1 ? r.endFrac - r.startFrac : i === 0 ? 1 - r.startFrac : i === r.arcs.length - 1 ? r.endFrac : 1;
        c += searcher.arcCost(r.arcs[i], lambda, 'walk', null, 5) * frac;
        if (i > 0) c += searcher.turnCost(r.arcs[i - 1], r.arcs[i], K);
      }
      return c;
    };
    for (const [a, b] of pairs) {
      const o = snapPoint(spatial, a, 'walk', 'origin'), d = snapPoint(spatial, b, 'walk', 'destination');
      const free = searcher.run(o, d, { lambda: 0, mode: 'walk' })!;
      const budget = free.lengthM * 1.25;
      for (const lambda of [0.35, 1, 3, 9]) {
        const node = searcher.run(o, d, { lambda, mode: 'walk', budget })!;
        // K → 0: the arc-labelled search must find the node-labelled optimum (exactness both ways).
        const eps = searcher.run(o, d, { lambda, mode: 'walk', budget, turnPenaltyM: 1e-6 })!;
        expect(eps.cost).toBeGreaterThanOrEqual(node.cost - 1e-6);
        expect(eps.cost).toBeLessThanOrEqual(node.cost + 1e-6 * 1.5 * node.arcs.length);
        for (const K of [TURN_PENALTY_M.walk, 20, 40]) {
          const r = searcher.run(o, d, { lambda, mode: 'walk', budget, turnPenaltyM: K })!;
          expect(r).not.toBeNull();
          expect(r.lengthM).toBeGreaterThanOrEqual(free.lengthM - 1e-6);
          expect(r.lengthM).toBeLessThanOrEqual(budget * 1.05 + 1e-6);
          expect(r.cost).toBeGreaterThanOrEqual(r.lengthM - 1e-6); // admissible: the heuristic is a length lower bound
          expect(r.cost).toBeCloseTo(recomputed(r, lambda, K), 6);
          expect(hasImmediateUTurn(graph, r.arcs)).toBe(false);
        }
      }
      // sweep(): Direct is the plain shortest path, the alternatives stay within the budget.
      const sw = sweep(searcher, o, d, 'walk', 0.25)!;
      expect(sw.shortest.lengthM).toBe(free.lengthM);
      expect(Array.from(sw.shortest.arcs)).toEqual(Array.from(free.arcs));
      for (const f of sw.feasible) expect(f.lengthM).toBeLessThanOrEqual(sw.budgetM + 0.5);
    }
    // Straight through is free, a right angle costs the penalty, a hairpin 1.5 × it.
    const east = spatial.nearestArc(...midpoint(lattice.at(10, 10), lattice.at(11, 10)), ArcFlag.WALK)!.arc;
    const eastOn = graph.nodeLon[graph.arcTo[east]] > graph.nodeLon[graph.arcFrom[east]] ? east : graph.arcReverse[east];
    const n1110 = graph.arcTo[eastOn];
    let straight = -1, right = -1, back = -1;
    for (let x = graph.arcStart[n1110]; x < graph.arcStart[n1110 + 1]; x++) {
      const to = graph.arcTo[x];
      if (graph.nodeLon[to] > graph.nodeLon[n1110]) straight = x;
      else if (graph.nodeLon[to] < graph.nodeLon[n1110]) back = x;
      else if (graph.nodeLat[to] < graph.nodeLat[n1110]) right = x;
    }
    expect(searcher.turnCost(eastOn, straight, 12)).toBe(0);
    expect(searcher.turnCost(eastOn, right, 12)).toBeCloseTo(12, 6);
    expect(searcher.turnCost(eastOn, back, 12)).toBeCloseTo(18, 6);
    expect(TURN_MIN_DEG).toBeGreaterThan(30); // a kink stays free
  });

  it('turn penalty prefers the straight route over the comb at equal length and novelty (route-quality-1 A7)', () => {
    // (0,29) → (29,0): every monotone staircase is 5,800 m and all new (the stripe is crossed once,
    // whichever way). Unpenalised, the (f, node index) tie-break walks a comb of ~36 turns; with the
    // penalty the L-shaped path wins at the same length and the same new metres.
    const o = snapPoint(spatial, lattice.at(0, 29), 'walk', 'origin'), d = snapPoint(spatial, lattice.at(29, 0), 'walk', 'destination');
    const comb = searcher.run(o, d, { lambda: 1, mode: 'walk' })!;
    const straight = searcher.run(o, d, { lambda: 1, mode: 'walk', turnPenaltyM: TURN_PENALTY_M.walk })!;
    expect(arcTurns(comb.arcs)).toBeGreaterThanOrEqual(20);
    expect(arcTurns(straight.arcs)).toBeLessThanOrEqual(3); // the L + at most a zero-length partial arc at each end
    expect(straight.lengthM).toBeCloseTo(comb.lengthM, 6);
    expect(straight.newM).toBeCloseTo(comb.newM, 0);
    // Through findCandidates with the mode default: Direct is untouched (λ = 0, no penalty).
    const res = findCandidates(graph, lookup, { from: lattice.at(0, 29), to: lattice.at(29, 0), mode: 'walk', detour: 0.25 }, { spatial, scorer, searcher });
    const direct = res.candidates[res.candidates.length - 1];
    expect(direct.name).toBe('Direct');
    expect(direct.lengthM).toBe(5800);
    expect(direct.lambda).toBe(0);
  });

  it('drive respects oneway rows, walk does not', () => {
    const ow = makeLattice({ size: 6, spacingM: 100, onewayRows: [2] });
    const g = new Graph([...ow.tiles.values()].map((t) => decodeGraphTile(encodeGraphTile(t))));
    const sp = new SpatialIndex(g);
    const sc = new NoveltyScorer(g, new MapCellLookup());
    const se = new Searcher(g, sc);
    // Row 2 is oneway west→east: driving east→west along it must use another row.
    const o = snapPoint(sp, ow.at(5, 2), 'drive', 'origin'), d = snapPoint(sp, ow.at(0, 2), 'drive', 'destination');
    const drive = se.run(o, d, { lambda: 0, mode: 'drive' })!;
    const walk = se.run(o, d, { lambda: 0, mode: 'walk' })!;
    expect(walk.lengthM).toBeCloseTo(500, 1);
    expect(drive.lengthM).toBeCloseTo(700, 1);
  });
});

describe('loop mode', () => {
  it('returns loops near the target length that start and end at the origin', () => {
    const from = lattice.at(15, 15);
    const res = findLoops(graph, lookup, { from, mode: 'walk', targetKm: 2 }, { spatial, scorer, searcher });
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    expect(res.candidates.length).toBeLessThanOrEqual(3);
    for (const c of res.candidates) {
      expect(c.lengthM).toBeGreaterThanOrEqual(1500); // ±25 % of the 2 km target
      expect(c.lengthM).toBeLessThanOrEqual(2500);
      expect(c.coords[0][0]).toBeCloseTo(from[0], 5);
      expect(c.coords[c.coords.length - 1][0]).toBeCloseTo(from[0], 5);
      expect(c.coords[c.coords.length - 1][1]).toBeCloseTo(from[1], 5);
      expect(c.pctNew).toBeGreaterThan(50);
      expect(compactness(c.coords)).toBeGreaterThanOrEqual(LOOP_MIN_COMPACTNESS);
    }
    // Ranked by pctNew (P4); names are rank labels — "Most new" first, the rest "Balanced", no "Direct" loop (P5).
    for (let i = 1; i < res.candidates.length; i++) expect(res.candidates[i].pctNew).toBeLessThanOrEqual(res.candidates[i - 1].pctNew);
    expect(res.candidates.map((c) => c.name)).toEqual(['Most new', ...res.candidates.slice(1).map(() => 'Balanced')]);
    // The shape measure behind LOOP_MIN_COMPACTNESS: a 400 m square 0.79, a 10 × 400 m strip 0.08.
    const sq = 400 / 110_574, x = (m: number) => m / (111_320 * Math.cos(from[1] * Math.PI / 180));
    expect(compactness([[from[0], from[1]], [from[0] + x(400), from[1]], [from[0] + x(400), from[1] - sq], [from[0], from[1] - sq], [from[0], from[1]]])).toBeCloseTo(Math.PI / 4, 2);
    expect(compactness([[from[0], from[1]], [from[0] + x(400), from[1]], [from[0] + x(400), from[1] - sq / 40], [from[0], from[1] - sq / 40], [from[0], from[1]]])).toBeLessThan(LOOP_MIN_COMPACTNESS);
  });

  // Route-quality sweep (NYC): ranked by raw new metres, the longest loop in the ±25 % window won
  // ("Most new" at 1.19–1.24 × target in 5 of 15 requests). No test looked at the loop order.
  it('loops rank by pctNew, ties (same integer point) towards the target length — not by raw new metres (route-quality-1 P4)', () => {
    const L = (lengthM: number, newM: number, heading: number) => ({ lengthM, newM, heading });
    const long = L(2480, 1700, 0); // 69 %: the longest loop in the window and the most new metres
    const dense = L(1900, 1500, 45); // 79 %
    const near = L(2050, 1620, 90); // 79 % too, closer to the 2 km target → ahead of dense
    const short = L(1600, 1200, 135); // 75 %
    expect(loopPct(near)).toBe(loopPct(dense));
    expect(rankLoops([long, dense, near, short], 2000)).toEqual([near, dense, short, long]);
    expect(rankLoops([long, dense, near, short], 1900)).toEqual([dense, near, short, long]); // the tie flips with the target
    expect(rankLoops([L(1000, 500, 90), L(1000, 500, 45)], 1000).map((l) => l.heading)).toEqual([45, 90]); // last resort: heading
  });

  // Route-quality sweep (NYC, 2026-09-02): 7 of 15 loops doubled back at a via point — the next leg
  // left along the reverse of the arc the previous leg arrived by (a→b→a in the coordinates). No
  // existing test looks at how legs join.
  it('a leg never doubles back on the street the previous leg arrived by, unless that is the only way out', () => {
    const hasABA = (coords: Array<[number, number]>) => {
      for (let i = 2; i < coords.length; i++) if (coords[i][0] === coords[i - 2][0] && coords[i][1] === coords[i - 2][1]) return true;
      return false;
    };
    // Lattice: via 1 sits 15 m past the (12,10) intersection on the block towards (13,10); via 2 is
    // south-west of it, so the cheapest second leg turns straight round and walks the 15 m back.
    const origin = snapPoint(spatial, lattice.at(10, 10), 'walk', 'origin');
    const n1210 = lattice.at(12, 10), n1310 = lattice.at(13, 10);
    const p1: [number, number] = [n1210[0] + (n1310[0] - n1210[0]) * 0.15, n1210[1]];
    const via1 = spatial.nearestArc(p1[0], p1[1], ArcFlag.WALK)!;
    const via2 = spatial.nearestArc(lattice.at(11, 12)[0], lattice.at(11, 12)[1], ArcFlag.WALK)!;
    const loop = routeLoop(searcher, origin, [via1, via2], 'walk', 0)!;
    expect(loop).not.toBeNull();
    const last1 = loop.legs[0].arcs[loop.legs[0].arcs.length - 1], first2 = loop.legs[1].arcs[0];
    expect(graph.arcReverse[last1]).not.toBe(first2);
    expect(hasABA(loopCoords(graph, loop))).toBe(false);
    expect(loop.legs[1].lengthM).toBeCloseTo(485, 0); // 85 m on to (13,10), two blocks south, two west
    // Dead end: a spur B—S off a street A—B—C; via 1 near the end of the spur. Nothing leaves S, so
    // the second leg may turn round after all (the loop is not lost).
    const A: [number, number] = [-73.9453125 - 0.002, 40.75], dLon = 100 / (111_320 * Math.cos(40.75 * Math.PI / 180)), dLat = 100 / 110_574;
    const B: [number, number] = [A[0] + dLon, A[1]], C: [number, number] = [A[0] + 2 * dLon, A[1]], S: [number, number] = [B[0], B[1] - 0.6 * dLat];
    const g = new Graph([...buildTestTiles([
      { id: 1, refs: [1, 2, 3], coords: [A, B, C], fwd: ALL_MODES, rev: ALL_MODES },
      { id: 2, refs: [2, 4], coords: [B, S], fwd: ALL_MODES, rev: ALL_MODES },
    ]).values()].map((t) => decodeGraphTile(encodeGraphTile(t))));
    const sp = new SpatialIndex(g), se = new Searcher(g, new NoveltyScorer(g, new MapCellLookup()));
    const o = snapPoint(sp, A, 'walk', 'origin');
    const nearS: [number, number] = [S[0], S[1] + 0.1 * dLat];
    const spur = sp.nearestArc(nearS[0], nearS[1], ArcFlag.WALK)!;
    const c = sp.nearestArc(C[0], C[1], ArcFlag.WALK)!;
    const deadEnd = routeLoop(se, o, [spur, c], 'walk', 0)!;
    expect(deadEnd).not.toBeNull();
    expect(g.arcReverse[deadEnd.legs[0].arcs[deadEnd.legs[0].arcs.length - 1]]).toBe(deadEnd.legs[1].arcs[0]);
    expect(deadEnd.legs[1].lengthM).toBeCloseTo(150, 0);
  });

  // Sweep (after the join fix above): the remaining a→b→a joins were all via points that had
  // snapped onto a dead-end stub — the only way on is back. No test looks at where vias land.
  it('via points never sit on a dead-end segment (the loop would walk in and turn round)', () => {
    const hasABA = (coords: Array<[number, number]>) => {
      for (let i = 2; i < coords.length; i++) if (coords[i][0] === coords[i - 2][0] && coords[i][1] === coords[i - 2][1]) return true;
      return false;
    };
    // 11 × 11 lattice; a 16 m stub leaves node (2,2) towards the exact spot where heading 0's
    // first via target falls (0.22 × 2 km from the centre at −45°), so it is the nearest road
    // there. Everything but the stub is visited, so a loop through the stub is the newest one.
    const centre: [number, number] = [-73.9453125, 40.735];
    const size = 11, spacingM = 100;
    const origin: [number, number] = [centre[0] - 5 * (spacingM / (111_320 * Math.cos(centre[1] * Math.PI / 180))), centre[1] + 5 * (spacingM / 110_574)];
    const viaTarget = offsetPoint(centre, 2000 * LOOP_RADIUS_FACTOR, -45);
    const plain = makeLattice({ size, spacingM, origin });
    const n22 = plain.at(2, 2), mid: [number, number] = [(n22[0] + viaTarget[0]) / 2, (n22[1] + viaTarget[1]) / 2];
    // Two layouts: the stub as one segment (its far end is a dead end — rejected outright), and a
    // stub that continues past the via target as a 4-segment zig-zag path, every point of which is
    // nearer the target than any street. Each segment has a neighbour, so only a leg's failure to
    // go on reveals the pocket — the via is then re-snapped outside everything that leg reached,
    // not just off the one arc (excluding one arc at a time would land on the next pocket arc).
    const kx = 111_320 * Math.cos(centre[1] * Math.PI / 180), ky = 110_574;
    const ux = (mid[0] - n22[0]) * kx, uy = (mid[1] - n22[1]) * ky, un = Math.hypot(ux, uy);
    const u: [number, number] = [ux / un, uy / un], v: [number, number] = [-u[1], u[0]]; // metres, u = away from the grid node
    const step = (p: [number, number], d: [number, number], m: number): [number, number] => [p[0] + (d[0] * m) / kx, p[1] + (d[1] * m) / ky];
    const pa = step(viaTarget, u, 5), pb = step(pa, v, 5), pc = step(pb, u, -5), pd = step(pc, v, 5);
    const layouts: TestWay[][] = [
      [{ id: 0, refs: [plain.id(2, 2), 100000], coords: [n22, viaTarget], fwd: ALL_MODES, rev: ALL_MODES }],
      [
        { id: 0, refs: [plain.id(2, 2), 100000], coords: [n22, viaTarget], fwd: ALL_MODES, rev: ALL_MODES },
        { id: 0, refs: [100000, 100001], coords: [viaTarget, pa], fwd: ALL_MODES, rev: ALL_MODES },
        { id: 0, refs: [100001, 100002], coords: [pa, pb], fwd: ALL_MODES, rev: ALL_MODES },
        { id: 0, refs: [100002, 100003], coords: [pb, pc], fwd: ALL_MODES, rev: ALL_MODES },
        { id: 0, refs: [100003, 100004], coords: [pc, pd], fwd: ALL_MODES, rev: ALL_MODES },
      ],
    ];
    for (const extraWays of layouts) {
      const stub = makeLattice({ size, spacingM, origin, extraWays });
      const g = new Graph([...stub.tiles.values()].map((t) => decodeGraphTile(encodeGraphTile(t))));
      expect(g.nodeCount).toBe(size * size + extraWays.length);
      const seen = new MapCellLookup();
      for (let r = 0; r < size; r++) for (const [cx, cy] of cellsAlong([stub.at(0, r), stub.at(size - 1, r)], { stepM: 3 })) seen.mark(cx, cy, 1, 1);
      for (let c = 0; c < size; c++) for (const [cx, cy] of cellsAlong([stub.at(c, 0), stub.at(c, size - 1)], { stepM: 3 })) seen.mark(cx, cy, 1, 1);
      const sp = new SpatialIndex(g), sc = new NoveltyScorer(g, seen), se = new Searcher(g, sc);
      const stubSnap = sp.nearestArc(viaTarget[0], viaTarget[1], ArcFlag.WALK)!;
      expect(stubSnap.distM).toBeLessThan(1);
      // The whole stub is a dead-end tree; the grid (every node on a cycle) is not.
      const dead = g.deadEnds(ArcFlag.WALK);
      expect(dead.reduce((a, b) => a + b, 0)).toBe(extraWays.length);
      expect(dead[g.arcFrom[stubSnap.arc]] + dead[g.arcTo[stubSnap.arc]]).toBeGreaterThan(0);
      const res = findLoops(g, seen, { from: stub.at(5, 5), mode: 'walk', targetKm: 2 }, { spatial: sp, scorer: sc, searcher: se });
      expect(res.candidates.length).toBeGreaterThanOrEqual(1);
      for (const c of res.candidates) {
        expect(hasABA(c.coords)).toBe(false);
        for (const p of c.coords) expect(Math.abs(p[0] - viaTarget[0]) + Math.abs(p[1] - viaTarget[1])).toBeGreaterThan(1e-6);
      }
    }
  });

  // Sweep: a 5 km bike loop from the middle of Prospect Park found NO loop — every leg to a via
  // outside the park needs more than max(1.6·d, d + 400) m of winding path, so all 16 attempts
  // failed and the user got an empty sheet. No existing test has a leg longer than its ellipse.
  it('a leg that needs more than the default detour is retried with a looser budget instead of losing the loop', () => {
    // A U-shaped path O–P1–P2–V in three ways (900 m of path, 300 m as the crow flies; the corners
    // are graph nodes, so the ellipse test applies) and a 50 m stub at V.
    const O: [number, number] = [-73.9453125 + 0.003, 40.75], kx = 111_320 * Math.cos(40.75 * Math.PI / 180), ky = 110_574;
    const P1: [number, number] = [O[0], O[1] - 300 / ky], P2: [number, number] = [O[0] + 300 / kx, O[1] - 300 / ky];
    const V: [number, number] = [O[0] + 300 / kx, O[1]], W: [number, number] = [V[0] + 50 / kx, V[1]];
    const g = new Graph([...buildTestTiles([
      { id: 1, refs: [1, 2], coords: [O, P1], fwd: ALL_MODES, rev: ALL_MODES },
      { id: 2, refs: [2, 3], coords: [P1, P2], fwd: ALL_MODES, rev: ALL_MODES },
      { id: 3, refs: [3, 4], coords: [P2, V], fwd: ALL_MODES, rev: ALL_MODES },
      { id: 4, refs: [4, 5], coords: [V, W], fwd: ALL_MODES, rev: ALL_MODES },
    ]).values()].map((t) => decodeGraphTile(encodeGraphTile(t))));
    const sp = new SpatialIndex(g), se = new Searcher(g, new NoveltyScorer(g, new MapCellLookup()));
    const o = snapPoint(sp, O, 'walk', 'origin');
    const via = sp.nearestArc(V[0] + 25 / kx, V[1], ArcFlag.WALK)!;
    expect(g.segmentId(via.arc)).not.toBe(g.segmentId(o.arc));
    expect(routeLoop(se, o, [via], 'walk', 0, [1.6])).toBeNull(); // default slack only: a 925 m leg for 325 m straight is over the ellipse
    const loop = routeLoop(se, o, [via], 'walk', 0)!;
    expect(loop).not.toBeNull();
    expect(loop.lengthM).toBeCloseTo(1850, 0);
  });
});
