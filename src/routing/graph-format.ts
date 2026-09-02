/**
 * Routing graph tile format ("UFG1").
 *
 * The road network is cut into zoom-12 tiles. A tile holds every graph node inside its bounds
 * plus the "foreign" endpoint nodes its arcs reach in neighbouring tiles (flagged, so tiles
 * merge by OSM node id). Arcs are DIRECTED (each undirected road segment is two arcs, one per
 * direction, each with its own mode permissions), stored CSR-style grouped by from-node, and
 * only for from-nodes local to the tile. Shape points (the road geometry between two graph
 * nodes) are stored once per undirected segment; the reverse arc references the same range
 * with the REVERSED flag.
 *
 * Binary layout (little-endian), then deflated with fflate (`deflateSync`) on disk:
 *   "UFG1"                       4 B
 *   u32 nodeCount, u32 arcCount, u32 shapeCount, u32 tileX, u32 tileY, u8 zoom, 3 B pad
 *   Float64 nodeId[nodeCount]     OSM node ids (exceed 2^32)
 *   Int32   nodeLon[nodeCount]    lon × 1e7
 *   Int32   nodeLat[nodeCount]    lat × 1e7
 *   Uint8   nodeFlags[nodeCount]  bit0 = foreign (lives in another tile; no arcs here)
 *   Uint32  arcStart[nodeCount+1] CSR offsets into the arc arrays
 *   Uint32  arcTo[arcCount]       target node index (local index into this tile's node table)
 *   Uint16  arcLen[arcCount]      metres, capped at 65535
 *   Uint8   arcFlags[arcCount]    see ArcFlag
 *   Uint32  arcWay[arcCount]      OSM way id (fits u32 as of 2026)
 *   Uint32  arcShapeStart[arcCount], Uint32 arcShapeEnd[arcCount]   [start, end) into the shape arrays
 *   Int32   shapeLon[shapeCount], Int32 shapeLat[shapeCount]        × 1e7, intermediate points only (excludes the two endpoints)
 * Alignment: every array starts at a multiple of 8 bytes (padded).
 */
import { deflateSync, inflateSync } from 'fflate';

export const GRAPH_ZOOM = 12;
export const MAGIC = 'UFG1';

export const ArcFlag = {
  WALK: 1 << 0,
  BIKE: 1 << 1,
  DRIVE: 1 << 2,
  /** highway=steps — walkable, bikes dismount, never drive. */
  STEPS: 1 << 3,
  /** Bike must dismount (footway/pedestrian where bicycle is not explicitly allowed). */
  DISMOUNT: 1 << 4,
  /** Traverse the shared shape backwards. */
  REVERSED: 1 << 5,
  /**
   * Connector that routes but never counts: sidewalk / crossing / traffic-island footways kept
   * only so pedestrian ways reach the street grid. Cost = plain length (no novelty term), 0 new
   * metres. (Bit was reserved "R6" before the builder emitted it.)
   */
  GLUE: 1 << 6,
  /** Reserved. */
  R7: 1 << 7,
} as const;

export const NodeFlag = { FOREIGN: 1 } as const;

export type Mode = 'walk' | 'bike' | 'drive';
export const MODE_BIT: Record<Mode, number> = { walk: ArcFlag.WALK, bike: ArcFlag.BIKE, drive: ArcFlag.DRIVE };

/** Decoded tile — plain typed arrays, never per-edge objects. */
export interface GraphTile {
  zoom: number;
  tx: number;
  ty: number;
  nodeId: Float64Array;
  nodeLon: Int32Array;
  nodeLat: Int32Array;
  nodeFlags: Uint8Array;
  arcStart: Uint32Array;
  arcTo: Uint32Array;
  arcLen: Uint16Array;
  arcFlags: Uint8Array;
  arcWay: Uint32Array;
  arcShapeStart: Uint32Array;
  arcShapeEnd: Uint32Array;
  shapeLon: Int32Array;
  shapeLat: Int32Array;
}

/** Builder-side input: the same arrays as plain (growable) JS arrays. */
export interface GraphTileInput {
  zoom?: number;
  tx: number;
  ty: number;
  nodeId: ArrayLike<number>;
  nodeLon: ArrayLike<number>;
  nodeLat: ArrayLike<number>;
  nodeFlags: ArrayLike<number>;
  arcStart: ArrayLike<number>;
  arcTo: ArrayLike<number>;
  arcLen: ArrayLike<number>;
  arcFlags: ArrayLike<number>;
  arcWay: ArrayLike<number>;
  arcShapeStart: ArrayLike<number>;
  arcShapeEnd: ArrayLike<number>;
  shapeLon: ArrayLike<number>;
  shapeLat: ArrayLike<number>;
}

const HEADER_BYTES = 32;
const align8 = (n: number) => (n + 7) & ~7;

