/**
 * OSM ways → routing graph tiles (the "UFG1" format in graph-format.ts).
 *
 * Shared by the Node CLI (tools/build-graph) and route.worker's on-demand Overpass downloader, so
 * it is pure: no DOM, no Node APIs, and no per-node objects — everything lives in flat number
 * arrays / typed arrays.
 *
 * Pipeline
 *   1. classify each way (osm-rules.ts), drop the rest; clean coords (NaN / missing points,
 *      consecutive duplicate refs);
 *   2. sort-unique every referenced node id → dense node index;
 *   3. GLUE selection (review F1): glue ways — crossings, traffic islands, sidewalks, driveways,
 *      parking aisles, unnamed service roads — are connectors that route but never count. Without
 *      them walk mode could not cross the East River; with all of them the graph triples. So:
 *      build the topology once with every glue candidate, union the non-glue segments, then keep
 *      only the glue segments that join two different components (Kruskal, shortest first), and
 *      trim glue leaves that lead nowhere. Each surviving glue segment becomes a pseudo-way; the
 *      final topology is rebuilt from non-glue ways + those spans, so a pruned crossing never
 *      splits the street it touched;
 *   4. count references; graph nodes = way endpoints ∪ nodes referenced ≥ 2 times (junctions,
 *      and loops — a node used twice in one way counts twice);
 *   5. cut every way into undirected segments between consecutive graph nodes; the intermediate
 *      nodes become the segment's shape; length = Σ distanceM along the shape;
 *   6. tile by the zoom-12 tile of the FROM node: each segment yields a forward arc in the tile of
 *      its first node and a reverse arc (REVERSED, sharing the shape range) in the tile of its
 *      last node; every node appears where it is local (flags 0) and as FOREIGN wherever an arc
 *      points at it from another tile.
 * Output is deterministic: nodes sorted by OSM id inside a tile, arcs per node sorted by
 * (target id, way id, direction), tiles in (tx, ty) order. `stats.km` excludes glue.
 */
import { distanceM } from '../grid/cell';
import { ArcFlag, GRAPH_ZOOM, NodeFlag, lonLatToGraphTile, type GraphTileInput } from './graph-format';
import { classifyWay, type ClassifyOptions, type WayClassEx } from './osm-rules';
import type { BuildGraphTiles, BuildOptions, BuildResult, OsmWay, WayClass } from './osm-types';

export const MAX_ARC_LEN = 65535;
const E7 = 1e7;

export interface BuildOptionsEx extends BuildOptions, ClassifyOptions {}

/** BuildResult plus what the glue (connector) network cost. */
export interface BuildResultEx extends BuildResult {
  glue: {
    /** Glue ways offered as candidates. */
    candidates: number;
    /** Distinct glue ways with at least one surviving span. */
    ways: number;
    arcs: number;
    km: number;
  };
}

/** Per-direction arc flags for a classified way: `[forward, reverse]` (REVERSED is added by the tiler). */
export function wayFlags(cls: WayClass | WayClassEx): [fwd: number, rev: number] {
  let common = 0;
  if (cls.walk) common |= ArcFlag.WALK;
  if (cls.steps) common |= ArcFlag.STEPS;
  if (cls.dismount) common |= ArcFlag.DISMOUNT;
  if ((cls as WayClassEx).glue) common |= ArcFlag.GLUE;
  let fwd = common, rev = common;
  if (cls.bike) {
    if (!(cls.onewayBack && !cls.bikeBothWays)) fwd |= ArcFlag.BIKE;
    if (!(cls.onewayFwd && !cls.bikeBothWays)) rev |= ArcFlag.BIKE;
  }
  if (cls.drive) {
    if (!cls.onewayBack) fwd |= ArcFlag.DRIVE;
    if (!cls.onewayFwd) rev |= ArcFlag.DRIVE;
  }
  return [fwd, rev];
}

