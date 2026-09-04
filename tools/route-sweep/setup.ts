/**
 * Shared setup for the route-quality sweep and its probes: a prebuilt region's graph, a seeded
 * PRNG, the synthetic visited set around two "homes", the seeded origin→destination pairs and
 * loop origins, plus the region's named cases (pins on piers, in parks, off the coverage edge…).
 * Everything here is deterministic for a given seed so a probe can name a sweep row by id.
 *
 * The generators snap with a LEGACY 300 m limit (`legacySnap`), the engine's rule when rounds 1–2
 * ran. The engine now snaps up to 5 km, and letting that into the generator diverts the seeded
 * PRNG (a destination that used to be rejected is now accepted, every later draw shifts) — with
 * the legacy filter the NYC seed 20260902 reproduces round 2's 50 pairs and 15 loops exactly, so
 * per-pair numbers stay comparable across rounds. The filter is also the right one for "seeded
 * on-street pairs"; pins off the network are the named cases.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellsAlong, distanceM } from '../../src/grid/cell';
import type { LonLat } from '../../src/routing/api';
import { MapCellLookup } from '../../src/routing/cells';
import { MODE_BIT, unpackGraphTile, type GraphTile, type Mode } from '../../src/routing/graph-format';
import { Graph } from '../../src/routing/graph';
import { offsetPoint } from '../../src/routing/loop';
import { NoveltyScorer } from '../../src/routing/novelty';
import { Searcher } from '../../src/routing/search';
import { SpatialIndex, canEnterArc, canLeaveArc, type Snap } from '../../src/routing/spatial';
import { readOsmPbf } from '../build-graph/pbf-reader';

const GRAPH_ROOT = new URL('../../public/graph', import.meta.url).pathname;
const PBF_ROOT = new URL('../build-graph/cache', import.meta.url).pathname;

/** The one mode the app requests (src/app/route-sheet.ts TRAVEL_MODE). */
export const MODE: Mode = 'walk';
/** Every mode the generators' legacy filter checks (rounds 1–2 required an on-street snap in all three). */
export const MODES: Mode[] = ['walk', 'bike', 'drive'];
/** Snap limit of the engine when rounds 1–2 ran; the generators keep it (see the header). */
export const LEGACY_SNAP_M = 300;

export type RegionId = 'nyc' | 'vancouver' | 'saltspring';

export interface NamedCase {
  /** Ids ≥ 500 (seeded pairs are 0..n−1). */
  id: number;
  name: string;
  from: LonLat;
  to: LonLat;
  /** What the case probes. */
  why: string;
}

export interface LoopSeed {
  name: string;
  p: LonLat;
}

export interface RegionSpec {
  id: RegionId;
  dir: string;
  /** OSM PBF the way classes are read from (null = no classes: Overpass-built regions). */
  pbf: string | null;
  homes: Array<{ name: string; p: LonLat }>;
  /** Seeded pairs are drawn inside this box. */
  area: [number, number, number, number];
  /** Seeded pairs; the last `detourPairs` of them are routed at detours 0.1 and 0.5, the rest at 0.25. */
  nPairs: number;
  detourPairs: number;
  named: NamedCase[];
  /** Named loop origins, each requested at 2 / 3 / 5 / 8 km (ids 2000 + 4·seed + target index). */
  loopSeeds: LoopSeed[];
  /** Reproduce round 2's 15 seeded loop origins (ids 1000–1014; all routed as MODE now). */
  legacyLoops: boolean;
}

