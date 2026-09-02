/**
 * Shared setup for the route-quality sweep and its probes: the NYC graph, a seeded PRNG, the
 * synthetic visited set around two homes, and the seeded origin→destination pairs. Everything
 * here is deterministic for a given seed so a probe can name a sweep row by id.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellsAlong, distanceM } from '../../src/grid/cell';
import type { LonLat } from '../../src/routing/api';
import { snapPoint } from '../../src/routing/candidates';
import { MapCellLookup } from '../../src/routing/cells';
import { unpackGraphTile, type GraphTile, type Mode } from '../../src/routing/graph-format';
import { Graph } from '../../src/routing/graph';
import { offsetPoint } from '../../src/routing/loop';
import { NoveltyScorer } from '../../src/routing/novelty';
import { Searcher } from '../../src/routing/search';
import { SpatialIndex, type Snap } from '../../src/routing/spatial';
import { readOsmPbf } from '../build-graph/pbf-reader';

export const REGION = new URL('../../public/graph/nyc', import.meta.url).pathname;
export const PBF = new URL('../build-graph/cache/NewYork.osm.pbf', import.meta.url).pathname;

export const HOMES: Array<{ name: string; p: LonLat }> = [
  { name: 'Park Slope', p: [-73.98, 40.671] },
  { name: 'Upper West Side', p: [-73.975, 40.785] },
];
/** Brooklyn + Manhattan (a sliver of western Queens is inside; water points are rejected by the snap). */
export const AREA: [number, number, number, number] = [-74.02, 40.63, -73.9, 40.83];
export const MODES: Mode[] = ['walk', 'bike', 'drive'];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadRegion(dir: string): GraphTile[] {
  const out: GraphTile[] = [];
  const z = join(dir, '12');
  for (const x of readdirSync(z)) for (const f of readdirSync(join(z, x))) {
    if (f.endsWith('.ufg')) out.push(unpackGraphTile(new Uint8Array(readFileSync(join(z, x, f)))));
  }
  return out;
}

/** highway class per OSM way id present in the graph (service sub-type kept as `service:<x>`). */
export function loadWayClasses(graph: Graph, cachePath: string): Map<number, string> {
  const map = new Map<number, string>();
  if (existsSync(cachePath)) {
    const obj = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, string>;
    for (const k in obj) map.set(Number(k), obj[k]);
    return map;
  }
  if (!existsSync(PBF)) return map;
  const wanted = new Set<number>();
  for (let a = 0; a < graph.arcCount; a++) wanted.add(graph.arcWay[a]);
  readOsmPbf(PBF, {
    wayKeyFilter: 'highway',
    way(id, tags) {
      if (!wanted.has(id)) return;
      let c = tags.highway;
      if (c.endsWith('_link')) c = c.slice(0, -5);
      if (c === 'service') c = tags.service ? `service:${tags.service}` : (tags.name ? 'service:named' : 'service:unnamed');
      map.set(id, c);
    },
  });
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[k] = v;
  writeFileSync(cachePath, JSON.stringify(obj));
  return map;
}

export interface Visited {
  lookup: MapCellLookup;
  /** Canonical segment ids marked visited. */
  segments: Set<number>;
  km: number;
  log: string[];
}

/**
 * Around each home: every arc within 600 m with probability 0.85·exp(−d/400)+0.1, plus the
 * shortest walks to 15 random destinations 0.4–2 km away; cells every 4 m, 8-neighbour dilation.
 */
export function buildVisited(graph: Graph, spatial: SpatialIndex, rand: () => number): Visited {
  const lookup = new MapCellLookup();
  const segments = new Set<number>();
  const log: string[] = [];
  let km = 0;
  const markArc = (a: number) => {
    const s = graph.segmentId(a);
    if (!segments.has(s)) { segments.add(s); km += graph.arcLen[a] / 1000; }
    for (const [cx, cy] of cellsAlong(graph.arcGeometry(a), { stepM: 4 })) lookup.mark(cx, cy, 1, 1);
  };
  const pt: [number, number] = [0, 0];
  for (const home of HOMES) {
    let nArcs = 0;
    for (let a = 0; a < graph.arcCount; a++) {
      if (graph.segmentId(a) !== a) continue;
      graph.arcPoint(a, graph.arcPointCount(a) >> 1, pt);
      const d = distanceM(home.p[0], home.p[1], pt[0], pt[1]);
      if (d > 600) continue;
      if (rand() < 0.85 * Math.exp(-d / 400) + 0.1) { markArc(a); nArcs++; }
    }
    const sc0 = new NoveltyScorer(graph, lookup), se0 = new Searcher(graph, sc0);
    const o = snapPoint(spatial, home.p, 'walk', 'origin');
    let trips = 0, tries = 0;
    while (trips < 15 && tries++ < 100) {
      const dest = offsetPoint(home.p, 400 + rand() * 1600, rand() * 360);
      let d: Snap;
      try { d = snapPoint(spatial, dest, 'walk', 'destination'); } catch { continue; }
      const p = se0.run(o, d, { lambda: 0, mode: 'walk' });
      if (!p) continue;
      for (const a of p.arcs) markArc(a);
      trips++;
    }
    log.push(`visited around ${home.name}: ${nArcs} random arcs + ${trips} shortest walks`);
  }
  return { lookup, segments, km, log };
}

