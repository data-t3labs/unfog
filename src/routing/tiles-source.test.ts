import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { makeLattice } from '../../tests/fixtures/routing/lattice';
import { graphTileBounds, packGraphTile, type RegionManifest } from './graph-format';
import { TileSource, graphTilesFor, tileKeyOf } from './tiles-source';

function fakeFetch(files: Map<string, Uint8Array | object>, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = files.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    if (body instanceof Uint8Array) return new Response(body.slice().buffer as ArrayBuffer, { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('TileSource', () => {
  it('serves prebuilt tiles from the region index and caches decoded tiles in memory', async () => {
    const lattice = makeLattice({ size: 4, spacingM: 100 });
    const inputs = [...lattice.tiles.values()];
    const files = new Map<string, Uint8Array | object>();
    const manifest: RegionManifest = {
      id: 'test', name: 'Test', zoom: 12, bbox: [-74, 40.7, -73.9, 40.75],
      tiles: inputs.map((t) => [t.tx, t.ty, 0] as [number, number, number]),
      builtAt: '2026-09-02', source: 'lattice', stats: { nodes: 16, arcs: 48, km: 2.4 },
    };
    files.set('/unfog/graph/index.json', { regions: ['test'] });
    files.set('/unfog/graph/test/manifest.json', manifest);
    for (const t of inputs) files.set(`/unfog/graph/test/12/${t.tx}/${t.ty}.ufg`, packGraphTile(t));
    const calls: string[] = [];
    const src = new TileSource({ fetch: fakeFetch(files, calls) });
    await src.init('/unfog');
    expect(src.listRegions().map((r) => r.id)).toEqual(['test']);
    const b = graphTileBounds(inputs[0].tx, inputs[0].ty);
    const bbox: [number, number, number, number] = [b.west + 1e-6, b.south + 1e-6, b.east - 1e-6, b.north - 1e-6];
    expect(graphTilesFor(bbox)).toEqual([[inputs[0].tx, inputs[0].ty]]);
    const cov = await src.coverage(bbox);
    expect(cov).toEqual({ needed: 1, available: 1, regions: ['test'] });
    const first = await src.tilesFor(bbox);
    expect(first.tiles.length).toBe(1);
    expect(first.keys).toEqual([tileKeyOf(inputs[0].tx, inputs[0].ty)]);
    const fetches = calls.filter((u) => u.endsWith('.ufg')).length;
    await src.tilesFor(bbox);
    expect(calls.filter((u) => u.endsWith('.ufg')).length).toBe(fetches); // memory hit
    const dl = await src.downloadRegion('test');
    expect(dl.tiles).toBe(inputs.length);
    // Unknown tile → missing, not an error.
    const far: [number, number, number, number] = [-123.2, 49.2, -123.1, 49.3];
    const none = await src.tilesFor(far);
    expect(none.tiles.length).toBe(0);
    expect(none.missing.length).toBeGreaterThan(0);
    expect((await src.coverage(far)).available).toBe(0);
  });

  it('fetches the tiles of one request concurrently, not one after another (review F3)', async () => {
    const lattice = makeLattice({ size: 30, spacingM: 400 }); // ~12 km: straddles 2×2 z12 tiles
    const inputs = [...lattice.tiles.values()];
    expect(inputs.length).toBeGreaterThanOrEqual(4);
    const files = new Map<string, Uint8Array | object>();
    const manifest: RegionManifest = {
      id: 'test', name: 'Test', zoom: 12, bbox: [-74.1, 40.6, -73.8, 40.8],
      tiles: inputs.map((t) => [t.tx, t.ty, 0] as [number, number, number]),
      builtAt: '2026-09-02', source: 'lattice', stats: { nodes: 900, arcs: 3480, km: 348 },
    };
    files.set('/unfog/graph/index.json', { regions: ['test'] });
    files.set('/unfog/graph/test/manifest.json', manifest);
    for (const t of inputs) files.set(`/unfog/graph/test/12/${t.tx}/${t.ty}.ufg`, packGraphTile(t));
    const inner = fakeFetch(files, []);
    let inFlight = 0, maxInFlight = 0;
    const slow: typeof fetch = async (input, init) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try { return await inner(input, init); } finally { inFlight--; }
    };
    const src = new TileSource({ fetch: slow });
    await src.init('/unfog/');
    maxInFlight = 0;
    const { tiles } = await src.tilesFor([-74.1, 40.6, -73.8, 40.8]);
    expect(tiles.length).toBe(inputs.length);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('stores, lists and deletes downloaded areas in unfog-graph', async () => {
    const lattice = makeLattice({ size: 5, spacingM: 100 });
    const src = new TileSource({ fetch: fakeFetch(new Map(), []) });
    await src.init('/unfog/');
    const progress: string[] = [];
    const rec = await src.storeArea({ id: 'a1', center: [-73.945, 40.73], radiusKm: 1 }, lattice.tiles, (p) => progress.push(`${p.phase} ${p.done}/${p.total}`));
    expect(rec.tiles).toBe(lattice.tiles.size);
    expect(rec.bytes).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(`store ${lattice.tiles.size}/${lattice.tiles.size}`);
    expect((await src.listDownloads()).map((a) => a.id)).toEqual(['a1']);
    const t = [...lattice.tiles.values()][0];
    const b = graphTileBounds(t.tx, t.ty);
    const bbox: [number, number, number, number] = [b.west + 1e-6, b.south + 1e-6, b.east - 1e-6, b.north - 1e-6];
    expect((await src.coverage(bbox)).available).toBe(1);
    const got = await src.tilesFor(bbox);
    expect(got.tiles.length).toBe(1);
    expect(got.tiles[0].nodeId.length).toBe(t.nodeId.length);
    // Replacing the same id keeps one area; deleting removes its tiles.
    await src.storeArea({ id: 'a1', center: [-73.945, 40.73], radiusKm: 1 }, lattice.tiles);
    expect((await src.listDownloads()).length).toBe(1);
    await src.deleteDownload('a1');
    expect(await src.listDownloads()).toEqual([]);
    src.clearMemory();
    expect((await src.tilesFor(bbox)).tiles.length).toBe(0);
    await src.close();
  });
});
