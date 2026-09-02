/**
 * Fog of World importer — Sync folder tile files (bare or zipped) and `.fwss` snapshots.
 *
 * Format (verified on real files; research: task artifact `research/fow-research.md` §2):
 *   filename  = md5(id)[0:4] + digits(id) mapped through "olhwjsktri" + last two digits mapped
 *               through "eizxdwknmo";  id = tileY·512 + tileX  (z9 Web-Mercator tile)
 *   file      = zlib stream →
 *               32768-byte header: 128×128 little-endian uint16, entry i (blockY = i>>7,
 *               blockX = i&127) = 0 when absent, else the 1-based ordinal of the block record;
 *               then N × 515-byte block records: 512-byte 64×64 bitmap (row-major, 8 bytes per
 *               row, MSB = leftmost pixel) + 3 extra bytes (2-char region in the top 10 bits,
 *               13-bit popcount checksum = (uint16BE(bytes 1..2) & 0x3fff) >> 1).
 *   pixel     = z22 cell: gx = (tileX<<13)|(blockX<<6)|px (see src/grid/cell.ts `fowToCell`).
 *
 * Runs inside the grid worker and in Node tests: fflate only, no DOM, no Node APIs.
 */
import { unzipSync, unzlibSync } from 'fflate';
import { TILE_SIZE, parseTileKey, tileKey } from '../grid/cell';
import type { CellCounts, ImportPayload } from '../grid/types';
import { type InputFile, basename } from './util';

export const FOW_MASK1 = 'olhwjsktri';
export const FOW_MASK2 = 'eizxdwknmo';
/** World = 512×512 z9 tiles. */
export const FOW_MAP_WIDTH = 512;
/** Tile = 128×128 blocks. */
export const FOW_TILE_WIDTH = 128;
/** Block = 64×64 pixels. */
export const FOW_BLOCK_WIDTH = 64;
const HEADER_ENTRIES = FOW_TILE_WIDTH * FOW_TILE_WIDTH; // 16384
export const FOW_TILE_HEADER_SIZE = HEADER_ENTRIES * 2; // 32768
export const FOW_BLOCK_BITMAP_SIZE = 512;
export const FOW_BLOCK_SIZE = FOW_BLOCK_BITMAP_SIZE + 3; // 515
const MAX_ID = FOW_MAP_WIDTH * FOW_MAP_WIDTH; // 262144
/** Blocks per base (z14) tile side: 256 cells / 64 px. */
const BLOCKS_PER_TILE_SHIFT = 2;
/** z9 tile → z14 tile shift (5 zoom levels). */
const TILE_TO_BASE_SHIFT = 5;

const MASK1_INDEX: Record<string, number> = {};
for (let i = 0; i < FOW_MASK1.length; i++) MASK1_INDEX[FOW_MASK1[i]] = i;

const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

export class FowFormatError extends Error {
  override name = 'FowFormatError';
}

/**
 * Lax filename decode: drop the 4-char md5 prefix and the 2-char suffix, map the rest through
 * the digit mask. `null` when a character is not in the mask or the id is out of range.
 * (The md5 prefix is deliberately not checked — no md5 dependency; see {@link isFowTileName}.)
 */
export function decodeFowFilename(name: string): number | null {
  if (name.length < 7) return null;
  let id = 0;
  for (let i = 4; i < name.length - 2; i++) {
    const d = MASK1_INDEX[name[i]];
    if (d === undefined) return null;
    id = id * 10 + d;
    if (id >= MAX_ID) return null;
  }
  return id;
}

/**
 * The part of a tile filename after the md5 prefix: id digits through mask 1, then the last
 * two digits through mask 2 (exactly fog-machine's encoder; ids < 10 get a 1-char suffix).
 */
export function encodeFowFilenameCore(id: number): string {
  const digits = String(id);
  let a = '';
  let b = '';
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - 48;
    a += FOW_MASK1[d];
    b += FOW_MASK2[d];
  }
  return a + b.slice(-2);
}