export interface Pair { id: number; from: LonLat; to: LonLat; straightM: number; nearHome: boolean }

export function inArea(p: LonLat): boolean {
  return p[0] >= AREA[0] && p[0] <= AREA[2] && p[1] >= AREA[1] && p[1] <= AREA[3];
}

export function snapsAll(spatial: SpatialIndex, p: LonLat, which: 'origin' | 'destination'): boolean {
  for (const m of MODES) { try { snapPoint(spatial, p, m, which); } catch { return false; } }
  return true;
}

/** `n` pairs, alternating "origin within 1.5 km of a home" and "anywhere in AREA"; 1–8 km apart. */
export function generatePairs(spatial: SpatialIndex, rand: () => number, n: number): Pair[] {
  const randomPoint = (): LonLat => [AREA[0] + rand() * (AREA[2] - AREA[0]), AREA[1] + rand() * (AREA[3] - AREA[1])];
  const pairs: Pair[] = [];
  while (pairs.length < n) {
    const nearHome = pairs.length % 2 === 0;
    const home = HOMES[(pairs.length >> 1) % HOMES.length].p;
    const from = nearHome ? offsetPoint(home, rand() * 1500, rand() * 360) : randomPoint();
    if (!inArea(from) || !snapsAll(spatial, from, 'origin')) continue;
    const to = offsetPoint(from, 1000 + rand() * 7000, rand() * 360);
    if (!inArea(to) || !snapsAll(spatial, to, 'destination')) continue;
    const straightM = distanceM(from[0], from[1], to[0], to[1]);
    if (straightM < 1000 || straightM > 8000) continue;
    pairs.push({ id: pairs.length, from, to, straightM, nearHome });
  }
  return pairs;
}

export interface LoopSpec { id: number; from: LonLat; mode: Mode; targetKm: number; nearHome: boolean }

/** 15 loop origins: 2/3/5/8 km cycling; walk ×10, bike ×3, drive ×2; every other one near a home. */
export function generateLoops(spatial: SpatialIndex, rand: () => number): LoopSpec[] {
  const randomPoint = (): LonLat => [AREA[0] + rand() * (AREA[2] - AREA[0]), AREA[1] + rand() * (AREA[3] - AREA[1])];
  const targets = [2, 3, 5, 8];
  const out: LoopSpec[] = [];
  for (let i = 0; i < 15; i++) {
    const id = 1000 + i;
    const nearHome = i % 2 === 0;
    let from: LonLat | null = null;
    while (!from) {
      const home = HOMES[id % HOMES.length].p;
      const p = nearHome ? offsetPoint(home, rand() * 1200, rand() * 360) : randomPoint();
      if (inArea(p) && snapsAll(spatial, p, 'origin')) from = p;
    }
    out.push({ id, from, mode: i < 10 ? 'walk' : i < 13 ? 'bike' : 'drive', targetKm: targets[i % 4], nearHome });
  }
  return out;
}

export interface Setup {
  graph: Graph;
  spatial: SpatialIndex;
  visited: Visited;
  scorer: NoveltyScorer;
  searcher: Searcher;
  pairs: Pair[];
  loops: LoopSpec[];
  wayClass: Map<number, string>;
  tiles: number;
}

export function setup(seed: number, wayCache: string, nPairs = 50): Setup {
  const tiles = loadRegion(REGION);
  const graph = new Graph(tiles);
  const spatial = new SpatialIndex(graph);
  const wayClass = loadWayClasses(graph, wayCache);
  const rand = mulberry32(seed);
  const visited = buildVisited(graph, spatial, rand);
  const scorer = new NoveltyScorer(graph, visited.lookup);
  const searcher = new Searcher(graph, scorer);
  const pairs = generatePairs(spatial, rand, nPairs);
  const loops = generateLoops(spatial, rand);
  return { graph, spatial, visited, scorer, searcher, pairs, loops, wayClass, tiles: tiles.length };
}
