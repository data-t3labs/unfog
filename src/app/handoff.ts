/**
 * Hand a route to a navigation app (feedback-3, data: "one tap opens it in Google Maps for
 * turn-by-turn"). Unfog is a web app and cannot navigate in the background; Google Maps can.
 *
 * Google Maps URLs (Directions form, https://developers.google.com/maps/documentation/urls) take an
 * origin, a destination and up to 9 waypoints when the Google Maps app handles the link (3 in a
 * mobile browser), the whole URL ≤ 2,048 characters; Google routes on its own network between the
 * points, so it may shortcut between two of them. A route is therefore reduced to its most
 * significant corners (Douglas–Peucker with a count budget) and, when 9 corners cannot hold it
 * within `maxDeviationM` of the original line, split into contiguous parts that chain end to start.
 *
 * `comgooglemaps://` takes no waypoints and Apple Maps takes one destination — the latter is the
 * fallback, destination only. Pure module: no DOM, no app state; unit-tested in node.
 */
import { distanceM } from '../grid/cell';
import { trackToGpx } from '../record/gpx';
import type { LonLat } from '../routing/api';

export interface RoutePart {
  /** The original vertices of this part, first to last (the last is the next part's first). */
  points: LonLat[];
  /** Interior checkpoints in route order — the Google Maps waypoints. */
  corners: LonLat[];
  start: LonLat;
  end: LonLat;
  /** Metres along `points`. */
  lengthM: number;
}

export interface SplitOptions {
  /** Interior corners a part may carry. Default 9 (the Google Maps app's waypoint limit). */
  maxInterior?: number;
  /** A part is cut once its simplification strays further than this from the route. Default 60 m. */
  maxDeviationM?: number;
  /** A vertex closer than this to the chord it sits on is not a corner (shape noise). Default 3 m. */
  minCornerM?: number;
}

/** Google Maps app: 9 waypoints per Directions URL; a mobile browser takes only 3. */
export const GOOGLE_MAX_WAYPOINTS = 9;
/** Google's documented cap on the whole URL. */
export const GOOGLE_MAX_URL_LENGTH = 2048;
export const DEFAULT_SPLIT: Required<SplitOptions> = { maxInterior: GOOGLE_MAX_WAYPOINTS, maxDeviationM: 60, minCornerM: 3 };

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- geometry (local plane, metres)

interface Plane {
  xs: Float64Array;
  ys: Float64Array;
}

/** Equirectangular projection about the polyline's mean latitude — the same model as distanceM. */
function projector(points: LonLat[]): (p: LonLat) => [number, number] {
  let lat = 0;
  for (const p of points) lat += p[1];
  lat /= points.length || 1;
  const kx = 111_320 * Math.cos(lat * DEG), ky = 110_574;
  const lon0 = points[0]?.[0] ?? 0, lat0 = points[0]?.[1] ?? 0;
  return (p) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky];
}

function toPlane(points: LonLat[], project = projector(points)): Plane {
  const xs = new Float64Array(points.length), ys = new Float64Array(points.length);
  points.forEach((p, i) => {
    const [x, y] = project(p);
    xs[i] = x;
    ys[i] = y;
  });
  return { xs, ys };
}

/** Distance from P to the segment AB (to the point when A = B). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Douglas–Peucker with a count budget on `points[s..e]`: start from the chord, repeatedly add the
 * vertex that deviates most from its current segment, until `maxInterior` interior vertices are in
 * or nothing deviates by more than `minM`. Ties go to the lower index (strict `>` on an ascending
 * scan), so the choice is deterministic. `residualM` is the largest deviation left after the last
 * pick, each vertex measured against the chord it sits on (at least its distance to the whole
 * simplified polyline, so a part that passes here passes deviationM too).
 */
