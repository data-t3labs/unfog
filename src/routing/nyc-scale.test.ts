/**
 * Scale test on the prebuilt NYC region (public/graph/nyc, 67 z12 tiles, ~15 MB packed). Skips
 * when the region is absent. Merges EVERY tile into one graph (a superset of anything the engine
 * would load for a single request) and routes city-scale trips in all three modes, asserting the
 * structural invariants (Direct present, endpoints at the snap points, no immediate U-turn, no
 * segment traversed twice) and the < 2 s budget of BUILD-PLAN §2.3 with a 2× Node-vs-phone margin.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellsAlong, distanceM } from '../grid/cell';
import { MapCellLookup } from './cells';
import { findCandidates, now, pathSegments, snapPoint } from './candidates';
import { ArcFlag, unpackGraphTile, type GraphTile, type Mode } from './graph-format';
import { Graph } from './graph';
import { findLoops } from './loop';
import { NoveltyScorer } from './novelty';
import { Searcher, hasImmediateUTurn } from './search';
import { SpatialIndex } from './spatial';
import { graphTilesFor } from './tiles-source';
import { routeBBox } from './engine';

const REGION = new URL('../../public/graph/nyc', import.meta.url).pathname;
const HAVE = existsSync(join(REGION, 'manifest.json'));

const HOME: [number, number] = [-73.9568, 40.7176];
const DOMINO: [number, number] = [-73.9678, 40.7142];
const TIMES_SQ: [number, number] = [-73.9855, 40.758];
const PROSPECT: [number, number] = [-73.969, 40.6602];
/** Grand Army Plaza — the park's north entrance; the park interior has no road cars may use. */
const GRAND_ARMY: [number, number] = [-73.9701, 40.6738];
/**
 * QA no-route case (Jamaica, Queens). The nearest walkable arc to the origin is a 12 m staircase
 * (way 514538882) whose two endpoints have no other arc — an island. Snapping onto it stranded the
 * walk and bike searches, which returned an empty candidate list with no error; drive routed fine.
 */
const JAMAICA_FROM: [number, number] = [-73.801, 40.702];
const JAMAICA_TO: [number, number] = [-73.79, 40.71];

let tiles: GraphTile[] = [];
let graph: Graph;
let spatial: SpatialIndex;
let lookup: MapCellLookup;
let scorer: NoveltyScorer;
let searcher: Searcher;
const bench: Record<string, unknown> = {};

function loadRegion(dir: string): GraphTile[] {
  const out: GraphTile[] = [];
  const z = join(dir, '12');
  for (const x of readdirSync(z)) for (const f of readdirSync(join(z, x))) {
    if (f.endsWith('.ufg')) out.push(unpackGraphTile(new Uint8Array(readFileSync(join(z, x, f)))));
  }
  return out;
}

const heapMB = () => Math.round(process.memoryUsage().heapUsed / 1e6);

/** Fraction of a polyline's length whose (undirected) steps occur more than once. */
function twiceFraction(coords: Array<[number, number]>): number {
  const seen = new Map<string, number>();
  let total = 0, twice = 0;
  const key = (a: [number, number], b: [number, number]) => {
    const p = `${a[0].toFixed(7)},${a[1].toFixed(7)}`, q = `${b[0].toFixed(7)},${b[1].toFixed(7)}`;
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  for (let i = 1; i < coords.length; i++) {
    const k = key(coords[i - 1], coords[i]);
    const d = distanceM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    total += d;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) twice += d * (n === 2 ? 2 : 1);
  }
  return total > 0 ? twice / total : 0;
}

