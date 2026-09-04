/**
 * Graph pack format ("UFP1") — coverage v2.
 *
 * A pack is one file per zoom-6 cell holding every packed (deflated) UFG1 zoom-12 tile of that
 * cell behind a small index, so a client fetches the index once and then byte-ranges only the
 * tiles it needs. GitHub release assets (and any static host) answer `Range` with HTTP 206.
 * Packs are published as assets of one GitHub release; `packs-index.json` (a `PacksIndex`)
 * maps cells → asset URL + sizes, and carries `indexBytes` so the client reads a pack's whole
 * index with ONE range request (`bytes=0-<indexBytes-1>`).
 *
 * Binary layout (little-endian):
 *   "UFP1"                            4 B
 *   u8 version (1), u8 zoom (12), u8 packZoom (6), u8 pad
 *   u32 cellX, u32 cellY              zoom-6 cell of the pack
 *   u32 tileCount
 *   u32 indexBytes                    header + entries = 32 + 16·tileCount
 *   u32 totalBytes                    whole file
 *   4 B pad                           (header = 32 B)
 *   tileCount × { u32 tx, u32 ty, u32 offset, u32 length }   absolute byte offset/length of the
 *                                     deflated UFG1 tile, entries in Morton (Z) order of (tx, ty)
 *                                     so a 5×5 neighbourhood spans few contiguous byte runs
 *   tiles                             concatenated in entry order, no padding
 * Shared by tools/build-graph (writer) and src/routing/pack-source.ts (reader); no Node APIs.
 */
import { GRAPH_ZOOM } from './graph-format';

export const PACK_MAGIC = 'UFP1';
export const PACK_VERSION = 1;
export const PACK_ZOOM = 6;
export const PACK_HEADER_BYTES = 32;
export const PACK_ENTRY_BYTES = 16;
/** Name of the top-level release asset that lists every pack. */
export const PACKS_INDEX_NAME = 'packs-index.json';

export interface PackEntry {
  tx: number;
  ty: number;
  /** Absolute byte offset of the deflated tile inside the pack file. */
  offset: number;
  length: number;
}

export interface PackIndex {
  version: number;
  zoom: number;
  packZoom: number;
  cellX: number;
  cellY: number;
  tileCount: number;
  indexBytes: number;
  totalBytes: number;
  entries: PackEntry[];
}

/** One pack's row in packs-index.json. */
export interface PackInfo {
  url: string;
  bytes: number;
  indexBytes: number;
  tiles: number;
  builtAt: string;
  /** e.g. "geofabrik us/washington 2026-09-01, us/oregon 2026-09-01" */
  source: string;
  sha256?: string;
}

export interface PacksIndex {
  version: 1;
  zoom: number;
  packZoom: number;
  builtAt: string;
  /** Release tag the assets live under, e.g. "graphs-v1". */
  release?: string;
  /** Key = cell key "6/<cx>/<cy>". */
  packs: Record<string, PackInfo>;
}

/**
 * Region table for the Data screen's "Streets near <region>" labels (src/app/pack-label.ts):
 * generated at build time from the extract manifests (tools/build-graph/region-table.ts →
 * src/routing/pack-regions.json). A pack's `source` lists every extract that touched the cell —
 * up to nine on a border cell — so the client needs to know WHICH of them the user's cached
 * tiles belong to: per multi-extract cell a z10 dominance grid (16×16 chars, row-major; each the
 * extract with the most z12 tiles in that z10 tile), plus a name / country / bbox per extract.
 */
export const LABEL_GRID_ZOOM = 10;
/** Grid character for a region index (≤ 36 regions per cell; the real maximum is nine). */
export const GRID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
export const GRID_EMPTY = '.';

export interface PackRegionInfo {
  /** Display name, e.g. "New York", "British Columbia", "Washington, DC". */
  name: string;
  /** Country tag shown after the name ("US", "CA", "MX", "GL"); "" = none. */
  cc: string;
  bbox: [west: number, south: number, east: number, north: number];
}

