/** Track → GPX 1.1 text (for Fog of World's Import folder, Strava, etc.). */
import type { Track } from '../grid/types';

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

export function trackToGpx(track: Track, name = track.name ?? 'Unfog session'): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<gpx version="1.1" creator="Unfog" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
  );
  const first = track.points.find((p) => p[2]);
  lines.push('  <metadata>');
  lines.push(`    <name>${esc(name)}</name>`);
  if (first?.[2]) lines.push(`    <time>${new Date(first[2]).toISOString()}</time>`);
  lines.push('  </metadata>');
  lines.push('  <trk>');
  lines.push(`    <name>${esc(name)}</name>`);
  lines.push('    <trkseg>');
  for (const [lon, lat, t] of track.points) {
    const time = t ? `<time>${new Date(t).toISOString()}</time>` : '';
    lines.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${time}</trkpt>`);
  }
  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

/** File name for a session GPX: unfog-2026-09-02-1432.gpx */
export function gpxFileName(track: Track): string {
  const t = track.points.find((p) => p[2])?.[2] ?? Date.now();
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `unfog-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.gpx`;
}
