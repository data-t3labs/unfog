/**
 * File-type detection + dispatch for the Data screen's file input. Everything the user can
 * drop in — Sync.zip, bare Sync tiles, .fwss, GPX, Apple Health export.zip, Google Timeline
 * JSON / Takeout zip, an Unfog backup — goes through {@link importFiles}.
 *
 * Sniffing order: zip magic → entries (`meta.json` mentioning "unfog" → backup; any FoW tile
 * name or `Model/*\/` → FoW; `*.gpx` entries → one GPX payload; `*.json` entries → one Timeline
 * payload). Non-zip: `.gpx` name or `<?xml` / `<gpx` text → GPX; `.json` or `{`/`[` text →
 * Timeline; FoW tile name → FoW (all bare tiles batched into one payload); else an error.
 */
import { unzipSync } from 'fflate';
import type { ImportPayload, Track } from '../grid/types';
import { type FowImportResult, classifyFowEntry, hasFowTileEntries, importFowArchive, importFowFiles, isFowJunkName, isFowTileName } from './fow';
import { parseGpx } from './gpx';
import { parseTimeline } from './timeline';
import { type InputFile, basename, decodeText } from './util';

export type { InputFile } from './util';

export type ImportOutcome =
  | { kind: 'payload'; payload: ImportPayload }
  | { kind: 'backup'; bytes: Uint8Array; name: string }
  | { kind: 'error'; name: string; message: string };

export type ProgressFn = (msg: string, done: number, total: number) => void;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06];

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

export function isZip(bytes: Uint8Array): boolean {
  return hasMagic(bytes, ZIP_MAGIC);
}