function pick(pl: Plane, s: number, e: number, maxInterior: number, minM: number): { interior: number[]; residualM: number } {
  const sel: number[] = [s, e];
  let residual = 0;
  for (let round = 0; ; round++) {
    let bestD = 0, bestI = -1, bestSeg = -1;
    for (let k = 0; k + 1 < sel.length; k++) {
      const a = sel[k], b = sel[k + 1];
      const ax = pl.xs[a], ay = pl.ys[a], bx = pl.xs[b], by = pl.ys[b];
      for (let i = a + 1; i < b; i++) {
        const d = segDist(pl.xs[i], pl.ys[i], ax, ay, bx, by);
        if (d > bestD) {
          bestD = d;
          bestI = i;
          bestSeg = k;
        }
      }
    }
    residual = bestD;
    if (bestI < 0 || bestD <= minM || round >= maxInterior) break;
    sel.splice(bestSeg + 1, 0, bestI);
  }
  return { interior: sel.slice(1, -1), residualM: residual };
}

/** Consecutive duplicates dropped (a snap point repeated at a part boundary, say). */
function dedupe(points: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

function polylineLengthM(points: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += distanceM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  return m;
}

// ---------------------------------------------------------------- public: simplification + split

/**
 * Indices (route order) of the `maxInterior` most significant interior vertices of `points`:
 * largest perpendicular deviation first, endpoints excluded, deterministic. Fewer when the rest
 * of the line lies within `minDeviationM` of the chords already (a straight route has no corners).
 */
export function significantCorners(points: LonLat[], maxInterior: number, minDeviationM = DEFAULT_SPLIT.minCornerM): number[] {
  if (points.length < 3 || maxInterior <= 0) return [];
  return pick(toPlane(points), 0, points.length - 1, maxInterior, minDeviationM).interior;
}

/** The largest distance (m) of any of `points` from the polyline `simplified`. */
export function deviationM(points: LonLat[], simplified: LonLat[]): number {
  if (!points.length) return 0;
  if (!simplified.length) return Infinity;
  const project = projector(points);
  const pl = toPlane(points, project), sp = toPlane(simplified, project);
  let worst = 0;
  for (let i = 0; i < points.length; i++) {
    let best = Infinity;
    if (sp.xs.length === 1) best = segDist(pl.xs[i], pl.ys[i], sp.xs[0], sp.ys[0], sp.xs[0], sp.ys[0]);
    for (let k = 0; k + 1 < sp.xs.length && best > 0; k++) {
      const d = segDist(pl.xs[i], pl.ys[i], sp.xs[k], sp.ys[k], sp.xs[k + 1], sp.ys[k + 1]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Cut a route into parts a navigation app can take: each part carries at most `maxInterior`
 * corners and its corner polyline stays within `maxDeviationM` of the original vertices. Greedy:
 * a part grows vertex by vertex until its simplification strays past the bound, then it is cut at
 * the last good vertex, which is also where the next part begins. Parts are contiguous and cover
 * the whole route; a route of fewer than two distinct points gives none.
 */
export function splitIntoParts(input: LonLat[], opts: SplitOptions = {}): RoutePart[] {
  const maxInterior = opts.maxInterior ?? DEFAULT_SPLIT.maxInterior;
  const maxDev = opts.maxDeviationM ?? DEFAULT_SPLIT.maxDeviationM;
  const minM = opts.minCornerM ?? DEFAULT_SPLIT.minCornerM;
  const points = dedupe(input);
  const n = points.length;
  if (n < 2) return [];
  const pl = toPlane(points);
  const parts: RoutePart[] = [];
  let s = 0;
  while (s < n - 1) {
    // Up to maxInterior + 2 vertices are represented exactly; scan on from there.
    let good = Math.min(n - 1, s + maxInterior + 1);
    let best = pick(pl, s, good, maxInterior, minM);
    for (let e = good + 1; e < n; e++) {
      const p = pick(pl, s, e, maxInterior, minM);
      if (p.residualM > maxDev) break;
      good = e;
      best = p;
    }
    const slice = points.slice(s, good + 1);
    parts.push({ points: slice, corners: best.interior.map((i) => points[i]), start: points[s], end: points[good], lengthM: polylineLengthM(slice) });
    s = good;
  }
  return parts;
}

/**
 * Parts for a route candidate that may carry `straight` legs (RouteCandidate.parts): a straight
 * leg — water, a void the street map has no way over — is not a walking route, so the route is
 * cut there and each walkable run (street + off-road parts) is split on its own; consecutive
 * parts either chain end to start or sit either side of a straight leg. A candidate that is
 * nothing but straight legs (the "Route anyway" line) is handed over whole: Google routes it on
 * its own network. Without parts (mock engine, loops) this is splitIntoParts.
 */
export function splitCandidate(c: { coords: LonLat[]; parts?: Array<{ kind: string; coords: LonLat[] }> }, opts: SplitOptions = {}): RoutePart[] {
  if (!c.parts?.length || !c.parts.some((p) => p.kind === 'straight')) return splitIntoParts(c.coords, opts);
  const out: RoutePart[] = [];
  let run: LonLat[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(...splitIntoParts(run, opts));
    run = [];
  };
  for (const p of c.parts) {
    if (p.kind === 'straight') flush();
    else run.push(...p.coords);
  }
  flush();
  return out.length ? out : splitIntoParts(c.coords, opts);
}

/** "Part 1 of 3" (i is zero-based). */
export function partLabel(i: number, n: number): string {
  return `Part ${i + 1} of ${n}`;
}

// ---------------------------------------------------------------- public: URLs + GPX

/** `LAT,LNG` at 5 decimals (≈ 1 m) — the order Google and Apple expect. */
export function fmtLatLng(p: LonLat): string {
  const f = (v: number) => {
    const s = v.toFixed(5);
    return s === '-0.00000' ? '0.00000' : s;
  };
  return `${f(p[1])},${f(p[0])}`;
}

export interface GoogleMapsOptions {
  /** `dir_action=navigate`: turn-by-turn straight away when the origin is the phone's position (else a route preview). */
  navigate?: boolean;
  /**
   * Leave `origin` out so Google starts from the device's location — for the first part of a route
   * that begins where the user stands. Later parts (and routes from the map centre) name their origin.
   */
  originFromDevice?: boolean;
}

/**
 * Directions URL for one part. Query built by hand: commas stay literal and the waypoint separator
 * is `%7C`, as in Google's examples. The caller keeps `corners` ≤ GOOGLE_MAX_WAYPOINTS
 * (splitIntoParts does); nothing is truncated here.
 */
export function googleMapsUrl(part: Pick<RoutePart, 'start' | 'end' | 'corners'>, opts: GoogleMapsOptions = {}): string {
  const q = ['api=1'];
  if (!opts.originFromDevice) q.push(`origin=${fmtLatLng(part.start)}`);
  q.push(`destination=${fmtLatLng(part.end)}`);
  if (part.corners.length) q.push(`waypoints=${part.corners.map(fmtLatLng).join('%7C')}`);
  q.push('travelmode=walking');
  if (opts.navigate) q.push('dir_action=navigate');
  return `https://www.google.com/maps/dir/?${q.join('&')}`;
}

/** Apple Maps walking directions to one point (no waypoints exist); from the device unless `origin` is given. */
export function appleMapsUrl(destination: LonLat, origin?: LonLat): string {
  return `https://maps.apple.com/?${origin ? `saddr=${fmtLatLng(origin)}&` : ''}daddr=${fmtLatLng(destination)}&dirflg=w`;
}

/** The route as a GPX track (the form every other navigation app imports), named after the trip. */
export function routeToGpx(coords: LonLat[], name: string): string {
  return trackToGpx({ id: 'route', source: 'route', name, points: coords.map(([lon, lat]) => [lon, lat]) }, name);
}

/** unfog-route-domino-park.gpx */
export function routeGpxFileName(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `unfog-route-${slug || 'route'}.gpx`;
}
