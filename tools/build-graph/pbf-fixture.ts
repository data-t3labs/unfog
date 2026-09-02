/**
 * Builds small OSM PBF files with `pbf`'s writer — for tests (hand-built blocks with 64-bit ids,
 * delta coding, tags, zlib blobs) and for the checked-in fixture tests/fixtures/graph/mini.osm.pbf.
 * Mirrors the wire format documented in pbf-reader.ts.
 */
import { deflateSync } from 'node:zlib';
import { PbfWriter } from 'pbf';

export interface FixtureNode { id: number; lon: number; lat: number; tags?: Record<string, string> }
export interface FixtureWay { id: number; tags: Record<string, string>; refs: number[] }
export interface FixtureBlock {
  nodes?: FixtureNode[];
  /** Encode nodes as DenseNodes (default) or as plain Node messages. */
  dense?: boolean;
  ways?: FixtureWay[];
  granularity?: number;
  latOffset?: number;
  lonOffset?: number;
  /** zlib-compress the blob (default true). */
  compress?: boolean;
}
export interface FixtureSpec { blocks: FixtureBlock[]; writingProgram?: string }

const utf8 = new TextEncoder();

export function buildOsmPbf(spec: FixtureSpec): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(...framedBlob('OSMHeader', headerBlock(spec.writingProgram ?? 'unfog-fixture'), true));
  for (const b of spec.blocks) parts.push(...framedBlob('OSMData', primitiveBlock(b), b.compress ?? true));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function framedBlob(type: string, payload: Uint8Array, compress: boolean): Uint8Array[] {
  const blob = new PbfWriter();
  if (compress) {
    blob.writeVarintField(2, payload.length);
    blob.writeBytesField(3, new Uint8Array(deflateSync(payload)));
  } else {
    blob.writeBytesField(1, payload);
  }
  const blobBytes = blob.finish();
  const header = new PbfWriter();
  header.writeStringField(1, type);
  header.writeVarintField(3, blobBytes.length);
  const headerBytes = header.finish();
  const len = new Uint8Array(4);
  len[0] = (headerBytes.length >>> 24) & 0xff; len[1] = (headerBytes.length >>> 16) & 0xff;
  len[2] = (headerBytes.length >>> 8) & 0xff; len[3] = headerBytes.length & 0xff;
  return [len, headerBytes, blobBytes];
}

function headerBlock(program: string): Uint8Array {
  const w = new PbfWriter();
  w.writeStringField(4, 'OsmSchema-V0.6');
  w.writeStringField(4, 'DenseNodes');
  w.writeStringField(16, program);
  return w.finish();
}

