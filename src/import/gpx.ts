/**
 * GPX importer — a linear hand-written tag scanner (no DOMParser: this runs in a worker and in
 * Node; no regex over the whole document: a 50 MB Apple Health / Strava export must not blow
 * up). Reads <trk>/<trkseg>/<trkpt lat lon> with optional <time>; one Track per <trkseg>,
 * split further on gaps > 500 m or > 30 min. <rtept>, <wpt>, <metadata> and everything under
 * <extensions> (Apple's speed/hAcc, Garmin's TrackPointExtension) are ignored.
 */
import type { Track } from '../grid/types';
import { type GapOptions, type TrackPoint, decodeXmlEntities, isFiniteLonLat, makePoint, splitOnGaps, tracksFromGroups } from './util';

export interface GpxOptions extends GapOptions {
  /** File name, used for track ids and as the fallback track name. */
  name?: string;
}

const SP = 32, TAB = 9, LF = 10, CR = 13, SLASH = 47, BANG = 33, QUESTION = 63;

function isSpace(c: number): boolean {
  return c === SP || c === LF || c === CR || c === TAB;
}

/** Pull `lat`/`lon` out of a trkpt attribute string (either order, either quote style). */
function parseLatLon(attrs: string): [lat: number, lon: number] {
  let lat = NaN;
  let lon = NaN;
  const re = /(?:^|[\s"'])(lat|lon)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const v = parseFloat(m[2] ?? m[3]);
    if (m[1] === 'lat') lat = v;
    else lon = v;
  }
  return [lat, lon];
}

export function parseGpx(text: string, opts: GpxOptions = {}): Track[] {
  const label = opts.name;
  const tracks: Track[] = [];
  const len = text.length;

  let inTrk = false;
  let inSeg = false;
  let inPt = false;
  let extDepth = 0;
  let trkName: string | undefined;
  let seg: TrackPoint[] = [];
  let ptLat = NaN;
  let ptLon = NaN;
  let ptTime: number | undefined;

  const flushSeg = () => {
    if (seg.length > 0) {
      tracks.push(...tracksFromGroups('gpx', label, splitOnGaps(seg, opts), tracks.length, trkName ?? label));
    }
    seg = [];
  };
  const pushPoint = () => {
    if (isFiniteLonLat(ptLon, ptLat)) seg.push(makePoint(ptLon, ptLat, ptTime));
    ptLat = NaN;
    ptLon = NaN;
    ptTime = undefined;
  };
  /** Text content following the tag that ends at `from` (CDATA sections included); returns the next tag position. */
  const readText = (from: number): [string, number] => {
    let out = '';
    let pos = from;
    for (;;) {
      const close = text.indexOf('<', pos);
      if (close < 0) return [out + text.slice(pos), len];
      out += text.slice(pos, close);
      if (!text.startsWith('<![CDATA[', close)) return [out, close];
      const end = text.indexOf(']]>', close + 9);
      if (end < 0) return [out + text.slice(close + 9), len];
      out += text.slice(close + 9, end);
      pos = end + 3;
    }
  };

  let i = 0;
  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    const c1 = text.charCodeAt(lt + 1);
    if (c1 === BANG) {
      if (text.startsWith('<!--', lt)) {
        const e = text.indexOf('-->', lt + 4);
        i = e < 0 ? len : e + 3;
      } else if (text.startsWith('<![CDATA[', lt)) {
        const e = text.indexOf(']]>', lt + 9);
        i = e < 0 ? len : e + 3;
      } else {
        const e = text.indexOf('>', lt + 2);
        i = e < 0 ? len : e + 1;
      }
      continue;
    }
    if (c1 === QUESTION) {
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? len : e + 2;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) break;
    let s = lt + 1;
    let e = gt;
    const closing = text.charCodeAt(s) === SLASH;
    if (closing) s++;
    const selfClosing = !closing && text.charCodeAt(e - 1) === SLASH;
    if (selfClosing) e--;
    let ne = s;
    while (ne < e && !isSpace(text.charCodeAt(ne))) ne++;
    let name = text.slice(s, ne);
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
    i = gt + 1;

    if (name === 'extensions') {
      if (closing) extDepth = Math.max(0, extDepth - 1);
      else if (!selfClosing) extDepth++;
      continue;
    }
    if (extDepth > 0) continue;

    switch (name) {
      case 'trk':
        if (closing) {
          if (inPt) { pushPoint(); inPt = false; }
          flushSeg();
          inTrk = false;
          inSeg = false;
          trkName = undefined;
        } else if (!selfClosing) {
          inTrk = true;
          trkName = undefined;
          seg = [];
        }
        break;
      case 'trkseg':
        if (closing) {
          if (inPt) { pushPoint(); inPt = false; }
          flushSeg();
          inSeg = false;
        } else if (!selfClosing) {
          flushSeg();
          inSeg = true;
        }
        break;
      case 'trkpt':
        if (closing) {
          if (inPt) pushPoint();
          inPt = false;
        } else {
          if (inPt) pushPoint(); // unterminated previous point
          [ptLat, ptLon] = parseLatLon(ne < e ? text.slice(ne, e) : '');
          ptTime = undefined;
          if (selfClosing) pushPoint();
          else inPt = true;
        }
        break;
      case 'time':
        if (inPt && !closing && !selfClosing) {
          const [raw, next] = readText(i);
          const t = Date.parse(raw.trim());
          ptTime = Number.isNaN(t) ? undefined : t;
          i = next;
        }
        break;
      case 'name':
        if (inTrk && !inSeg && !inPt && trkName === undefined && !closing && !selfClosing) {
          const [raw, next] = readText(i);
          const n = decodeXmlEntities(raw).trim();
          if (n.length > 0) trkName = n;
          i = next;
        }
        break;
      default:
        break;
    }
  }
  if (inPt) pushPoint();
  flushSeg();
  return tracks;
}
