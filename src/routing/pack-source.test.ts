import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { makeLattice } from '../../tests/fixtures/routing/lattice';
import { fakePackServer as fakeServer, publishPacks } from '../../tests/fixtures/routing/pack-server';
import { graphTileBounds, packGraphTile, unpackGraphTile, type GraphTileInput } from './graph-format';
import {
  PACK_HEADER_BYTES, cellKey, cellOf, coalesceRanges, encodePack, mortonKey, packIndexBytes, parseCellKey, parsePackIndex, rangeHeader, sliceEntry,
} from './pack-format';
import { PackSource, tilesInBBox } from './pack-source';

// ---- fixtures (the fake Range-capable host + publisher live in tests/fixtures/routing/pack-server.ts, shared with the engine test)

function latticeTiles(size: number, spacingM: number, origin?: [number, number]): GraphTileInput[] {
  return [...makeLattice({ size, spacingM, origin }).tiles.values()];
}

const BASE = 'https://example.test/release/';

const publish = (tiles: GraphTileInput[], builtAt?: string) => publishPacks(tiles, { base: BASE, builtAt });

const bboxOf = (t: { tx: number; ty: number }): [number, number, number, number] => {
  const b = graphTileBounds(t.tx, t.ty);
  return [b.west + 1e-6, b.south + 1e-6, b.east - 1e-6, b.north - 1e-6];
};

// ---- pack-format --------------------------------------------------------------------------------

describe('pack-format', () => {
  it('cells, keys and Morton order', () => {
    expect(cellOf(1206, 1539)).toEqual([18, 24]);
    expect(cellKey(18, 24)).toBe('6/18/24');
    expect(parseCellKey('6/18/24')).toEqual([18, 24]);
    expect(parseCellKey('7/1/1')).toBeNull();
    expect(mortonKey(0, 0)).toBe(0);
    expect(mortonKey(1, 0)).toBe(1);
    expect(mortonKey(0, 1)).toBe(2);
    expect(mortonKey(3, 3)).toBe(15);
    expect(mortonKey(65535, 65535)).toBe(2 ** 32 - 1);
  });

  it('encodePack / parsePackIndex round-trip, entries in Morton order, offsets contiguous', () => {
    const tiles = latticeTiles(30, 400); // 2×2 z12 tiles
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    const [cx, cy] = cellOf(tiles[0].tx, tiles[0].ty);
    const { bytes, index } = encodePack([cx, cy], tiles.map((t) => ({ tx: t.tx, ty: t.ty, bytes: packGraphTile(t) })));
    expect(index.indexBytes).toBe(packIndexBytes(tiles.length));
    expect(index.totalBytes).toBe(bytes.length);
    const parsed = parsePackIndex(bytes.subarray(0, index.indexBytes)); // only the index bytes, as the client fetches them
    expect(parsed).toEqual(index);
    let next = index.indexBytes, prevMorton = -1;
    for (const e of parsed.entries) {
      expect(e.offset).toBe(next);
      next += e.length;
      const m = mortonKey(e.tx, e.ty);
      expect(m).toBeGreaterThan(prevMorton);
      prevMorton = m;
      const t = unpackGraphTile(bytes.subarray(e.offset, e.offset + e.length));
      expect([t.tx, t.ty]).toEqual([e.tx, e.ty]);
    }
    expect(next).toBe(bytes.length);
    // whole pack parses too
    expect(parsePackIndex(bytes).entries.length).toBe(tiles.length);
    // truncated / wrong magic / duplicate / foreign tile
    expect(() => parsePackIndex(bytes.subarray(0, index.indexBytes - 1))).toThrow(/truncated/);
    expect(() => parsePackIndex(bytes.subarray(0, PACK_HEADER_BYTES - 1))).toThrow(/truncated/);
    const bad = bytes.slice(0, index.indexBytes); bad[0] = 0x58;
    expect(() => parsePackIndex(bad)).toThrow(/not a UFP1/);
    expect(() => encodePack([cx, cy], [{ tx: 1, ty: 1, bytes: new Uint8Array(1) }, { tx: 1, ty: 1, bytes: new Uint8Array(1) }])).toThrow(/duplicate|not in cell/);
    expect(() => encodePack([cx + 1, cy], [{ tx: tiles[0].tx, ty: tiles[0].ty, bytes: new Uint8Array(1) }])).toThrow(/not in cell/);
  });

  it('coalesceRanges merges neighbours within the gap and respects the run cap; sliceEntry cuts the body', () => {
    const e = (tx: number, offset: number, length: number) => ({ tx, ty: 0, offset, length });
    const entries = [e(3, 1000, 100), e(1, 0, 100), e(2, 100, 50), e(4, 5000, 10)];
    const r = coalesceRanges(entries, 500, 10_000);
    expect(r.map((x) => [x.start, x.end, x.entries.map((y) => y.tx)])).toEqual([[0, 150, [1, 2]], [1000, 1100, [3]], [5000, 5010, [4]]]);
    expect(coalesceRanges(entries, 10_000, 10_000).length).toBe(1);
    expect(coalesceRanges(entries, 10_000, 1000).map((x) => x.entries.length)).toEqual([2, 1, 1]); // run cap
    expect(rangeHeader(r[0])).toBe('bytes=0-149');
    const body = new Uint8Array(150).map((_, i) => i);
    expect(Array.from(sliceEntry(body, r[0], r[0].entries[1]))).toEqual(Array.from(body.subarray(100, 150)));
    expect(() => sliceEntry(body.subarray(0, 120), r[0], r[0].entries[1])).toThrow(/too short/);
  });
});

