import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLatLng, parseTimeline } from './timeline';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../tests/fixtures/timeline/${name}`, import.meta.url), 'utf8'));
const utc = { dayBoundary: 'utc' as const };

describe('parseLatLng', () => {
  it('accepts every spelling Google uses', () => {
    expect(parseLatLng('geo:40.7176,-73.9568')).toEqual([-73.9568, 40.7176]);
    expect(parseLatLng('40.7176°, -73.9568°')).toEqual([-73.9568, 40.7176]);
    expect(parseLatLng('40.7176, -73.9568')).toEqual([-73.9568, 40.7176]);
    expect(parseLatLng({ latLng: '40.7°, -73.9°' })).toEqual([-73.9, 40.7]);
    expect(parseLatLng({ latitudeE7: 407176000, longitudeE7: -739568000 })).toEqual([-73.9568, 40.7176]);
    expect(parseLatLng({ latE7: 407176000, lngE7: -739568000 })).toEqual([-73.9568, 40.7176]);
    expect(parseLatLng({ latitude: 40.7, longitude: -73.9 })).toEqual([-73.9, 40.7]);
    expect(parseLatLng({ lat: '40.7', lng: '-73.9' })).toEqual([-73.9, 40.7]);
  });

  it('rejects garbage and out-of-range values', () => {
    expect(parseLatLng('not a point')).toBeNull();
    expect(parseLatLng('geo:95,10')).toBeNull();
    expect(parseLatLng({ latitudeE7: 'garbage', longitudeE7: 1 })).toBeNull();
    expect(parseLatLng(null)).toBeNull();
    expect(parseLatLng(42)).toBeNull();
    expect(parseLatLng({})).toBeNull();
  });
});

describe('parseTimeline — current on-device export', () => {
  it('turns visits, timeline paths and activities into tracks; skips malformed segments', () => {
    const tracks = parseTimeline(fixture('semantic-segments.json'), { ...utc, name: 'Timeline.json' });
    expect(tracks.map((t) => [t.name, t.points.length])).toEqual([
      ['Visit (home)', 1],
      ['Timeline 2024-03-10', 5],
      ['Activity (walking)', 2],
      ['Activity (in_subway)', 1], // 5 km apart → not joined: two single-point tracks
      ['Activity (in_subway)', 1],
      ['Visit', 1],
    ]);
    expect(tracks[0].points[0]).toEqual([-73.9568, 40.7176, Date.parse('2024-03-10T08:00:00.000-04:00')]);
    expect(tracks[1].points[1]).toEqual([-73.9561, 40.7181, Date.parse('2024-03-10T09:32:00.000-04:00')]);
    expect(tracks[2].points).toEqual([
      [-73.954, 40.7196, Date.parse('2024-03-10T09:40:00.000-04:00')],
      [-73.9512, 40.7215, Date.parse('2024-03-10T09:55:00.000-04:00')],
    ]);
    for (const t of tracks) {
      expect(t.source).toBe('timeline');
      expect(t.id).toMatch(/^timeline-[0-9a-f]{8}$/);
    }
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
  });

  it('uses rawSignals only when asked or when nothing else is there, dropping fixes with accuracy > 100 m', () => {
    const doc = fixture('semantic-segments.json') as { rawSignals: unknown[] };
    const withRaw = parseTimeline(doc, { ...utc, includeRawSignals: true });
    expect(withRaw.length).toBe(7);
    expect(withRaw[6].points).toEqual([[-73.9568, 40.7176, Date.parse('2024-03-10T08:05:00.000-04:00')]]);
    const onlyRaw = parseTimeline({ rawSignals: doc.rawSignals }, utc);
    expect(onlyRaw.length).toBe(1);
    expect(onlyRaw[0].name).toBe('Timeline 2024-03-10');
    const loose = parseTimeline({ rawSignals: doc.rawSignals }, { ...utc, maxAccuracyM: 1000 });
    expect(loose[0].points.length).toBe(2);
  });

  it('iOS export: a bare array of segments with minute offsets instead of times', () => {
    const start = '2024-04-01T12:00:00.000-04:00';
    const doc = [
      {
        startTime: start,
        endTime: '2024-04-01T12:10:00.000-04:00',
        timelinePath: [
          { point: 'geo:40.7176,-73.9568', durationMinutesOffsetFromStartTime: '0' },
          { point: 'geo:40.7180,-73.9560', durationMinutesOffsetFromStartTime: '3' },
          { point: 'geo:40.7184,-73.9552', durationMinutesOffsetFromStartTime: 6 },
        ],
      },
      { startTime: '2024-04-01T13:00:00.000-04:00', endTime: '2024-04-01T14:00:00.000-04:00', visit: { topCandidate: { placeLocation: { latLng: '40.72°, -73.95°' }, semanticType: 'WORK' } } },
    ];
    const tracks = parseTimeline(doc, utc);
    expect(tracks.length).toBe(2);
    expect(tracks[0].points.map((p) => p[2])).toEqual([Date.parse(start), Date.parse(start) + 3 * 60_000, Date.parse(start) + 6 * 60_000]);
    expect(tracks[1]).toMatchObject({ name: 'Visit (work)', points: [[-73.95, 40.72, Date.parse('2024-04-01T13:00:00.000-04:00')]] });
  });
});

describe('parseTimeline — legacy Takeout', () => {
  it('Records.json: accuracy filter, both timestamp spellings, per-day + gap split, bad rows skipped', () => {
    const tracks = parseTimeline(fixture('records.json'), utc);
    expect(tracks.map((t) => [t.name, t.points.length])).toEqual([
      ['Timeline 2023-11-05', 4],
      ['Timeline 2023-11-05', 2],
      ['Timeline 2023-11-07', 3],
    ]);
    expect(tracks[0].points[0]).toEqual([-73.9568, 40.7176, Date.parse('2023-11-05T14:00:00.000Z')]);
    expect(tracks[2].points[0]).toEqual([-73.9568, 40.7176, 1699344000000]);
    // the 1200 m-accuracy fix at 40.7182 on day 1 is gone
    expect(tracks[0].points.some((p) => p[1] === 40.7182)).toBe(false);
  });

  it('sorts out-of-order records by time', () => {
    const doc = fixture('records.json') as { locations: unknown[] };
    const shuffled = { locations: [...doc.locations].reverse() };
    const a = parseTimeline(doc, utc);
    const b = parseTimeline(shuffled, utc);
    expect(b.map((t) => t.points)).toEqual(a.map((t) => t.points));
  });

  it('splits at the calendar-day boundary even without a gap', () => {
    const loc = (lat: number, t: string) => ({ latitudeE7: Math.round(lat * 1e7), longitudeE7: -739568000, accuracy: 5, timestamp: t });
    const doc = { locations: [loc(40.7176, '2023-11-05T23:50:00Z'), loc(40.7177, '2023-11-05T23:55:00Z'), loc(40.7178, '2023-11-06T00:05:00Z')] };
    expect(parseTimeline(doc, utc).map((t) => t.points.length)).toEqual([2, 1]);
  });

  it('Semantic Location History: activitySegment raw path + placeVisit', () => {
    const doc = {
      timelineObjects: [
        {
          activitySegment: {
            startLocation: { latitudeE7: 407176000, longitudeE7: -739568000 },
            endLocation: { latitudeE7: 407190000, longitudeE7: -739550000 },
            duration: { startTimestamp: '2022-09-01T10:00:00Z', endTimestamp: '2022-09-01T10:10:00Z' },
            activityType: 'WALKING',
            simplifiedRawPath: {
              points: [
                { latE7: 407176000, lngE7: -739568000, accuracyMeters: 10, timestamp: '2022-09-01T10:00:00Z' },
                { latE7: 407183000, lngE7: -739559000, accuracyMeters: 10, timestamp: '2022-09-01T10:05:00Z' },
                { latE7: 407190000, lngE7: -739550000, accuracyMeters: 10, timestamp: '2022-09-01T10:10:00Z' },
              ],
            },
          },
        },
        {
          activitySegment: {
            startLocation: { latitudeE7: 407190000, longitudeE7: -739550000 },
            endLocation: { latitudeE7: 407200000, longitudeE7: -739540000 },
            duration: { startTimestampMs: '1662027000000', endTimestampMs: '1662027300000' },
            waypointPath: { waypoints: [{ latE7: 407195000, lngE7: -739545000 }] },
          },
        },
        {
          placeVisit: {
            location: { latitudeE7: 407200000, longitudeE7: -739540000, name: 'Cafe' },
            duration: { startTimestamp: '2022-09-01T10:20:00Z', endTimestamp: '2022-09-01T11:00:00Z' },
          },
        },
        { placeVisit: { location: {} } },
      ],
    };
    const tracks = parseTimeline(doc, utc);
    expect(tracks.map((t) => [t.name, t.points.length])).toEqual([
      ['Activity (walking) 2022-09-01', 3],
      ['Activity 2022-09-01', 3],
      ['Visit', 1],
    ]);
    expect(tracks[1].points[1]).toEqual([-73.9545, 40.7195]);
  });
});

describe('parseTimeline — leniency', () => {
  it('returns nothing for unknown shapes and accepts a JSON string', () => {
    expect(parseTimeline(null)).toEqual([]);
    expect(parseTimeline(42)).toEqual([]);
    expect(parseTimeline({ foo: 'bar' })).toEqual([]);
    expect(parseTimeline([])).toEqual([]);
    expect(parseTimeline({ semanticSegments: [null, 1, 'x', {}] })).toEqual([]);
    expect(parseTimeline('{"locations":[{"latitudeE7":407176000,"longitudeE7":-739568000}]}').length).toBe(1);
  });

  it('a bare array of Records-style locations still works', () => {
    const tracks = parseTimeline([{ latitudeE7: 407176000, longitudeE7: -739568000, timestamp: '2023-01-01T00:00:00Z' }], utc);
    expect(tracks.length).toBe(1);
    expect(tracks[0].points).toEqual([[-73.9568, 40.7176, Date.parse('2023-01-01T00:00:00Z')]]);
  });
});
