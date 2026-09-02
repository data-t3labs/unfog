/**
 * Unfog backup format (docs/BUILD-PLAN.md §2.5): a plain zip —
 *   meta.json               { app: 'unfog', format: 1, exportedAt, stats }
 *   tiles/14_<tx>_<ty>.bin  raw 65 536 visit counts of one base tile (the zip deflates them)
 *   tracks.json             [{ id, source, name?, lon[], lat[], t[] (null = unknown), startMs?, endMs?, lengthM }]
 * Only base tiles are stored; overviews are rebuilt on import. Import semantics = merge with MAX
 * (idempotent: importing your own backup twice changes nothing).
 *
 * Memory: encode writes the zip container itself (local headers + central directory, one
 * independent `deflateSync` per entry) so only the compressed output accumulates — fflate's
 * streaming `Zip` class emitted archives that its own reader rejected ("invalid distance") once
 * more than four 64 KB entries were pushed back-to-back, so it is not used. Decode lists the
 * central directory once and inflates tiles lazily in batches of 64 (~4 MB) through a generator.
 * A phone with a 10 000-tile history never holds 640 MB of counts. No ZIP64: < 65 535 entries and
 * < 4 GB, i.e. far beyond any Fog of World history.
 */
import { deflateSync, strFromU8, strToU8, unzipSync } from 'fflate';
import { TILE_SIZE } from './cell';
import type { TrackRecord } from './db';
import type { GridStats } from './types';

export const BACKUP_APP = 'unfog';
export const BACKUP_FORMAT = 1;
const TILE_CELLS = TILE_SIZE * TILE_SIZE;
const TILE_RE = /^tiles\/(\d+)_(\d+)_(\d+)\.bin$/;
const DECODE_BATCH = 64;

export interface BackupMeta {
  app: typeof BACKUP_APP;
  format: number;
  /** ms since epoch */
  exportedAt: number;
  stats: GridStats;
}

export interface BackupTile { tx: number; ty: number; counts: Uint8Array }

/** JSON shape of a track in tracks.json (typed arrays → plain arrays, NaN → null). */
export interface BackupTrackJson {
  id: string;
  source: string;
  name?: string;
  lon: number[];
  lat: number[];
  t: Array<number | null>;
  startMs?: number;
  endMs?: number;
  lengthM: number;
}

export interface BackupInput {
  stats: GridStats;
  tiles: Iterable<BackupTile> | AsyncIterable<BackupTile>;
  tracks: TrackRecord[];
  /** Default Date.now(). */
  exportedAt?: number;
}

export interface DecodedBackup {
  meta: BackupMeta;
  /** Lazy: each iteration inflates the next batch. Iterate once. */
  tiles: Iterable<BackupTile>;
  tileCount: number;
  tracks: TrackRecord[];
}

export function trackRecordToJson(rec: TrackRecord): BackupTrackJson {
  const t: Array<number | null> = new Array(rec.t.length);
  for (let i = 0; i < rec.t.length; i++) t[i] = Number.isNaN(rec.t[i]) ? null : rec.t[i];
  const j: BackupTrackJson = { id: rec.id, source: rec.source, lon: Array.from(rec.lon), lat: Array.from(rec.lat), t, lengthM: rec.lengthM };
  if (rec.name !== undefined) j.name = rec.name;
  if (rec.startMs !== undefined) j.startMs = rec.startMs;
  if (rec.endMs !== undefined) j.endMs = rec.endMs;
  return j;
}

export function jsonToTrackRecord(j: BackupTrackJson): TrackRecord {
  const n = j.lon.length;
  if (j.lat.length !== n) throw new Error(`backup track ${j.id}: lon/lat length mismatch`);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = j.t?.[i]; t[i] = typeof v === 'number' ? v : NaN; }
  const rec: TrackRecord = { id: String(j.id), source: String(j.source ?? 'backup'), lon: Float64Array.from(j.lon), lat: Float64Array.from(j.lat), t, lengthM: Number(j.lengthM) || 0 };
  if (j.name !== undefined) rec.name = j.name;
  if (typeof j.startMs === 'number') rec.startMs = j.startMs;
  if (typeof j.endMs === 'number') rec.endMs = j.endMs;
  return rec;
}

/** Name of a backup file for a given date: unfog-backup-YYYYMMDD.zip */
export function backupFileName(when: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `unfog-backup-${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}.zip`;
}

// ---------------------------------------------------------------- minimal zip writer

let crcTable: Uint32Array | null = null;
/** CRC-32 (IEEE 802.3), the checksum zip stores per entry. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time/date pair (2-second resolution, local time) as zip stores it. */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

interface ZipEntry { name: Uint8Array; crc: number; csize: number; usize: number; offset: number }

/**
 * Streaming-friendly zip writer: each `add` deflates one entry and keeps only the compressed
 * bytes; `finish` appends the central directory. Method 8 (deflate) for every entry.
 */
class ZipWriter {
  private readonly parts: Uint8Array[] = [];
  private readonly entries: ZipEntry[] = [];
  private offset = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(mtimeMs: number) {
    const { time, date } = dosDateTime(mtimeMs);
    this.time = time;
    this.date = date;
  }

