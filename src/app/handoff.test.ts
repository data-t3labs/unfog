/**
 * Google Maps hand-off (feedback-3): corner selection, the deviation bound, the split into parts,
 * the URLs. New file: new module (src/app/handoff.ts). The last block routes on the prebuilt NYC
 * region (public/graph/nyc, skipped when absent) so a real engine polyline goes through the
 * splitter and the URL rules are checked on it, not on a synthetic line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distanceM } from '../grid/cell';
import type { LonLat } from '../routing/api';
import { findCandidates } from '../routing/candidates';
import { MapCellLookup } from '../routing/cells';
import { routeBBox } from '../routing/engine';
import { graphTilePath, unpackGraphTile, type GraphTile } from '../routing/graph-format';
import { Graph } from '../routing/graph';
import { graphTilesFor } from '../routing/tiles-source';
import {
  DEFAULT_SPLIT,
  GOOGLE_MAX_URL_LENGTH,
  GOOGLE_MAX_WAYPOINTS,
  appleMapsUrl,
  deviationM,
  fmtLatLng,
  googleMapsUrl,
  partLabel,
  routeGpxFileName,
  routeToGpx,
  significantCorners,
  splitCandidate,
  splitIntoParts,
  type RoutePart,
} from './handoff';

// ---------------------------------------------------------------- synthetic lines (Williamsburg latitude)

const LAT0 = 40.7176, LON0 = -73.9568;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110_574;
/** Metres east/north of the anchor → lon/lat. */
const at = (xM: number, yM: number): LonLat => [LON0 + xM / KX, LAT0 + yM / KY];

/**
 * Straight legs between `corners` (metres), each leg sampled every `stepM` with a deterministic
 * sub-metre wobble so no intermediate vertex is exactly collinear. Returns the vertices and the
 * indices of the corners.
 */
function polyline(corners: Array<[number, number]>, stepM = 12, wobbleM = 0.4): { points: LonLat[]; cornerIdx: number[] } {
  const points: LonLat[] = [];
  const cornerIdx: number[] = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let c = 0; c < corners.length; c++) {
    const [x, y] = corners[c];
    if (c === 0) {
      points.push(at(x, y));
      cornerIdx.push(0);
      continue;
    }
    const [px, py] = corners[c - 1];
    const len = Math.hypot(x - px, y - py);
    const n = Math.max(1, Math.round(len / stepM));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      // Wobble across the leg (perpendicular), never along it.
      const nx = -(y - py) / len, ny = (x - px) / len;
      const w = rnd() * wobbleM;
      points.push(at(px + (x - px) * t + nx * w, py + (y - py) * t + ny * w));
    }
    points.push(at(x, y));
    cornerIdx.push(points.length - 1);
  }
  return { points, cornerIdx };
}

/** A zig-zag with five sharp corners: 200 m legs, alternating 90° turns. */
const ZIGZAG: Array<[number, number]> = [[0, 0], [200, 0], [200, 200], [400, 200], [400, 400], [600, 400], [600, 600]];

/** A long grid walk: 60 right-angle turns of 80–160 m, deterministic. */
function gridWalk(turns = 60): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, 0]];
  let x = 0, y = 0, dir = 0;
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < turns; i++) {
    const len = 80 + Math.round(rnd() * 80);
    if (dir === 0) x += len;
    else if (dir === 1) y += len;
    else if (dir === 2) x -= len;
    else y -= len;
    out.push([x, y]);
    // Mostly forward-going: turn left or right, never straight back.
    dir = (dir + (rnd() < 0.5 ? 1 : 3)) % 4;
  }
  return out;
}

const withEnds = (p: RoutePart): LonLat[] => [p.start, ...p.corners, p.end];

function expectContiguousCover(parts: RoutePart[], route: LonLat[]): void {
  expect(parts.length).toBeGreaterThanOrEqual(1);
  expect(parts[0].start).toEqual(route[0]);
  expect(parts[parts.length - 1].end).toEqual(route[route.length - 1]);
  const stitched: LonLat[] = [];
  parts.forEach((p, i) => {
    expect(p.points[0]).toEqual(p.start);
    expect(p.points[p.points.length - 1]).toEqual(p.end);
    if (i > 0) expect(p.start).toEqual(parts[i - 1].end);
    stitched.push(...(i === 0 ? p.points : p.points.slice(1)));
  });
  expect(stitched).toEqual(route);
}

// ================================================================ corners