function primitiveBlock(b: FixtureBlock): Uint8Array {
  const granularity = b.granularity ?? 100, latOffset = b.latOffset ?? 0, lonOffset = b.lonOffset ?? 0;
  // string table: index 0 is the empty string by convention
  const strings: string[] = [''];
  const idx = new Map<string, number>([['', 0]]);
  const sid = (s: string) => { let i = idx.get(s); if (i === undefined) { i = strings.length; strings.push(s); idx.set(s, i); } return i; };
  const toUnit = (deg: number, offset: number) => Math.round((deg * 1e9 - offset) / granularity);

  const nodes = b.nodes ?? [], ways = b.ways ?? [];
  // register strings deterministically (nodes first, then ways)
  for (const n of nodes) for (const [k, v] of Object.entries(n.tags ?? {})) { sid(k); sid(v); }
  for (const w of ways) for (const [k, v] of Object.entries(w.tags)) { sid(k); sid(v); }

  const w = new PbfWriter();
  w.writeMessage(1, (st: string[], p) => { for (const s of st) p.writeBytesField(1, utf8.encode(s)); }, strings);
  w.writeMessage(2, (_g, p) => {
    if (nodes.length && (b.dense ?? true)) {
      const ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
      let pid = 0, plat = 0, plon = 0;
      for (const n of nodes) {
        const la = toUnit(n.lat, latOffset), lo = toUnit(n.lon, lonOffset);
        ids.push(n.id - pid); lats.push(la - plat); lons.push(lo - plon);
        pid = n.id; plat = la; plon = lo;
        for (const [k, v] of Object.entries(n.tags ?? {})) kv.push(sid(k), sid(v));
        kv.push(0);
      }
      p.writeMessage(2, (_d, q) => {
        q.writePackedSVarint(1, ids);
        q.writePackedSVarint(8, lats);
        q.writePackedSVarint(9, lons);
        q.writePackedVarint(10, kv);
      }, null);
    } else {
      for (const n of nodes) {
        p.writeMessage(1, (_n, q) => {
          q.writeSVarintField(1, n.id);
          const keys = Object.keys(n.tags ?? {});
          if (keys.length) { q.writePackedVarint(2, keys.map(sid)); q.writePackedVarint(3, keys.map((k) => sid(n.tags![k]))); }
          q.writeSVarintField(8, toUnit(n.lat, latOffset));
          q.writeSVarintField(9, toUnit(n.lon, lonOffset));
        }, null);
      }
    }
    for (const way of ways) {
      p.writeMessage(3, (_w, q) => {
        q.writeVarintField(1, way.id);
        const keys = Object.keys(way.tags);
        q.writePackedVarint(2, keys.map(sid));
        q.writePackedVarint(3, keys.map((k) => sid(way.tags[k])));
        const deltas: number[] = [];
        let prev = 0;
        for (const r of way.refs) { deltas.push(r - prev); prev = r; }
        q.writePackedSVarint(8, deltas);
      }, null);
    }
  }, null);
  // lat_offset / lon_offset are int64 (NOT zigzag sint64): negative values take the 10-byte two's-complement form.
  if (granularity !== 100) w.writeVarintField(17, granularity);
  if (latOffset) w.writeVarintField(19, latOffset);
  if (lonOffset) w.writeVarintField(20, lonOffset);
  return w.finish();
}

/**
 * The checked-in mini fixture (tests/fixtures/graph/mini.osm.pbf): a 2×2 block of streets in
 * Williamsburg with 64-bit node ids, one dropped sidewalk, one oneway, one unnamed service road,
 * one plain-node block with custom granularity, and one uncompressed blob.
 */
export const MINI_FIXTURE: FixtureSpec = {
  writingProgram: 'unfog-fixture',
  blocks: [
    {
      nodes: [
        { id: 2 ** 33 + 5, lon: -73.9568, lat: 40.7176, tags: { highway: 'crossing' } },
        { id: 2 ** 33 + 6, lon: -73.9558, lat: 40.7176 },
        { id: 2 ** 33 + 7, lon: -73.9548, lat: 40.7176 },
        { id: 12_000_000_001, lon: -73.9568, lat: 40.7166 },
        { id: 12_000_000_002, lon: -73.9558, lat: 40.7166 },
        { id: 12_000_000_003, lon: -73.9548, lat: 40.7166 },
      ],
      ways: [
        { id: 4_000_000_001, tags: { highway: 'residential', name: 'North 7th Street' }, refs: [2 ** 33 + 5, 2 ** 33 + 6, 2 ** 33 + 7] },
        { id: 4_000_000_002, tags: { highway: 'residential', name: 'North 6th Street', oneway: 'yes' }, refs: [12_000_000_001, 12_000_000_002, 12_000_000_003] },
        { id: 4_000_000_003, tags: { highway: 'footway', footway: 'sidewalk' }, refs: [2 ** 33 + 5, 12_000_000_001] },
        { id: 4_000_000_004, tags: { building: 'yes' }, refs: [2 ** 33 + 6, 12_000_000_002] },
      ],
    },
    {
      dense: false,
      granularity: 1000,
      latOffset: 40_000_000_000,
      lonOffset: -73_000_000_000,
      compress: false,
      nodes: [
        { id: 2 ** 34 + 1, lon: -73.9563, lat: 40.7171 },
      ],
      ways: [
        { id: 4_000_000_005, tags: { highway: 'primary', name: 'Bedford Avenue' }, refs: [2 ** 33 + 6, 2 ** 34 + 1, 12_000_000_002] },
        { id: 4_000_000_006, tags: { highway: 'service' }, refs: [2 ** 33 + 7, 12_000_000_003] },
      ],
    },
  ],
};
