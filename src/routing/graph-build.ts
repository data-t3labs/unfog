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
 *   2. sort-unique every referenced node id → dense node index; count references; graph nodes =
 *      way endpoints ∪ nodes referenced ≥ 2 times (junctions, and loops — a node used twice in one
 *      way counts twice);
 *   3. cut every way into undirected segments between consecutive graph nodes; the intermediate
 *      nodes become the segment's shape; length = Σ distanceM along the shape;
 *   4. tile by the zoom-12 tile of the FROM node: each segment yields a forward arc in the tile of
 *      its first node and a reverse arc (REVERSED, sharing the shape range) in the tile of its
 *      last node; every node appears where it is local (flags 0) and as FOREIGN wherever an arc
 *      points at it from another tile.
 * Output is deterministic: nodes sorted by OSM id inside a tile, arcs per node sorted by
 * (target id, way id, direction), tiles in (tx, ty) order.
 */
import { distanceM } from '../grid/cell';
import { ArcFlag, GRAPH_ZOOM, NodeFlag, lonLatToGraphTile, type GraphTileInput } from './graph-format';
import { classifyWay } from './osm-rules';
import type { BuildGraphTiles, BuildOptions, BuildResult, OsmWay, WayClass } from './osm-types';

export const MAX_ARC_LEN = 65535;
const E7 = 1e7;

/** Per-direction arc flags for a classified way: `[forward, reverse]` (REVERSED is added by the tiler). */
export function wayFlags(cls: WayClass): [fwd: number, rev: number] {
  let common = 0;
  if (cls.walk) common |= ArcFlag.WALK;
  if (cls.steps) common |= ArcFlag.STEPS;
  if (cls.dismount) common |= ArcFlag.DISMOUNT;
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

interface TileAcc { tx: number; ty: number; local: number[]; foreign: number[] }

export const buildGraphTiles: BuildGraphTiles = (ways: Iterable<OsmWay>, opts: BuildOptions = {}): BuildResult => {
  const zoom = opts.zoom ?? GRAPH_ZOOM;
  if (zoom > 16) throw new Error('buildGraphTiles: zoom > 16 not supported');

  // ---- 1. ingest kept ways into flat arrays --------------------------------------------------
  const wayId: number[] = [], wayFwd: number[] = [], wayRev: number[] = [], wayStart: number[] = [];
  const refs: number[] = [], lon: number[] = [], lat: number[] = [];
  for (const w of ways) {
    const cls = classifyWay(w.tags);
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
    const [f, r] = wayFlags(cls);
    wayId.push(w.id); wayFwd.push(f); wayRev.push(r); wayStart.push(start);
  }
  const W = wayId.length;
  wayStart.push(refs.length);
  const R = refs.length;

  // ---- 2. unique node ids, reference counts, graph-node selection ---------------------------
  const sorted = Float64Array.from(refs);
  sorted.sort();
  let U = 0;
  for (let i = 0; i < R; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[U++] = sorted[i];
  const ids = sorted.subarray(0, U);
  const refIdx = new Int32Array(R);
  for (let i = 0; i < R; i++) refIdx[i] = lowerBound(ids, refs[i]);
  const count = new Uint32Array(U);
  const isGraph = new Uint8Array(U);
  const uLon = new Float64Array(U), uLat = new Float64Array(U);
  for (let w = 0; w < W; w++) {
    const s = wayStart[w], e = wayStart[w + 1];
    for (let i = s; i < e; i++) { const u = refIdx[i]; count[u]++; uLon[u] = lon[i]; uLat[u] = lat[i]; }
    isGraph[refIdx[s]] = 1; isGraph[refIdx[e - 1]] = 1;
  }
  for (let u = 0; u < U; u++) if (count[u] >= 2) isGraph[u] = 1;
  const gOf = new Int32Array(U).fill(-1);
  let G = 0;
  for (let u = 0; u < U; u++) if (isGraph[u]) gOf[u] = G++;
  const gU = new Int32Array(G); // graph index → unique index (both ascend by id)
  for (let u = 0; u < U; u++) if (gOf[u] >= 0) gU[gOf[u]] = u;

  // ---- 3. cut ways into segments ------------------------------------------------------------
  const segFrom: number[] = [], segTo: number[] = [], segLen: number[] = [], segWay: number[] = [];
  const segShapeStart: number[] = [], segShapeEnd: number[] = [];
  const shapeLon: number[] = [], shapeLat: number[] = [];
  let km = 0;
  for (let w = 0; w < W; w++) {
    const s = wayStart[w], e = wayStart[w + 1];
    let fromG = gOf[refIdx[s]], shapeStart = shapeLon.length, len = 0;
    let pLon = lon[s], pLat = lat[s];
    for (let i = s + 1; i < e; i++) {
      const x = lon[i], y = lat[i];
      len += distanceM(pLon, pLat, x, y);
      pLon = x; pLat = y;
      const g = gOf[refIdx[i]];
      if (g < 0) { shapeLon.push(Math.round(x * E7)); shapeLat.push(Math.round(y * E7)); continue; }
      const shapeEnd = shapeLon.length;
      if (g === fromG && shapeEnd === shapeStart) { /* degenerate zero-length loop */ }
      else {
        segFrom.push(fromG); segTo.push(g); segLen.push(len); segWay.push(w);
        segShapeStart.push(shapeStart); segShapeEnd.push(shapeEnd);
        km += len;
      }
      fromG = g; shapeStart = shapeEnd; len = 0;
    }
  }
  const S = segFrom.length;

  // ---- 4. adjacency (CSR over graph nodes), sorted for determinism --------------------------
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

  // ---- 5. tiles -----------------------------------------------------------------------------
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

  return { tiles, stats: { ways: W, nodes: G, arcs: 2 * S, km: km / 1000 } };
};