  add(name: string, data: Uint8Array): void {
    const nameBytes = strToU8(name);
    const compressed = deflateSync(data, { level: 6 });
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); // local file header signature
    v.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    v.setUint16(6, 0x0800, true); // flags: UTF-8 names
    v.setUint16(8, 8, true); // method: deflate
    v.setUint16(10, this.time, true);
    v.setUint16(12, this.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, compressed.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true); // extra length
    header.set(nameBytes, 30);
    this.entries.push({ name: nameBytes, crc, csize: compressed.length, usize: data.length, offset: this.offset });
    this.parts.push(header, compressed);
    this.offset += header.length + compressed.length;
  }

  finish(): Uint8Array {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true); // central directory signature
      v.setUint16(4, 20, true); // version made by
      v.setUint16(6, 20, true); // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 8, true);
      v.setUint16(12, this.time, true);
      v.setUint16(14, this.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.csize, true);
      v.setUint32(24, e.usize, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, 0, true); // extra
      v.setUint16(32, 0, true); // comment
      v.setUint16(34, 0, true); // disk number start
      v.setUint16(36, 0, true); // internal attributes
      v.setUint32(38, 0, true); // external attributes
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      this.parts.push(rec);
      cdSize += rec.length;
    }
    if (this.entries.length > 0xffff || cdStart + cdSize > 0xffffffff) throw new Error('backup too large for a plain zip (ZIP64 needed)');
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdStart, true);
    v.setUint16(20, 0, true);
    this.parts.push(eocd);
    const out = new Uint8Array(cdStart + cdSize + 22);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

/** Encode a backup zip. Tiles may come from an async source (IndexedDB) — they are consumed once. */
export async function encodeBackup(input: BackupInput): Promise<Uint8Array> {
  const exportedAt = input.exportedAt ?? Date.now();
  const zip = new ZipWriter(exportedAt);
  const meta: BackupMeta = { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt, stats: input.stats };
  zip.add('meta.json', strToU8(JSON.stringify(meta)));
  for await (const t of input.tiles) {
    if (t.counts.length !== TILE_CELLS) throw new Error(`backup: tile ${t.tx}/${t.ty} has ${t.counts.length} cells`);
    zip.add(`tiles/14_${t.tx}_${t.ty}.bin`, t.counts);
  }
  zip.add('tracks.json', strToU8(JSON.stringify(input.tracks.map(trackRecordToJson))));
  return zip.finish();
}

/** Parse a backup zip. Throws on anything that is not an Unfog backup. */
export function decodeBackup(bytes: Uint8Array): DecodedBackup {
  const names: string[] = [];
  unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } });
  if (!names.includes('meta.json')) throw new Error('Not an Unfog backup (meta.json missing)');
  const one = (name: string): Uint8Array | undefined => unzipSync(bytes, { filter: (f) => f.name === name })[name];
  const metaRaw = one('meta.json');
  if (!metaRaw) throw new Error('Not an Unfog backup (meta.json unreadable)');
  const meta = JSON.parse(strFromU8(metaRaw)) as Partial<BackupMeta>;
  if (meta.app !== BACKUP_APP) throw new Error('Not an Unfog backup (wrong app id)');
  if (typeof meta.format !== 'number' || meta.format > BACKUP_FORMAT) throw new Error(`Unsupported backup format ${String(meta.format)} (this app reads ≤ ${BACKUP_FORMAT})`);
  const tileNames: Array<{ name: string; tx: number; ty: number }> = [];
  for (const name of names) {
    const m = TILE_RE.exec(name);
    if (!m || Number(m[1]) !== 14) continue; // only base-level tiles are meaningful
    tileNames.push({ name, tx: Number(m[2]), ty: Number(m[3]) });
  }
  let tracks: TrackRecord[] = [];
  const tracksRaw = one('tracks.json');
  if (tracksRaw) {
    const arr = JSON.parse(strFromU8(tracksRaw)) as unknown;
    if (Array.isArray(arr)) tracks = (arr as BackupTrackJson[]).map(jsonToTrackRecord);
  }
  const fullMeta: BackupMeta = {
    app: BACKUP_APP,
    format: meta.format,
    exportedAt: typeof meta.exportedAt === 'number' ? meta.exportedAt : 0,
    stats: (meta.stats ?? { visitedCells: 0, areaM2: 0, tiles: 0, version: 0, updatedAt: 0 }) as GridStats,
  };
  function* tiles(): Generator<BackupTile> {
    for (let i = 0; i < tileNames.length; i += DECODE_BATCH) {
      const batch = tileNames.slice(i, i + DECODE_BATCH);
      const want = new Set(batch.map((b) => b.name));
      const files = unzipSync(bytes, { filter: (f) => want.has(f.name) });
      for (const b of batch) {
        const counts = files[b.name];
        if (!counts) throw new Error(`backup: ${b.name} missing`);
        if (counts.length !== TILE_CELLS) throw new Error(`backup: ${b.name} has ${counts.length} bytes, expected ${TILE_CELLS}`);
        yield { tx: b.tx, ty: b.ty, counts };
      }
    }
  }
  return { meta: fullMeta, tiles: { [Symbol.iterator]: tiles }, tileCount: tileNames.length, tracks };
}
