/**
 * Two-pass PBF → OsmWay loader.
 *   pass 1: ways with a `highway` key (block-level fast path) that pass `keep`; ids, tags and refs
 *           go into flat arrays;
 *   pass 2: coordinates for the referenced node ids only — a sorted Float64Array of wanted ids
 *           with a monotone galloping search (PBF nodes are id-sorted; an out-of-order id falls
 *           back to a full binary search).
 * The result iterates OsmWay objects lazily, one at a time, for buildGraphTiles.
 */
import { lowerBound } from '../../src/routing/graph-build';
import type { OsmWay } from '../../src/routing/osm-types';
import { readOsmPbf } from './pbf-reader';

export interface LoadPbfOptions {
  /** Keep a highway way? Default: every way with a highway tag. */
  keep?: (tags: Record<string, string>) => boolean;
  /** Keep only ways with at least one node inside [west, south, east, north]. */
  bbox?: [west: number, south: number, east: number, north: number];
  log?: (msg: string) => void;
}

export interface PbfWays {
  /** Ways after `keep` and `bbox`. */
  count: number;
  /** Ways after `keep`, before `bbox`. */
  countBeforeBbox: number;
  /** Unique referenced node ids. */
  nodeCount: number;
  /** Referenced node ids absent from the file (their points are yielded as NaN). */
  missing: number;
  pass1Ms: number;
  pass2Ms: number;
  ways(): Generator<OsmWay, void, void>;
}

export function loadPbfWays(path: string, opts: LoadPbfOptions = {}): PbfWays {
  const log = opts.log ?? (() => {});
  const keep = opts.keep;

  // ---- pass 1: ways ----
  const t1 = performance.now();
  const wayIds: number[] = [], wayTags: Record<string, string>[] = [], wayStart: number[] = [];
  const flat: number[] = [];
  let lastLog = 0;
  const s1 = readOsmPbf(path, {
    wayKeyFilter: 'highway',
    way(id, tags, refs) {
      if (keep && !keep(tags)) return;
      wayIds.push(id); wayTags.push(tags); wayStart.push(flat.length);
      for (let i = 0; i < refs.length; i++) flat.push(refs[i]);
    },
    block(info) { if (info.bytes - lastLog > 64e6) { lastLog = info.bytes; log(`  pass 1: ${(info.bytes / 1e6).toFixed(0)} MB decoded, ${wayIds.length} ways kept`); } },
  });
  wayStart.push(flat.length);
  const W = wayIds.length;
  const pass1Ms = performance.now() - t1;
  log(`pass 1: ${s1.blocks} blocks, ${s1.ways} highway ways seen, ${W} kept, ${flat.length} node refs (${(pass1Ms / 1000).toFixed(1)} s)`);

  // ---- wanted node ids ----
  const wanted = Float64Array.from(flat);
  wanted.sort();
  let U = 0;
  for (let i = 0; i < wanted.length; i++) if (i === 0 || wanted[i] !== wanted[i - 1]) wanted[U++] = wanted[i];
  const ids = wanted.subarray(0, U);
  const refIdx = new Int32Array(flat.length);
  for (let i = 0; i < flat.length; i++) refIdx[i] = lowerBound(ids, flat[i]);
  const lon = new Float64Array(U).fill(NaN), lat = new Float64Array(U).fill(NaN);

  // ---- pass 2: coordinates ----
  const t2 = performance.now();
  let ptr = 0, found = 0;
  lastLog = 0;
  const s2 = readOsmPbf(path, {
    node(id, x, y) {
      if (ptr < U && ids[ptr] < id) ptr = gallop(ids, id, ptr, U);
      else if (ptr > 0 && ids[ptr - 1] >= id) ptr = lowerBound(ids, id);
      if (ptr < U && ids[ptr] === id) { lon[ptr] = x; lat[ptr] = y; found++; }
    },
    block(info) { if (info.bytes - lastLog > 64e6) { lastLog = info.bytes; log(`  pass 2: ${(info.bytes / 1e6).toFixed(0)} MB decoded, ${found}/${U} nodes resolved`); } },
  });
  const pass2Ms = performance.now() - t2;
  const missing = U - found;
  log(`pass 2: ${s2.nodes} nodes scanned, ${found}/${U} wanted resolved, ${missing} missing (${(pass2Ms / 1000).toFixed(1)} s)`);

  // ---- bbox filter ----
  let inBox: Uint8Array | undefined;
  let count = W;
  if (opts.bbox) {
    const [w, s, e, n] = opts.bbox;
    inBox = new Uint8Array(W);
    count = 0;
    for (let wi = 0; wi < W; wi++) {
      for (let i = wayStart[wi]; i < wayStart[wi + 1]; i++) {
        const u = refIdx[i], x = lon[u], y = lat[u];
        if (x >= w && x <= e && y >= s && y <= n) { inBox[wi] = 1; count++; break; }
      }
    }
    log(`bbox filter: ${count}/${W} ways touch [${opts.bbox.join(', ')}]`);
  }

  return {
    count, countBeforeBbox: W, nodeCount: U, missing, pass1Ms, pass2Ms,
    *ways() {
      for (let wi = 0; wi < W; wi++) {
        if (inBox && !inBox[wi]) continue;
        const s = wayStart[wi], e = wayStart[wi + 1];
        const refs = new Array<number>(e - s), coords = new Array<[number, number]>(e - s);
        for (let i = s; i < e; i++) { const u = refIdx[i]; refs[i - s] = flat[i]; coords[i - s] = [lon[u], lat[u]]; }
        yield { id: wayIds[wi], tags: wayTags[wi], refs, coords };
      }
    },
  };
}

/** lowerBound restricted to [lo, hi) with exponential probing from `lo` — O(log distance) for id-sorted input. */
function gallop(a: Float64Array, x: number, lo: number, hi: number): number {
  let step = 1, end = lo + 1;
  while (end < hi && a[end] < x) { lo = end; step <<= 1; end = lo + step; }
  hi = Math.min(end, hi);
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
