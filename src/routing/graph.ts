/**
 * In-memory routing graph: several decoded graph tiles merged into one CSR structure over global
 * node indices. Nodes are deduplicated by OSM id (a tile's FOREIGN copy of a node collapses onto
 * the local copy from its home tile; if the home tile is not loaded the node stays as a dead end
 * with no outgoing arcs). Everything is typed arrays — never per-node/per-arc objects.
 */
import { ArcFlag, NodeFlag, type GraphTile } from './graph-format';
import type { LonLat } from './api';
import { usableFlags } from './spatial';

export class Graph {
  readonly nodeCount: number;
  readonly arcCount: number;
  /** OSM node ids. */
  readonly nodeId: Float64Array;
  /** Degrees. */
  readonly nodeLon: Float64Array;
  readonly nodeLat: Float64Array;
  /** CSR offsets: arcs of node n are [arcStart[n], arcStart[n+1]). */
  readonly arcStart: Uint32Array;
  readonly arcFrom: Uint32Array;
  readonly arcTo: Uint32Array;
  /** Metres. */
  readonly arcLen: Uint16Array;
  readonly arcFlags: Uint8Array;
  readonly arcWay: Uint32Array;
  /** [start, end) into shapeLon/shapeLat (global). */
  readonly arcShapeStart: Uint32Array;
  readonly arcShapeEnd: Uint32Array;
  /** × 1e7. */
  readonly shapeLon: Int32Array;
  readonly shapeLat: Int32Array;
  /** Index of the opposite-direction arc of the same road segment, -1 if absent. */
  readonly arcReverse: Int32Array;
  /** Tiles merged (for diagnostics). */
  readonly tileKeys: string[];
  readonly bbox: [west: number, south: number, east: number, north: number];
  private readonly componentCache = new Map<number, Uint32Array>();
  private readonly deadEndCache = new Map<number, Uint8Array>();

