import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PbfWriter } from 'pbf';
import { classifyWay } from '../../src/routing/osm-rules';
import { MINI_FIXTURE, buildOsmPbf } from './pbf-fixture';
import { readBlobs, readOsmPbf } from './pbf-reader';
import { loadPbfWays } from './pbf-ways';

const FIXTURE = fileURLToPath(new URL('../../tests/fixtures/graph/mini.osm.pbf', import.meta.url));
const VANCOUVER = fileURLToPath(new URL('./cache/Vancouver.osm.pbf', import.meta.url));

type Node = { id: number; lon: number; lat: number };
type Way = { id: number; tags: Record<string, string>; refs: number[] };
function readAll(src: string | Uint8Array, wayKeyFilter?: string) {
  const nodes: Node[] = [], ways: Way[] = [];
  const stats = readOsmPbf(src, { wayKeyFilter, node: (id, lon, lat) => nodes.push({ id, lon, lat }), way: (id, tags, refs) => ways.push({ id, tags, refs }) });
  return { nodes, ways, stats };
}

describe('pbf-reader — hand-built blocks', () => {
  const bytes = buildOsmPbf(MINI_FIXTURE);

  it('frames blobs: header + 2 data blocks, zlib and raw', () => {
    const blobs = [...readBlobs(bytes)];
    expect(blobs.map((b) => b.type)).toEqual(['OSMHeader', 'OSMData', 'OSMData']);
  });

  it('decodes 64-bit ids exactly (dense delta-coded and plain), > 2^33', () => {
    const { nodes } = readAll(bytes);
    expect(nodes.map((n) => n.id)).toEqual([2 ** 33 + 5, 2 ** 33 + 6, 2 ** 33 + 7, 12_000_000_001, 12_000_000_002, 12_000_000_003, 2 ** 34 + 1]);
    expect(Number.isSafeInteger(2 ** 34 + 1)).toBe(true);
  });

  it('decodes coordinates with granularity and offsets', () => {
    const { nodes } = readAll(bytes);
    const spec = [...MINI_FIXTURE.blocks[0].nodes!, ...MINI_FIXTURE.blocks[1].nodes!];
    for (let i = 0; i < spec.length; i++) {
      expect(nodes[i].lon).toBeCloseTo(spec[i].lon, 6);
      expect(nodes[i].lat).toBeCloseTo(spec[i].lat, 6);
    }
    // default granularity 100 nanodegrees → exact to 1e-7
    expect(Math.abs(nodes[0].lon - -73.9568)).toBeLessThan(1e-9);
    // custom block: granularity 1000 with 40°/−73° offsets
    expect(Math.abs(nodes[6].lat - 40.7171)).toBeLessThan(1e-8);
  });

  it('decodes ways: tags via the string table, refs delta-decoded to absolute 64-bit ids', () => {
    const { ways, stats } = readAll(bytes);
    expect(ways.length).toBe(6);
    expect(stats.ways).toBe(6); expect(stats.nodes).toBe(7); expect(stats.blocks).toBe(2);
    const n7 = ways.find((w) => w.id === 4_000_000_001)!;
    expect(n7.tags).toEqual({ highway: 'residential', name: 'North 7th Street' });
    expect(n7.refs).toEqual([2 ** 33 + 5, 2 ** 33 + 6, 2 ** 33 + 7]);
    const bedford = ways.find((w) => w.id === 4_000_000_005)!;
    expect(bedford.refs).toEqual([2 ** 33 + 6, 2 ** 34 + 1, 12_000_000_002]); // refs go up and down (negative deltas)
    expect(ways.find((w) => w.id === 4_000_000_004)!.tags).toEqual({ building: 'yes' });
  });

  it('wayKeyFilter reports only ways with that key', () => {
    const { ways } = readAll(bytes, 'highway');
    expect(ways.map((w) => w.id)).toEqual([4_000_000_001, 4_000_000_002, 4_000_000_003, 4_000_000_005, 4_000_000_006]);
  });

  it('skips a whole block of ways when its string table lacks the key (nodes still visited)', () => {
    const b = buildOsmPbf({ blocks: [{ nodes: [{ id: 1, lon: 0, lat: 0 }, { id: 2, lon: 1, lat: 1 }], ways: [{ id: 9, tags: { railway: 'rail' }, refs: [1, 2] }] }] });
    const r = readAll(b, 'highway');
    expect(r.ways).toEqual([]);
    expect(r.nodes.length).toBe(2);
    expect(readAll(b).ways.length).toBe(1);
  });

  it('a visitor without node() never decodes nodes; without way() never decodes ways', () => {
    let n = 0;
    const s = readOsmPbf(bytes, { way: () => n++ });
    expect(s.nodes).toBe(0); expect(n).toBe(6);
    const s2 = readOsmPbf(bytes, { node: () => n++ });
    expect(s2.ways).toBe(0);
  });

  it('rejects unsupported blob compression and truncated files', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const blob = new PbfWriter(); blob.writeVarintField(2, 3); blob.writeBytesField(4, payload); const blobBytes = blob.finish();
    const hdr = new PbfWriter(); hdr.writeStringField(1, 'OSMData'); hdr.writeVarintField(3, blobBytes.length); const hdrBytes = hdr.finish();
    const file = new Uint8Array(4 + hdrBytes.length + blobBytes.length);
    file[3] = hdrBytes.length; file.set(hdrBytes, 4); file.set(blobBytes, 4 + hdrBytes.length);
    expect(() => readOsmPbf(file, {})).toThrow(/lzma/);
    expect(() => readOsmPbf(bytes.subarray(0, bytes.length - 10), {})).toThrow(/truncated/);
  });

  it('checked-in fixture matches the builder byte for byte and reads identically from disk', () => {
    if (process.env.UNFOG_WRITE_FIXTURES) writeFileSync(FIXTURE, bytes);
    expect(existsSync(FIXTURE)).toBe(true);
    expect(new Uint8Array(readFileSync(FIXTURE))).toEqual(bytes);
    const fromDisk = readAll(FIXTURE, 'highway'), fromMem = readAll(bytes, 'highway');
    expect(fromDisk.ways).toEqual(fromMem.ways);
    expect(fromDisk.nodes).toEqual(fromMem.nodes);
  });
});