describe('significantCorners', () => {
  it('picks the sharp corners of a zig-zag, in route order, endpoints excluded', () => {
    const { points, cornerIdx } = polyline(ZIGZAG);
    const interior = cornerIdx.slice(1, -1);
    expect(significantCorners(points, 5)).toEqual(interior);
    expect(significantCorners(points, 9)).toEqual(interior); // nothing else deviates more than the wobble
  });

  it('never returns more than maxInterior, and takes the largest deviations first', () => {
    const { points, cornerIdx } = polyline(ZIGZAG);
    for (const k of [0, 1, 2, 3, 4]) {
      const got = significantCorners(points, k);
      expect(got.length).toBe(k);
      for (const i of got) expect(cornerIdx).toContain(i);
      expect(got).toEqual([...got].sort((a, b) => a - b));
    }
    // One big kink and one small one: the budget of one goes to the big one.
    const { points: two, cornerIdx: ci } = polyline([[0, 0], [300, 0], [300, 15], [600, 15], [600, 300], [900, 300]]);
    expect(significantCorners(two, 1)).toEqual([ci[3]]); // the 285 m step, not the 15 m one
  });

  it('is deterministic and empty for straight or tiny lines', () => {
    const { points } = polyline(gridWalk(20));
    expect(significantCorners(points, 9)).toEqual(significantCorners(points, 9));
    expect(significantCorners([at(0, 0), at(100, 0)], 9)).toEqual([]);
    expect(significantCorners([at(0, 0), at(50, 0), at(100, 0)], 9)).toEqual([]); // collinear: deviation 0 is not a corner
    expect(significantCorners([], 9)).toEqual([]);
  });
});

// ================================================================ deviation

describe('deviationM', () => {
  it('is the perpendicular distance of the worst vertex from the simplified line', () => {
    const a = at(0, 0), b = at(200, 55), c = at(400, 0);
    expect(deviationM([a, b, c], [a, c])).toBeCloseTo(55, 0);
    expect(deviationM([a, b, c], [a, b, c])).toBeLessThan(0.01);
    // Beyond the end of the segment the distance is to the endpoint, not the infinite line.
    expect(deviationM([at(500, 0)], [a, c])).toBeCloseTo(100, 0);
  });

  it('is within the wobble when every corner is kept and the leg height when none is', () => {
    const { points, cornerIdx } = polyline(ZIGZAG);
    expect(deviationM(points, cornerIdx.map((i) => points[i]))).toBeLessThan(1);
    expect(deviationM(points, [points[0], points[points.length - 1]])).toBeGreaterThan(100);
    expect(deviationM([], [at(0, 0)])).toBe(0);
    expect(deviationM([at(0, 0)], [])).toBe(Infinity);
  });
});

// ================================================================ split