function ext(name: string): string {
  const b = basename(name);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** First non-blank characters of a file, decoded as UTF-8 (BOM stripped). */
function textHead(bytes: Uint8Array, n = 512): string {
  return decodeText(bytes.subarray(0, n)).trimStart();
}

function looksLikeGpx(name: string, bytes: Uint8Array): boolean {
  if (ext(name) === 'gpx') return true;
  const head = textHead(bytes);
  return head.startsWith('<?xml') || head.startsWith('<gpx');
}

function looksLikeJson(name: string, bytes: Uint8Array): boolean {
  if (ext(name) === 'json') return true;
  const head = textHead(bytes, 64);
  return head.startsWith('{') || head.startsWith('[');
}

/** Enumerate zip entry paths without inflating anything (fflate calls the filter per entry). */
export function listZipEntries(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names;
}

function extractEntries(bytes: Uint8Array, wanted: Set<string>): Record<string, Uint8Array> {
  return unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
}

function isJunkPath(path: string): boolean {
  return path.endsWith('/') || path.includes('__MACOSX/') || isFowJunkName(basename(path));
}

function payloadOutcome(payload: ImportPayload): ImportOutcome {
  return { kind: 'payload', payload };
}

function errorOutcome(name: string, e: unknown): ImportOutcome {
  const message = e instanceof Error ? e.message : String(e);
  return { kind: 'error', name, message };
}

function tracksPayload(source: string, fileName: string, tracks: Track[], note?: string): ImportPayload {
  const meta: ImportPayload['meta'] = { source, fileName, items: tracks.length };
  if (note) meta.note = note;
  return { tracks, meta };
}

function parseGpxFile(name: string, bytes: Uint8Array): ImportPayload {
  const tracks = parseGpx(decodeText(bytes), { name: basename(name) });
  return tracksPayload('gpx', name, tracks, tracks.length === 0 ? 'no track points found' : undefined);
}

function parseTimelineFile(name: string, bytes: Uint8Array): ImportPayload {
  const json: unknown = JSON.parse(decodeText(bytes));
  const tracks = parseTimeline(json, { name: basename(name) });
  return tracksPayload('timeline', name, tracks, tracks.length === 0 ? 'no location data recognised' : undefined);
}

function isUnfogBackup(bytes: Uint8Array, entries: string[]): boolean {
  const metas = entries.filter((p) => basename(p) === 'meta.json' && !isJunkPath(p));
  if (metas.length === 0) return false;
  // Prefer the shallowest meta.json.
  metas.sort((a, b) => a.length - b.length);
  const got = extractEntries(bytes, new Set([metas[0]]));
  const text = got[metas[0]] ? decodeText(got[metas[0]]) : '';
  return text.toLowerCase().includes('unfog');
}

/** Classify + import one zip archive; may yield several outcomes (e.g. Takeout with both GPX and JSON). */
function importZip(file: InputFile, onProgress: ProgressFn | undefined, done: number, total: number): ImportOutcome[] {
  const { name, bytes } = file;
  let entries: string[];
  try {
    entries = listZipEntries(bytes);
  } catch (e) {
    return [errorOutcome(name, e)];
  }

  if (isUnfogBackup(bytes, entries)) {
    onProgress?.(`${basename(name)}: Unfog backup`, done, total);
    return [{ kind: 'backup', bytes, name }];
  }

  const out: ImportOutcome[] = [];
  let handled = false;

  if (hasFowTileEntries(entries)) {
    handled = true;
    try {
      const inner: ProgressFn = (msg, d, t) => onProgress?.(msg, done + (t > 0 ? Math.min(d / t, 1) : 0), total);
      const r: FowImportResult = importFowArchive(name, bytes, inner);
      out.push(payloadOutcome(r));
    } catch (e) {
      out.push(errorOutcome(name, e));
    }
  }

  const gpxEntries = entries.filter((p) => !isJunkPath(p) && ext(p) === 'gpx');
  if (gpxEntries.length > 0) {
    handled = true;
    try {
      onProgress?.(`${basename(name)}: ${gpxEntries.length} GPX file(s)`, done, total);
      const got = extractEntries(bytes, new Set(gpxEntries));
      const tracks: Track[] = [];
      let empty = 0;
      for (const path of gpxEntries.sort()) {
        const data = got[path];
        if (!data) continue;
        const t = parseGpx(decodeText(data), { name: basename(path) });
        if (t.length === 0) empty++;
        tracks.push(...t);
      }
      const note = `${gpxEntries.length} GPX file(s)${empty > 0 ? `, ${empty} without track points` : ''}`;
      out.push(payloadOutcome(tracksPayload('gpx', name, tracks, note)));
    } catch (e) {
      out.push(errorOutcome(name, e));
    }
  }

  const jsonEntries = entries.filter((p) => !isJunkPath(p) && ext(p) === 'json' && basename(p) !== 'meta.json');
  if (jsonEntries.length > 0) {
    onProgress?.(`${basename(name)}: ${jsonEntries.length} JSON file(s)`, done, total);
    const got = extractEntries(bytes, new Set(jsonEntries));
    const tracks: Track[] = [];
    let used = 0;
    let bad = 0;
    for (const path of jsonEntries.sort()) {
      const data = got[path];
      if (!data) continue;
      try {
        const t = parseTimeline(JSON.parse(decodeText(data)), { name: basename(path) });
        if (t.length > 0) {
          used++;
          tracks.push(...t);
        }
      } catch {
        bad++;
      }
    }
    if (tracks.length > 0) {
      handled = true;
      const note = `${used} Timeline file(s)${bad > 0 ? `, ${bad} unreadable` : ''}`;
      out.push(payloadOutcome(tracksPayload('timeline', name, tracks, note)));
    } else if (!handled) {
      out.push({ kind: 'error', name, message: `${jsonEntries.length} JSON file(s) but none contained Timeline location data` });
      handled = true;
    }
  }

  if (!handled) out.push({ kind: 'error', name, message: 'no Fog of World tiles, GPX, Timeline JSON or Unfog backup found in the archive' });
  return out;
}

/**
 * Detect and import every file. Never throws: each file yields a payload, a backup (bytes for
 * the grid worker's `importBackup`) or an error. Bare Fog of World tile files are batched into
 * one payload. `onProgress(msg, done, total)` counts files; `done` is fractional inside a FoW
 * archive.
 */
export async function importFiles(files: InputFile[], onProgress?: ProgressFn): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  const fowBare: InputFile[] = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const base = basename(f.name);
    onProgress?.(`Reading ${base}`, i, total);
    // Let progress messages through between files (worker → main thread).
    if (i > 0) await new Promise<void>((r) => setTimeout(r, 0));

    if (f.bytes.length === 0) {
      if (isFowJunkName(base)) continue;
      outcomes.push({ kind: 'error', name: f.name, message: 'empty file' });
      continue;
    }
    if (isZip(f.bytes)) {
      outcomes.push(...importZip(f, onProgress, i, total));
      continue;
    }
    if (hasMagic(f.bytes, ZIP_EMPTY_MAGIC)) {
      outcomes.push({ kind: 'error', name: f.name, message: 'empty zip archive' });
      continue;
    }
    const e = ext(f.name);
    if (e === 'zip' || e === 'fwss') {
      outcomes.push({ kind: 'error', name: f.name, message: `not a zip archive (${e === 'fwss' ? 'snapshot' : 'zip'} file is damaged or still downloading)` });
      continue;
    }
    if (isFowTileName(base)) {
      fowBare.push(f);
      continue;
    }
    if (isFowJunkName(base)) continue; // .DS_Store, FoW-Sync-Lock, ._x next to bare tiles
    try {
      if (looksLikeGpx(f.name, f.bytes)) {
        outcomes.push(payloadOutcome(parseGpxFile(f.name, f.bytes)));
      } else if (looksLikeJson(f.name, f.bytes)) {
        outcomes.push(payloadOutcome(parseTimelineFile(f.name, f.bytes)));
      } else {
        outcomes.push({ kind: 'error', name: f.name, message: 'unrecognised file (expected Sync.zip, Fog of World tiles, .fwss, .gpx, Timeline .json or an Unfog backup)' });
      }
    } catch (err) {
      outcomes.push(errorOutcome(f.name, err));
    }
  }

  if (fowBare.length > 0) {
    const label = fowBare.length === 1 ? basename(fowBare[0].name) : `${fowBare.length} Fog of World tiles`;
    const inner: ProgressFn = (msg, d, t) => onProgress?.(msg, total - 1 + (t > 0 ? Math.min(d / t, 1) : 0), total);
    outcomes.push(payloadOutcome(importFowFiles(fowBare, inner, label)));
  }
  onProgress?.('Done', total, total);
  return outcomes;
}

/** Exposed for tests and the Data screen's "what is this file" hint. */
export function describeZipEntry(path: string): 'fow-tile' | 'gpx' | 'json' | 'junk' | 'other' {
  if (isJunkPath(path)) return 'junk';
  if (classifyFowEntry(path) === 'tile') return 'fow-tile';
  const e = ext(path);
  if (e === 'gpx') return 'gpx';
  if (e === 'json') return 'json';
  return 'other';
}