// ---- PackSource ---------------------------------------------------------------------------------

describe('PackSource', () => {
  it('loads packs-index.json, byte-ranges only the needed tiles, caches them in IndexedDB', async () => {
    const tiles = latticeTiles(30, 400);
    const { files, packs } = publish(tiles);
    const server = fakeServer(files);
    const src = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch });
    await src.init();
    expect(src.packsIndex?.packs).toBeDefined();
    const t0 = tiles[0];
    const cov = await src.coverage(bboxOf(t0));
    expect(cov).toEqual({ needed: 1, cached: 0, packable: 1, cells: [cellKey(...cellOf(t0.tx, t0.ty))] });
    const got = await src.tilesFor(bboxOf(t0));
    expect(got.tiles.length).toBe(1);
    expect(got.tiles[0].nodeId.length).toBe(t0.nodeId.length);
    const packUrl = src.packFor(t0.tx, t0.ty)!.url;
    const pack = packs.get(cellKey(...cellOf(t0.tx, t0.ty)))!;
    const ranges = server.calls.filter((c) => c.url === packUrl).map((c) => c.range);
    expect(ranges[0]).toBe(`bytes=0-${pack.index.indexBytes - 1}`); // index first, one request
    expect(ranges.length).toBe(2); // index + one tile range
    expect(src.perf.fetchBytes).toBeLessThan(pack.bytes.length); // never the whole pack
    expect(src.perf.fullBodies).toBe(0);
    // cached now: no network for the same tile, from IndexedDB after clearing memory
    const before = server.calls.length;
    src.clearMemory();
    expect((await src.tilesFor(bboxOf(t0))).tiles.length).toBe(1);
    expect(server.calls.length).toBe(before);
    expect(src.perf.idbHits).toBeGreaterThan(0);
    expect(await src.hasTile(t0.tx, t0.ty)).toBe(true);
    expect((await src.coverage(bboxOf(t0))).cached).toBe(1);
    // a second PackSource over the same IndexedDB starts from the cached index + tiles (offline)
    const offline = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: fakeServer(new Map()).fetch });
    await offline.init();
    expect(offline.packsIndex).not.toBeNull();
    expect((await offline.tilesFor(bboxOf(t0))).tiles.length).toBe(1);
    const other = tiles[tiles.length - 1];
    const miss = await offline.tilesFor(bboxOf(other));
    expect(miss.tiles.length).toBe(0);
    expect(miss.missing.length).toBe(1);
    await src.clear();
    await src.close();
    await offline.close();
  });

  it('fetches a whole bbox in coalesced ranges and tolerates a server that ignores Range', async () => {
    const tiles = latticeTiles(30, 400);
    const { files } = publish(tiles);
    const server = fakeServer(files);
    const src = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch, maxGap: 1 << 30, dbName: 'unfog-packs-bbox' });
    await src.init();
    const bbox: [number, number, number, number] = [-74.1, 40.6, -73.8, 40.8];
    const wanted = tilesInBBox(bbox);
    const r = await src.fetchTiles(wanted);
    expect(r.fetched).toBe(tiles.length);
    expect(r.uncovered.length).toBe(wanted.length - tiles.length); // bbox tiles outside the lattice
    expect(r.failed).toEqual([]);
    const tileRanges = server.calls.filter((c) => c.range && !c.range.startsWith('bytes=0-')).length;
    expect(tileRanges).toBeLessThanOrEqual(tiles.length - 1); // coalesced (gap unlimited → one per pack)
    expect((await src.tilesFor(bbox)).tiles.length).toBe(tiles.length);
    // Range ignored: 200 + whole body is sliced, still correct
    await src.clear();
    server.ignoreRange = true;
    const again = await src.tilesFor(bboxOf(tiles[0]));
    expect(again.tiles.length).toBe(1);
    expect(src.perf.fullBodies).toBeGreaterThan(0);
    // network failure → tile reported failed, no throw
    server.fail = true;
    await src.evict([`${tiles[1].tx}/${tiles[1].ty}`]);
    const failed = await src.fetchTiles([[tiles[1].tx, tiles[1].ty]]);
    expect(failed.failed.length + failed.alreadyCached).toBeGreaterThanOrEqual(1);
    expect((await src.tilesFor(bboxOf(tiles[1]))).tiles.length).toBe(0);
    await src.clear();
    await src.close();
  });

  it('re-fetches the index only when it is older than the max age; a changed pack drops its cached index', async () => {
    const tiles = latticeTiles(4, 100);
    const { files, index } = publish(tiles, '2026-09-01T00:00:00Z');
    const server = fakeServer(files);
    let now = 1_000_000;
    const src = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch, indexMaxAgeMs: 1000, now: () => now, dbName: 'unfog-packs-age' });
    await src.init();
    expect(src.perf.indexFetches).toBe(1);
    await src.tilesFor(bboxOf(tiles[0]));
    const src2 = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch, indexMaxAgeMs: 1000, now: () => now, dbName: 'unfog-packs-age' });
    now += 500;
    await src2.init();
    expect(src2.perf.indexFetches).toBe(0); // fresh enough: from IndexedDB
    expect(src2.indexAgeMs).toBe(500);
    // publish a newer pack: after the max age the index is refreshed and the pack index re-read
    const k = Object.keys(index.packs)[0];
    const newer = publish(tiles, '2026-09-03T00:00:00Z');
    for (const [u, b] of newer.files) files.set(u, b);
    now += 1000;
    const src3 = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch, indexMaxAgeMs: 1000, now: () => now, dbName: 'unfog-packs-age' });
    await src3.init();
    expect(src3.perf.indexFetches).toBe(1);
    expect(src3.packsIndex?.packs[k].builtAt).toBe('2026-09-03T00:00:00Z');
    const calls = server.calls.length;
    await src3.packIndex(k);
    expect(server.calls.length).toBe(calls + 1); // cached pack index was for the old builtAt → fetched again
    const cached = await src3.listCached();
    expect(cached.length).toBe(1);
    expect(cached[0].builtAt).toBe('2026-09-01T00:00:00Z'); // old tile bytes stay usable until evicted/refetched
    expect(await src3.cachedBytes()).toBe(cached[0].size);
    await src3.clear(true);
    expect(src3.packsIndex).toBeNull();
    await src.close(); await src2.close(); await src3.close();
  });

  it('a pack whose URL 404s (shard not deployed) fails its tiles quietly; covers/status group by cell; init never waits past its refresh timeout', async () => {
    // Two cells: New York (default lattice origin) and Vancouver; the New York pack is missing from the host.
    const ny = latticeTiles(4, 100), van = latticeTiles(4, 100, [-123.12, 49.28]);
    const nyCell = cellKey(...cellOf(ny[0].tx, ny[0].ty)), vanCell = cellKey(...cellOf(van[0].tx, van[0].ty));
    expect(nyCell).not.toBe(vanCell);
    const { files, index } = publishPacks([...ny, ...van], { base: BASE, source: 'Geofabrik us/new-york 2026-09-01' });
    files.delete(index.packs[nyCell].url);
    const server = fakeServer(files);
    const src = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: server.fetch, dbName: 'unfog-packs-404' });
    await src.init();
    expect(src.covers(ny[0].tx, ny[0].ty)).toBe(true);
    expect(src.covers(van[0].tx, van[0].ty)).toBe(true);
    expect(src.covers(0, 0)).toBe(false);
    const r = await src.fetchTiles([[ny[0].tx, ny[0].ty], [van[0].tx, van[0].ty]]);
    expect(r.failed).toEqual([`${ny[0].tx}/${ny[0].ty}`]);
    expect(r.fetched).toBe(1);
    expect(await src.getTile(ny[0].tx, ny[0].ty)).toBeNull(); // the retry 404s again: null, never a throw
    expect(await src.coverage(bboxOf(ny[0]))).toEqual({ needed: 1, cached: 0, packable: 1, cells: [nyCell] });
    expect(await src.coverage(bboxOf(van[0]))).toEqual({ needed: 1, cached: 1, packable: 1, cells: [vanCell] });
    const status = await src.status();
    expect(status.indexCells).toBe(2);
    expect(status.indexAgeMs).toBeLessThan(60_000);
    expect(status.totalTiles).toBe(1);
    // `sub`: the cached tiles by z10 sub-cell (the Data screen's one-region label needs to know where in the cell they are).
    expect(status.cells).toEqual([{ cell: vanCell, tiles: 1, bytes: status.totalBytes, lastUsed: status.cells[0].lastUsed, source: 'Geofabrik us/new-york 2026-09-01', sub: [[van[0].tx >> 2, van[0].ty >> 2, 1, status.cells[0].lastUsed]] }]);
    await src.clear();
    expect((await src.status()).cells).toEqual([]);
    await src.close();

    // Boot bound: an index that takes 200 ms arrives after init({ refreshTimeoutMs: 20 }) returned, in the background.
    const slow: typeof fetch = async (input, init) => {
      await new Promise((res) => setTimeout(res, 200));
      return server.fetch(input, init);
    };
    const late = new PackSource({ indexUrl: `${BASE}packs-index.json`, fetch: slow, dbName: 'unfog-packs-late' });
    const t0 = Date.now();
    await late.init({ refreshTimeoutMs: 20 });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(late.packsIndex).toBeNull();
    expect(late.covers(van[0].tx, van[0].ty)).toBe(false);
    expect(await late.indexRefresh).toBe(true);
    expect(late.covers(van[0].tx, van[0].ty)).toBe(true);
    await late.clear(true);
    await late.close();
  });
});
