import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGpx } from './gpx';

const fixture = (name: string): string => readFileSync(new URL(`../../tests/fixtures/gpx/${name}`, import.meta.url), 'utf8');

describe('parseGpx', () => {
  it('reads a minimal track with times and decodes the entity in its name', () => {
    const tracks = parseGpx(fixture('minimal.gpx'), { name: 'minimal.gpx' });
    expect(tracks.length).toBe(1);
    const t = tracks[0];
    expect(t.source).toBe('gpx');
    expect(t.name).toBe('Bedford Ave & N 7th');
    expect(t.points.length).toBe(4);
    expect(t.points[0]).toEqual([-73.9568, 40.7176, Date.parse('2024-05-12T14:03:11Z')]);
    expect(t.points[3][2]).toBe(Date.parse('2024-05-12T14:04:41Z'));
    expect(t.id).toMatch(/^gpx-[0-9a-f]{8}$/);
  });

  it('handles Apple Health routes: lon before lat, metadata time, per-point extensions', () => {
    const tracks = parseGpx(fixture('apple-health-route.gpx'), { name: 'route_2024-06-02_8.15am.gpx' });
    expect(tracks.length).toBe(1);
    const t = tracks[0];
    expect(t.name).toBe('Route 2024-06-02 8:15am');
    expect(t.points.length).toBe(5);
    expect(t.points[0]).toEqual([-73.9621, 40.7143, Date.parse('2024-06-02T12:15:04Z')]);
    expect(t.points[4]).toEqual([-73.9605, 40.7145, Date.parse('2024-06-02T12:16:44Z')]);
    for (const p of t.points) expect(p.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('Strava style: multiple segments and tracks, single quotes, comments, CDATA, wpt/rte ignored', () => {
    const tracks = parseGpx(fixture('multiseg.gpx'), { name: 'multiseg.gpx' });
    expect(tracks.map((t) => t.points.length)).toEqual([3, 2, 3]);
    expect(tracks.map((t) => t.name)).toEqual(['Morning Ride', 'Morning Ride', 'Evening <Walk>']);
    expect(tracks[0].points[0]).toEqual([-73.95, 40.71, Date.parse('2024-07-04T13:00:00Z')]);
    expect(tracks[1].points[0]).toEqual([-73.94, 40.72, Date.parse('2024-07-04T13:30:00Z')]);
    // self-closing untimed point keeps the [lon, lat] shape
    expect(tracks[2].points[2]).toEqual([-73.9546, 40.7304]);
    const all = tracks.flatMap((t) => t.points);
    expect(all.some((p) => p[0] === 0 && p[1] === 0)).toBe(false); // comment content ignored
    expect(all.some((p) => p[1] === 40.7 || p[1] === 40.701 || p[1] === 40.702)).toBe(false); // wpt/rtept ignored
    const ids = new Set(tracks.map((t) => t.id));
    expect(ids.size).toBe(3);
  });

  it('GPX 1.0 with namespace prefixes and no times', () => {
    const tracks = parseGpx(fixture('notimes.gpx'));
    expect(tracks.length).toBe(1);
    expect(tracks[0].points.length).toBe(4);
    expect(tracks[0].points[0]).toEqual([-73.99, 40.73]);
    expect(tracks[0].name).toBeUndefined();
  });

  it('splits a segment on distance gaps > 500 m and time gaps > 30 min', () => {
    const pt = (lon: number, lat: number, t: string) => `<trkpt lat="${lat}" lon="${lon}"><time>${t}</time></trkpt>`;
    const gpx = `<gpx><trk><trkseg>
      ${pt(-73.95, 40.71, '2024-01-01T10:00:00Z')}
      ${pt(-73.951, 40.71, '2024-01-01T10:01:00Z')}
      ${pt(-73.96, 40.71, '2024-01-01T10:02:00Z')}
      ${pt(-73.961, 40.71, '2024-01-01T10:03:00Z')}
      ${pt(-73.962, 40.71, '2024-01-01T10:40:00Z')}
      ${pt(-73.963, 40.71, '2024-01-01T11:09:00Z')}
    </trkseg></trk></gpx>`;
    const tracks = parseGpx(gpx);
    // 0.009° lon ≈ 760 m → gap; 37 min → gap; 29 min → no gap
    expect(tracks.map((t) => t.points.length)).toEqual([2, 2, 2]);
    const tight = parseGpx(gpx, { gapM: 1000, gapMs: 60 * 60_000 });
    expect(tight.map((t) => t.points.length)).toEqual([6]);
  });

  it('tolerates attribute order, quote styles, extra attributes and self-closing points', () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lon='-73.95' lat='40.71'/>
      <trkpt foo="bar" lat="40.7101" lon="-73.9501" />
      <trkpt lat = "40.7102" lon = '-73.9502'><ele>1</ele></trkpt>
      <trkpt lat="abc" lon="-73.95"/>
      <trkpt lat="40.71"/>
    </trkseg></trk></gpx>`;
    const tracks = parseGpx(gpx);
    expect(tracks.length).toBe(1);
    expect(tracks[0].points).toEqual([[-73.95, 40.71], [-73.9501, 40.7101], [-73.9502, 40.7102]]);
  });

  it('ignores <time> inside <extensions> and nested extension blocks', () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="40.71" lon="-73.95"><extensions><a><time>2000-01-01T00:00:00Z</time></a><extensions/></extensions><time>2024-01-01T00:00:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const tracks = parseGpx(gpx);
    expect(tracks[0].points[0][2]).toBe(Date.parse('2024-01-01T00:00:00Z'));
  });

  it('is deterministic: the same file gives the same ids, a different name different ids', () => {
    const a = parseGpx(fixture('minimal.gpx'), { name: 'a.gpx' });
    const b = parseGpx(fixture('minimal.gpx'), { name: 'a.gpx' });
    const c = parseGpx(fixture('minimal.gpx'), { name: 'c.gpx' });
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).not.toBe(c[0].id);
  });

  it('returns nothing for garbage or truncated input instead of throwing', () => {
    expect(parseGpx('')).toEqual([]);
    expect(parseGpx('hello world')).toEqual([]);
    expect(parseGpx('<gpx><trk><trkseg><trkpt lat="40.71" lon="-73.95"><time>2024-01-01T00:00:00Z')).toEqual([
      expect.objectContaining({ points: [[-73.95, 40.71, Date.parse('2024-01-01T00:00:00Z')]] }),
    ]);
    expect(parseGpx('<gpx><trk><trkseg><trkpt lat="40.71" lon="-73.95"')).toEqual([]);
  });

  it('parses a 200k-point (~20 MB) file in one pass', () => {
    const n = 200_000;
    const parts: string[] = ['<?xml version="1.0"?>\n<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>big</name><trkseg>\n'];
    const t0 = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
      const lon = (-73.95 + i * 0.00001).toFixed(6);
      parts.push(`<trkpt lat="40.71" lon="${lon}"><ele>3.0</ele><time>${new Date(t0 + i * 1000).toISOString()}</time><extensions><speed>1</speed></extensions></trkpt>\n`);
    }
    parts.push('</trkseg></trk></gpx>');
    const text = parts.join('');
    expect(text.length).toBeGreaterThan(20_000_000);
    const started = performance.now();
    const tracks = parseGpx(text, { name: 'big.gpx' });
    const ms = performance.now() - started;
    expect(tracks.length).toBe(1);
    expect(tracks[0].points.length).toBe(n);
    expect(tracks[0].points[n - 1][2]).toBe(t0 + (n - 1) * 1000);
    expect(ms).toBeLessThan(15_000);
  });
});
