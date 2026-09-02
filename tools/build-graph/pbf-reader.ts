/**
 * Pure-JS OSM PBF reader (Node only — uses fs + zlib). Streams the file blob by blob with
 * `fs.readSync`, so a 150 MB extract never sits in memory at once; each blob is inflated,
 * decoded with `pbf`, and dropped.
 *
 * Wire format (https://wiki.openstreetmap.org/wiki/PBF_Format):
 *   repeated [ u32 BE headerLen ][ BlobHeader ][ Blob(datasize) ]
 *   BlobHeader { type=1 string ("OSMHeader" | "OSMData"), indexdata=2, datasize=3 }
 *   Blob       { raw=1, raw_size=2, zlib_data=3, lzma_data=4, bzip2=5, lz4=6, zstd=7 }
 *   PrimitiveBlock { stringtable=1 { s=1 repeated bytes }, primitivegroup=2 repeated,
 *                    granularity=17 (default 100), date_granularity=18, lat_offset=19, lon_offset=20 }
 *   PrimitiveGroup { nodes=1, dense=2, ways=3, relations=4, changesets=5 }
 *   DenseNodes { id=1 packed sint64 Δ, denseinfo=5, lat=8 packed sint64 Δ, lon=9 packed sint64 Δ, keys_vals=10 }
 *   Node { id=1 sint64, keys=2, vals=3, info=4, lat=8 sint64, lon=9 sint64 }
 *   Way  { id=1 int64, keys=2 packed uint32, vals=3 packed uint32, info=4, refs=8 packed sint64 Δ }
 *   lat = 1e-9 · (lat_offset + granularity · lat)
 *
 * 64-bit ids: `pbf` assembles varints as high·2^32 + low (exact below 2^53); OSM ids (~1.2e10)
 * and nanodegree deltas are far below that. pbf-reader.test.ts proves it with ids > 2^33.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PbfReader } from 'pbf';

export interface PbfVisitor {
  /** Every way carrying `wayKeyFilter` (or every way when no filter). `refs` are absolute node ids. */
  way?(id: number, tags: Record<string, string>, refs: number[]): void;
  /** Every node (dense and plain). Node tags are not decoded. */
  node?(id: number, lon: number, lat: number): void;
  /** Only report ways that have this tag key; blocks whose string table lacks it skip their ways entirely. */
  wayKeyFilter?: string;
  /** Progress: after each OSMData block. */
  block?(info: { blocks: number; bytes: number; totalBytes: number }): void;
}

export interface PbfReadStats { blocks: number; bytes: number; ways: number; nodes: number; headerFeatures: string[] }

export interface PbfBlob { type: string; data: Uint8Array }

const utf8 = new TextDecoder('utf-8');

/** Iterate the blobs of a PBF file (path) or an in-memory buffer, inflating zlib blobs. */
export function* readBlobs(source: string | Uint8Array): Generator<PbfBlob, void, void> {
  const src = typeof source === 'string' ? new FileSource(source) : new MemorySource(source);
  try {
    const lenBuf = new Uint8Array(4);
    for (;;) {
      const n = src.read(lenBuf, 4);
      if (n === 0) return;
      if (n < 4) throw new Error('PBF: truncated blob header length');
      const headerLen = ((lenBuf[0] << 24) | (lenBuf[1] << 16) | (lenBuf[2] << 8) | lenBuf[3]) >>> 0;
      if (headerLen > 64 * 1024) throw new Error(`PBF: BlobHeader too large (${headerLen})`);
      const headerBytes = new Uint8Array(headerLen);
      if (src.read(headerBytes, headerLen) < headerLen) throw new Error('PBF: truncated BlobHeader');
      const header = new PbfReader(headerBytes).readFields(readBlobHeader, { type: '', datasize: 0 });
      if (header.datasize > 32 * 1024 * 1024) throw new Error(`PBF: Blob too large (${header.datasize})`);
      const blobBytes = new Uint8Array(header.datasize);
      if (src.read(blobBytes, header.datasize) < header.datasize) throw new Error('PBF: truncated Blob');
      yield { type: header.type, data: decodeBlob(blobBytes) };
    }
  } finally {
    src.close();
  }
}

function readBlobHeader(tag: number, r: { type: string; datasize: number }, p: PbfReader): void {
  if (tag === 1) r.type = p.readString();
  else if (tag === 3) r.datasize = p.readVarint();
}

