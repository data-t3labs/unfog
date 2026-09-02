import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { cellsAlong, distanceM } from '../grid/cell';
import { overpassToTiles, type OverpassWay } from '../../tests/fixtures/routing/overpass-to-tiles';
import { decodeGraphTile, encodeGraphTile, type GraphTile, type GraphTileInput } from './graph-format';
import { Graph } from './graph';
import { MapCellLookup } from './cells';
import { NoveltyScorer } from './novelty';
import { Searcher, hasImmediateUTurn } from './search';
import { findCandidates, now } from './candidates';
import { SpatialIndex } from './spatial';
import { RouteEngine, routeBBox } from './engine';
import { cellToLonLat } from '../grid/cell';
import type { BBox } from './api';
import { graphTileBounds } from './graph-format';
import { makeLattice } from '../../tests/fixtures/routing/lattice';

const FIXTURE = new URL('../../tests/fixtures/osm/williamsburg.json.gz', import.meta.url).pathname;
const HOME: [number, number] = [-73.9568, 40.7176];
const DOMINO: [number, number] = [-73.9678, 40.7142];

let inputs: Map<string, GraphTileInput>;
let ways: OverpassWay[];
let tiles: GraphTile[];
let graph: Graph;
let lookup: MapCellLookup;
let mergeMs = 0;
const bench: Record<string, number | string> = {};

beforeAll(() => {
  ({ tiles: inputs, ways } = overpassToTiles(FIXTURE));
  tiles = [...inputs.values()].map((t) => decodeGraphTile(encodeGraphTile(t)));
  const t0 = now();
  graph = new Graph(tiles);
  mergeMs = now() - t0;
  // Visited: every cell along ways whose midpoint is within 400 m of home, dilated by one cell
  // (the home neighbourhood)…
  lookup = new MapCellLookup();
  let marked = 0;
  for (const w of ways) {
    const mid = w.geometry[Math.floor(w.geometry.length / 2)];
    if (distanceM(mid.lon, mid.lat, HOME[0], HOME[1]) > 400) continue;
    marked++;
    for (const [cx, cy] of cellsAlong(w.geometry.map((p) => [p.lon, p.lat] as [number, number]), { stepM: 3 })) lookup.mark(cx, cy, 1, 1);
  }
  // …plus the usual commute: the shortest walk to Domino Park. With the disc alone the shortest
  // path is already λ-optimal for every λ (it leaves the disc as fast as any path can), so no
  // alternative can be newer; the commute is what makes "find me a new way" meaningful.
  {
    const spatial = new SpatialIndex(graph);
    const searcher = new Searcher(graph, new NoveltyScorer(graph, lookup));
    const o = spatial.nearestArc(HOME[0], HOME[1], 1)!, d = spatial.nearestArc(DOMINO[0], DOMINO[1], 1)!;
    const commute = searcher.run(o, d, { lambda: 0, mode: 'walk' })!;
    for (const a of commute.arcs) for (const [cx, cy] of cellsAlong(graph.arcGeometry(a), { stepM: 3 })) lookup.mark(cx, cy, 1, 1);
  }
  bench.waysMarked = marked;
  bench.cells = lookup.size;
});

