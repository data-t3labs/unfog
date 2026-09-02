/**
 * Google Timeline importer. Lenient about field presence; accepts:
 *  (a) the current on-device export — `{ semanticSegments: [...] }` (Android) or a bare array
 *      of segments (iOS): `timelinePath[] { point: "geo:lat,lng", time | durationMinutesOffsetFromStartTime }`,
 *      `visit.topCandidate.placeLocation.latLng "lat°, lng°"`, `activity.start/end.latLng`;
 *      `rawSignals[].position` is used only when the semantic segments yield nothing;
 *  (b) legacy Takeout `Records.json` — `{ locations: [{ latitudeE7, longitudeE7, timestamp | timestampMs, accuracy }] }`;
 *  (c) legacy Takeout "Semantic Location History" — `{ timelineObjects: [{ activitySegment | placeVisit }] }`.
 * Fixes with accuracy > 100 m are dropped. Fix streams become per-day tracks, then split on
 * gaps > 500 m / > 30 min like GPX. Visits become single-point tracks (they still mark a cell).
 */
import type { Track } from '../grid/types';
import { type GapOptions, type TrackPoint, dayKey, dayLabel, isFiniteLonLat, makePoint, parseTimeMs, splitOnGaps, tracksFromGroups } from './util';

export interface TimelineOptions extends GapOptions {
  /** Drop fixes whose reported accuracy exceeds this (metres, default 100). */
  maxAccuracyM?: number;
  /** Which calendar to use for "one track per day": the runtime's local zone (default) or UTC. */
  dayBoundary?: 'local' | 'utc';
  /** File name (track ids). */
  name?: string;
  /** Always include `rawSignals` positions (default: only when semantic segments yield no tracks). */
  includeRawSignals?: boolean;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const PAIR_RE = /(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?/;

/**
 * Parse any of Google's coordinate spellings into [lon, lat]:
 * "geo:lat,lng", "lat°, lng°", "lat,lng", {latitude,longitude}, {lat,lng}, {latE7,lngE7},
 * {latitudeE7,longitudeE7}, {latLng: ...}.
 */
export function parseLatLng(v: unknown): [lon: number, lat: number] | null {
  if (typeof v === 'string') {
    const m = PAIR_RE.exec(v);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    return isFiniteLonLat(lon, lat) ? [lon, lat] : null;
  }
  if (!isObj(v)) return null;
  if ('latLng' in v) return parseLatLng(v.latLng);
  let lat = num(v.latitude) ?? num(v.lat);
  let lon = num(v.longitude) ?? num(v.lng) ?? num(v.lon);
  if (lat === undefined || lon === undefined) {
    const latE7 = num(v.latitudeE7) ?? num(v.latE7);
    const lngE7 = num(v.longitudeE7) ?? num(v.lngE7);
    if (latE7 !== undefined && lngE7 !== undefined) {
      lat = latE7 / 1e7;
      lon = lngE7 / 1e7;
    }
  }
  if (lat === undefined || lon === undefined) return null;
  return isFiniteLonLat(lon, lat) ? [lon, lat] : null;
}

/** Group timed fixes by calendar day (untimed fixes stay with their neighbours), then by gaps. */
function groupFixes(points: TrackPoint[], opts: TimelineOptions): TrackPoint[][] {
  const boundary = opts.dayBoundary ?? 'local';
  const days: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  let curDay: number | undefined;
  for (const p of points) {
    const t = p[2];
    if (t !== undefined) {
      const d = dayKey(t, boundary);
      if (curDay !== undefined && d !== curDay && cur.length > 0) {
        days.push(cur);
        cur = [];
      }
      curDay = d;
    }
    cur.push(p);
  }
  if (cur.length > 0) days.push(cur);
  const out: TrackPoint[][] = [];
  for (const day of days) out.push(...splitOnGaps(day, opts));
  return out;
}

function firstTime(points: TrackPoint[]): number | undefined {
  for (const p of points) if (p[2] !== undefined) return p[2];
  return undefined;
}

class Collector {
  tracks: Track[] = [];
  constructor(private readonly opts: TimelineOptions) {}

  /** Emit per-day / per-gap tracks from a fix stream. */
  addFixes(points: TrackPoint[], labelPrefix: string): void {
    if (points.length === 0) return;
    const boundary = this.opts.dayBoundary ?? 'local';
    for (const group of groupFixes(points, this.opts)) {
      const t = firstTime(group);
      const name = t !== undefined ? `${labelPrefix} ${dayLabel(t, boundary)}` : labelPrefix;
      this.tracks.push(...tracksFromGroups('timeline', this.opts.name, [group], this.tracks.length, name));
    }
  }

  /** Emit one track (already a coherent path), split only on gaps. */
  addPath(points: TrackPoint[], name: string | undefined): void {
    if (points.length === 0) return;
    this.tracks.push(...tracksFromGroups('timeline', this.opts.name, splitOnGaps(points, this.opts), this.tracks.length, name));
  }
}

/* ---------- (a) current on-device export ---------- */

function segmentStart(seg: Obj): number | undefined {
  return parseTimeMs(seg.startTime) ?? parseTimeMs(seg.startTimestamp);
}

function parseSemanticSegment(seg: unknown, col: Collector, opts: TimelineOptions): void {
  if (!isObj(seg)) return;
  const startMs = segmentStart(seg);
  const endMs = parseTimeMs(seg.endTime) ?? parseTimeMs(seg.endTimestamp);
  const boundary = opts.dayBoundary ?? 'local';

  if (Array.isArray(seg.timelinePath)) {
    const pts: TrackPoint[] = [];
    for (const it of seg.timelinePath) {
      if (!isObj(it)) continue;
      const ll = parseLatLng(it.point ?? it.latLng ?? it);
      if (!ll) continue;
      let t = parseTimeMs(it.time);
      if (t === undefined && startMs !== undefined) {
        const off = num(it.durationMinutesOffsetFromStartTime);
        if (off !== undefined) t = startMs + off * 60_000;
      }
      pts.push(makePoint(ll[0], ll[1], t));
    }
    const t = firstTime(pts) ?? startMs;
    col.addPath(pts, t !== undefined ? `Timeline ${dayLabel(t, boundary)}` : 'Timeline path');
    return;
  }

  if (isObj(seg.visit)) {
    const visit = seg.visit;
    const cand = isObj(visit.topCandidate) ? visit.topCandidate : visit;
    const ll = parseLatLng(cand.placeLocation) ?? parseLatLng(visit.placeLocation) ?? parseLatLng(cand);
    if (!ll) return;
    const semantic = typeof cand.semanticType === 'string' ? cand.semanticType : undefined;
    const name = semantic && semantic !== 'UNKNOWN' ? `Visit (${semantic.toLowerCase()})` : 'Visit';
    col.addPath([makePoint(ll[0], ll[1], startMs)], name);
    return;
  }

  if (isObj(seg.activity)) {
    const act = seg.activity;
    const pts: TrackPoint[] = [];
    const a = parseLatLng(act.start);
    const b = parseLatLng(act.end);
    if (a) pts.push(makePoint(a[0], a[1], startMs));
    if (b) pts.push(makePoint(b[0], b[1], endMs ?? startMs));
    const cand = isObj(act.topCandidate) ? act.topCandidate : undefined;
    const type = cand && typeof cand.type === 'string' ? cand.type : undefined;
    col.addPath(pts, type ? `Activity (${type.toLowerCase()})` : 'Activity');
  }
}

function parseRawSignals(signals: unknown[], col: Collector, opts: TimelineOptions): void {
  const maxAcc = opts.maxAccuracyM ?? 100;
  const pts: TrackPoint[] = [];
  for (const s of signals) {
    if (!isObj(s) || !isObj(s.position)) continue;
    const pos = s.position;
    const acc = num(pos.accuracyMeters) ?? num(pos.accuracy);
    if (acc !== undefined && acc > maxAcc) continue;
    const ll = parseLatLng(pos.LatLng ?? pos.latLng ?? pos.point ?? pos);
    if (!ll) continue;
    pts.push(makePoint(ll[0], ll[1], parseTimeMs(pos.timestamp) ?? parseTimeMs(pos.time)));
  }
  sortByTime(pts);
  col.addFixes(pts, 'Timeline');
}

/* ---------- (b) legacy Records.json ---------- */

function parseRecords(locations: unknown[], col: Collector, opts: TimelineOptions): void {
  const maxAcc = opts.maxAccuracyM ?? 100;
  const pts: TrackPoint[] = [];
  for (const loc of locations) {
    if (!isObj(loc)) continue;
    const acc = num(loc.accuracy);
    if (acc !== undefined && acc > maxAcc) continue;
    const ll = parseLatLng(loc);
    if (!ll) continue;
    pts.push(makePoint(ll[0], ll[1], parseTimeMs(loc.timestamp) ?? parseTimeMs(loc.timestampMs)));
  }
  sortByTime(pts);
  col.addFixes(pts, 'Timeline');
}

/** Stable sort by time when every point is timed (Takeout files are usually, not always, chronological). */
function sortByTime(pts: TrackPoint[]): void {
  if (pts.length < 2 || pts.some((p) => p[2] === undefined)) return;
  pts.sort((a, b) => (a[2] as number) - (b[2] as number));
}

/* ---------- (c) legacy Semantic Location History ---------- */

function parseTimelineObject(obj: unknown, col: Collector, opts: TimelineOptions): void {
  if (!isObj(obj)) return;
  const boundary = opts.dayBoundary ?? 'local';
  if (isObj(obj.activitySegment)) {
    const a = obj.activitySegment;
    const dur = isObj(a.duration) ? a.duration : {};
    const startMs = parseTimeMs(dur.startTimestamp) ?? parseTimeMs(dur.startTimestampMs);
    const endMs = parseTimeMs(dur.endTimestamp) ?? parseTimeMs(dur.endTimestampMs);
    const pts: TrackPoint[] = [];
    const raw = isObj(a.simplifiedRawPath) && Array.isArray(a.simplifiedRawPath.points) ? a.simplifiedRawPath.points : null;
    if (raw && raw.length > 0) {
      for (const p of raw) {
        if (!isObj(p)) continue;
        const ll = parseLatLng(p);
        if (!ll) continue;
        pts.push(makePoint(ll[0], ll[1], parseTimeMs(p.timestamp) ?? parseTimeMs(p.timestampMs)));
      }
    } else {
      const s = parseLatLng(a.startLocation);
      if (s) pts.push(makePoint(s[0], s[1], startMs));
      const wp = isObj(a.waypointPath) && Array.isArray(a.waypointPath.waypoints) ? a.waypointPath.waypoints : [];
      for (const w of wp) {
        const ll = parseLatLng(w);
        if (ll) pts.push(makePoint(ll[0], ll[1], undefined));
      }
      const e = parseLatLng(a.endLocation);
      if (e) pts.push(makePoint(e[0], e[1], endMs ?? startMs));
    }
    const type = typeof a.activityType === 'string' ? a.activityType : undefined;
    const t = firstTime(pts);
    const when = t !== undefined ? ` ${dayLabel(t, boundary)}` : '';
    col.addPath(pts, `${type ? `Activity (${type.toLowerCase()})` : 'Activity'}${when}`);
    return;
  }
  if (isObj(obj.placeVisit)) {
    const v = obj.placeVisit;
    const ll = parseLatLng(v.location) ?? parseLatLng(v.centerLatE7 !== undefined ? { latE7: v.centerLatE7, lngE7: v.centerLngE7 } : null);
    if (!ll) return;
    const dur = isObj(v.duration) ? v.duration : {};
    const t = parseTimeMs(dur.startTimestamp) ?? parseTimeMs(dur.startTimestampMs);
    col.addPath([makePoint(ll[0], ll[1], t)], 'Visit');
  }
}

/* ---------- entry point ---------- */

/**
 * Parse a Timeline JSON document (already `JSON.parse`d, or a string) into tracks. Unknown
 * shapes yield an empty array rather than throwing; malformed entries are skipped.
 */
export function parseTimeline(json: unknown, opts: TimelineOptions = {}): Track[] {
  const root: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  const col = new Collector(opts);

  if (Array.isArray(root)) {
    const first = root.find((x) => isObj(x));
    if (isObj(first) && (first.latitudeE7 !== undefined || first.latE7 !== undefined)) parseRecords(root, col, opts);
    else for (const seg of root) parseSemanticSegment(seg, col, opts);
    return col.tracks;
  }
  if (!isObj(root)) return col.tracks;

  if (Array.isArray(root.semanticSegments)) {
    for (const seg of root.semanticSegments) parseSemanticSegment(seg, col, opts);
  }
  if (Array.isArray(root.timelineObjects)) {
    for (const obj of root.timelineObjects) parseTimelineObject(obj, col, opts);
  }
  if (Array.isArray(root.locations)) {
    parseRecords(root.locations, col, opts);
  }
  if (Array.isArray(root.rawSignals) && (opts.includeRawSignals || col.tracks.length === 0)) {
    parseRawSignals(root.rawSignals, col, opts);
  }
  return col.tracks;
}