function decodeBlob(bytes: Uint8Array): Uint8Array {
  const b = new PbfReader(bytes).readFields(
    (tag, r: { raw?: Uint8Array; rawSize: number; zlib?: Uint8Array; other?: number }, p) => {
      if (tag === 1) r.raw = p.readBytes();
      else if (tag === 2) r.rawSize = p.readVarint();
      else if (tag === 3) r.zlib = p.readBytes();
      else if (tag >= 4 && tag <= 7) r.other = tag;
    },
    { rawSize: 0 },
  );
  if (b.raw) return b.raw;
  if (b.zlib) {
    const out = inflateSync(b.zlib);
    if (b.rawSize && out.length !== b.rawSize) throw new Error(`PBF: inflated ${out.length} bytes, expected raw_size ${b.rawSize}`);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  const name = { 4: 'lzma', 5: 'bzip2', 6: 'lz4', 7: 'zstd' }[b.other ?? 0] ?? 'unknown';
  throw new Error(`PBF: unsupported blob compression (${name}); re-encode with zlib (osmium cat --output-format pbf,pbf_compression=zlib)`);
}

/** Read every block, dispatching ways / nodes to the visitor. Returns counts of what was reported. */
export function readOsmPbf(source: string | Uint8Array, visitor: PbfVisitor): PbfReadStats {
  const stats: PbfReadStats = { blocks: 0, bytes: 0, ways: 0, nodes: 0, headerFeatures: [] };
  const totalBytes = typeof source === 'string' ? FileSource.size(source) : source.byteLength;
  const wantWays = !!visitor.way, wantNodes = !!visitor.node;
  const filterKey = visitor.wayKeyFilter !== undefined ? new TextEncoder().encode(visitor.wayKeyFilter) : undefined;
  for (const blob of readBlobs(source)) {
    stats.bytes += blob.data.byteLength;
    if (blob.type === 'OSMHeader') {
      stats.headerFeatures = readHeaderFeatures(blob.data);
      continue;
    }
    if (blob.type !== 'OSMData') continue;
    stats.blocks++;
    decodePrimitiveBlock(blob.data, visitor, wantWays, wantNodes, filterKey, stats);
    visitor.block?.({ blocks: stats.blocks, bytes: stats.bytes, totalBytes });
  }
  return stats;
}

function readHeaderFeatures(data: Uint8Array): string[] {
  const features: string[] = [];
  new PbfReader(data).readFields((tag, _r, p) => { if (tag === 4) features.push(p.readString()); }, features);
  const missing = features.filter((f) => f !== 'OsmSchema-V0.6' && f !== 'DenseNodes' && f !== 'Sort.Type_then_ID' && !f.startsWith('timestamp=') && !f.startsWith('Has_Metadata'));
  if (missing.length) throw new Error(`PBF: unsupported required_features ${missing.join(', ')}`);
  return features;
}

interface BlockState {
  strings: Array<Uint8Array | string>;
  groups: Uint8Array[];
  granularity: number;
  latOffset: number;
  lonOffset: number;
}

function decodePrimitiveBlock(data: Uint8Array, visitor: PbfVisitor, wantWays: boolean, wantNodes: boolean, filterKey: Uint8Array | undefined, stats: PbfReadStats): void {
  const block = new PbfReader(data).readFields(
    (tag, b: BlockState, p) => {
      if (tag === 1) p.readMessage((t, s: Array<Uint8Array | string>, q) => { if (t === 1) s.push(q.readBytes()); }, b.strings);
      else if (tag === 2) b.groups.push(p.readBytes());
      else if (tag === 17) b.granularity = p.readVarint();
      else if (tag === 19) b.latOffset = p.readVarint(true);
      else if (tag === 20) b.lonOffset = p.readVarint(true);
    },
    { strings: [], groups: [], granularity: 100, latOffset: 0, lonOffset: 0 },
  );
  // Fast path: a block whose string table lacks the filter key has no wanted ways.
  let filterIdx = -1;
  if (wantWays && filterKey) {
    for (let i = 0; i < block.strings.length; i++) if (bytesEqual(block.strings[i] as Uint8Array, filterKey)) { filterIdx = i; break; }
  }
  const decodeWays = wantWays && (!filterKey || filterIdx >= 0);
  const str = (i: number): string => {
    const s = block.strings[i];
    if (typeof s === 'string') return s;
    const d = utf8.decode(s);
    block.strings[i] = d;
    return d;
  };
  const scale = block.granularity * 1e-9, latOff = block.latOffset * 1e-9, lonOff = block.lonOffset * 1e-9;

  for (const g of block.groups) {
    new PbfReader(g).readFields((tag, _r, p) => {
      if (tag === 1 && wantNodes) readPlainNode(p, visitor, scale, latOff, lonOff, stats);
      else if (tag === 2 && wantNodes) readDenseNodes(p, visitor, scale, latOff, lonOff, stats);
      else if (tag === 3 && decodeWays) readWay(p, visitor, str, filterIdx, stats);
    }, null);
  }
}

interface WayState { id: number; keys: number[]; vals: number[]; refs: number[]; wanted: boolean | undefined }

function readWay(p: PbfReader, visitor: PbfVisitor, str: (i: number) => string, filterIdx: number, stats: PbfReadStats): void {
  const w = p.readMessage((tag, w: WayState, q) => {
    if (tag === 1) w.id = q.readVarint(true);
    else if (tag === 2) { q.readPackedVarint(w.keys); w.wanted = filterIdx < 0 || w.keys.includes(filterIdx); }
    else if (tag === 3) q.readPackedVarint(w.vals);
    else if (tag === 8 && w.wanted !== false) q.readPackedSVarint(w.refs);
  }, { id: 0, keys: [], vals: [], refs: [], wanted: undefined });
  if (w.wanted === false) return;
  const tags: Record<string, string> = {};
  for (let i = 0; i < w.keys.length; i++) tags[str(w.keys[i])] = str(w.vals[i]);
  const refs = w.refs;
  for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
  stats.ways++;
  visitor.way!(w.id, tags, refs);
}

interface DenseState { ids: number[]; lats: number[]; lons: number[] }

function readDenseNodes(p: PbfReader, visitor: PbfVisitor, scale: number, latOff: number, lonOff: number, stats: PbfReadStats): void {
  const d = p.readMessage((tag, d: DenseState, q) => {
    if (tag === 1) q.readPackedSVarint(d.ids);
    else if (tag === 8) q.readPackedSVarint(d.lats);
    else if (tag === 9) q.readPackedSVarint(d.lons);
  }, { ids: [], lats: [], lons: [] });
  const n = d.ids.length;
  if (d.lats.length !== n || d.lons.length !== n) throw new Error('PBF: DenseNodes id/lat/lon length mismatch');
  let id = 0, lat = 0, lon = 0;
  const node = visitor.node!;
  for (let i = 0; i < n; i++) {
    id += d.ids[i]; lat += d.lats[i]; lon += d.lons[i];
    node(id, lonOff + scale * lon, latOff + scale * lat);
  }
  stats.nodes += n;
}

function readPlainNode(p: PbfReader, visitor: PbfVisitor, scale: number, latOff: number, lonOff: number, stats: PbfReadStats): void {
  const n = p.readMessage((tag, n: { id: number; lat: number; lon: number }, q) => {
    if (tag === 1) n.id = q.readSVarint();
    else if (tag === 8) n.lat = q.readSVarint();
    else if (tag === 9) n.lon = q.readSVarint();
  }, { id: 0, lat: 0, lon: 0 });
  stats.nodes++;
  visitor.node!(n.id, lonOff + scale * n.lon, latOff + scale * n.lat);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ByteSource { read(into: Uint8Array, n: number): number; close(): void }

class FileSource implements ByteSource {
  private fd: number;
  private pos = 0;
  constructor(path: string) { this.fd = openSync(path, 'r'); }
  static size(path: string): number { const fd = openSync(path, 'r'); try { return fstatSync(fd).size; } finally { closeSync(fd); } }
  read(into: Uint8Array, n: number): number {
    let got = 0;
    while (got < n) {
      const r = readSync(this.fd, into, got, n - got, this.pos + got);
      if (r === 0) break;
      got += r;
    }
    this.pos += got;
    return got;
  }
  close(): void { closeSync(this.fd); }
}

class MemorySource implements ByteSource {
  private pos = 0;
  constructor(private buf: Uint8Array) {}
  read(into: Uint8Array, n: number): number {
    const take = Math.min(n, this.buf.length - this.pos);
    into.set(this.buf.subarray(this.pos, this.pos + take), 0);
    this.pos += take;
    return take;
  }
  close(): void { /* nothing */ }
}