describe('splitIntoParts', () => {
  it('keeps a short route in one part with at most 9 corners', () => {
    const { points, cornerIdx } = polyline(ZIGZAG);
    const parts = splitIntoParts(points, DEFAULT_SPLIT);
    expect(parts).toHaveLength(1);
    expect(parts[0].corners).toEqual(cornerIdx.slice(1, -1).map((i) => points[i]));
    expect(parts[0].points).toEqual(points);
    expect(parts[0].lengthM).toBeCloseTo(1200, -1);
    expectContiguousCover(parts, points);
  });

  it('splits a long grid walk into contiguous parts that cover the route, each within the bound', () => {
    const { points } = polyline(gridWalk(60));
    const parts = splitIntoParts(points, { maxInterior: 9, maxDeviationM: 60 });
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expectContiguousCover(parts, points);
    let total = 0;
    for (const p of parts) {
      expect(p.corners.length).toBeLessThanOrEqual(GOOGLE_MAX_WAYPOINTS);
      expect(deviationM(p.points, withEnds(p))).toBeLessThanOrEqual(60);
      expect(p.lengthM).toBeGreaterThan(0);
      total += p.lengthM;
    }
    let routeM = 0;
    for (let i = 1; i < points.length; i++) routeM += distanceM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    expect(total).toBeCloseTo(routeM, 3);
    // A tighter bound or a smaller budget needs more parts; a loose bound with many corners needs fewer.
    expect(splitIntoParts(points, { maxInterior: 9, maxDeviationM: 10 }).length).toBeGreaterThanOrEqual(parts.length);
    expect(splitIntoParts(points, { maxInterior: 3, maxDeviationM: 60 }).length).toBeGreaterThan(parts.length);
    expect(splitIntoParts(points, { maxInterior: 30, maxDeviationM: 60 }).length).toBeLessThan(parts.length);
    // Each part is greedy-maximal: one vertex more and its 9-corner simplification breaks the bound
    // (measured as the splitter does — every vertex against the chord it sits on).
    for (let i = 0; i + 1 < parts.length; i++) {
      const p = parts[i];
      const from = points.indexOf(p.start);
      const longer = points.slice(from, from + p.points.length + 1);
      const sel = [0, ...significantCorners(longer, 9), longer.length - 1];
      let worst = 0;
      for (let k = 0; k + 1 < sel.length; k++) worst = Math.max(worst, deviationM(longer.slice(sel[k], sel[k + 1] + 1), [longer[sel[k]], longer[sel[k + 1]]]));
      expect(worst).toBeGreaterThan(60);
    }
  });

  it('handles the degenerate routes: two points, duplicates, one point', () => {
    const line = [at(0, 0), at(1400, 0)];
    expect(splitIntoParts(line)).toEqual([{ points: line, corners: [], start: line[0], end: line[1], lengthM: expect.closeTo(1400, 0) }]);
    const dup = [at(0, 0), at(0, 0), at(100, 0), at(100, 0), at(100, 100)];
    const parts = splitIntoParts(dup);
    expect(parts).toHaveLength(1);
    expect(parts[0].points).toEqual([at(0, 0), at(100, 0), at(100, 100)]);
    expect(parts[0].corners).toEqual([at(100, 0)]);
    expect(splitIntoParts([at(0, 0)])).toEqual([]);
    expect(splitIntoParts([at(0, 0), at(0, 0)])).toEqual([]);
    expect(splitIntoParts([])).toEqual([]);
  });

  it('a loop (start = end) splits like any other route', () => {
    const square: Array<[number, number]> = [[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]];
    const { points } = polyline(square);
    const parts = splitIntoParts(points);
    expect(parts).toHaveLength(1);
    expect(parts[0].corners).toHaveLength(3);
    expect(parts[0].start).toEqual(parts[0].end);
  });

  // Route-quality 4: the "Straight across" candidate (and the two-component gap) carry a straight
  // leg Google would route round or refuse; no test fed a candidate with parts to the splitter.
  it('splitCandidate cuts at straight legs: walking runs either side, nothing spans the water; a straight-only line goes whole', () => {
    const west = polyline(gridWalk(20)).points; // a long grid walk: several parts on its own
    const shore = west[west.length - 1];
    const far: LonLat = [shore[0] + 1200 / KX, shore[1]];
    const east = polyline([[0, 0], [300, 0], [300, 300]]).points.map(([lon, lat]) => [lon + (far[0] - LON0), lat + (far[1] - LAT0)] as LonLat);
    const off: LonLat[] = [at(-80, 0), west[0]];
    const c = {
      coords: [...off, ...west, ...east],
      parts: [
        { kind: 'offroad', coords: off },
        { kind: 'street', coords: west },
        { kind: 'straight', coords: [shore, far] },
        { kind: 'street', coords: east },
      ],
    };
    const parts = splitCandidate(c, DEFAULT_SPLIT);
    const westParts = splitIntoParts([...off, ...west], DEFAULT_SPLIT);
    expect(westParts.length).toBeGreaterThanOrEqual(2);
    expect(parts).toHaveLength(westParts.length + 1);
    // The off-road leg joins the first walking run; the last west part ends at the shore, the east part starts across the water.
    expect(parts[0].start).toEqual(off[0]);
    expect(parts[westParts.length - 1].end).toEqual(shore);
    expect(parts[westParts.length].start).toEqual(far);
    expect(parts[westParts.length].end).toEqual(east[east.length - 1]);
    expect(parts.slice(0, westParts.length)).toEqual(westParts);
    expect(parts.filter((p) => p.points.includes(shore) && p.points.includes(far))).toEqual([]); // nothing spans the water
    expect(parts.reduce((s, p) => s + p.lengthM, 0)).toBeCloseTo(splitIntoParts(c.coords, DEFAULT_SPLIT).reduce((s, p) => s + p.lengthM, 0) - 1200, -1);
    // Without parts, or without a straight leg, it is splitIntoParts.
    expect(splitCandidate({ coords: west }, DEFAULT_SPLIT)).toEqual(splitIntoParts(west, DEFAULT_SPLIT));
    expect(splitCandidate({ coords: west, parts: [{ kind: 'street', coords: west }] }, DEFAULT_SPLIT)).toEqual(splitIntoParts(west, DEFAULT_SPLIT));
    // A straight-only line (Route anyway) is handed over whole.
    const line = [at(0, 0), at(1400, 0)];
    expect(splitCandidate({ coords: line, parts: [{ kind: 'straight', coords: line }] }, DEFAULT_SPLIT)).toEqual(splitIntoParts(line, DEFAULT_SPLIT));
  });
});