/** Index of the first element ≥ x in a sorted array (x's index when present). */
export function lowerBound(sorted: Float64Array, x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Ways as flat arrays: way w covers refs[wayS[w] .. wayE[w]) with coords lon/lat at the same indices. */
interface FlatWays {
  wayId: number[]; wayFwd: number[]; wayRev: number[]; wayGlue: number[]; wayS: number[]; wayE: number[];
  refs: number[]; lon: number[]; lat: number[];
}

interface Topology {
  G: number;
  gOf: Int32Array; // unique node index → graph node index or −1
  gU: Int32Array;  // graph node index → unique node index
  segFrom: number[]; segTo: number[]; segLen: number[]; segWay: number[];
  segRefS: number[]; segRefE: number[]; // inclusive ref index range of the segment inside its way
  segShapeStart: number[]; segShapeEnd: number[]; shapeLon: number[]; shapeLat: number[];
}

/** Graph nodes (endpoints ∪ refcount ≥ 2) and undirected segments for a set of ways. */
function topology(f: FlatWays, U: number, refIdx: Int32Array, uLon: Float64Array, uLat: Float64Array): Topology {
  const W = f.wayId.length;
  const count = new Uint32Array(U);
  const isGraph = new Uint8Array(U);
  for (let w = 0; w < W; w++) {
    const s = f.wayS[w], e = f.wayE[w];
    for (let i = s; i < e; i++) { const u = refIdx[i]; count[u]++; uLon[u] = f.lon[i]; uLat[u] = f.lat[i]; }
    isGraph[refIdx[s]] = 1; isGraph[refIdx[e - 1]] = 1;
  }
  for (let u = 0; u < U; u++) if (count[u] >= 2) isGraph[u] = 1;
  const gOf = new Int32Array(U).fill(-1);
  let G = 0;
  for (let u = 0; u < U; u++) if (isGraph[u] && count[u] > 0) gOf[u] = G++;
  const gU = new Int32Array(G);
  for (let u = 0; u < U; u++) if (gOf[u] >= 0) gU[gOf[u]] = u;

  const t: Topology = { G, gOf, gU, segFrom: [], segTo: [], segLen: [], segWay: [], segRefS: [], segRefE: [], segShapeStart: [], segShapeEnd: [], shapeLon: [], shapeLat: [] };
  for (let w = 0; w < W; w++) {
    const s = f.wayS[w], e = f.wayE[w];
    let fromG = gOf[refIdx[s]], fromI = s, shapeStart = t.shapeLon.length, len = 0;
    let pLon = f.lon[s], pLat = f.lat[s];
    for (let i = s + 1; i < e; i++) {
      const x = f.lon[i], y = f.lat[i];
      len += distanceM(pLon, pLat, x, y);
      pLon = x; pLat = y;
      const g = gOf[refIdx[i]];
      if (g < 0) { t.shapeLon.push(Math.round(x * E7)); t.shapeLat.push(Math.round(y * E7)); continue; }
      const shapeEnd = t.shapeLon.length;
      if (!(g === fromG && shapeEnd === shapeStart)) { // skip degenerate zero-length loops
        t.segFrom.push(fromG); t.segTo.push(g); t.segLen.push(len); t.segWay.push(w);
        t.segRefS.push(fromI); t.segRefE.push(i);
        t.segShapeStart.push(shapeStart); t.segShapeEnd.push(shapeEnd);
      }
      fromG = g; fromI = i; shapeStart = shapeEnd; len = 0;
    }
  }
  return t;
}

/**
 * Minimal glue: keep only glue segments that connect otherwise separate components (Kruskal over
 * the non-glue graph, shortest glue first), then drop glue leaves iteratively. Returns the way set
 * for the final build: every non-glue way + one pseudo-way per surviving glue span.
 */
function selectGlue(f: FlatWays, t: Topology): { ways: FlatWays; glueWays: number } {
  const G = t.G, S = t.segFrom.length;
  // One union-find per mode a glue arc can serve: a crossing must be kept when it joins two parts of
  // the WALK network even if a car-only bridge already joins them for driving (East River!).
  const MODES = [ArcFlag.WALK, ArcFlag.BIKE];
  const parents = MODES.map(() => { const p = new Int32Array(G); for (let g = 0; g < G; g++) p[g] = g; return p; });
  const find = (parent: Int32Array, x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const segBits = (s: number) => { const w = t.segWay[s]; return f.wayFwd[w] | f.wayRev[w]; };
  const glueSegs: number[] = [];
  for (let s = 0; s < S; s++) {
    if (f.wayGlue[t.segWay[s]]) { glueSegs.push(s); continue; }
    const bits = segBits(s);
    for (let m = 0; m < MODES.length; m++) {
      if (!(bits & MODES[m])) continue;
      const a = find(parents[m], t.segFrom[s]), b = find(parents[m], t.segTo[s]);
      if (a !== b) parents[m][a] = b;
    }
  }
  glueSegs.sort((p, q) => t.segLen[p] - t.segLen[q] || f.wayId[t.segWay[p]] - f.wayId[t.segWay[q]] || p - q);
  const live = new Uint8Array(S);
  const deg = new Int32Array(G);
  for (let s = 0; s < S; s++) if (!f.wayGlue[t.segWay[s]]) { deg[t.segFrom[s]]++; deg[t.segTo[s]]++; }
  for (const s of glueSegs) {
    const bits = segBits(s);
    let keep = false;
    for (let m = 0; m < MODES.length; m++) {
      if (!(bits & MODES[m])) continue;
      const a = find(parents[m], t.segFrom[s]), b = find(parents[m], t.segTo[s]);
      if (a !== b) { parents[m][a] = b; keep = true; }
    }
    if (!keep) continue;
    live[s] = 1; deg[t.segFrom[s]]++; deg[t.segTo[s]]++;
  }
  // trim glue leaves (a node whose only live segment is glue) until stable
  const incident: number[][] = [];
  for (const s of glueSegs) if (live[s]) {
    (incident[t.segFrom[s]] ??= []).push(s);
    if (t.segTo[s] !== t.segFrom[s]) (incident[t.segTo[s]] ??= []).push(s);
  }
  const queue: number[] = [];
  for (let g = 0; g < G; g++) if (deg[g] === 1 && incident[g]) queue.push(g);
  while (queue.length) {
    const g = queue.pop()!;
    if (deg[g] !== 1) continue;
    const s = incident[g]?.find((x) => live[x] === 1);
    if (s === undefined) continue;
    live[s] = 0;
    deg[t.segFrom[s]]--; deg[t.segTo[s]]--;
    const other = t.segFrom[s] === g ? t.segTo[s] : t.segFrom[s];
    if (deg[other] === 1 && incident[other]) queue.push(other);
  }
  // final way set: non-glue ways + surviving glue spans (pseudo-ways sharing the ref arrays)
  const ways: FlatWays = { wayId: [], wayFwd: [], wayRev: [], wayGlue: [], wayS: [], wayE: [], refs: f.refs, lon: f.lon, lat: f.lat };
  for (let w = 0; w < f.wayId.length; w++) {
    if (f.wayGlue[w]) continue;
    ways.wayId.push(f.wayId[w]); ways.wayFwd.push(f.wayFwd[w]); ways.wayRev.push(f.wayRev[w]); ways.wayGlue.push(0);
    ways.wayS.push(f.wayS[w]); ways.wayE.push(f.wayE[w]);
  }
  const usedWay = new Uint8Array(f.wayId.length);
  for (const s of glueSegs) {
    if (!live[s]) continue;
    const w = t.segWay[s];
    usedWay[w] = 1;
    ways.wayId.push(f.wayId[w]); ways.wayFwd.push(f.wayFwd[w]); ways.wayRev.push(f.wayRev[w]); ways.wayGlue.push(1);
    ways.wayS.push(t.segRefS[s]); ways.wayE.push(t.segRefE[s] + 1);
  }
  let glueWays = 0;
  for (let w = 0; w < usedWay.length; w++) glueWays += usedWay[w];
  return { ways, glueWays };
}

interface TileAcc { tx: number; ty: number; local: number[]; foreign: number[] }

export const buildGraphTiles = (input: Iterable<OsmWay>, opts: BuildOptionsEx = {}): BuildResultEx => {
  const zoom = opts.zoom ?? GRAPH_ZOOM;
  if (zoom > 16) throw new Error('buildGraphTiles: zoom > 16 not supported');

  // ---- 1. ingest kept ways into flat arrays --------------------------------------------------
  let f: FlatWays = { wayId: [], wayFwd: [], wayRev: [], wayGlue: [], wayS: [], wayE: [], refs: [], lon: [], lat: [] };
  const refs = f.refs, lon = f.lon, lat = f.lat;
  let glueCandidates = 0;
  for (const w of input) {
    const cls = classifyWay(w.tags, opts);
    if (!cls.keep) continue;
    const start = refs.length;
    const n = Math.min(w.refs.length, w.coords.length);
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const c = w.coords[i];
      if (!c) continue;
      const x = c[0], y = c[1], r = w.refs[i];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) continue;
      if (r === prev) continue;
      refs.push(r); lon.push(x); lat.push(y); prev = r;
    }
    if (refs.length - start < 2) { refs.length = start; lon.length = start; lat.length = start; continue; }
    const [fwd, rev] = wayFlags(cls);
    f.wayId.push(w.id); f.wayFwd.push(fwd); f.wayRev.push(rev); f.wayGlue.push(cls.glue ? 1 : 0);
    f.wayS.push(start); f.wayE.push(refs.length);
    if (cls.glue) glueCandidates++;
  }
  const R = refs.length;

  // ---- 2. unique node ids --------------------------------------------------------------------
  const sorted = Float64Array.from(refs);
  sorted.sort();
  let U = 0;
  for (let i = 0; i < R; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[U++] = sorted[i];
  const ids = sorted.subarray(0, U);
  const refIdx = new Int32Array(R);
  for (let i = 0; i < R; i++) refIdx[i] = lowerBound(ids, refs[i]);
  const uLon = new Float64Array(U), uLat = new Float64Array(U);

  // ---- 3. glue selection, 4–5. final topology -------------------------------------------------
  let glueWays = 0;
  if (glueCandidates > 0) {
    const first = topology(f, U, refIdx, uLon, uLat);
    ({ ways: f, glueWays } = selectGlue(f, first));
  }
  const t = topology(f, U, refIdx, uLon, uLat);
  const { G, gU, segFrom, segTo, segLen, segWay, segShapeStart, segShapeEnd, shapeLon, shapeLat } = t;
  const S = segFrom.length;
  const wayId = f.wayId, wayFwd = f.wayFwd, wayRev = f.wayRev, wayGlue = f.wayGlue;
  let km = 0, glueKm = 0, glueSegs = 0;
  for (let s = 0; s < S; s++) { if (wayGlue[segWay[s]]) { glueKm += segLen[s]; glueSegs++; } else km += segLen[s]; }

  // ---- 6. adjacency (CSR over graph nodes), sorted for determinism ---------------------------
  const deg = new Uint32Array(G + 1);
  for (let s = 0; s < S; s++) { deg[segFrom[s] + 1]++; deg[segTo[s] + 1]++; }
  for (let g = 0; g < G; g++) deg[g + 1] += deg[g];
  const fill = Uint32Array.from(deg.subarray(0, G));
  const adj = new Int32Array(2 * S); // segment*2 + dir (0 = from→to, 1 = to→from)
  for (let s = 0; s < S; s++) { adj[fill[segFrom[s]]++] = s * 2; adj[fill[segTo[s]]++] = s * 2 + 1; }
  const targetG = (a: number) => (a & 1) === 0 ? segTo[a >> 1] : segFrom[a >> 1];
  const arcLess = (a: number, b: number): boolean => {
    const ta = ids[gU[targetG(a)]], tb = ids[gU[targetG(b)]];
    if (ta !== tb) return ta < tb;
    const wa = wayId[segWay[a >> 1]], wb = wayId[segWay[b >> 1]];
    if (wa !== wb) return wa < wb;
    if ((a >> 1) !== (b >> 1)) return (a >> 1) < (b >> 1);
    return (a & 1) < (b & 1);
  };
  for (let g = 0; g < G; g++) {
    // insertion sort — degrees are tiny
    for (let i = deg[g] + 1; i < deg[g + 1]; i++) {
      const v = adj[i];
      let j = i - 1;
      while (j >= deg[g] && arcLess(v, adj[j])) { adj[j + 1] = adj[j]; j--; }
      adj[j + 1] = v;
    }
  }

  // ---- 7. tiles ------------------------------------------------------------------------------
  const tileKey = new Int32Array(G);
  const accs = new Map<number, TileAcc>();
  for (let g = 0; g < G; g++) {
    const u = gU[g];
    const [tx, ty] = lonLatToGraphTile(uLon[u], uLat[u], zoom);
    const key = tx * 65536 + ty;
    tileKey[g] = key;
    let acc = accs.get(key);
    if (!acc) { acc = { tx, ty, local: [], foreign: [] }; accs.set(key, acc); }
    acc.local.push(g);
  }
  for (let s = 0; s < S; s++) {
    const a = segFrom[s], b = segTo[s];
    if (tileKey[a] === tileKey[b]) continue;
    accs.get(tileKey[a])!.foreign.push(b);
    accs.get(tileKey[b])!.foreign.push(a);
  }

  const localIndex = new Int32Array(G).fill(-1);
  const segShapeInTile = new Int32Array(S).fill(-1);
  const tiles = new Map<string, GraphTileInput>();
  const keys = Array.from(accs.keys()).sort((p, q) => p - q);
  for (const key of keys) {
    const acc = accs.get(key)!;
    // merged node table: locals (already ascending by id) ∪ unique foreigns, ascending by id
    const foreign = acc.foreign.length ? Array.from(new Set(acc.foreign)).sort((p, q) => p - q) : [];
    const N = acc.local.length + foreign.length;
    const nodes = new Int32Array(N);
    const nodeFlags = new Uint8Array(N);
    for (let i = 0, li = 0, fi = 0; i < N; i++) {
      if (fi >= foreign.length || (li < acc.local.length && acc.local[li] < foreign[fi])) nodes[i] = acc.local[li++];
      else { nodes[i] = foreign[fi++]; nodeFlags[i] = NodeFlag.FOREIGN; }
      localIndex[nodes[i]] = i;
    }
    const arcStart: number[] = [0];
    const arcTo: number[] = [], arcLen: number[] = [], arcFlags: number[] = [], arcWay: number[] = [];
    const arcShapeStart: number[] = [], arcShapeEnd: number[] = [];
    const tShapeLon: number[] = [], tShapeLat: number[] = [];
    const touched: number[] = [];
    for (let i = 0; i < N; i++) {
      if (nodeFlags[i] === 0) {
        const g = nodes[i];
        for (let k = deg[g]; k < deg[g + 1]; k++) {
          const a = adj[k], s = a >> 1, rev = (a & 1) === 1, w = segWay[s];
          arcTo.push(localIndex[targetG(a)]);
          arcLen.push(Math.min(MAX_ARC_LEN, Math.round(segLen[s])));
          arcFlags.push(rev ? wayRev[w] | ArcFlag.REVERSED : wayFwd[w]);
          arcWay.push(wayId[w]);
          let ss = segShapeInTile[s];
          if (ss < 0) {
            ss = tShapeLon.length;
            for (let p = segShapeStart[s]; p < segShapeEnd[s]; p++) { tShapeLon.push(shapeLon[p]); tShapeLat.push(shapeLat[p]); }
            segShapeInTile[s] = ss;
            touched.push(s);
          }
          arcShapeStart.push(ss); arcShapeEnd.push(ss + (segShapeEnd[s] - segShapeStart[s]));
        }
      }
      arcStart.push(arcTo.length);
    }
    for (const s of touched) segShapeInTile[s] = -1;
    const nodeId = new Float64Array(N), nodeLon = new Int32Array(N), nodeLat = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const u = gU[nodes[i]];
      nodeId[i] = ids[u]; nodeLon[i] = Math.round(uLon[u] * E7); nodeLat[i] = Math.round(uLat[u] * E7);
      localIndex[nodes[i]] = -1;
    }
    tiles.set(`${acc.tx}/${acc.ty}`, {
      zoom, tx: acc.tx, ty: acc.ty,
      nodeId, nodeLon, nodeLat, nodeFlags,
      arcStart: Uint32Array.from(arcStart),
      arcTo: Uint32Array.from(arcTo),
      arcLen: Uint16Array.from(arcLen),
      arcFlags: Uint8Array.from(arcFlags),
      arcWay: Uint32Array.from(arcWay),
      arcShapeStart: Uint32Array.from(arcShapeStart),
      arcShapeEnd: Uint32Array.from(arcShapeEnd),
      shapeLon: Int32Array.from(tShapeLon),
      shapeLat: Int32Array.from(tShapeLat),
    });
  }

  let nonGlueWays = 0;
  for (let w = 0; w < wayId.length; w++) if (!wayGlue[w]) nonGlueWays++;
  return {
    tiles,
    stats: { ways: nonGlueWays + glueWays, nodes: G, arcs: 2 * S, km: km / 1000 },
    glue: { candidates: glueCandidates, ways: glueWays, arcs: 2 * glueSegs, km: glueKm / 1000 },
  };
};

// Compile-time check that the implementation satisfies the fixed contract in osm-types.ts.
const _contract: BuildGraphTiles = buildGraphTiles;
void _contract;
