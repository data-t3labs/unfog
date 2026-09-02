import { readFileSync } from 'node:fs';
import { strToU8, zipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cellToLonLat, cellToTile, fowToCell } from '../grid/cell';
import type { ImportPayload } from '../grid/types';
import {
  FOW_BLOCK_SIZE,
  FOW_TILE_HEADER_SIZE,
  FowFormatError,
  classifyFowEntry,
  decodeFowFilename,
  encodeFowFilenameCore,
  fowTileXY,
  importFowArchive,
  importFowArchiveChunked,
  importFowFiles,
  importFowFilesChunked,
  isFowTileName,
  parseFowTile,
} from './fow';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/fow/${name}`, import.meta.url)));
const REAL_A = '23e4lltkkoke'; // id 117660 → (412, 229), 54 blocks, 3,757 px
const REAL_B = 'cd36lltksiwo'; // id 117659 → (411, 229), 393 blocks, 33,226 px
const HAINAN = { west: 109.36, east: 109.75, south: 18.22, north: 18.51 };

/* ---------- synthetic tile writer (written to the spec, independent of the parser) ---------- */

interface SynthBlock {
  bx: number;
  by: number;
  pixels: Array<[px: number, py: number]>;
  region?: string;
  /** Store popcount+1 to provoke a checksum mismatch. */
  badChecksum?: boolean;
}

function popcount(b: number): number {
  let n = 0;
  for (let v = b; v; v >>= 1) n += v & 1;
  return n;
}

/** Decompressed tile image: header + block records, ordinals in header order. */
function writeFowRaw(blocks: SynthBlock[]): Uint8Array {
  const sorted = [...blocks].sort((a, b) => a.by * 128 + a.bx - (b.by * 128 + b.bx));
  const raw = new Uint8Array(FOW_TILE_HEADER_SIZE + sorted.length * FOW_BLOCK_SIZE);
  const dv = new DataView(raw.buffer);
  sorted.forEach((blk, n) => {
    dv.setUint16((blk.by * 128 + blk.bx) * 2, n + 1, true);
    const off = FOW_TILE_HEADER_SIZE + n * FOW_BLOCK_SIZE;
    for (const [px, py] of blk.pixels) raw[off + py * 8 + (px >> 3)] |= 0x80 >> (px & 7);
    let pop = 0;
    for (let i = 0; i < 512; i++) pop += popcount(raw[off + i]);
    const region = blk.region ?? '??';
    const r0 = region.charCodeAt(0) - 63;
    const r1 = region.charCodeAt(1) - 63;
    const cnt = (((blk.badChecksum ? pop + 1 : pop) << 1) | 1) & 0x3fff;
    raw[off + 512] = (r0 << 3) | (r1 >> 2);
    raw[off + 513] = ((r1 & 3) << 6) | (cnt >> 8);
    raw[off + 514] = cnt & 0xff;
  });
  return raw;
}

const writeFowTile = (blocks: SynthBlock[]): Uint8Array => zlibSync(writeFowRaw(blocks));

const VAN_ID = 89680; // Vancouver z9 tile (80, 175)
const VAN_NAME = '4af3' + encodeFowFilenameCore(VAN_ID); // "4af3rikrome"

function visitedCells(p: ImportPayload): Array<[cx: number, cy: number]> {
  const out: Array<[number, number]> = [];
  for (const t of p.cellTiles ?? []) {
    for (let i = 0; i < t.counts.length; i++) {
      if (t.counts[i] !== 0) out.push([t.tx * 256 + (i & 255), t.ty * 256 + (i >> 8)]);
    }
  }
  return out;
}

function countVisited(p: ImportPayload): number {
  let n = 0;
  for (const t of p.cellTiles ?? []) for (let i = 0; i < t.counts.length; i++) if (t.counts[i] !== 0) n++;
  return n;
}

function bbox(cells: Array<[number, number]>): { west: number; east: number; south: number; north: number } {
  let west = 180, east = -180, south = 90, north = -90;
  for (const [cx, cy] of cells) {
    const [lon, lat] = cellToLonLat(cx, cy);
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return { west, east, south, north };
}

/* ---------- filenames ---------- */

describe('Fog of World filenames', () => {
  it('decodes the documented test vectors', () => {
    expect(decodeFowFilename('23e4lltkkoke')).toBe(117660);
    expect(fowTileXY(117660)).toEqual({ tileX: 412, tileY: 229 });
    expect(decodeFowFilename('e10alhwjskwk')).toBe(123456);
    expect(decodeFowFilename('4af3rikrome')).toBe(89680);
    expect(fowTileXY(89680)).toEqual({ tileX: 80, tileY: 175 });
    expect(decodeFowFilename('cd36lltksiwo')).toBe(117659);
  });

  it('encodes the core (mask 1 digits + mask 2 suffix) like fog-machine', () => {
    expect(encodeFowFilenameCore(117660)).toBe('lltkkoke');
    expect(encodeFowFilenameCore(123456)).toBe('lhwjskwk');
    expect(encodeFowFilenameCore(89680)).toBe('rikrome');
    expect(encodeFowFilenameCore(117659)).toBe('lltksiwo');
  });

  it('rejects unknown characters, out-of-range ids and non-tile names', () => {
    expect(decodeFowFilename('README.md')).toBeNull();
    expect(decodeFowFilename('FoW-Sync-Lock')).toBeNull();
    expect(decodeFowFilename('0000' + encodeFowFilenameCore(262144))).toBeNull(); // id ≥ 512·512
    expect(decodeFowFilename('0000' + encodeFowFilenameCore(262143))).toBe(262143);
    expect(decodeFowFilename('abc')).toBeNull();
  });

  it('isFowTileName validates structure: hex prefix, mask-1 core, matching mask-2 suffix', () => {
    expect(isFowTileName('23e4lltkkoke')).toBe(true);
    expect(isFowTileName('cd36lltksiwo')).toBe(true);
    expect(isFowTileName('4af3rikrome')).toBe(true);
    expect(isFowTileName('E10ALHWJSKWK'.toLowerCase())).toBe(true);
    expect(isFowTileName('23e4lltkkoki')).toBe(false); // suffix mismatch (fog-machine server's negative vector)
    expect(decodeFowFilename('23e4lltkkoki')).toBe(117660); // …but the lax decoder still reads it
    expect(isFowTileName('zzzzlltkkoke')).toBe(false); // non-hex prefix
    expect(isFowTileName('23e4olltkkoke')).toBe(false); // leading zero digit is never emitted
    expect(isFowTileName('.DS_Store')).toBe(false);
    expect(isFowTileName('FoW-Sync-Lock')).toBe(false);
    expect(isFowTileName('01abfc750a')).toBe(false); // .fwss Model/#/ metadata file
    expect(isFowTileName('track.gpx')).toBe(false);
  });
});

/* ---------- real fixtures ---------- */

describe('parseFowTile on real Sync files', () => {
  it('23e4lltkkoke → tile (412,229), 54 blocks, 3,757 visited cells, checksums valid, in Hainan', () => {
    const r = parseFowTile(REAL_A, fixture(REAL_A));
    expect(r.id).toBe(117660);
    expect(r.tileX).toBe(412);
    expect(r.tileY).toBe(229);
    expect(r.blocks).toBe(54);
    expect(r.visited).toBe(3757);
    expect(r.checksumErrors).toBe(0);
    const payload = importFowFiles([{ name: REAL_A, bytes: fixture(REAL_A) }]);
    const cells = visitedCells(payload);
    expect(cells.length).toBe(3757);
    const b = bbox(cells);
    expect(b.west).toBeGreaterThan(HAINAN.west);
    expect(b.east).toBeLessThan(HAINAN.east);
    expect(b.south).toBeGreaterThan(HAINAN.south);
    expect(b.north).toBeLessThan(HAINAN.north);
    // every base tile lies inside the z9 tile's 32×32 base-tile square
    for (const t of payload.cellTiles ?? []) {
      expect(t.tx >> 5).toBe(412);
      expect(t.ty >> 5).toBe(229);
    }
  });

  it('cd36lltksiwo → tile (411,229), 393 blocks, 33,226 visited cells, checksums valid, in Hainan', () => {
    const r = parseFowTile(REAL_B, fixture(REAL_B));
    expect(r.tileX).toBe(411);
    expect(r.tileY).toBe(229);
    expect(r.blocks).toBe(393);
    expect(r.visited).toBe(33226);
    expect(r.checksumErrors).toBe(0);
    const payload = importFowFiles([{ name: REAL_B, bytes: fixture(REAL_B) }]);
    const cells = visitedCells(payload);
    expect(cells.length).toBe(33226);
    const b = bbox(cells);
    expect(b.west).toBeGreaterThan(HAINAN.west);
    expect(b.east).toBeLessThan(HAINAN.east);
    expect(b.south).toBeGreaterThan(HAINAN.south);
    expect(b.north).toBeLessThan(HAINAN.north);
  });

  it('importFowFiles merges both into one payload of 0/1 masks with no empty tiles', () => {
    const files = [
      { name: `Sync/${REAL_A}`, bytes: fixture(REAL_A) },
      { name: REAL_B, bytes: fixture(REAL_B) },
      { name: 'FoW-Sync-Lock', bytes: new Uint8Array(0) },
    ];
    const r = importFowFiles(files, undefined, 'Sync');
    expect(r.meta).toMatchObject({ source: 'fow', fileName: 'Sync', items: 2 });
    expect(r.tilesParsed).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.visited).toBe(3757 + 33226);
    expect(r.checksumErrors).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(countVisited(r)).toBe(3757 + 33226);
    let badValues = 0;
    let emptyTiles = 0;
    let wrongSize = 0;
    for (const t of r.cellTiles) {
      if (t.counts.length !== 65536) wrongSize++;
      let any = false;
      for (let i = 0; i < t.counts.length; i++) {
        const v = t.counts[i];
        if (v !== 0 && v !== 1) badValues++;
        if (v) any = true;
      }
      if (!any) emptyTiles++;
    }
    expect({ badValues, emptyTiles, wrongSize }).toEqual({ badValues: 0, emptyTiles: 0, wrongSize: 0 });
    const keys = new Set(r.cellTiles.map((t) => `${t.tx}/${t.ty}`));
    expect(keys.size).toBe(r.cellTiles.length);
  });
});

/* ---------- synthetic round-trips ---------- */

describe('synthetic tiles (writer → parser)', () => {
  it('round-trips pixels at block edges into the right base tiles', () => {
    const blocks: SynthBlock[] = [
      { bx: 0, by: 0, pixels: [[0, 0], [63, 63], [7, 0], [8, 0], [0, 63], [63, 0]], region: 'CA' },
      { bx: 127, by: 127, pixels: [[63, 63], [0, 0]] },
      { bx: 5, by: 3, pixels: [[10, 20]], region: '@@' },
      { bx: 4, by: 3, pixels: [] }, // present but empty block: allocates nothing
    ];
    const r = parseFowTile(VAN_NAME, writeFowTile(blocks));
    expect(r.tileX).toBe(80);
    expect(r.tileY).toBe(175);
    expect(r.blocks).toBe(4);
    expect(r.visited).toBe(9);
    expect(r.checksumErrors).toBe(0);
    expect(r.touched).toBe(3);

    const expected = new Set<string>();
    for (const b of blocks) for (const [px, py] of b.pixels) expected.add(fowToCell(80, 175, b.bx, b.by, px, py).join(','));
    let setInMap = 0;
    for (const counts of r.cells.values()) for (let i = 0; i < counts.length; i++) if (counts[i]) setInMap++;
    expect(setInMap).toBe(9);

    const imported = importFowFiles([{ name: VAN_NAME, bytes: writeFowTile(blocks) }]);
    const cells = visitedCells(imported).map((c) => c.join(','));
    expect(new Set(cells)).toEqual(expected);
    // Block (5,3) → base tile (80·32 + 1, 175·32 + 0), cell offset (64 + 10, 192 + 20)
    const [cx, cy] = fowToCell(80, 175, 5, 3, 10, 20);
    const { tx, ty, ix, iy } = cellToTile(cx, cy);
    expect([tx, ty, ix, iy]).toEqual([80 * 32 + 1, 175 * 32 + 0, 64 + 10, 192 + 20]);
    expect(imported.cellTiles.find((t) => t.tx === tx && t.ty === ty)?.counts[iy * 256 + ix]).toBe(1);
  });

  it('a full 64×64 block sets exactly 4096 cells forming a solid quarter of a base tile', () => {
    const pixels: Array<[number, number]> = [];
    for (let py = 0; py < 64; py++) for (let px = 0; px < 64; px++) pixels.push([px, py]);
    const r = importFowFiles([{ name: VAN_NAME, bytes: writeFowTile([{ bx: 2, by: 1, pixels }]) }]);
    expect(r.visited).toBe(4096);
    expect(r.checksumErrors).toBe(0);
    expect(r.cellTiles.length).toBe(1);
    const t = r.cellTiles[0];
    expect([t.tx, t.ty]).toEqual([80 * 32, 175 * 32]);
    for (let iy = 0; iy < 256; iy++) {
      for (let ix = 0; ix < 256; ix++) {
        const inside = ix >= 128 && ix < 192 && iy >= 64 && iy < 128;
        if (t.counts[iy * 256 + ix] !== (inside ? 1 : 0)) throw new Error(`cell ${ix},${iy} wrong`);
      }
    }
  });

  it('counts checksum mismatches but still imports the pixels', () => {
    const bytes = writeFowTile([
      { bx: 1, by: 1, pixels: [[1, 1], [2, 2]], badChecksum: true },
      { bx: 2, by: 2, pixels: [[3, 3]] },
    ]);
    const r = parseFowTile(VAN_NAME, bytes);
    expect(r.checksumErrors).toBe(1);
    expect(r.visited).toBe(3);
    const imported = importFowFiles([{ name: VAN_NAME, bytes }]);
    expect(imported.checksumErrors).toBe(1);
    expect(countVisited(imported)).toBe(3);
    expect(imported.warnings[0]).toMatch(/checksum/);
    expect(imported.meta.note).toMatch(/checksum/);
  });

  it('an all-empty header parses as zero blocks and no cell tiles', () => {
    const r = importFowFiles([{ name: VAN_NAME, bytes: writeFowTile([]) }]);
    expect(r.tilesParsed).toBe(1);
    expect(r.cellTiles).toEqual([]);
  });

  it('skips corrupt files with a warning: non-zlib bytes, truncated stream, bad length', () => {
    const good = writeFowTile([{ bx: 1, by: 1, pixels: [[1, 1]] }]);
    const truncatedRaw = writeFowRaw([{ bx: 1, by: 1, pixels: [[1, 1]] }]).subarray(0, FOW_TILE_HEADER_SIZE + 100);
    const badLength = zlibSync(truncatedRaw);
    const junk = strToU8('this is not a tile');
    const shortRaw = zlibSync(new Uint8Array(100));
    expect(() => parseFowTile(VAN_NAME, junk)).toThrow(FowFormatError);
    expect(() => parseFowTile(VAN_NAME, badLength)).toThrow(/≠/);
    expect(() => parseFowTile(VAN_NAME, shortRaw)).toThrow(/shorter/);
    expect(() => parseFowTile('README.md', good)).toThrow(/tile name/);

    const r = importFowFiles([
      { name: VAN_NAME, bytes: junk },
      { name: 'e10alhwjskwk', bytes: badLength },
      { name: REAL_A, bytes: good.subarray(0, 20) },
      { name: REAL_B, bytes: fixture(REAL_B) },
    ]);
    expect(r.tilesParsed).toBe(1);
    expect(r.visited).toBe(33226);
    expect(r.warnings.length).toBe(3);
    expect(r.warnings.every((w) => /skipped/.test(w))).toBe(true);
    expect(r.meta.items).toBe(1);
  });
});

/* ---------- archives ---------- */

describe('importFowArchive', () => {
  const synth = writeFowTile([{ bx: 9, by: 9, pixels: [[1, 2], [3, 4]] }]);

  it('finds tiles by name under any nesting and ignores macOS/iOS junk, the lock file and Import/', () => {
    const zip = zipSync({
      'Sync/': new Uint8Array(0),
      [`Sync/${REAL_A}`]: fixture(REAL_A),
      [`Fog of World/Sync/${REAL_B}`]: fixture(REAL_B),
      [`tiles/${VAN_NAME}`]: synth,
      [`__MACOSX/Sync/._${REAL_A}`]: strToU8('AppleDouble junk'),
      'Sync/.DS_Store': strToU8('junk'),
      'Sync/FoW-Sync-Lock': new Uint8Array(0),
      'Fog of World/Import/track.gpx': strToU8('<gpx/>'),
      'Sync/README.txt': strToU8('not a tile'),
      [`Sync/_${REAL_A}`]: strToU8('underscore junk'),
    });
    const progress: string[] = [];
    const r = importFowArchive('Sync.zip', zip, (msg) => progress.push(msg));
    expect(r.tilesParsed).toBe(3);
    expect(r.visited).toBe(3757 + 33226 + 2);
    expect(r.checksumErrors).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.meta).toEqual({ source: 'fow', fileName: 'Sync.zip', items: 3 });
    expect(countVisited(r)).toBe(3757 + 33226 + 2);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('streams big archives as disjoint payload chunks whose union is the merged payload', () => {
    // three Sync tiles (distinct z9 tiles), each with one pixel in every one of its 4×4 blocks → 16 base tiles per file
    const blocks = (): SynthBlock[] => { const b: SynthBlock[] = []; for (let by = 0; by < 16; by += 4) for (let bx = 0; bx < 16; bx += 4) b.push({ bx, by, pixels: [[bx, by]] }); return b; };
    const ids = [VAN_ID, VAN_ID + 1, VAN_ID + 2];
    const files: Record<string, Uint8Array> = {};
    for (const id of ids) files[`Sync/4af3${encodeFowFilenameCore(id)}`] = writeFowTile(blocks());
    const zip = zipSync(files);
    const merged = importFowArchive('Sync.zip', zip);
    expect(merged.cellTiles).toHaveLength(48);
    expect(merged.meta.note).toBeUndefined();
    const chunks = [...importFowArchiveChunked('Sync.zip', zip, undefined, 20)];
    expect(chunks.map((c) => c.cellTiles.length)).toEqual([32, 16]); // the budget is checked after each file
    expect(chunks.map((c) => c.meta.note)).toEqual(['part 1', 'part 2 of 2']);
    expect(chunks.map((c) => c.meta.items)).toEqual([2, 1]);
    expect(chunks.map((c) => c.meta.fileName)).toEqual(['Sync.zip', 'Sync.zip']);
    const keys = chunks.flatMap((c) => c.cellTiles.map((t) => `${t.tx}/${t.ty}`));
    expect(new Set(keys).size).toBe(48);
    expect(keys.sort()).toEqual(merged.cellTiles.map((t) => `${t.tx}/${t.ty}`).sort());
    expect(chunks.reduce((n, c) => n + countVisited(c), 0)).toBe(countVisited(merged));
    // a budget that never fills → one chunk, identical to the merged import (no "part" note)
    const one = [...importFowFilesChunked(Object.entries(files).map(([name, bytes]) => ({ name, bytes })), undefined, 'Sync.zip', 1000)];
    expect(one).toHaveLength(1);
    expect(one[0].meta).toEqual(merged.meta);
    // an empty archive still yields exactly one (empty) chunk carrying the warning
    const empty = [...importFowArchiveChunked('empty.zip', zipSync({ 'README.txt': strToU8('x') }))];
    expect(empty).toHaveLength(1);
    expect(empty[0].meta.note).toContain('no Fog of World tile files');
  });

  it('imports only Model/*/ from a .fwss snapshot', () => {
    const zip = zipSync({
      [`Model/*/${REAL_A}`]: fixture(REAL_A),
      [`Model/#/${REAL_A}`]: strToU8('hash file junk'),
      [`Model/~/${REAL_A}`]: strToU8('layer file junk'),
      'Model/#/01abfc750a': strToU8('metadata junk'),
      'Model/#/3389dae361': strToU8('index junk'),
    });
    const r = importFowArchive('Snapshot.fwss', zip);
    expect(r.tilesParsed).toBe(1);
    expect(r.visited).toBe(3757);
    expect(r.warnings).toEqual([]);
  });

  it('does not descend into nested .fwss snapshots but says so', () => {
    const inner = zipSync({ [`Model/*/${REAL_A}`]: fixture(REAL_A) });
    const zip = zipSync({
      'Fog of World/Databases/Main.fwdb/snapshots/Snapshot-2026.fwss': inner,
      [`Fog of World/Sync/${REAL_B}`]: fixture(REAL_B),
    });
    const r = importFowArchive('all.zip', zip);
    expect(r.tilesParsed).toBe(1);
    expect(r.visited).toBe(33226);
    expect(r.warnings.join(' ')).toMatch(/1 \.fwss snapshot/);
    expect(r.meta.note).toMatch(/snapshot/);
  });

  it('reports an archive without any tiles', () => {
    const r = importFowArchive('photos.zip', zipSync({ 'a.txt': strToU8('x') }));
    expect(r.tilesParsed).toBe(0);
    expect(r.cellTiles).toEqual([]);
    expect(r.meta.note).toMatch(/no Fog of World tile files/);
  });

  it('throws FowFormatError on a non-zip', () => {
    expect(() => importFowArchive('x.zip', strToU8('nope'))).toThrow(FowFormatError);
  });

  it('classifyFowEntry', () => {
    expect(classifyFowEntry('Sync/')).toBe('dir');
    expect(classifyFowEntry('__MACOSX/Sync/._23e4lltkkoke')).toBe('junk');
    expect(classifyFowEntry('Sync/.DS_Store')).toBe('junk');
    expect(classifyFowEntry('Sync/FoW-Sync-Lock')).toBe('junk');
    expect(classifyFowEntry('Model/#/23e4lltkkoke')).toBe('junk');
    expect(classifyFowEntry('Model/~/23e4lltkkoke')).toBe('junk');
    expect(classifyFowEntry('Model/*/23e4lltkkoke')).toBe('tile');
    expect(classifyFowEntry('Fog of World/Import/x.gpx')).toBe('junk');
    expect(classifyFowEntry('Databases/Main.fwdb/snapshots/S.fwss')).toBe('snapshot');
    expect(classifyFowEntry('23e4lltkkoke')).toBe('tile');
    expect(classifyFowEntry('Apps/Fog of World/Sync/cd36lltksiwo')).toBe('tile');
    expect(classifyFowEntry('Sync/notes.txt')).toBe('other');
  });
});