describe.skipIf(!HAVE)('NYC prebuilt region at scale', () => {
  beforeAll(() => {
    const t0 = now();
    tiles = loadRegion(REGION);
    bench.unpackMs = Math.round(now() - t0);
    const t1 = now();
    graph = new Graph(tiles);
    bench.mergeMs = Math.round(now() - t1);
    const t2 = now();
    spatial = new SpatialIndex(graph);
    bench.spatialMs = Math.round(now() - t2);
    lookup = new MapCellLookup();
    // Visited: the shortest ride Times Square → Prospect Park and the shortest walks home → Domino
    // and home → Prospect Park (the usual ways).
    const sc0 = new NoveltyScorer(graph, lookup);
    const se0 = new Searcher(graph, sc0);
    for (const [a, b, mode] of [[TIMES_SQ, PROSPECT, 'bike'], [HOME, DOMINO, 'walk'], [HOME, PROSPECT, 'walk']] as Array<[[number, number], [number, number], Mode]>) {
      const mask = mode === 'walk' ? 1 : 2;
      const o = spatial.nearestArc(a[0], a[1], mask)!, d = spatial.nearestArc(b[0], b[1], mask)!;
      const p = se0.run(o, d, { lambda: 0, mode })!;
      expect(p).not.toBeNull();
      for (const arc of p.arcs) for (const [cx, cy] of cellsAlong(graph.arcGeometry(arc), { stepM: 3 })) lookup.mark(cx, cy, 1, 1);
    }
    scorer = new NoveltyScorer(graph, lookup);
    searcher = new Searcher(graph, scorer);
    bench.tiles = tiles.length; bench.nodes = graph.nodeCount; bench.arcs = graph.arcCount; bench.graphMB = +(graph.byteLength / 1e6).toFixed(1);
    bench.heapMBAfterMerge = heapMB();
  });

  function check(from: [number, number], to: [number, number], mode: Mode, label: string) {
    const t0 = now();
    const res = findCandidates(graph, lookup, { from, to, mode, detour: 0.25 }, { spatial, scorer, searcher });
    const ms = now() - t0;
    bench[label] = { ms: Math.round(ms), shortestM: res.shortestM, budgetM: res.budgetM, candidates: res.candidates.map((c) => `${c.name} λ=${c.lambda} ${c.lengthM} m ${c.newM} new (${c.pctNew} %) eta ${c.etaMin}`), heapMB: heapMB() };
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    const direct = res.candidates[res.candidates.length - 1];
    expect(direct.name).toBe('Direct');
    for (const c of res.candidates) {
      expect(c.lengthM).toBeLessThanOrEqual(res.budgetM + 1);
      expect(c.coords.length).toBeGreaterThan(2);
      expect(distanceM(c.coords[0][0], c.coords[0][1], from[0], from[1])).toBeLessThan(300);
      const last = c.coords[c.coords.length - 1];
      expect(distanceM(last[0], last[1], to[0], to[1])).toBeLessThan(300);
      // No zero-length steps, and the polyline is as long as the route says (a spike or a missing
      // trim would inflate it, a wrong trim would shorten it).
      let poly = 0;
      for (let i = 1; i < c.coords.length; i++) {
        const d = distanceM(c.coords[i - 1][0], c.coords[i - 1][1], c.coords[i][0], c.coords[i][1]);
        expect(d).toBeGreaterThan(0);
        poly += d;
      }
      expect(Math.abs(poly - c.lengthM) / c.lengthM).toBeLessThan(0.03);
    }
    // Structural: every sweep result is U-turn free and never traverses a segment twice.
    const o = snapPoint(spatial, from, mode, 'origin');
    const d = snapPoint(spatial, to, mode, 'destination');
    for (const lambda of [0, 1, 4, 9]) {
      const r = searcher.run(o, d, { lambda, mode, budget: res.budgetM });
      if (!r) continue;
      expect(hasImmediateUTurn(graph, r.arcs)).toBe(false);
      expect(pathSegments(graph, r.arcs).size).toBe(r.arcs.length);
    }
    return ms;
  }

  it('Williamsburg home → Domino Park, walk', () => {
    expect(check(HOME, DOMINO, 'walk', 'wb-walk')).toBeLessThan(4000);
  });

  it('Williamsburg home → Prospect Park (~7 km inside Brooklyn), walk, under the budget', () => {
    expect(check(HOME, PROSPECT, 'walk', 'home-pp-walk')).toBeLessThan(4000);
  });

  // Review finding F1: before the GLUE rebuild, osm-rules dropped footway=crossing|traffic_island —
  // the only walkable links between the bridge walkways and the street grid — and the walk network
  // was two giant components (Manhattan side / Brooklyn+Queens). Skips on a pre-GLUE graph.
  it('Times Square → Prospect Park (~12 km) on foot crosses the East River via GLUE connectors', (ctx) => {
    let glue = 0;
    for (let a = 0; a < graph.arcCount; a++) if (graph.arcFlags[a] & ArcFlag.GLUE) glue++;
    bench.glueArcs = glue;
    if (glue === 0) ctx.skip();
    expect(check(TIMES_SQ, PROSPECT, 'walk', 'ts-pp-walk')).toBeLessThan(4000);
    const walk = bench['ts-pp-walk'] as { shortestM: number };
    expect(walk.shortestM).toBeGreaterThan(11000);
    expect(walk.shortestM).toBeLessThan(15000);
  });

  it('Times Square → Prospect Park (~12 km) by bike and by car, each under the budget', () => {
    expect(check(TIMES_SQ, PROSPECT, 'bike', 'ts-pp-bike')).toBeLessThan(4000);
    // Inside the park there is no road a car may use within 300 m: the drive ends on the nearest
    // road and the last part is the walk into the park (feedback-1 item 2), no error.
    expect(check(TIMES_SQ, PROSPECT, 'drive', 'ts-pp-drive')).toBeLessThan(4000);
    const drive = findCandidates(graph, lookup, { from: TIMES_SQ, to: PROSPECT, mode: 'drive', detour: 0.25 }, { spatial, scorer, searcher });
    const driveDirect = drive.candidates[drive.candidates.length - 1];
    const lastPart = driveDirect.parts![driveDirect.parts!.length - 1];
    expect(lastPart.kind).toBe('offroad');
    expect(lastPart.lengthM).toBeGreaterThan(300);
    expect(lastPart.lengthM).toBeLessThan(1500);
    expect(driveDirect.coords[driveDirect.coords.length - 1]).toEqual(PROSPECT);
    bench['ts-pp-drive-offroad'] = Math.round(lastPart.lengthM);
    expect(check(TIMES_SQ, GRAND_ARMY, 'drive', 'ts-gap-drive')).toBeLessThan(4000);
    // Warm repeat (novelty cached): well under the budget.
    const t0 = now();
    findCandidates(graph, lookup, { from: TIMES_SQ, to: PROSPECT, mode: 'bike', detour: 0.25 }, { spatial, scorer, searcher });
    bench['ts-pp-bike-warm-ms'] = Math.round(now() - t0);
    bench.engineTilesForRoute = graphTilesFor(routeBBox(TIMES_SQ, PROSPECT)).length;
    bench.heapMBEnd = heapMB();
  });

  it('Jamaica, Queens: walk and bike snap past an isolated staircase and find a sane route (QA no-route regression)', () => {
    const straight = distanceM(JAMAICA_FROM[0], JAMAICA_FROM[1], JAMAICA_TO[0], JAMAICA_TO[1]);
    for (const mode of ['walk', 'bike', 'drive'] as Mode[]) {
      expect(check(JAMAICA_FROM, JAMAICA_TO, mode, `jamaica-${mode}`)).toBeLessThan(4000);
      const res = findCandidates(graph, lookup, { from: JAMAICA_FROM, to: JAMAICA_TO, mode, detour: 0.25 }, { spatial, scorer, searcher });
      const direct = res.candidates[res.candidates.length - 1];
      // Sane length: no shorter than the chord between its own ends, no longer than 3× the pins' straight line.
      const last = direct.coords[direct.coords.length - 1];
      const chord = distanceM(direct.coords[0][0], direct.coords[0][1], last[0], last[1]);
      expect(direct.lengthM).toBeGreaterThanOrEqual(chord - 1);
      expect(direct.lengthM).toBeGreaterThan(0.8 * straight);
      expect(direct.lengthM).toBeLessThan(3 * straight);
    }
  });

  it('loop 5 km from Times Square: starts and ends at the origin, no plain out-and-back', () => {
    const t0 = now();
    const res = findLoops(graph, lookup, { from: TIMES_SQ, mode: 'walk', targetKm: 5 }, { spatial, scorer, searcher });
    bench.loopMs = Math.round(now() - t0);
    bench.loops = res.candidates.map((c) => `${c.name} ${c.lengthM} m ${c.newM} new (${c.pctNew} %) coords ${c.coords.length} twice ${Math.round(100 * twiceFraction(c.coords))} %`);
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    for (const c of res.candidates) {
      expect(c.lengthM).toBeGreaterThanOrEqual(0.75 * 5000);
      expect(c.lengthM).toBeLessThanOrEqual(1.25 * 5000);
      expect(distanceM(c.coords[0][0], c.coords[0][1], TIMES_SQ[0], TIMES_SQ[1])).toBeLessThan(300);
      const last = c.coords[c.coords.length - 1];
      expect(distanceM(last[0], last[1], c.coords[0][0], c.coords[0][1])).toBeLessThan(1);
      // Not an out-and-back: at most a quarter of the length retraces itself.
      expect(twiceFraction(c.coords)).toBeLessThan(0.25);
    }
  });

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log('[nyc bench]', JSON.stringify(bench, null, 1));
  });
});