/** Encode a tile to its raw (not deflated) bytes. */
export function encodeGraphTile(t: GraphTileInput): Uint8Array {
  const n = t.nodeId.length, a = t.arcTo.length, s = t.shapeLon.length;
  if (t.arcStart.length !== n + 1) throw new Error(`arcStart must have nodeCount+1 entries (${t.arcStart.length} vs ${n + 1})`);
  const sizes = [8 * n, 4 * n, 4 * n, n, 4 * (n + 1), 4 * a, 2 * a, a, 4 * a, 4 * a, 4 * a, 4 * s, 4 * s];
  let total = HEADER_BYTES;
  const offsets: number[] = [];
  for (const sz of sizes) { offsets.push(total); total = align8(total + sz); }
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x55, 0x46, 0x47, 0x31], 0); // "UFG1"
  dv.setUint32(4, n, true); dv.setUint32(8, a, true); dv.setUint32(12, s, true);
  dv.setUint32(16, t.tx, true); dv.setUint32(20, t.ty, true); dv.setUint8(24, t.zoom ?? GRAPH_ZOOM);
  new Float64Array(buf, offsets[0], n).set(t.nodeId);
  new Int32Array(buf, offsets[1], n).set(t.nodeLon);
  new Int32Array(buf, offsets[2], n).set(t.nodeLat);
  new Uint8Array(buf, offsets[3], n).set(t.nodeFlags);
  new Uint32Array(buf, offsets[4], n + 1).set(t.arcStart);
  new Uint32Array(buf, offsets[5], a).set(t.arcTo);
  new Uint16Array(buf, offsets[6], a).set(t.arcLen);
  new Uint8Array(buf, offsets[7], a).set(t.arcFlags);
  new Uint32Array(buf, offsets[8], a).set(t.arcWay);
  new Uint32Array(buf, offsets[9], a).set(t.arcShapeStart);
  new Uint32Array(buf, offsets[10], a).set(t.arcShapeEnd);
  new Int32Array(buf, offsets[11], s).set(t.shapeLon);
  new Int32Array(buf, offsets[12], s).set(t.shapeLat);
  return u8;
}

/** Decode raw (not deflated) bytes. The returned arrays are views over a copy of the input. */
export function decodeGraphTile(raw: Uint8Array): GraphTile {
  // Copy so views are 8-byte aligned regardless of the input's byteOffset.
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error(`not a UFG1 graph tile (magic ${JSON.stringify(magic)})`);
  const n = dv.getUint32(4, true), a = dv.getUint32(8, true), s = dv.getUint32(12, true);
  const tx = dv.getUint32(16, true), ty = dv.getUint32(20, true), zoom = dv.getUint8(24);
  const sizes = [8 * n, 4 * n, 4 * n, n, 4 * (n + 1), 4 * a, 2 * a, a, 4 * a, 4 * a, 4 * a, 4 * s, 4 * s];
  let total = HEADER_BYTES;
  const o: number[] = [];
  for (const sz of sizes) { o.push(total); total = align8(total + sz); }
  if (total !== buf.byteLength) throw new Error(`graph tile size mismatch: expected ${total} bytes, got ${buf.byteLength}`);
  return {
    zoom, tx, ty,
    nodeId: new Float64Array(buf, o[0], n),
    nodeLon: new Int32Array(buf, o[1], n),
    nodeLat: new Int32Array(buf, o[2], n),
    nodeFlags: new Uint8Array(buf, o[3], n),
    arcStart: new Uint32Array(buf, o[4], n + 1),
    arcTo: new Uint32Array(buf, o[5], a),
    arcLen: new Uint16Array(buf, o[6], a),
    arcFlags: new Uint8Array(buf, o[7], a),
    arcWay: new Uint32Array(buf, o[8], a),
    arcShapeStart: new Uint32Array(buf, o[9], a),
    arcShapeEnd: new Uint32Array(buf, o[10], a),
    shapeLon: new Int32Array(buf, o[11], s),
    shapeLat: new Int32Array(buf, o[12], s),
  };
}

/** On-disk form: deflated raw bytes. */
export function packGraphTile(t: GraphTileInput): Uint8Array {
  return deflateSync(encodeGraphTile(t), { level: 9 });
}

export function unpackGraphTile(deflated: Uint8Array): GraphTile {
  return decodeGraphTile(inflateSync(deflated));
}

/** Path of a tile inside a region directory: `<region>/12/<x>/<y>.ufg`. */
export function graphTilePath(tx: number, ty: number, zoom = GRAPH_ZOOM): string {
  return `${zoom}/${tx}/${ty}.ufg`;
}

/** Region manifest published next to the tiles (`<region>/manifest.json`). */
export interface RegionManifest {
  id: string;            // e.g. 'nyc', 'vancouver'
  name: string;          // 'New York City'
  zoom: number;          // 12
  bbox: [west: number, south: number, east: number, north: number];
  tiles: Array<[tx: number, ty: number, bytes: number]>;
  builtAt: string;       // ISO date
  source: string;        // e.g. 'BBBike NewYork.osm.pbf 2026-08-29'
  stats: { nodes: number; arcs: number; km: number };
}

/** Zoom-12 tile containing a lon/lat. */
export function lonLatToGraphTile(lon: number, lat: number, zoom = GRAPH_ZOOM): [tx: number, ty: number] {
  const n = 1 << zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const la = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

export function graphTileBounds(tx: number, ty: number, zoom = GRAPH_ZOOM): { west: number; south: number; east: number; north: number } {
  const n = 1 << zoom;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / n));
  return { west: lon(tx), east: lon(tx + 1), north: lat(ty), south: lat(ty + 1) };
}