describe('loadPbfWays (two-pass)', () => {
  it('resolves coordinates for kept ways only, lazily', () => {
    const r = loadPbfWays(FIXTURE, { keep: (t) => classifyWay(t).keep });
    expect(r.countBeforeBbox).toBe(5); // N7th, N6th, sidewalk (glue), Bedford, unnamed service (glue) — building is not a highway
    expect(r.count).toBe(5);
    expect(r.missing).toBe(0);
    expect(r.nodeCount).toBe(7);
    const ways = [...r.ways()];
    expect(ways.map((w) => w.id)).toEqual([4_000_000_001, 4_000_000_002, 4_000_000_003, 4_000_000_005, 4_000_000_006]);
    expect(loadPbfWays(FIXTURE, { keep: (t) => { const c = classifyWay(t); return c.keep && !c.glue; } }).count).toBe(3);
    const bedford = ways[3];
    expect(bedford.refs).toEqual([2 ** 33 + 6, 2 ** 34 + 1, 12_000_000_002]);
    expect(bedford.coords[1][0]).toBeCloseTo(-73.9563, 6);
    expect(bedford.coords[1][1]).toBeCloseTo(40.7171, 6);
  });

  it('bbox keeps ways with at least one node inside', () => {
    // nodes 2^33+5 (N7th + sidewalk) and 2^34+1 (Bedford) are inside; everything else is south of 40.717
    const inside = loadPbfWays(FIXTURE, { bbox: [-73.957, 40.717, -73.956, 40.718] });
    expect(inside.count).toBe(3);
    expect([...inside.ways()].map((w) => w.id)).toEqual([4_000_000_001, 4_000_000_003, 4_000_000_005]);
    const none = loadPbfWays(FIXTURE, { bbox: [0, 0, 1, 1] });
    expect(none.count).toBe(0);
    expect([...none.ways()]).toEqual([]);
  });

  it('marks nodes missing from the file as NaN coordinates', () => {
    const b = buildOsmPbf({ blocks: [{ nodes: [{ id: 1, lon: 0, lat: 0 }], ways: [{ id: 9, tags: { highway: 'path' }, refs: [1, 2] }] }] });
    const dir = mkdtempSync(join(tmpdir(), 'unfog-pbf-'));
    const tmp = join(dir, 'missing.osm.pbf');
    writeFileSync(tmp, b);
    try {
      const r = loadPbfWays(tmp);
      expect(r.missing).toBe(1);
      const w = [...r.ways()][0];
      expect(w.coords[0]).toEqual([0, 0]);
      expect(Number.isNaN(w.coords[1][0])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const OVERPASS_EXCLUDED = /^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|abandoned|platform|bus_stop|elevator|corridor)$/;

describe.skipIf(!existsSync(VANCOUVER))('BBBike Vancouver extract (skipped when tools/build-graph/cache/Vancouver.osm.pbf is absent)', () => {
  it('way count in the research 3×3 km bbox is within ±10 % of the 2026-09-01 Overpass measurement (7,277)', { timeout: 300_000 }, () => {
    // Research §1a query: way["highway"]["highway"!~"^(motorway|…|corridor)$"] — walk/bike-routable, sidewalks included.
    const bbox: [number, number, number, number] = [-123.1406, 49.2465, -123.0994, 49.2735];
    const overpassLike = loadPbfWays(VANCOUVER, { keep: (t) => !OVERPASS_EXCLUDED.test(t.highway), bbox });
    const kept = loadPbfWays(VANCOUVER, { keep: (t) => { const c = classifyWay(t); return c.keep && !c.glue; }, bbox });
    console.log(`Vancouver bbox check: overpass-like ${overpassLike.count} ways (ref 7,277), classify-kept non-glue ${kept.count}; ` +
      `${overpassLike.countBeforeBbox} highway ways in extract, ${overpassLike.nodeCount} nodes, ${overpassLike.missing} missing; ` +
      `pass1 ${(overpassLike.pass1Ms / 1000).toFixed(1)} s, pass2 ${(overpassLike.pass2Ms / 1000).toFixed(1)} s`);
    expect(overpassLike.count).toBeGreaterThan(7277 * 0.9);
    expect(overpassLike.count).toBeLessThan(7277 * 1.1);
    expect(kept.count).toBeLessThan(overpassLike.count); // sidewalks/crossings/unnamed service removed
    expect(kept.count).toBeGreaterThan(overpassLike.count * 0.3);
  });
});