  constructor(tiles: readonly GraphTile[]) {
    // Pass 1: global node indices (dedupe by OSM id) and arc counts per global from-node.
    const index = new Map<number, number>();
    let n = 0;
    let arcTotal = 0;
    let shapeTotal = 0;
    const tileNodeIndex: Int32Array[] = [];
    for (const t of tiles) {
      const local = new Int32Array(t.nodeId.length);
      for (let i = 0; i < t.nodeId.length; i++) {
        const id = t.nodeId[i];
        let g = index.get(id);
        if (g === undefined) { g = n++; index.set(id, g); }
        local[i] = g;
      }
      tileNodeIndex.push(local);
      arcTotal += t.arcTo.length;
      shapeTotal += t.shapeLon.length;
    }
    this.nodeCount = n;
    this.arcCount = arcTotal;
    this.nodeId = new Float64Array(n);
    this.nodeLon = new Float64Array(n);
    this.nodeLat = new Float64Array(n);
    const filled = new Uint8Array(n); // 1 = coords set from a local copy, 2 = from a foreign copy
    const degree = new Uint32Array(n + 1);
    tiles.forEach((t, ti) => {
      const local = tileNodeIndex[ti];
      for (let i = 0; i < t.nodeId.length; i++) {
        const g = local[i];
        const foreign = (t.nodeFlags[i] & NodeFlag.FOREIGN) !== 0;
        const rank = foreign ? 2 : 1;
        if (filled[g] === 0 || rank < filled[g]) {
          this.nodeId[g] = t.nodeId[i];
          this.nodeLon[g] = t.nodeLon[i] / 1e7;
          this.nodeLat[g] = t.nodeLat[i] / 1e7;
          filled[g] = rank;
        }
        degree[g] += t.arcStart[i + 1] - t.arcStart[i];
      }
    });
    // Prefix sum → CSR offsets.
    this.arcStart = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.arcStart[i + 1] = this.arcStart[i] + degree[i];
    this.arcFrom = new Uint32Array(arcTotal);
    this.arcTo = new Uint32Array(arcTotal);
    this.arcLen = new Uint16Array(arcTotal);
    this.arcFlags = new Uint8Array(arcTotal);
    this.arcWay = new Uint32Array(arcTotal);
    this.arcShapeStart = new Uint32Array(arcTotal);
    this.arcShapeEnd = new Uint32Array(arcTotal);
    this.shapeLon = new Int32Array(shapeTotal);
    this.shapeLat = new Int32Array(shapeTotal);
    // Pass 2: place arcs.
    const fill = new Uint32Array(n);
    let shapeOff = 0;
    tiles.forEach((t, ti) => {
      const local = tileNodeIndex[ti];
      this.shapeLon.set(t.shapeLon, shapeOff);
      this.shapeLat.set(t.shapeLat, shapeOff);
      for (let i = 0; i < t.nodeId.length; i++) {
        const g = local[i];
        for (let a = t.arcStart[i]; a < t.arcStart[i + 1]; a++) {
          const k = this.arcStart[g] + fill[g]++;
          this.arcFrom[k] = g;
          this.arcTo[k] = local[t.arcTo[a]];
          this.arcLen[k] = t.arcLen[a];
          this.arcFlags[k] = t.arcFlags[a];
          this.arcWay[k] = t.arcWay[a];
          this.arcShapeStart[k] = t.arcShapeStart[a] + shapeOff;
          this.arcShapeEnd[k] = t.arcShapeEnd[a] + shapeOff;
        }
      }
      shapeOff += t.shapeLon.length;
    });
    // Reverse arcs: scan the to-node's arcs for one that comes back along the same way with the
    // same length and shape point count (shape ranges are per-tile copies, so equality of ranges
    // does not hold across a tile boundary).
    this.arcReverse = new Int32Array(arcTotal).fill(-1);
    for (let a = 0; a < arcTotal; a++) {
      if (this.arcReverse[a] >= 0) continue;
      const u = this.arcFrom[a], v = this.arcTo[a];
      const way = this.arcWay[a], len = this.arcLen[a];
      const shapeN = this.arcShapeEnd[a] - this.arcShapeStart[a];
      for (let b = this.arcStart[v]; b < this.arcStart[v + 1]; b++) {
        if (b === a || this.arcTo[b] !== u || this.arcWay[b] !== way || this.arcLen[b] !== len) continue;
        if (this.arcShapeEnd[b] - this.arcShapeStart[b] !== shapeN) continue;
        if (this.arcReverse[b] >= 0) continue;
        this.arcReverse[a] = b;
        this.arcReverse[b] = a;
        break;
      }
    }
    this.tileKeys = tiles.map((t) => `${t.zoom}/${t.tx}/${t.ty}`);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (let i = 0; i < n; i++) {
      const lon = this.nodeLon[i], lat = this.nodeLat[i];
      if (lon < west) west = lon; if (lon > east) east = lon;
      if (lat < south) south = lat; if (lat > north) north = lat;
    }
    this.bbox = n ? [west, south, east, north] : [0, 0, 0, 0];
  }

  /** [start, end) range of the arcs leaving `node`. */
  arcsFrom(node: number): [start: number, end: number] {
    return [this.arcStart[node], this.arcStart[node + 1]];
  }

  arcLengthM(arc: number): number {
    return this.arcLen[arc];
  }

  /** Index of the opposite-direction arc, or -1. */
  reverseArc(arc: number): number {
    return this.arcReverse[arc];
  }

  /** Canonical id of the undirected segment an arc belongs to (min of arc and its reverse). */
  segmentId(arc: number): number {
    const r = this.arcReverse[arc];
    return r >= 0 && r < arc ? r : arc;
  }

  /** Number of geometry points of an arc (endpoints + shape). */
  arcPointCount(arc: number): number {
    return 2 + (this.arcShapeEnd[arc] - this.arcShapeStart[arc]);
  }