export interface PackRegionCell {
  /** Extract ids contributing to the cell, sorted (the order the grid characters index). */
  regions: string[];
  /** (2^(gridZoom−packZoom))² characters, row-major within the cell; GRID_EMPTY = no tile from any listed extract. */
  grid: string;
}

export interface PackRegionTable {
  version: 1;
  zoom: number;
  packZoom: number;
  gridZoom: number;
  builtAt: string;
  regions: Record<string, PackRegionInfo>;
  /** Only cells more than one extract contributes to; a single-extract cell needs no grid. */
  cells: Record<string, PackRegionCell>;
}

/** Zoom-6 cell containing a zoom-12 tile. */
export function cellOf(tx: number, ty: number, zoom = GRAPH_ZOOM, packZoom = PACK_ZOOM): [cx: number, cy: number] {
  const s = zoom - packZoom;
  return [tx >> s, ty >> s];
}

export const cellKey = (cx: number, cy: number, packZoom = PACK_ZOOM): string => `${packZoom}/${cx}/${cy}`;

/** Asset file name of a pack: `6-<cx>-<cy>.ufp`. */
export const packFileName = (cx: number, cy: number, packZoom = PACK_ZOOM): string => `${packZoom}-${cx}-${cy}.ufp`;

export function parseCellKey(key: string): [cx: number, cy: number] | null {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!m || Number(m[1]) !== PACK_ZOOM) return null;
  return [Number(m[2]), Number(m[3])];
}

/** Morton (Z-order) key of a tile coordinate pair (≤ 16 bits each). */
export function mortonKey(x: number, y: number): number {
  let k = 0;
  for (let b = 0; b < 16; b++) k += ((x >> b) & 1) * 2 ** (2 * b) + ((y >> b) & 1) * 2 ** (2 * b + 1);
  return k;
}

const MAGIC_BYTES = [0x55, 0x46, 0x50, 0x31]; // "UFP1"

/** Byte length of the header + index for `tileCount` tiles. */
export const packIndexBytes = (tileCount: number): number => PACK_HEADER_BYTES + PACK_ENTRY_BYTES * tileCount;

/**
 * Encode a pack. Tiles are sorted into Morton order; `bytes` are the deflated UFG1 tiles. Returns
 * the pack file and its parsed index (offsets as written).
 */
export function encodePack(
  cell: [cx: number, cy: number],
  tiles: Array<{ tx: number; ty: number; bytes: Uint8Array }>,
  zoom = GRAPH_ZOOM,
  packZoom = PACK_ZOOM,
): { bytes: Uint8Array; index: PackIndex } {
  const seen = new Set<string>();
  for (const t of tiles) {
    const k = `${t.tx}/${t.ty}`;
    if (seen.has(k)) throw new Error(`encodePack: duplicate tile ${k}`);
    seen.add(k);
    const [cx, cy] = cellOf(t.tx, t.ty, zoom, packZoom);
    if (cx !== cell[0] || cy !== cell[1]) throw new Error(`encodePack: tile ${k} is not in cell ${cell[0]}/${cell[1]}`);
  }
  const sorted = tiles.slice().sort((a, b) => mortonKey(a.tx, a.ty) - mortonKey(b.tx, b.ty));
  const indexBytes = packIndexBytes(sorted.length);
  let total = indexBytes;
  const entries: PackEntry[] = sorted.map((t) => {
    const e = { tx: t.tx, ty: t.ty, offset: total, length: t.bytes.length };
    total += t.bytes.length;
    return e;
  });
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  dv.setUint8(4, PACK_VERSION); dv.setUint8(5, zoom); dv.setUint8(6, packZoom);
  dv.setUint32(8, cell[0], true); dv.setUint32(12, cell[1], true);
  dv.setUint32(16, sorted.length, true);
  dv.setUint32(20, indexBytes, true);
  dv.setUint32(24, total, true);
  entries.forEach((e, i) => {
    const o = PACK_HEADER_BYTES + i * PACK_ENTRY_BYTES;
    dv.setUint32(o, e.tx, true); dv.setUint32(o + 4, e.ty, true); dv.setUint32(o + 8, e.offset, true); dv.setUint32(o + 12, e.length, true);
    out.set(sorted[i].bytes, e.offset);
  });
  return {
    bytes: out,
    index: { version: PACK_VERSION, zoom, packZoom, cellX: cell[0], cellY: cell[1], tileCount: sorted.length, indexBytes, totalBytes: total, entries },
  };
}