// ================================================================ URLs + labels + GPX

describe('URLs', () => {
  const part: RoutePart = { points: [], corners: [at(200, 0), at(200, 200)], start: at(0, 0), end: at(400, 200), lengthM: 600 };

  it('Google Maps: Directions form, 5-decimal LAT,LNG, %7C between waypoints, walking, navigate', () => {
    const url = googleMapsUrl(part, { navigate: true });
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=40.71760,-73.95680&destination=40.71941,-73.95206&waypoints=40.71760,-73.95443%7C40.71941,-73.95443&travelmode=walking&dir_action=navigate',
    );
    const u = new URL(url);
    expect(u.host).toBe('www.google.com');
    expect(u.pathname).toBe('/maps/dir/');
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('travelmode')).toBe('walking');
    expect(u.searchParams.get('waypoints')!.split('|')).toHaveLength(2);
    expect(url).not.toContain('%2C');
    // Without navigate, no dir_action; from the device, no origin.
    expect(googleMapsUrl(part)).not.toContain('dir_action');
    const dev = googleMapsUrl(part, { navigate: true, originFromDevice: true });
    expect(dev).not.toContain('origin=');
    expect(dev).toContain('destination=40.71941,-73.95206');
    // No corners → no waypoints parameter at all.
    expect(googleMapsUrl({ ...part, corners: [] })).toBe('https://www.google.com/maps/dir/?api=1&origin=40.71760,-73.95680&destination=40.71941,-73.95206&travelmode=walking');
  });

  it('Apple Maps: walking directions to the destination, from the device unless an origin is given', () => {
    expect(appleMapsUrl(at(400, 200))).toBe('https://maps.apple.com/?daddr=40.71941,-73.95206&dirflg=w');
    expect(appleMapsUrl(at(400, 200), at(0, 0))).toBe('https://maps.apple.com/?saddr=40.71760,-73.95680&daddr=40.71941,-73.95206&dirflg=w');
  });

  it('formats coordinates lat first, never "-0.00000"', () => {
    expect(fmtLatLng([-0.0000001, 51.5])).toBe('51.50000,0.00000');
    expect(fmtLatLng([-122.4194155, 37.7749295])).toBe('37.77493,-122.41942');
  });

  it('labels parts one-based and names the GPX after the trip', () => {
    expect(partLabel(0, 3)).toBe('Part 1 of 3');
    expect(partLabel(2, 3)).toBe('Part 3 of 3');
    expect(routeGpxFileName('Domino Park')).toBe('unfog-route-domino-park.gpx');
    expect(routeGpxFileName('Café Réveil / N 7th St.')).toBe('unfog-route-cafe-reveil-n-7th-st.gpx');
    expect(routeGpxFileName('   ')).toBe('unfog-route-route.gpx');
    expect(routeGpxFileName('x'.repeat(80))).toBe(`unfog-route-${'x'.repeat(40)}.gpx`);
  });

  it('writes the route as a GPX track named after the trip', () => {
    const gpx = routeToGpx([at(0, 0), at(100, 0), at(100, 100)], 'Unfog route · Domino Park');
    expect(gpx).toMatch(/^<\?xml/);
    expect(gpx).toContain('creator="Unfog"');
    expect(gpx).toContain('<name>Unfog route · Domino Park</name>');
    expect((gpx.match(/<trkpt /g) ?? []).length).toBe(3);
    expect(gpx).not.toContain('<time>');
  });
});

// ================================================================ a real NYC route

const REGION = new URL('../../public/graph/nyc', import.meta.url).pathname;
const HAVE = existsSync(join(REGION, 'manifest.json'));
const HOME: LonLat = [-73.9568, 40.7176];
const DOMINO: LonLat = [-73.9678, 40.7142];
const TIMES_SQ: LonLat = [-73.9855, 40.758];
const PROSPECT: LonLat = [-73.969, 40.6602];