describe('Williamsburg fixture', () => {
  it('converts 1,760 ways into a connected z12 graph', () => {
    expect(ways.length).toBe(1760);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(graph.nodeCount).toBeGreaterThan(2000);
    expect(graph.arcCount).toBeGreaterThan(5000);
    let paired = 0;
    for (let a = 0; a < graph.arcCount; a++) if (graph.arcReverse[a] >= 0) paired++;
    expect(paired).toBe(graph.arcCount); // every segment was emitted in both directions
    bench.nodes = graph.nodeCount; bench.arcs = graph.arcCount; bench.tiles = tiles.length; bench.mergeMs = +mergeMs.toFixed(1);
  });

  it('home → Domino Park, walk, +25 %: Direct 1.25–1.5 km; Most new ≤ 1.25× and ≥ 300 m newer', () => {
    const spatial = new SpatialIndex(graph);
    const scorer = new NoveltyScorer(graph, lookup);
    const searcher = new Searcher(graph, scorer);
    const t0 = now();
    const res = findCandidates(graph, lookup, { from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 }, { spatial, scorer, searcher });
    bench.routeMsFirst = +(now() - t0).toFixed(1);
    const t1 = now();
    findCandidates(graph, lookup, { from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 }, { spatial, scorer, searcher });
    bench.routeMsWarm = +(now() - t1).toFixed(1);
    const direct = res.candidates[res.candidates.length - 1];
    const most = res.candidates[0];
    bench.candidates = res.candidates.map((c) => `${c.name} λ=${c.lambda} ${c.lengthM} m ${c.newM} new (${c.pctNew} %)`).join(' | ');
    // eslint-disable-next-line no-console
    console.log('[williamsburg candidates]', bench.candidates, 'shortest', res.shortestM, 'budget', res.budgetM);
    expect(direct.name).toBe('Direct');
    // 1290 m with arc snapping (the mockup's 1,379 m snapped to the nearest node).
    expect(direct.lengthM).toBeGreaterThanOrEqual(1250);
    expect(direct.lengthM).toBeLessThanOrEqual(1500);
    expect(direct.newM).toBeLessThan(50); // the commute is fully visited
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(most.name).toBe('Most new');
    expect(most.lengthM).toBeLessThanOrEqual(1.25 * direct.lengthM + 1);
    expect(most.newM - direct.newM).toBeGreaterThanOrEqual(300);
    expect(most.coords.length).toBeGreaterThan(10);
    // Geometry starts/ends at the snapped points near home / Domino Park.
    expect(distanceM(most.coords[0][0], most.coords[0][1], HOME[0], HOME[1])).toBeLessThan(60);
    const last = most.coords[most.coords.length - 1];
    expect(distanceM(last[0], last[1], DOMINO[0], DOMINO[1])).toBeLessThan(60);
    for (const mode of ['bike', 'drive'] as const) {
      const r = findCandidates(graph, lookup, { from: HOME, to: DOMINO, mode, detour: 0.25 }, { spatial, scorer, searcher });
      expect(r.candidates.length).toBeGreaterThanOrEqual(1);
      bench[`${mode}Direct`] = r.candidates[r.candidates.length - 1].lengthM;
    }
    // Structural: no immediate U-turns in any sweep result.
    const o = spatial.nearestArc(HOME[0], HOME[1], 1)!, d = spatial.nearestArc(DOMINO[0], DOMINO[1], 1)!;
    for (const lambda of [0, 1, 3, 9]) {
      const r = searcher.run(o, d, { lambda, mode: 'walk', budget: 2000 });
      if (r) expect(hasImmediateUTurn(graph, r.arcs)).toBe(false);
    }
  });

  it('routes end to end through RouteEngine (downloaded-area tiles in IndexedDB)', async () => {
    const engine = new RouteEngine({ cells: lookup });
    await engine.init('/unfog/');
    const rec = await engine.tiles.storeArea({ id: 'wb', center: HOME, radiusKm: 2 }, inputs);
    expect(rec.tiles).toBe(inputs.size);
    const cov = await engine.coverage(routeBBox(HOME, DOMINO));
    expect(cov.available).toBeGreaterThanOrEqual(1);
    const t0 = now();
    const res = await engine.route({ from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 });
    bench.engineRouteMsCold = +(now() - t0).toFixed(1);
    const t1 = now();
    const again = await engine.route({ from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 });
    bench.engineRouteMsWarm = +(now() - t1).toFixed(1);
    expect(res.candidates.length).toBeGreaterThanOrEqual(2);
    expect(res.graphTiles).toBeGreaterThanOrEqual(1);
    expect(again.candidates.map((c) => c.lengthM)).toEqual(res.candidates.map((c) => c.lengthM));
    const downloads = await engine.listDownloads();
    expect(downloads.map((d) => d.id)).toEqual(['wb']);
    await engine.invalidateCells(2);
    const after = await engine.route({ from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 });
    expect(after.candidates.map((c) => c.newM)).toEqual(res.candidates.map((c) => c.newM));
    await engine.deleteDownload('wb');
    await expect(engine.route({ from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 })).rejects.toMatchObject({ name: 'NoCoverageError', message: expect.stringContaining('coverage') });
    await engine.tiles.close();
    // eslint-disable-next-line no-console
    console.log('[williamsburg bench]', JSON.stringify(bench));
  });

  it('prepares cells for the whole merged graph, so a score cached while brushing past an arc is never stale (review F2)', async () => {
    // A 5×5 lattice, 1.1 km spacing, centred in one z12 tile; the lookup only reveals cells inside
    // the bboxes it was asked to prepare (IdbCellLookup minus its one-tile margin).
    const b = graphTileBounds(1205, 1539);
    const centre: [number, number] = [(b.west + b.east) / 2, (b.south + b.north) / 2];
    const dLon = 1100 / (111_320 * Math.cos((centre[1] * Math.PI) / 180)), dLat = 1100 / 110_574;
    const lattice = makeLattice({ size: 5, spacingM: 1100, origin: [centre[0] - 2 * dLon, centre[1] + 2 * dLat] });
    class BoxedLookup extends MapCellLookup {
      prepared: BBox[] = [];
      async prepare(bbox: BBox): Promise<number> { this.prepared.push(bbox); return 0; }
      override get(cx: number, cy: number): number {
        const [lon, lat] = cellToLonLat(cx, cy);
        return this.prepared.some((p) => lon >= p[0] && lon <= p[2] && lat >= p[1] && lat <= p[3]) ? super.get(cx, cy) : 0;
      }
    }
    const cells = new BoxedLookup();
    // The street between (2,1) and (2,2) has been walked.
    for (const [cx, cy] of cellsAlong([lattice.at(2, 1), lattice.at(2, 2)], { stepM: 3, gapM: 2000 })) cells.mark(cx, cy, 1, 1);
    const engine = new RouteEngine({ cells });
    await engine.init('/unfog/');
    await engine.tiles.storeArea({ id: 'lat', center: centre, radiusKm: 3 }, lattice.tiles);
    // Request 1 (one block east along row 2) brushes past that street while its cells are 1.1 km
    // outside the 1 km-padded request bbox…
    const first = await engine.route({ from: lattice.at(2, 2), to: lattice.at(3, 2), mode: 'walk', detour: 0.25 });
    expect(first.candidates.length).toBeGreaterThanOrEqual(1);
    // …request 2 walks exactly that street: it is fully visited, so Direct must report 0 new metres.
    const second = await engine.route({ from: lattice.at(2, 1), to: lattice.at(2, 2), mode: 'walk', detour: 0.25 });
    const direct = second.candidates[second.candidates.length - 1];
    expect(direct.lengthM).toBe(1100);
    expect(direct.newM).toBe(0);
    await engine.deleteDownload('lat');
    await engine.tiles.close();
  });
});
