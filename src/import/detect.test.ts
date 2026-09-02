import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { type ImportOutcome, describeZipEntry, importFiles, isZip, listZipEntries } from './detect';

const fowFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/fow/${name}`, import.meta.url)));
const gpxFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/gpx/${name}`, import.meta.url)));
const timelineFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/timeline/${name}`, import.meta.url)));

function payloadOf(o: ImportOutcome) {
  if (o.kind !== 'payload') throw new Error(`expected payload, got ${o.kind}: ${JSON.stringify(o)}`);
  return o.payload;
}

describe('importFiles — bare files', () => {
  it('GPX by extension and by content sniff', async () => {
    const out = await importFiles([
      { name: 'minimal.gpx', bytes: gpxFixture('minimal.gpx') },
      { name: 'renamed.txt', bytes: gpxFixture('apple-health-route.gpx') },
      { name: 'nodecl.dat', bytes: strToU8('﻿  <gpx><trk><trkseg><trkpt lat="40.71" lon="-73.95"/></trkseg></trk></gpx>') },
    ]);
    expect(out.map((o) => o.kind)).toEqual(['payload', 'payload', 'payload']);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'gpx', fileName: 'minimal.gpx', items: 1 });
    expect(payloadOf(out[1]).tracks?.[0].points.length).toBe(5);
    expect(payloadOf(out[2]).tracks?.[0].points).toEqual([[-73.95, 40.71]]);
  });

  it('Timeline JSON by extension and by content sniff', async () => {
    const out = await importFiles([
      { name: 'Records.json', bytes: timelineFixture('records.json') },
      { name: 'Timeline.json', bytes: timelineFixture('semantic-segments.json') },
      { name: 'blob.bin', bytes: strToU8('  [{"latitudeE7":407176000,"longitudeE7":-739568000}]') },
    ]);
    expect(out.map((o) => o.kind)).toEqual(['payload', 'payload', 'payload']);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'timeline', fileName: 'Records.json', items: 3 });
    expect(payloadOf(out[1]).meta.items).toBe(6);
    expect(payloadOf(out[2]).meta.items).toBe(1);
  });

  it('bare Fog of World tiles are batched into one payload; junk beside them is skipped silently', async () => {
    const out = await importFiles([
      { name: '23e4lltkkoke', bytes: fowFixture('23e4lltkkoke') },
      { name: '.DS_Store', bytes: strToU8('junk') },
      { name: 'FoW-Sync-Lock', bytes: new Uint8Array(0) },
      { name: 'cd36lltksiwo', bytes: fowFixture('cd36lltksiwo') },
    ]);
    expect(out.length).toBe(1);
    const p = payloadOf(out[0]);
    expect(p.meta).toEqual({ source: 'fow', fileName: '2 Fog of World tiles', items: 2 });
    expect(p.cellTiles?.length).toBeGreaterThan(0);
  });

  it('onOutcome receives each outcome as it is produced and the returned payloads are released; a small chunk budget splits FoW archives', async () => {
    const zip = zipSync({ 'Sync/23e4lltkkoke': fowFixture('23e4lltkkoke'), 'Sync/cd36lltksiwo': fowFixture('cd36lltksiwo'), 'Sync/Import/walk.gpx': gpxFixture('minimal.gpx') });
    const order: string[] = [];
    const out = await importFiles([{ name: 'Sync.zip', bytes: zip }, { name: 'walk.gpx', bytes: gpxFixture('minimal.gpx') }], undefined, {
      maxBaseTiles: 1,
      onOutcome: async (o) => {
        await new Promise((r) => setTimeout(r, 1));
        if (o.kind !== 'payload') throw new Error(o.kind);
        order.push(`${o.payload.meta.source}:${o.payload.meta.items}:${o.payload.cellTiles?.length ?? 0}c${o.payload.tracks?.length ?? 0}t:${o.payload.meta.note ?? ''}`);
      },
    });
    // two FoW chunks (one per tile file), then the GPX file; every delivered payload had its data
    expect(order).toEqual([
      expect.stringMatching(/^fow:1:\d+c0t:part 1$/),
      expect.stringMatching(/^fow:1:\d+c0t:part 2 of 2$/),
      'gpx:1:0c1t:',
    ]);
    expect(out).toHaveLength(3);
    for (const o of out) { const p = payloadOf(o); expect(p.cellTiles).toEqual([]); expect(p.tracks).toEqual([]); expect(p.meta.items).toBe(1); }
  });

  it('a lone tile file names the payload after the file', async () => {
    const out = await importFiles([{ name: 'Sync/23e4lltkkoke', bytes: fowFixture('23e4lltkkoke') }]);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'fow', fileName: '23e4lltkkoke', items: 1 });
  });

  it('errors: unknown binary, empty file, bad JSON, .zip/.fwss that are not zips', async () => {
    const out = await importFiles([
      { name: 'photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]) },
      { name: 'empty.gpx', bytes: new Uint8Array(0) },
      { name: 'broken.json', bytes: strToU8('{ not json') },
      { name: 'Sync.zip', bytes: strToU8('not a zip') },
      { name: 'Snapshot.fwss', bytes: strToU8('not a zip') },
      { name: 'empty.zip', bytes: new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ]);
    expect(out.map((o) => o.kind)).toEqual(['error', 'error', 'error', 'error', 'error', 'error']);
    const msgs = out.map((o) => (o.kind === 'error' ? o.message : ''));
    expect(msgs[0]).toMatch(/unrecognised/);
    expect(msgs[1]).toMatch(/empty/);
    expect(msgs[3]).toMatch(/not a zip/);
    expect(msgs[4]).toMatch(/snapshot/);
    expect(msgs[5]).toMatch(/empty zip/);
  });
});

describe('importFiles — archives', () => {
  it('Sync.zip → one FoW payload', async () => {
    const zip = zipSync({
      'Sync/23e4lltkkoke': fowFixture('23e4lltkkoke'),
      'Sync/FoW-Sync-Lock': new Uint8Array(0),
      '__MACOSX/Sync/._23e4lltkkoke': strToU8('x'),
    });
    expect(isZip(zip)).toBe(true);
    const progress: Array<[string, number, number]> = [];
    const out = await importFiles([{ name: 'Sync.zip', bytes: zip }], (m, d, t) => progress.push([m, d, t]));
    expect(out.length).toBe(1);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'fow', fileName: 'Sync.zip', items: 1 });
    expect(progress[progress.length - 1]).toEqual(['Done', 1, 1]);
    expect(progress.every(([, d, t]) => d >= 0 && d <= t)).toBe(true);
  });

  it('.fwss snapshot → FoW payload (Model/*/ only)', async () => {
    const zip = zipSync({ 'Model/*/cd36lltksiwo': fowFixture('cd36lltksiwo'), 'Model/#/cd36lltksiwo': strToU8('x') });
    const out = await importFiles([{ name: 'Snapshot-20260601.fwss', bytes: zip }]);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'fow', fileName: 'Snapshot-20260601.fwss', items: 1 });
  });

  it('Unfog backup: meta.json mentioning unfog → backup outcome with the original bytes', async () => {
    const zip = zipSync({ 'meta.json': strToU8('{"app":"unfog","version":1}'), 'tiles/14_1_2.bin': new Uint8Array(10), 'tracks.json': strToU8('[]') });
    const out = await importFiles([{ name: 'unfog-backup-20260901.zip', bytes: zip }]);
    expect(out).toEqual([{ kind: 'backup', bytes: zip, name: 'unfog-backup-20260901.zip' }]);
  });

  it('a zip with a meta.json that is not ours is not a backup', async () => {
    const zip = zipSync({ 'meta.json': strToU8('{"app":"other"}'), 'a.gpx': gpxFixture('minimal.gpx') });
    const out = await importFiles([{ name: 'x.zip', bytes: zip }]);
    expect(out[0].kind).toBe('payload');
    expect(payloadOf(out[0]).meta.source).toBe('gpx');
  });

  it('Apple Health export.zip → one GPX payload with every workout route, export.xml untouched', async () => {
    const zip = zipSync({
      'apple_health_export/export.xml': strToU8('<?xml version="1.0"?><HealthData/>'),
      'apple_health_export/export_cda.xml': strToU8('<ClinicalDocument/>'),
      'apple_health_export/workout-routes/route_2024-06-02_8.15am.gpx': gpxFixture('apple-health-route.gpx'),
      'apple_health_export/workout-routes/route_2024-05-12_10.03am.gpx': gpxFixture('minimal.gpx'),
      'apple_health_export/workout-routes/route_empty.gpx': strToU8('<gpx/>'),
    });
    const out = await importFiles([{ name: 'export.zip', bytes: zip }]);
    expect(out.length).toBe(1);
    const p = payloadOf(out[0]);
    expect(p.meta).toEqual({ source: 'gpx', fileName: 'export.zip', items: 2, note: '3 GPX file(s), 1 without track points' });
    // entries are parsed in sorted path order: route_2024-05-12 (minimal.gpx) before route_2024-06-02
    expect(p.tracks?.map((t) => t.name)).toEqual(['Bedford Ave & N 7th', 'Route 2024-06-02 8:15am']);
  });

  it('Takeout zip → one Timeline payload across JSON files; unreadable JSON counted', async () => {
    const zip = zipSync({
      'Takeout/Location History (Timeline)/Records.json': timelineFixture('records.json'),
      'Takeout/Location History (Timeline)/Settings.json': strToU8('{"deviceSettings":[]}'),
      'Takeout/Location History (Timeline)/broken.json': strToU8('{'),
      'Takeout/archive_browser.html': strToU8('<html/>'),
    });
    const out = await importFiles([{ name: 'takeout.zip', bytes: zip }]);
    expect(out.length).toBe(1);
    expect(payloadOf(out[0]).meta).toEqual({ source: 'timeline', fileName: 'takeout.zip', items: 3, note: '1 Timeline file(s), 1 unreadable' });
  });

  it('a zip with only irrelevant JSON reports an error; a zip with nothing useful too', async () => {
    const out = await importFiles([
      { name: 'settings.zip', bytes: zipSync({ 'Settings.json': strToU8('{"deviceSettings":[]}') }) },
      { name: 'photos.zip', bytes: zipSync({ 'IMG_1.jpg': new Uint8Array(4) }) },
    ]);
    expect(out.map((o) => o.kind)).toEqual(['error', 'error']);
    expect(out[0].kind === 'error' && out[0].message).toMatch(/Timeline/);
    expect(out[1].kind === 'error' && out[1].message).toMatch(/no Fog of World/);
  });

  it('a mixed archive yields one outcome per kind; GPX under Fog of World\'s Import/ is not re-imported (already in the tiles)', async () => {
    const zip = zipSync({
      'Fog of World/Sync/23e4lltkkoke': fowFixture('23e4lltkkoke'),
      'Fog of World/Import/walk.gpx': gpxFixture('minimal.gpx'),
      'strava/run.gpx': gpxFixture('minimal.gpx'),
      'Records.json': timelineFixture('records.json'),
    });
    const out = await importFiles([{ name: 'everything.zip', bytes: zip }]);
    expect(out.map((o) => (o.kind === 'payload' ? o.payload.meta.source : o.kind))).toEqual(['fow', 'gpx', 'timeline']);
    expect(payloadOf(out[1]).meta.note).toBe('1 GPX file(s)');
    // without Fog of World tiles beside it, an Import/ folder is just a folder of GPX
    const gpxOnly = await importFiles([{ name: 'import.zip', bytes: zipSync({ 'Fog of World/Import/walk.gpx': gpxFixture('minimal.gpx') }) }]);
    expect(gpxOnly.map((o) => (o.kind === 'payload' ? o.payload.meta.source : o.kind))).toEqual(['gpx']);
  });

  it('listZipEntries enumerates without inflating; describeZipEntry classifies', () => {
    const zip = zipSync({ 'Sync/23e4lltkkoke': fowFixture('23e4lltkkoke'), 'a/b.gpx': strToU8('x'), 'c.json': strToU8('{}'), '.hidden': strToU8('x') });
    expect(listZipEntries(zip).sort()).toEqual(['.hidden', 'Sync/23e4lltkkoke', 'a/b.gpx', 'c.json']);
    expect(describeZipEntry('Sync/23e4lltkkoke')).toBe('fow-tile');
    expect(describeZipEntry('a/b.gpx')).toBe('gpx');
    expect(describeZipEntry('c.json')).toBe('json');
    expect(describeZipEntry('.hidden')).toBe('junk');
    expect(describeZipEntry('__MACOSX/a/b.gpx')).toBe('junk');
    expect(describeZipEntry('readme.txt')).toBe('other');
  });
});
