/** Mock importer: parses GPX only; anything else reports a clear error. Runs in the import worker. */
import type { ImportFile, ImportOutcome, ImportProgressCb } from '../import-types';
import type { Track } from '../../grid/types';

export async function mockImportFiles(files: ImportFile[], onProgress?: ImportProgressCb): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  let i = 0;
  for (const f of files) {
    i++;
    onProgress?.({ name: f.name, done: i, total: files.length, message: `Reading ${f.name}` });
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.gpx')) {
      const text = new TextDecoder().decode(f.bytes);
      const points: Track['points'] = [];
      const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>|<trkpt[^>]*lon="([-\d.]+)"[^>]*lat="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const lat = parseFloat(m[1] ?? m[5]);
        const lon = parseFloat(m[2] ?? m[4]);
        const body = m[3] ?? m[6] ?? '';
        const t = /<time>([^<]+)<\/time>/.exec(body);
        const ms = t ? Date.parse(t[1]) : undefined;
        if (Number.isFinite(lat) && Number.isFinite(lon)) points.push(ms ? [lon, lat, ms] : [lon, lat]);
      }
      if (points.length < 2) {
        out.push({ kind: 'error', name: f.name, message: 'No track points found' });
        continue;
      }
      const track: Track = { id: `gpx-${hash(f.name)}-${points.length}`, source: 'gpx', name: f.name.replace(/\.gpx$/i, ''), points };
      out.push({ kind: 'payload', payload: { tracks: [track], meta: { source: 'gpx', fileName: f.name, items: 1 } } });
    } else if (lower.endsWith('.json') && f.bytes.length < 4_000_000) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(f.bytes)) as { format?: string };
        if (parsed.format === 'unfog-mock-backup') {
          out.push({ kind: 'backup', bytes: f.bytes, name: f.name });
          continue;
        }
      } catch {
        /* fall through */
      }
      out.push({ kind: 'error', name: f.name, message: 'Mock mode parses GPX and mock backups only' });
    } else {
      out.push({ kind: 'error', name: f.name, message: 'Mock mode parses GPX only (real importers not loaded)' });
    }
  }
  return out;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