/**
 * Structural test for a Sync tile filename: 4 hex chars, a mask-1 core that decodes to a valid
 * id, and a suffix equal to mask 2 of the id's last two digits. Rejects "23e4lltkkoki"
 * (bad suffix) like fog-machine's server does, without needing md5.
 */
export function isFowTileName(name: string): boolean {
  if (name.length < 8 || name.length > 12) return false;
  for (let i = 0; i < 4; i++) {
    const c = name.charCodeAt(i);
    const hex = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!hex) return false;
  }
  const id = decodeFowFilename(name);
  if (id === null) return false;
  return name.slice(4) === encodeFowFilenameCore(id);
}

/** z9 tile coordinates of a tile id. */
export function fowTileXY(id: number): { tileX: number; tileY: number } {
  return { tileX: id % FOW_MAP_WIDTH, tileY: Math.floor(id / FOW_MAP_WIDTH) };
}

export type FowEntryKind = 'tile' | 'snapshot' | 'junk' | 'dir' | 'other';

const MODEL_JUNK_RE = /(^|[\\/])Model[\\/][#~][\\/]/;
const MODEL_TILE_RE = /(^|[\\/])Model[\\/]\*[\\/]/;
const IMPORT_DIR_RE = /(^|[\\/])Import[\\/]/;

/** Names that show up next to tiles but are never tiles (skipped silently by every importer). */
export function isFowJunkName(base: string): boolean {
  return base.length === 0 || base[0] === '.' || base[0] === '_' || base === 'FoW-Sync-Lock' || base === 'Thumbs.db';
}

/**
 * Classify a zip entry path for the Fog of World importer. Tiles are matched by NAME wherever
 * they sit (Sync/, Fog of World/Sync/, tiles/, root, Model/*\/) — never by path.
 */
export function classifyFowEntry(path: string): FowEntryKind {
  if (path.endsWith('/') || path.endsWith('\\')) return 'dir';
  if (path.includes('__MACOSX/')) return 'junk';
  const base = basename(path);
  if (isFowJunkName(base)) return 'junk';
  if (MODEL_JUNK_RE.test(path)) return 'junk';
  if (IMPORT_DIR_RE.test(path)) return 'junk';
  if (base.toLowerCase().endsWith('.fwss')) return 'snapshot';
  if (isFowTileName(base)) return 'tile';
  if (MODEL_TILE_RE.test(path) && decodeFowFilename(base) !== null) return 'tile';
  return 'other';
}

export interface FowTileResult {
  id: number;
  tileX: number;
  tileY: number;
  /** Block records present in the file. */
  blocks: number;
  /** Visited pixels (= cells) in this file. */
  visited: number;
  /** Blocks whose stored popcount disagrees with the bitmap (still imported). */
  checksumErrors: number;
  /**
   * Base (z14) cell tiles, keyed by `tileKey(14, tx, ty)`, values = 0/1 masks. When `into` was
   * passed this is that same map (the caller accumulates across files).
   */
  cells: Map<number, CellCounts>;
  /** Number of base tiles this file wrote pixels into. */
  touched: number;
}

/**
 * Parse one Sync tile file. Throws {@link FowFormatError} for a bad name, a non-zlib stream or
 * a decompressed size that does not equal 32768 + max(ordinal)·515 (corrupt/truncated file).
 * Cells are marked into `into` (or a fresh map): one Uint8Array(65536) per touched base tile.
 */
export function parseFowTile(name: string, bytes: Uint8Array, into?: Map<number, CellCounts>): FowTileResult {
  const base = basename(name);
  const id = decodeFowFilename(base);
  if (id === null) throw new FowFormatError(`${base}: not a Fog of World tile name`);
  const { tileX, tileY } = fowTileXY(id);

  let raw: Uint8Array;
  try {
    raw = unzlibSync(bytes);
  } catch (e) {
    throw new FowFormatError(`${base}: not a zlib stream (${(e as Error).message ?? e})`);
  }
  if (raw.length < FOW_TILE_HEADER_SIZE) {
    throw new FowFormatError(`${base}: decompressed size ${raw.length} is shorter than the ${FOW_TILE_HEADER_SIZE}-byte header`);
  }
  let maxOrd = 0;
  for (let i = 0; i < HEADER_ENTRIES; i++) {
    const ord = raw[2 * i] | (raw[2 * i + 1] << 8);
    if (ord > maxOrd) maxOrd = ord;
  }
  const expected = FOW_TILE_HEADER_SIZE + maxOrd * FOW_BLOCK_SIZE;
  if (raw.length !== expected) {
    throw new FowFormatError(`${base}: decompressed size ${raw.length} ≠ ${expected} expected for ${maxOrd} block(s)`);
  }

  const cells = into ?? new Map<number, CellCounts>();
  const touchedKeys = new Set<number>();
  let blocks = 0;
  let visited = 0;
  let checksumErrors = 0;

  for (let i = 0; i < HEADER_ENTRIES; i++) {
    const ord = raw[2 * i] | (raw[2 * i + 1] << 8);
    if (ord === 0) continue;
    const bx = i & (FOW_TILE_WIDTH - 1);
    const by = i >> 7;
    const off = FOW_TILE_HEADER_SIZE + (ord - 1) * FOW_BLOCK_SIZE;

    // The block sits wholly inside one base tile: 4×4 blocks per 256×256 tile.
    const tx = (tileX << TILE_TO_BASE_SHIFT) | (bx >> BLOCKS_PER_TILE_SHIFT);
    const ty = (tileY << TILE_TO_BASE_SHIFT) | (by >> BLOCKS_PER_TILE_SHIFT);
    const ox = (bx & 3) << 6;
    const oy = (by & 3) << 6;
    const key = tileKey(14, tx, ty);
    let counts = cells.get(key);
    let pop = 0;

    for (let py = 0; py < FOW_BLOCK_WIDTH; py++) {
      const rowOff = off + py * 8;
      let rowBase = -1;
      for (let b = 0; b < 8; b++) {
        const byte = raw[rowOff + b];
        if (byte === 0) continue;
        if (counts === undefined) {
          counts = new Uint8Array(TILE_SIZE * TILE_SIZE);
          cells.set(key, counts);
        }
        if (rowBase < 0) {
          rowBase = (oy + py) * TILE_SIZE + ox;
          touchedKeys.add(key);
        }
        pop += POPCOUNT[byte];
        const p = rowBase + (b << 3);
        if (byte & 0x80) counts[p] = 1;
        if (byte & 0x40) counts[p + 1] = 1;
        if (byte & 0x20) counts[p + 2] = 1;
        if (byte & 0x10) counts[p + 3] = 1;
        if (byte & 0x08) counts[p + 4] = 1;
        if (byte & 0x04) counts[p + 5] = 1;
        if (byte & 0x02) counts[p + 6] = 1;
        if (byte & 0x01) counts[p + 7] = 1;
      }
    }

    blocks++;
    visited += pop;
    const stored = (((raw[off + 513] << 8) | raw[off + 514]) & 0x3fff) >> 1;
    if (stored !== pop) checksumErrors++;
  }

  return { id, tileX, tileY, blocks, visited, checksumErrors, cells, touched: touchedKeys.size };
}

export type ProgressFn = (msg: string, done: number, total: number) => void;

/** An {@link ImportPayload} plus the import statistics the Data screen shows. */
export interface FowImportResult extends ImportPayload {
  cellTiles: Array<{ tx: number; ty: number; counts: CellCounts }>;
  /** Tile files parsed successfully. */
  tilesParsed: number;
  /** Visited cells across all parsed tiles (before merging duplicates). */
  visited: number;
  checksumErrors: number;
  /** Files that were skipped because their name is not a tile name. */
  skipped: number;
  /** Human-readable warnings (corrupt files, checksum mismatches, ignored snapshots). */
  warnings: string[];
}

const MAX_WARNINGS = 25;

/**
 * Import any number of bare Sync tile files (e.g. the user multi-selected the Sync folder's
 * contents). Non-tile names are ignored, corrupt tiles skipped with a warning, all cells
 * merged into one payload (`count = 1` per visited cell, only tiles that received a pixel).
 */
export function importFowFiles(files: InputFile[], onProgress?: ProgressFn, fileName?: string): FowImportResult {
  const cells = new Map<number, CellCounts>();
  const warnings: string[] = [];
  let tilesParsed = 0;
  let visited = 0;
  let checksumErrors = 0;
  let skipped = 0;
  let dropped = 0;

  const warn = (msg: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(msg);
    else dropped++;
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const base = basename(f.name);
    onProgress?.(`Reading ${base}`, i, files.length);
    if (!isFowTileName(base) && !(MODEL_TILE_RE.test(f.name) && decodeFowFilename(base) !== null)) {
      skipped++;
      continue;
    }
    try {
      const r = parseFowTile(base, f.bytes, cells);
      tilesParsed++;
      visited += r.visited;
      checksumErrors += r.checksumErrors;
      if (r.checksumErrors > 0) warn(`${base}: ${r.checksumErrors} block checksum mismatch(es), imported anyway`);
    } catch (e) {
      warn(`${base}: skipped — ${(e as Error).message}`);
    }
  }
  if (dropped > 0) warnings.push(`…and ${dropped} more warning(s)`);
  onProgress?.('Assembling cells', files.length, files.length);

  const cellTiles: FowImportResult['cellTiles'] = [];
  for (const [key, counts] of cells) {
    const { tx, ty } = parseTileKey(key);
    cellTiles.push({ tx, ty, counts });
  }

  const noteParts: string[] = [];
  if (skipped > 0) noteParts.push(`${skipped} non-tile file(s) ignored`);
  if (warnings.length > 0) noteParts.push(...warnings);
  const meta: ImportPayload['meta'] = { source: 'fow', items: tilesParsed };
  if (fileName !== undefined) meta.fileName = fileName;
  if (noteParts.length > 0) meta.note = noteParts.join('; ');

  return { cellTiles, meta, tilesParsed, visited, checksumErrors, skipped, warnings };
}

/**
 * Import a `.zip` of the Sync folder (any nesting, macOS/iOS junk tolerated, `Import/` GPX
 * ignored) or a `.fwss` snapshot (`Model/*\/` entries only). Only tile entries are inflated.
 * Snapshots nested inside a zip are not parsed (each is a whole database copy) — a warning
 * asks the user to import them separately.
 */
export function importFowArchive(name: string, bytes: Uint8Array, onProgress?: ProgressFn): FowImportResult {
  let snapshots = 0;
  let entries: Record<string, Uint8Array>;
  onProgress?.(`Opening ${name}`, 0, 1);
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        const kind = classifyFowEntry(f.name);
        if (kind === 'snapshot') snapshots++;
        return kind === 'tile';
      },
    });
  } catch (e) {
    throw new FowFormatError(`${name}: cannot read archive (${(e as Error).message ?? e})`);
  }
  const files: InputFile[] = [];
  for (const path in entries) files.push({ name: path, bytes: entries[path] });
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const result = importFowFiles(files, onProgress, name);
  if (snapshots > 0) {
    const w = `${snapshots} .fwss snapshot(s) inside the archive were not imported — import them separately`;
    result.warnings.push(w);
    result.meta.note = result.meta.note ? `${result.meta.note}; ${w}` : w;
  }
  if (files.length === 0) {
    const w = 'no Fog of World tile files found in the archive';
    result.warnings.push(w);
    result.meta.note = result.meta.note ? `${result.meta.note}; ${w}` : w;
  }
  return result;
}

/** True when a list of zip entry paths contains at least one Fog of World tile. */
export function hasFowTileEntries(paths: Iterable<string>): boolean {
  for (const p of paths) if (classifyFowEntry(p) === 'tile') return true;
  return false;
}
