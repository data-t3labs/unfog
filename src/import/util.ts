/**
 * Small helpers shared by the importers. Everything here runs in a Web Worker and in Node
 * (no DOM, no Node-only APIs).
 */
import { distanceM } from '../grid/cell';
import type { Track } from '../grid/types';

/** A file handed to an importer: the name the user picked and its raw bytes. */
export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

/** [lon, lat, timeMs?] — the shape `Track.points` uses. */
export type TrackPoint = [lon: number, lat: number, timeMs?: number];

/** Consecutive fixes further apart than this are never joined (docs/BUILD-PLAN.md §2.5). */
export const DEFAULT_GAP_M = 500;
/** Consecutive fixes further apart in time than this start a new track. */
export const DEFAULT_GAP_MS = 30 * 60_000;

export interface GapOptions {
  /** Distance gap in metres (default 500). */
  gapM?: number;
  /** Time gap in milliseconds (default 30 min). Only applies when both fixes carry a time. */
  gapMs?: number;
}

/** Last path segment of a zip entry or file name (handles both separators). */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? path : path.slice(i + 1);
}

export function isFiniteLonLat(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/** Build a point, omitting the time slot when unknown so JSON stays `[lon, lat]`. */
export function makePoint(lon: number, lat: number, timeMs: number | undefined): TrackPoint {
  return timeMs === undefined || !Number.isFinite(timeMs) ? [lon, lat] : [lon, lat, timeMs];
}

/**
 * Split an ordered point list wherever consecutive fixes are further apart than `gapM` metres,
 * or more than `gapMs` apart in time (when both are timed). Never returns empty parts.
 */
export function splitOnGaps(points: TrackPoint[], opts: GapOptions = {}): TrackPoint[][] {
  const gapM = opts.gapM ?? DEFAULT_GAP_M;
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const out: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (cur.length > 0) {
      const q = cur[cur.length - 1];
      const dt = p[2] !== undefined && q[2] !== undefined ? p[2] - q[2] : 0;
      if (dt > gapMs || distanceM(q[0], q[1], p[0], p[1]) > gapM) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(p);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** FNV-1a 32-bit hash of a string (deterministic ids without a crypto dependency). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic track id: the same file re-imported yields the same ids, so the store can
 * dedupe. Hashes the source, a name/label, the track's ordinal within the file and its
 * first/last points.
 */
export function makeTrackId(source: string, label: string | undefined, index: number, points: TrackPoint[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  const seed = `${source}|${label ?? ''}|${index}|${points.length}|${first.join(',')}|${last.join(',')}`;
  return `${source}-${fnv1a(seed).toString(16).padStart(8, '0')}`;
}

/** Assemble Track objects from point groups (drops empty groups). */
export function tracksFromGroups(source: string, label: string | undefined, groups: TrackPoint[][], startIndex = 0, name?: string): Track[] {
  const out: Track[] = [];
  for (const points of groups) {
    if (points.length === 0) continue;
    const idx = startIndex + out.length;
    const t: Track = { id: makeTrackId(source, label, idx, points), source, points };
    const n = name ?? label;
    if (n) t.name = n;
    out.push(t);
  }
  return out;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five XML entities plus numeric character references. */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

/** Parse an ISO-8601 string, a millisecond number, or a numeric string; undefined when unusable. */
export function parseTimeMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.length === 0) return undefined;
  if (/^\d{10,}$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Local or UTC calendar-day key for grouping fixes into "one visit per day" tracks. */
export function dayKey(timeMs: number, boundary: 'local' | 'utc'): number {
  if (boundary === 'utc') return Math.floor(timeMs / 86_400_000);
  const d = new Date(timeMs);
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** `YYYY-MM-DD` label for a day key produced by {@link dayKey}. */
export function dayLabel(timeMs: number, boundary: 'local' | 'utc'): string {
  const d = new Date(timeMs);
  const y = boundary === 'utc' ? d.getUTCFullYear() : d.getFullYear();
  const m = (boundary === 'utc' ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = boundary === 'utc' ? d.getUTCDate() : d.getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

let sharedDecoder: TextDecoder | undefined;

/** UTF-8 decode (lenient; strips a BOM). */
export function decodeText(bytes: Uint8Array): string {
  sharedDecoder ??= new TextDecoder('utf-8');
  const s = sharedDecoder.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