// Region bboxes (manifest.json): nyc −74.37369,40.47417,−73.65336,40.98588 (BBBike extract north edge
// ≈ 40.96); vancouver −123.30655,48.98424,−122.5235,49.43752 (extract east edge ≈ −122.67);
// saltspring −123.62,48.72,−123.4,48.9 (Overpass box; the island continues north to 48.94).
export const REGIONS: RegionSpec[] = [
  {
    id: 'nyc',
    dir: join(GRAPH_ROOT, 'nyc'),
    pbf: join(PBF_ROOT, 'NewYork.osm.pbf'),
    homes: [
      { name: 'Park Slope', p: [-73.98, 40.671] },
      { name: 'Upper West Side', p: [-73.975, 40.785] },
    ],
    // Brooklyn + Manhattan (a sliver of western Queens is inside; water points are rejected by the snap).
    area: [-74.02, 40.63, -73.9, 40.83],
    nPairs: 50,
    detourPairs: 10,
    named: [
      { id: 500, name: 'Domino Park pier → Bedford Av L', from: [-73.9684, 40.715], to: [-73.9563, 40.7172], why: 'pin on a pier over the East River: off-road leg to the park paths' },
      { id: 501, name: 'Bedford Av L → Domino Park pier', from: [-73.9563, 40.7172], to: [-73.9684, 40.715], why: 'the same pier as the destination' },
      { id: 502, name: 'Central Park Great Lawn → Columbus Circle', from: [-73.966, 40.7815], to: [-73.9819, 40.7681], why: 'pin on a lawn inside the park: off-road leg to a park path, then paths + streets' },
      { id: 503, name: 'Sheep Meadow → Lincoln Center', from: [-73.9748, 40.7719], to: [-73.9835, 40.7725], why: 'park interior, short trip' },
      { id: 504, name: 'Riverdale → 2 km north of the region edge', from: [-73.908, 40.89], to: [-73.9, 41.004], why: 'destination outside coverage (Yonkers, streets exist but no tile): straight leg to the edge' },
      { id: 505, name: '2 km north of the region edge → Riverdale', from: [-73.9, 41.004], to: [-73.908, 40.89], why: 'origin outside coverage' },
      { id: 506, name: 'Tottenville → 2 km west of the region edge', from: [-74.247, 40.51], to: [-74.3975, 40.55], why: 'destination outside coverage across the Arthur Kill (NJ)' },
      { id: 507, name: 'Park Slope → Astoria (12 km cross-borough)', from: [-73.98, 40.671], to: [-73.925, 40.772], why: 'long trip over the East River bridges + GLUE connectors' },
      { id: 508, name: 'Upper West Side → Bushwick (11 km cross-borough)', from: [-73.975, 40.785], to: [-73.921, 40.694], why: 'long trip, Manhattan → Brooklyn' },
      { id: 509, name: 'Jamaica Center → Hillside Av', from: [-73.801, 40.702], to: [-73.79, 40.71], why: 'the historic empty-candidate case (isolated staircase nearest the origin)' },
      { id: 510, name: 'Bedford Av → Governors Island', from: [-73.9563, 40.7172], to: [-74.0169, 40.6895], why: 'separate walk component: straight gap over the water' },
      { id: 511, name: 'Bedford Av → mid-East River', from: [-73.9563, 40.7172], to: [-73.97, 40.7205], why: 'pin in the water 450 m from any street: off-road leg at the end' },
      { id: 512, name: 'Times Square → Prospect Park', from: [-73.9855, 40.758], to: [-73.969, 40.6602], why: 'nyc-scale test pair (12 km) for a runtime check' },
    ],
    loopSeeds: [
      { name: 'Park Slope home', p: [-73.98, 40.671] },
      { name: 'Upper West Side home', p: [-73.975, 40.785] },
      { name: 'Domino Park (Kent Av)', p: [-73.9668, 40.7137] },
      { name: 'Central Park Great Lawn', p: [-73.966, 40.7815] },
      { name: 'Jamaica (Sutphin Blvd)', p: [-73.8075, 40.702] },
    ],
    legacyLoops: true,
  },
  {
    id: 'vancouver',
    dir: join(GRAPH_ROOT, 'vancouver'),
    pbf: join(PBF_ROOT, 'Vancouver.osm.pbf'),
    homes: [
      { name: 'Kitsilano', p: [-123.158, 49.264] },
      { name: 'Commercial Drive', p: [-123.07, 49.27] },
    ],
    // Vancouver city + Burnaby (Burrard Inlet / English Bay points are rejected by the snap).
    area: [-123.23, 49.2, -122.95, 49.32],
    nPairs: 30,
    detourPairs: 6,
    named: [
      { id: 500, name: 'Stanley Park seawall (Prospect Point) → Denman & Robson', from: [-123.1422, 49.3138], to: [-123.133, 49.289], why: 'pin on the seawall path: paths out of the park' },
      { id: 501, name: 'Second Beach → Brockton Point (seawall both ends)', from: [-123.152, 49.292], to: [-123.118, 49.302], why: 'seawall to seawall around the park' },
      { id: 502, name: 'Brockton Point → Kitsilano home', from: [-123.118, 49.302], to: [-123.158, 49.264], why: 'seawall pin, trip over the Burrard Bridge' },
      { id: 503, name: 'Lynn Valley → 2 km north of the region edge', from: [-123.033, 49.34], to: [-123.03, 49.4555], why: 'destination outside coverage (mountains): straight leg to the edge' },
      { id: 504, name: 'Langley → 2 km east of the region edge', from: [-122.66, 49.1], to: [-122.5035, 49.1], why: 'destination outside coverage (Abbotsford side); the extract ends near −122.67' },
      { id: 505, name: '2 km east of the region edge → Langley', from: [-122.5035, 49.1], to: [-122.66, 49.1], why: 'origin outside coverage' },
      { id: 506, name: 'Kitsilano → Metrotown (12 km cross-city)', from: [-123.158, 49.264], to: [-123.003, 49.227], why: 'long trip across the city' },
      { id: 507, name: 'Commercial Drive → Lonsdale Quay (over the inlet)', from: [-123.07, 49.27], to: [-123.083, 49.31], why: 'north shore: the walk network crosses on the Second Narrows bridge or not at all' },
    ],
    loopSeeds: [
      { name: 'Kitsilano home', p: [-123.158, 49.264] },
      { name: 'Commercial Drive home', p: [-123.07, 49.27] },
      { name: 'Second Beach (seawall)', p: [-123.152, 49.292] },
      { name: 'Lynn Valley', p: [-123.033, 49.34] },
      { name: 'Metrotown', p: [-123.003, 49.227] },
    ],
    legacyLoops: false,
  },
  {
    id: 'saltspring',
    dir: join(GRAPH_ROOT, 'saltspring'),
    pbf: null,
    homes: [
      { name: 'Ganges', p: [-123.497, 48.853] },
      { name: 'Fulford Harbour', p: [-123.447, 48.769] },
    ],
    area: [-123.6, 48.74, -123.42, 48.88],
    nPairs: 16,
    detourPairs: 4,
    named: [
      { id: 500, name: 'Ganges → Fulford ferry', from: [-123.497, 48.853], to: [-123.447, 48.7685], why: 'rural pair, one main road' },
      { id: 501, name: 'Vesuvius ferry → Ganges', from: [-123.573, 48.881], to: [-123.497, 48.853], why: 'rural pair' },
      { id: 502, name: 'Long Harbour ferry → Ganges', from: [-123.439, 48.861], to: [-123.497, 48.853], why: 'rural pair, a winding road' },
      { id: 503, name: 'Beddis Beach → Ganges', from: [-123.462, 48.819], to: [-123.497, 48.853], why: 'rural pair from a beach road end' },
      { id: 504, name: 'Ganges → Cusheon Lake', from: [-123.497, 48.853], to: [-123.479, 48.81], why: 'rural pair to a lake shore' },
      { id: 505, name: 'Fulford → Beaver Point Rd', from: [-123.447, 48.769], to: [-123.41, 48.775], why: 'rural pair near the east edge of the box' },
      { id: 506, name: 'Vesuvius → Southey Point (2 km north of the box)', from: [-123.573, 48.881], to: [-123.56, 48.918], why: 'destination outside the Overpass box on the island: roads exist, no data' },
      { id: 507, name: 'Ganges → Mount Maxwell lookout', from: [-123.497, 48.853], to: [-123.53, 48.8135], why: 'a gravel road up the mountain (track/unclassified)' },
    ],
    loopSeeds: [
      { name: 'Ganges', p: [-123.497, 48.853] },
      { name: 'Fulford Harbour', p: [-123.447, 48.769] },
      { name: 'Vesuvius', p: [-123.573, 48.881] },
      { name: 'Beddis Beach', p: [-123.462, 48.819] },
      { name: 'Cusheon Lake', p: [-123.479, 48.81] },
    ],
    legacyLoops: false,
  },
];