/**
 * Parse a pack's header + index from its first bytes (at least `indexBytes` of them; a whole
 * pack works too). Throws on a bad magic/version or a truncated index.
 */
export function parsePackIndex(bytes: Uint8Array): PackIndex {
  if (bytes.length < PACK_HEADER_BYTES) throw new Error(`pack index truncated: ${bytes.length} B`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC_BYTES[i]) throw new Error('not a UFP1 graph pack');
  const version = dv.getUint8(4);
  if (version !== PACK_VERSION) throw new Error(`unsupported pack version ${version}`);
  const zoom = dv.getUint8(5), packZoom = dv.getUint8(6);
  const cellX = dv.getUint32(8, true), cellY = dv.getUint32(12, true);
  const tileCount = dv.getUint32(16, true);
  const indexBytes = dv.getUint32(20, true), totalBytes = dv.getUint32(24, true);
  if (indexBytes !== packIndexBytes(tileCount)) throw new Error(`pack index size mismatch: ${indexBytes} vs ${packIndexBytes(tileCount)} for ${tileCount} tiles`);
  if (bytes.length < indexBytes) throw new Error(`pack index truncated: have ${bytes.length} B, need ${indexBytes}`);
  const entries: PackEntry[] = new Array(tileCount);
  for (let i = 0; i < tileCount; i++) {
    const o = PACK_HEADER_BYTES + i * PACK_ENTRY_BYTES;
    const e: PackEntry = { tx: dv.getUint32(o, true), ty: dv.getUint32(o + 4, true), offset: dv.getUint32(o + 8, true), length: dv.getUint32(o + 12, true) };
    if (e.offset < indexBytes || e.offset + e.length > totalBytes) throw new Error(`pack entry ${e.tx}/${e.ty} out of bounds`);
    entries[i] = e;
  }
  return { version, zoom, packZoom, cellX, cellY, tileCount, indexBytes, totalBytes, entries };
}

export interface ByteRange {
  /** Inclusive first byte. */
  start: number;
  /** Exclusive end. */
  end: number;
  entries: PackEntry[];
}

/**
 * Group wanted entries into byte ranges: entries are sorted by offset and two consecutive entries
 * share a request when the gap between them is ≤ `maxGap` bytes (fetching a little unused data
 * beats another round trip) and the run stays ≤ `maxRun` bytes.
 */
export function coalesceRanges(entries: PackEntry[], maxGap = 32 * 1024, maxRun = 4 * 1024 * 1024): ByteRange[] {
  const sorted = entries.slice().sort((a, b) => a.offset - b.offset);
  const out: ByteRange[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    const end = e.offset + e.length;
    if (last && e.offset - last.end <= maxGap && end - last.start <= maxRun) {
      last.end = Math.max(last.end, end);
      last.entries.push(e);
    } else {
      out.push({ start: e.offset, end, entries: [e] });
    }
  }
  return out;
}

/** HTTP `Range` header value for a range. */
export const rangeHeader = (r: { start: number; end: number }): string => `bytes=${r.start}-${r.end - 1}`;

/** Slice one entry's bytes out of a fetched range body. */
export function sliceEntry(body: Uint8Array, range: { start: number }, e: PackEntry): Uint8Array {
  const from = e.offset - range.start;
  if (from < 0 || from + e.length > body.length) throw new Error(`range body too short for tile ${e.tx}/${e.ty}`);
  return body.subarray(from, from + e.length);
}
