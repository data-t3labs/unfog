import { beforeAll, describe, expect, it } from 'vitest';
import { cellsAlong } from '../grid/cell';
import { makeLattice, type Lattice } from '../../tests/fixtures/routing/lattice';
import { encodeGraphTile, decodeGraphTile, type GraphTile } from './graph-format';
import { Graph } from './graph';
import { MapCellLookup } from './cells';
import { NoveltyScorer } from './novelty';
import { Searcher, hasImmediateUTurn } from './search';
import { LAMBDA_SWEEP, findCandidates, snapPoint, sweep } from './candidates';
import { SpatialIndex } from './spatial';
import { findLoops } from './loop';

let lattice: Lattice;
let tiles: GraphTile[];
let graph: Graph;
let lookup: MapCellLookup;
let scorer: NoveltyScorer;
let searcher: Searcher;
let spatial: SpatialIndex;
const ROW = 15;

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
      expect(c.lengthM).toBeGreaterThanOrEqual(1200);
      expect(c.lengthM).toBeLessThanOrEqual(3000);
      expect(c.coords[0][0]).toBeCloseTo(from[0], 5);
      expect(c.coords[c.coords.length - 1][0]).toBeCloseTo(from[0], 5);
      expect(c.coords[c.coords.length - 1][1]).toBeCloseTo(from[1], 5);
      expect(c.pctNew).toBeGreaterThan(50);
    }
    expect(res.candidates[0].name).toBe('Most new');
  });
});