export const LOOP_TARGETS_KM = [2, 3, 5, 8];

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
export function loadWayClasses(graph: Graph, cachePath: string, pbf: string | null): Map<number, string> {
  const map = new Map<number, string>();
  if (existsSync(cachePath)) {
    const obj = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, string>;
    for (const k in obj) map.set(Number(k), obj[k]);
    return map;
  }
  if (!pbf || !existsSync(pbf)) return map;
  const wanted = new Set<number>();
  for (let a = 0; a < graph.arcCount; a++) wanted.add(graph.arcWay[a]);
  readOsmPbf(pbf, {
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

/**
 * The engine's snap as it was in rounds 1–2: nearest usable arc within 300 m that the search can
 * leave / arrive on, else the nearest usable arc within 300 m, else null (SnapError then).
 */
export function legacySnap(spatial: SpatialIndex, p: LonLat, mode: Mode, which: 'origin' | 'destination', maxM = LEGACY_SNAP_M): Snap | null {
  const mask = MODE_BIT[mode], graph = spatial.graph;
  const connected = which === 'origin' ? (a: number) => canLeaveArc(graph, a, mask) : (a: number) => canEnterArc(graph, a, mask);
  return spatial.nearestArc(p[0], p[1], mask, maxM, connected) ?? spatial.nearestArc(p[0], p[1], mask, maxM);
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
export function buildVisited(graph: Graph, spatial: SpatialIndex, homes: RegionSpec['homes'], rand: () => number): Visited {
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
  for (const home of homes) {
    let nArcs = 0;
    for (let a = 0; a < graph.arcCount; a++) {
      if (graph.segmentId(a) !== a) continue;
      graph.arcPoint(a, graph.arcPointCount(a) >> 1, pt);
      const d = distanceM(home.p[0], home.p[1], pt[0], pt[1]);
      if (d > 600) continue;
      if (rand() < 0.85 * Math.exp(-d / 400) + 0.1) { markArc(a); nArcs++; }
    }
    const sc0 = new NoveltyScorer(graph, lookup), se0 = new Searcher(graph, sc0);
    const o = legacySnap(spatial, home.p, 'walk', 'origin');
    if (!o) throw new Error(`home ${home.name} has no street within ${LEGACY_SNAP_M} m`);
    let trips = 0, tries = 0;
    while (trips < 15 && tries++ < 100) {
      const dest = offsetPoint(home.p, 400 + rand() * 1600, rand() * 360);
      const d = legacySnap(spatial, dest, 'walk', 'destination');
      if (!d) continue;
      const p = se0.run(o, d, { lambda: 0, mode: 'walk' });
      if (!p) continue;
      for (const a of p.arcs) markArc(a);
      trips++;
    }
    log.push(`visited around ${home.name}: ${nArcs} random arcs + ${trips} shortest walks`);
  }
  return { lookup, segments, km, log };
}

export interface Pair { id: number; from: LonLat; to: LonLat; straightM: number; nearHome: boolean; name?: string; why?: string }

export function inArea(area: RegionSpec['area'], p: LonLat): boolean {
  return p[0] >= area[0] && p[0] <= area[2] && p[1] >= area[1] && p[1] <= area[3];
}

/** Rounds 1–2's pair filter: a street within 300 m for every mode. */
export function snapsAll(spatial: SpatialIndex, p: LonLat, which: 'origin' | 'destination'): boolean {
  for (const m of MODES) if (!legacySnap(spatial, p, m, which)) return false;
  return true;
}

/** `n` pairs, alternating "origin within 1.5 km of a home" and "anywhere in the area"; 1–8 km apart. */
export function generatePairs(spec: RegionSpec, spatial: SpatialIndex, rand: () => number, n: number): Pair[] {
  const { area, homes } = spec;
  const randomPoint = (): LonLat => [area[0] + rand() * (area[2] - area[0]), area[1] + rand() * (area[3] - area[1])];
  const pairs: Pair[] = [];
  let guard = 0;
  while (pairs.length < n && guard++ < 100_000) {
    const nearHome = pairs.length % 2 === 0;
    const home = homes[(pairs.length >> 1) % homes.length].p;
    const from = nearHome ? offsetPoint(home, rand() * 1500, rand() * 360) : randomPoint();
    if (!inArea(area, from) || !snapsAll(spatial, from, 'origin')) continue;
    const to = offsetPoint(from, 1000 + rand() * 7000, rand() * 360);
    if (!inArea(area, to) || !snapsAll(spatial, to, 'destination')) continue;
    const straightM = distanceM(from[0], from[1], to[0], to[1]);
    if (straightM < 1000 || straightM > 8000) continue;
    pairs.push({ id: pairs.length, from, to, straightM, nearHome });
  }
  return pairs;
}

export interface LoopSpec { id: number; from: LonLat; targetKm: number; nearHome: boolean; name?: string; /** Round 2's mode for this id (all are routed as MODE now). */ legacyMode?: Mode }

/** Round 2's 15 loop origins: 2/3/5/8 km cycling; every other one near a home (ids 1000–1014). */
export function generateLegacyLoops(spec: RegionSpec, spatial: SpatialIndex, rand: () => number): LoopSpec[] {
  const { area, homes } = spec;
  const randomPoint = (): LonLat => [area[0] + rand() * (area[2] - area[0]), area[1] + rand() * (area[3] - area[1])];
  const out: LoopSpec[] = [];
  for (let i = 0; i < 15; i++) {
    const id = 1000 + i;
    const nearHome = i % 2 === 0;
    let from: LonLat | null = null;
    let guard = 0;
    while (!from && guard++ < 100_000) {
      const home = homes[id % homes.length].p;
      const p = nearHome ? offsetPoint(home, rand() * 1200, rand() * 360) : randomPoint();
      if (inArea(area, p) && snapsAll(spatial, p, 'origin')) from = p;
    }
    if (!from) break;
    out.push({ id, from, targetKm: LOOP_TARGETS_KM[i % 4], nearHome, legacyMode: i < 10 ? 'walk' : i < 13 ? 'bike' : 'drive' });
  }
  return out;
}

/** The region's named loop seeds at every target: ids 2000 + 4·seed + target index. */
export function seedLoops(spec: RegionSpec): LoopSpec[] {
  const out: LoopSpec[] = [];
  spec.loopSeeds.forEach((s, i) => {
    LOOP_TARGETS_KM.forEach((km, k) => out.push({ id: 2000 + 4 * i + k, from: s.p, targetKm: km, nearHome: spec.homes.some((h) => distanceM(h.p[0], h.p[1], s.p[0], s.p[1]) < 1500), name: s.name }));
  });
  return out;
}

export interface Setup {
  spec: RegionSpec;
  graph: Graph;
  spatial: SpatialIndex;
  visited: Visited;
  scorer: NoveltyScorer;
  searcher: Searcher;
  /** Seeded pairs (ids 0..n−1) followed by the named cases (ids ≥ 500). */
  pairs: Pair[];
  named: Pair[];
  loops: LoopSpec[];
  wayClass: Map<number, string>;
  tiles: number;
}

export function setup(spec: RegionSpec, seed: number, wayCache: string): Setup {
  const tiles = loadRegion(spec.dir);
  const graph = new Graph(tiles);
  const spatial = new SpatialIndex(graph);
  const wayClass = loadWayClasses(graph, wayCache, spec.pbf);
  const rand = mulberry32(seed);
  const visited = buildVisited(graph, spatial, spec.homes, rand);
  const scorer = new NoveltyScorer(graph, visited.lookup);
  const searcher = new Searcher(graph, scorer);
  const pairs = generatePairs(spec, spatial, rand, spec.nPairs);
  const loops = [...(spec.legacyLoops ? generateLegacyLoops(spec, spatial, rand) : []), ...seedLoops(spec)];
  const named: Pair[] = spec.named.map((c) => ({ id: c.id, from: c.from, to: c.to, straightM: distanceM(c.from[0], c.from[1], c.to[0], c.to[1]), nearHome: false, name: c.name, why: c.why }));
  return { spec, graph, spatial, visited, scorer, searcher, pairs, named, loops, wayClass, tiles: tiles.length };
}
