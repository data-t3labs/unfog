import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { backupFileName, decodeBackup, encodeBackup } from './backup';
import type { TrackRecord } from './db';
import type { GridStats } from './types';

const stats: GridStats = { visitedCells: 3, areaM2: 150, tiles: 2, version: 9, updatedAt: 1_700_000_000_000 };

function tile(tx: number, ty: number, cells: Array<[number, number]>): { tx: number; ty: number; counts: Uint8Array } {
  const counts = new Uint8Array(65536);
  for (const [i, v] of cells) counts[i] = v;
  return { tx, ty, counts };
}

const track: TrackRecord = {
  id: 'trk-1', source: 'gpx', name: 'Morning walk',
  lon: Float64Array.from([-73.9568, -73.955]), lat: Float64Array.from([40.7176, 40.7176]),
  t: Float64Array.from([1_700_000_000_000, NaN]), startMs: 1_700_000_000_000, endMs: 1_700_000_000_000, lengthM: 151.9,
};

describe('backup format', () => {
  it('encodes meta.json + tiles/14_x_y.bin + tracks.json and decodes them back exactly', async () => {
    const tiles = [tile(4830, 6152, [[0, 1], [65535, 255], [300, 7]]), tile(4831, 6152, [[1234, 2]])];
    const bytes = await encodeBackup({ stats, tiles, tracks: [track], exportedAt: 1_725_000_000_000 });
    const names = Object.keys(unzipSync(bytes)).sort();
    expect(names).toEqual(['meta.json', 'tiles/14_4830_6152.bin', 'tiles/14_4831_6152.bin', 'tracks.json']);
    const dec = decodeBackup(bytes);
    expect(dec.meta).toEqual({ app: 'unfog', format: 1, exportedAt: 1_725_000_000_000, stats });
    expect(dec.tileCount).toBe(2);
    const got = [...dec.tiles];
    expect(got.map((t) => [t.tx, t.ty])).toEqual([[4830, 6152], [4831, 6152]]);
    expect(got[0].counts).toEqual(tiles[0].counts);
    expect(got[1].counts).toEqual(tiles[1].counts);
    expect(dec.tracks).toHaveLength(1);
    const t = dec.tracks[0];
    expect(t.id).toBe('trk-1');
    expect(Array.from(t.lon)).toEqual(Array.from(track.lon));
    expect(t.t[0]).toBe(1_700_000_000_000);
    expect(Number.isNaN(t.t[1])).toBe(true);
    expect(t.lengthM).toBe(151.9);
    expect(t.name).toBe('Morning walk');
  });

  it('streams many tiles (async source) without holding them all', async () => {
    async function* gen(): AsyncGenerator<{ tx: number; ty: number; counts: Uint8Array }> {
      for (let i = 0; i < 150; i++) yield tile(100 + i, 200, [[i, 1]]);
    }
    const bytes = await encodeBackup({ stats, tiles: gen(), tracks: [] });
    const dec = decodeBackup(bytes);
    expect(dec.tileCount).toBe(150);
    let n = 0;
    for (const t of dec.tiles) { expect(t.counts[n]).toBe(1); expect(t.tx).toBe(100 + n); n++; }
    expect(n).toBe(150);
  });

  it('rejects things that are not Unfog backups', async () => {
    expect(() => decodeBackup(new Uint8Array([1, 2, 3, 4]))).toThrow();
    const { zipSync, strToU8 } = await import('fflate');
    const other = zipSync({ 'readme.txt': strToU8('hello') });
    expect(() => decodeBackup(other)).toThrow(/meta\.json/);
    const wrongApp = zipSync({ 'meta.json': strToU8(JSON.stringify({ app: 'other', format: 1 })) });
    expect(() => decodeBackup(wrongApp)).toThrow(/app/);
    const future = zipSync({ 'meta.json': strToU8(JSON.stringify({ app: 'unfog', format: 99 })) });
    expect(() => decodeBackup(future)).toThrow(/format/);
  });

  it('names files unfog-backup-YYYYMMDD.zip', () => {
    expect(backupFileName(new Date(2026, 8, 2))).toBe('unfog-backup-20260902.zip');
  });
});
