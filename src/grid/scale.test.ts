/**
 * Scale checks on a real Fog of World Sync archive (MemoLanes' fow_3.zip, 213 tiles, GPL-3 —
 * never vendored). Skipped when the file is absent: set UNFOG_FOW3_ZIP=/path/to/fow_3.zip.
 * One new test file: guards import/apply/backup at a realistic size, which the fixtures cannot.
 */
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { importFiles } from '../import/detect';
import { importFowArchive, importFowArchiveChunked } from '../import/fow';
import { tileBounds } from './cell';
import { CellStore, TILE_CELLS } from './store';

const ZIP = process.env.UNFOG_FOW3_ZIP ?? '/private/tmp/claude-501/-Users-gvw-macbookpro23--openclaw-workspace/e5b02fb7-1438-4a39-826a-74ad50c784f7/scratchpad/fow_3.zip';
const have = existsSync(ZIP);

let n = 0;
const open: CellStore[] = [];
function store(opts: { cacheTiles?: number; flushEvery?: number } = {}): CellStore {
  const s = new CellStore({ dbName: `unfog-scale-${Date.now()}-${n++}`, ...opts });
  open.push(s);
  return s;
}
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });

describe.skipIf(!have)('fow_3.zip (213 real Sync tiles)', () => {
  const bytes = have ? new Uint8Array(readFileSync(ZIP)) : new Uint8Array(0);

  it('parses to 0/1 base tiles of one region, streams in bounded chunks, applies in bounded time, and re-import is a no-op', async () => {
    const t0 = performance.now();
    const r = importFowArchive('fow_3.zip', bytes);
    const parseMs = performance.now() - t0;
    expect(r.tilesParsed).toBe(213);
    expect(r.warnings).toEqual([]);
    expect(r.cellTiles.length).toBeGreaterThan(200);
    let cells = 0;
    const bbox = { west: 180, east: -180, south: 90, north: -90 };
    for (const ct of r.cellTiles) {
      expect(ct.counts.length).toBe(TILE_CELLS);
      const b = tileBounds(14, ct.tx, ct.ty);
      bbox.west = Math.min(bbox.west, b.west); bbox.east = Math.max(bbox.east, b.east);
      bbox.south = Math.min(bbox.south, b.south); bbox.north = Math.max(bbox.north, b.north);
      let any = false;
      for (let i = 0; i < TILE_CELLS; i++) { const v = ct.counts[i]; if (v > 1) throw new Error('count > 1 in a FoW mask'); if (v) any = true; }
      expect(any).toBe(true);
      cells += ct.counts.length;
    }
    // eslint-disable-next-line no-console
    console.log(`fow_3.zip: ${r.tilesParsed} tiles → ${r.cellTiles.length} base tiles (${(cells / 1048576).toFixed(0)} MB of counts), ${r.visited} visited cells, parse ${parseMs.toFixed(0)} ms, bbox ${JSON.stringify(bbox)}`);
    // a real person's Sync folder spans the world; every tile must still be inside it
    expect(bbox.west).toBeGreaterThanOrEqual(-180); expect(bbox.east).toBeLessThanOrEqual(180);
    expect(bbox.south).toBeGreaterThan(-85); expect(bbox.north).toBeLessThan(85);

    // streamed: chunks of ≤ 256 (+ one file's worth) base tiles, disjoint, applied one at a time
    const s = store();
    const t1 = performance.now();
    let chunks = 0, maxChunk = 0, touched = 0, sumItems = 0;
    const seen = new Set<string>();
    let a1 = await s.getStats();
    for (const chunk of importFowArchiveChunked('fow_3.zip', bytes)) {
      chunks++;
      maxChunk = Math.max(maxChunk, chunk.cellTiles.length);
      sumItems += chunk.meta.items;
      for (const ct of chunk.cellTiles) { const k = `${ct.tx}/${ct.ty}`; expect(seen.has(k), `base tile ${k} in two chunks`).toBe(false); seen.add(k); }
      const res = await s.applyPayload(chunk);
      touched += res.touched.length;
      a1 = res.stats;
    }
    const applyMs = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`streamed applyPayload: ${chunks} chunks (largest ${maxChunk} base tiles), ${applyMs.toFixed(0)} ms, ${a1.tiles} tiles, ${a1.visitedCells} cells, ${(a1.areaM2 / 1e6).toFixed(2)} km²`);
    expect(chunks).toBeGreaterThan(10);
    expect(maxChunk).toBeLessThanOrEqual(256 + 1024);
    expect(sumItems).toBe(213);
    expect(a1.visitedCells).toBe(r.visited);
    expect(a1.tiles).toBe(r.cellTiles.length);
    expect(touched).toBe(r.cellTiles.length);
    expect(applyMs).toBeLessThan(60_000);

    const a2 = await s.applyPayload(importFowArchive('fow_3.zip', bytes));
    expect(a2.stats.visitedCells).toBe(a1.visitedCells);
    expect(a2.stats.areaM2).toBe(a1.areaM2);
    expect(a2.stats.tiles).toBe(a1.tiles);
    expect(a2.stats.version).toBe(a1.version + 1); // an import always bumps (provenance row)
    expect(a2.touched).toEqual([]);
    expect((await s.listBaseTiles()).length).toBe(a1.tiles);
    expect((await s.rebuildStats()).visitedCells).toBe(a1.visitedCells);
  }, 300_000);

  it('detect streams the zip as FoW payload chunks through onOutcome and releases them', async () => {
    let delivered = 0, items = 0, alive = 0;
    const outcomes = await importFiles([{ name: 'fow_3.zip', bytes }], undefined, {
      onOutcome: (o) => { delivered++; if (o.kind === 'payload') { items += o.payload.meta.items; alive = Math.max(alive, o.payload.cellTiles?.length ?? 0); } },
    });
    expect(delivered).toBeGreaterThan(10);
    expect(outcomes).toHaveLength(delivered);
    expect(items).toBe(213);
    expect(alive).toBeLessThanOrEqual(256 + 1024);
    for (const o of outcomes) { expect(o.kind).toBe('payload'); if (o.kind === 'payload') { expect(o.payload.cellTiles).toEqual([]); expect(o.payload.meta.source).toBe('fow'); } }
  }, 60_000);

  it('backup export → import round-trips every tile and track; a corrupted zip is an error, not a crash', async () => {
    const a = store();
    await a.applyPayload(importFowArchive('fow_3.zip', bytes));
    await a.markTrack({ id: 'walk-1', source: 'session', name: 'Test walk', points: [[113.9, 22.55, 1_700_000_000_000], [113.905, 22.55, 1_700_000_300_000]] });
    const statsA = await a.getStats();
    const t0 = performance.now();
    const zip = await a.exportBackup();
    const exportMs = performance.now() - t0;
    const meta = strFromU8(unzipSync(zip, { filter: (f) => f.name === 'meta.json' })['meta.json']);
    expect(meta).toContain('"app":"unfog"'); // detect.ts recognises backups by this text
    const outcomes = await importFiles([{ name: 'unfog-backup-20260902.zip', bytes: zip }]);
    expect(outcomes[0].kind).toBe('backup');

    const b = store({ cacheTiles: 32, flushEvery: 8 });
    const t1 = performance.now();
    const r = await b.importBackup(zip);
    const importMs = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`backup: ${(zip.length / 1024).toFixed(0)} KB, export ${exportMs.toFixed(0)} ms, import ${importMs.toFixed(0)} ms`);
    expect(r.stats.visitedCells).toBe(statsA.visitedCells);
    expect(r.stats.tiles).toBe(statsA.tiles);
    expect(r.stats.areaM2).toBeCloseTo(statsA.areaM2, 3);
    const tilesA = await a.listBaseTiles(), tilesB = await b.listBaseTiles();
    expect(tilesB).toEqual(tilesA);
    const t2 = performance.now();
    for (const [tx, ty] of tilesA) {
      const ta = await a.getTile(14, tx, ty), tb = await b.getTile(14, tx, ty);
      let diff = 0;
      for (let i = 0; i < TILE_CELLS; i++) if ((ta as Uint8Array)[i] !== (tb as Uint8Array)[i]) diff++;
      expect(diff, `tile ${tx}/${ty}`).toBe(0);
    }
    const compareMs = performance.now() - t2;
    const tracks = await b.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 'walk-1', name: 'Test walk', points: 2 });
    // idempotent
    const t3 = performance.now();
    const r2 = await b.importBackup(zip);
    const reimportMs = performance.now() - t3;
    // eslint-disable-next-line no-console
    console.log(`backup: compare ${compareMs.toFixed(0)} ms, re-import ${reimportMs.toFixed(0)} ms`);
    expect(r2.touched).toEqual([]);
    expect(r2.stats.visitedCells).toBe(statsA.visitedCells);
    // corrupted: flip bytes inside the compressed data of the first tile entry
    const bad = zip.slice();
    for (let i = 200; i < 400; i++) bad[i] ^= 0xff;
    await expect(b.importBackup(bad)).rejects.toThrow();
    expect((await b.getStats()).visitedCells).toBe(statsA.visitedCells);
  }, 300_000);
});