  /**
   * i-th geometry point of an arc in travel direction (0 = from-node … count-1 = to-node),
   * honouring REVERSED for the shared shape range. Writes into `out` and returns it.
   */
  arcPoint(arc: number, i: number, out: [number, number] = [0, 0]): [number, number] {
    const s = this.arcShapeStart[arc], e = this.arcShapeEnd[arc];
    const count = 2 + (e - s);
    if (i <= 0) { out[0] = this.nodeLon[this.arcFrom[arc]]; out[1] = this.nodeLat[this.arcFrom[arc]]; return out; }
    if (i >= count - 1) { out[0] = this.nodeLon[this.arcTo[arc]]; out[1] = this.nodeLat[this.arcTo[arc]]; return out; }
    const k = (this.arcFlags[arc] & ArcFlag.REVERSED) ? e - i : s + i - 1;
    out[0] = this.shapeLon[k] / 1e7; out[1] = this.shapeLat[k] / 1e7;
    return out;
  }

  /** Full geometry of an arc in travel direction: from-node, shape points, to-node. */
  arcGeometry(arc: number): LonLat[] {
    const count = this.arcPointCount(arc);
    const out: LonLat[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.arcPoint(arc, i, [0, 0]);
    return out;
  }

  /**
   * Connected-component label per node for a mode: an arc usable by the mode in either direction
   * joins its two ends (oneways are ignored, so this is reachability up to one-way traps). Used
   * to keep snaps off islands — a cemetery's or a park's own roads, a pier — that the one-hop
   * check cannot see. Union-find over every arc, computed once per mode and cached.
   */
  components(modeMask: number): Uint32Array {
    const cached = this.componentCache.get(modeMask);
    if (cached) return cached;
    const n = this.nodeCount;
    const parent = new Uint32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    for (let a = 0; a < this.arcCount; a++) {
      if (!usableFlags(this.arcFlags[a], modeMask)) continue;
      const u = find(this.arcFrom[a]), v = find(this.arcTo[a]);
      if (u !== v) parent[u] = v;
    }
    const label = new Uint32Array(n);
    for (let i = 0; i < n; i++) label[i] = find(i);
    this.componentCache.set(modeMask, label);
    return label;
  }

  /**
   * 1 for every node in a dead-end tree of the mode's network — a pier, a stub path, a cul-de-sac,
   * an estate's walkways with one entrance — found by peeling degree-1 nodes until only the
   * 2-core (nodes on or between cycles) is left. Undirected, like `components`. Cached per mode.
   */
  deadEnds(modeMask: number): Uint8Array {
    const cached = this.deadEndCache.get(modeMask);
    if (cached) return cached;
    const n = this.nodeCount;
    const deg = new Uint32Array(n);
    const usable = (a: number): boolean => {
      const r = this.arcReverse[a];
      return usableFlags(this.arcFlags[a], modeMask) || (r >= 0 && usableFlags(this.arcFlags[r], modeMask));
    };
    for (let a = 0; a < this.arcCount; a++) {
      if (this.segmentId(a) !== a || !usable(a)) continue;
      deg[this.arcFrom[a]]++; deg[this.arcTo[a]]++;
    }
    const dead = new Uint8Array(n);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) if (deg[i] <= 1) stack.push(i);
    while (stack.length) {
      const u = stack.pop()!;
      if (dead[u]) continue;
      dead[u] = 1;
      for (let a = this.arcStart[u]; a < this.arcStart[u + 1]; a++) {
        if (!usable(a)) continue;
        const v = this.arcTo[a];
        if (!dead[v] && --deg[v] <= 1) stack.push(v);
      }
    }
    this.deadEndCache.set(modeMask, dead);
    return dead;
  }

  /** Approximate resident size in bytes (diagnostics). */
  get byteLength(): number {
    return this.nodeCount * (8 + 8 + 8 + 4) + this.arcCount * (4 + 4 + 2 + 1 + 4 + 4 + 4 + 4) + this.shapeLon.length * 8;
  }
}