/** The z12 tiles the engine would load for the route's bbox (routeBBox pads by 60 % of the span). */
function loadTiles(from: LonLat, to: LonLat): GraphTile[] {
  const out: GraphTile[] = [];
  for (const [x, y] of graphTilesFor(routeBBox(from, to))) {
    const f = join(REGION, graphTilePath(x, y));
    if (existsSync(f)) out.push(unpackGraphTile(new Uint8Array(readFileSync(f))));
  }
  return out;
}

const COORD5 = /^-?\d+\.\d{5},-?\d+\.\d{5}$/;

function expectGoogleUrl(url: string): URL {
  expect(url.length).toBeLessThan(GOOGLE_MAX_URL_LENGTH);
  const u = new URL(url);
  expect(u.host).toBe('www.google.com');
  expect(u.pathname).toBe('/maps/dir/');
  expect(u.searchParams.get('api')).toBe('1');
  expect(u.searchParams.get('travelmode')).toBe('walking');
  expect(u.searchParams.get('origin')).toMatch(COORD5);
  expect(u.searchParams.get('destination')).toMatch(COORD5);
  const wp = u.searchParams.get('waypoints');
  if (wp !== null) {
    expect(url).toContain('%7C');
    const list = wp.split('|');
    expect(list.length).toBeLessThanOrEqual(GOOGLE_MAX_WAYPOINTS);
    for (const w of list) expect(w).toMatch(COORD5);
  }
  return u;
}

describe.skipIf(!HAVE)('real NYC routes through the splitter', () => {
  it('Times Square → Prospect Park (~12 km) opens in ≥ 2 parts whose URLs chain and fit', { timeout: 60_000 }, () => {
    const tiles = loadTiles(TIMES_SQ, PROSPECT);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    const graph = new Graph(tiles);
    const lookup = new MapCellLookup();
    const res = findCandidates(graph, lookup, { from: TIMES_SQ, to: PROSPECT, mode: 'walk', detour: 0.25 });
    expect(res.candidates.length).toBeGreaterThanOrEqual(1);
    const bench: string[] = [];
    for (const c of res.candidates) {
      const parts = splitIntoParts(c.coords, DEFAULT_SPLIT);
      bench.push(`${c.name} ${Math.round(c.lengthM)} m, ${c.coords.length} vertices → ${parts.length} parts (${parts.map((p) => `${p.corners.length} corners/${Math.round(p.lengthM)} m/${googleMapsUrl(p).length} chars`).join(', ')})`);
      expect(parts.length, `${c.name}: ${c.coords.length} vertices, ${Math.round(c.lengthM)} m`).toBeGreaterThanOrEqual(2);
      expectContiguousCover(parts, c.coords);
      const urls = parts.map((p, i) => googleMapsUrl(p, { navigate: true, originFromDevice: i === 0 }));
      urls.forEach((url, i) => {
        const u = new URL(url);
        if (i === 0) expect(u.searchParams.get('origin')).toBeNull();
        else {
          expectGoogleUrl(url);
          expect(u.searchParams.get('origin')).toBe(fmtLatLng(parts[i - 1].end));
        }
        expect(u.searchParams.get('dir_action')).toBe('navigate');
        expect(deviationM(parts[i].points, withEnds(parts[i]))).toBeLessThanOrEqual(DEFAULT_SPLIT.maxDeviationM);
      });
      // The sum of the parts is the route.
      expect(parts.reduce((s, p) => s + p.lengthM, 0)).toBeCloseTo(c.lengthM, -2);
    }
    // Williamsburg home → Domino Park (~1.3 km) on the same tiles: a part or two, every URL well within the cap.
    const wb = findCandidates(graph, lookup, { from: HOME, to: DOMINO, mode: 'walk', detour: 0.25 });
    for (const c of wb.candidates) {
      const parts = splitIntoParts(c.coords, DEFAULT_SPLIT);
      bench.push(`WB ${c.name} ${Math.round(c.lengthM)} m, ${c.coords.length} vertices → ${parts.length} part(s), ${parts.map((p) => p.corners.length).join('/')} corners`);
      expect(parts.length).toBeLessThanOrEqual(2);
      for (const p of parts) expectGoogleUrl(googleMapsUrl(p, { navigate: true })).searchParams.get('destination');
      const apple = new URL(appleMapsUrl(DOMINO));
      expect(apple.host).toBe('maps.apple.com');
      expect(apple.searchParams.get('daddr')).toBe(fmtLatLng(DOMINO));
      expect(apple.searchParams.get('dirflg')).toBe('w');
    }
    // eslint-disable-next-line no-console
    console.log('[handoff bench]', `${tiles.length} tiles;`, bench.join(' | '));
  });
});
