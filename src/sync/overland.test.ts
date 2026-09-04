import { describe, expect, it } from 'vitest';
import type { ApplyResult, GridApi, TrackSummary } from '../grid/api';
import type { GridStats, Track } from '../grid/types';
import { dayKey } from '../import/util';
import { OVERLAND_KEY, OverlandSource, describeAge, maskToken, mergeIntoDayTracks, normalizeReceiverUrl, overlandDayId, validToken, type FetchFn, type OverlandPoint, type OverlandState } from './overland';
import { SyncError } from './scheduler';
import { memoryKV } from './state';

/** A grid double that stores tracks by id (re-marking replaces, like the real store). */
function fakeGrid() {
  const tracks = new Map<string, Track>();
  const marks: Track[] = [];
  const stats = (): GridStats => ({ visitedCells: marks.length, areaM2: 0, tiles: 0, version: marks.length, updatedAt: 0 });
  const result = (): ApplyResult => ({ stats: stats(), touched: [] });
  const grid: GridApi = {
    init: async () => stats(),
    getStats: async () => stats(),
    applyPayload: async () => result(),
    async markTrack(t) {
      marks.push(structuredClone(t));
      tracks.set(t.id, structuredClone(t));
      return result();
    },
    renderTile: async () => new Uint8ClampedArray(0),
    getTileCounts: async () => null,
    listBaseTiles: async () => [],
    exportBackup: async () => new Uint8Array(0),
    importBackup: async () => result(),
    listTracks: async () => [...tracks.values()].map((t): TrackSummary => ({ id: t.id, source: t.source, name: t.name, points: t.points.length, lengthM: 0 })),
    getTrack: async (id) => tracks.get(id) ?? null,
    deleteTrack: async () => stats(),
    deleteAll: async () => stats(),
  };
  return { grid, tracks, marks };
}

const T0 = Date.UTC(2026, 8, 3, 15, 0, 0); // 2026-09-03 15:00 UTC — the same local day everywhere west of UTC+9
const pt = (i: number, extra: Partial<OverlandPoint> = {}): OverlandPoint => ({ t: T0 + i * 10_000, lon: -73.9568 + i * 0.0001, lat: 40.7176, ...extra });

describe('Overland helpers', () => {
  it('normalises the receiver URL and validates tokens', () => {
    expect(normalizeReceiverUrl(' unfog-overland.jacob.workers.dev/ ')).toBe('https://unfog-overland.jacob.workers.dev');
    expect(normalizeReceiverUrl('https://a.b/c/?x=1#y')).toBe('https://a.b/c');
    expect(normalizeReceiverUrl('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeReceiverUrl('')).toBe('');
    expect(() => normalizeReceiverUrl('http://example.com')).toThrow(/https/);
    expect(() => normalizeReceiverUrl('https://exa mple.com')).toThrow(/valid URL/);
    expect(validToken('abcdef12')).toBe(true);
    expect(validToken('a'.repeat(128))).toBe(true);
    expect(validToken('short')).toBe(false);
    expect(validToken('has space 123')).toBe(false);
    expect(maskToken('0123456789abcdef')).toBe('0123…cdef');
    expect(maskToken('tiny')).toBe('••••');
    expect(describeAge(10_000)).toBe('just now');
    expect(describeAge(5 * 60_000)).toBe('5 min ago');
    expect(describeAge(3 * 3_600_000)).toBe('3 h ago');
    expect(describeAge(72 * 3_600_000)).toBe('3 days ago');
  });

  it('mergeIntoDayTracks: drops poor fixes, dedupes on time, merges with the stored day and sorts', () => {
    const existing = new Map<string, Track | null>();
    const id = overlandDayId(T0);
    expect(id).toBe(`overland-${dayKey(T0, 'local')}`);
    existing.set(id, { id, source: 'overland', name: 'Overland x', points: [[-73.95, 40.71, T0 - 60_000]] });
    const r = mergeIntoDayTracks([pt(2), pt(0, { acc: 12 }), pt(1, { acc: 80 }), pt(0), { t: Number.NaN, lon: 0, lat: 0 }, pt(3, { speed: 1.2 })], existing);
    expect(r).toMatchObject({ kept: 3, dropped: 2 });
    expect(r.tracks).toHaveLength(1);
    const t = r.tracks[0];
    expect(t.id).toBe(id);
    expect(t.source).toBe('overland');
    expect(t.name).toMatch(/^Overland \d{4}-\d{2}-\d{2}$/);
    expect(t.points.map((p) => p[2])).toEqual([T0 - 60_000, T0, T0 + 20_000, T0 + 30_000]);
    expect(t.points[0]).toEqual([-73.95, 40.71, T0 - 60_000]); // the stored point kept
    // Nothing new for the day → not returned.
    const again = mergeIntoDayTracks([pt(0), pt(2)], new Map([[id, t]]));
    expect(again.tracks).toEqual([]);
    expect(again.kept).toBe(0);
    // Two days → two tracks.
    const two = mergeIntoDayTracks([pt(0), { ...pt(0), t: T0 + 3 * 86_400_000 }], new Map());
    expect(two.tracks.map((x) => x.id).sort()).toEqual([overlandDayId(T0), overlandDayId(T0 + 3 * 86_400_000)].sort());
  });
});

/** A receiver double: pages keyed by `since`. */
function fakeReceiver(pages: Record<string, { batches: Array<{ key: string; points: OverlandPoint[] }>; cursor: string; hasMore: boolean }>, opts: { token?: string; status?: unknown; fail?: () => Response } = {}) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fn: FetchFn = async (url, init = {}) => {
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ url, auth });
    if (opts.fail) return opts.fail();
    if (auth !== `Bearer ${opts.token ?? 'tok-12345678'}`) return new Response('{"result":"error","error":"unauthorized"}', { status: 401 });
    const u = new URL(url);
    if (u.pathname.endsWith('/status')) return new Response(JSON.stringify(opts.status ?? { result: 'ok', batches: 0, latest: null }), { status: 200 });
    if (u.pathname.endsWith('/pull')) {
      const since = u.searchParams.get('since') ?? '';
      const page = pages[since] ?? { batches: [], cursor: since, hasMore: false };
      return new Response(JSON.stringify({ result: 'ok', ...page }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  return { fn, calls };
}

function makeSource(grid: GridApi, fetchFn: FetchFn, configured = true) {
  const store = memoryKV();
  const source = new OverlandSource({ grid, store, fetchFn, now: () => T0 + 3_600_000 });
  if (configured) source.configure('https://unfog-overland.jacob.workers.dev', 'tok-12345678');
  return { source, store };
}

const progress = (_m: string) => undefined;

describe('OverlandSource', () => {
  it('configure validates and resets the cursor on change; forget clears everything', () => {
    const { grid } = fakeGrid();
    const { source, store } = makeSource(grid, fakeReceiver({}).fn, false);
    expect(source.configured()).toBe(false);
    expect(source.ready()).toBe(false);
    expect(() => source.configure('', 'tok-12345678')).toThrow(/receiver URL/);
    expect(() => source.configure('https://x.test', 'bad token')).toThrow(/token/);
    source.configure('https://x.test/', 'tok-12345678');
    expect(source.state()).toMatchObject({ url: 'https://x.test', token: 'tok-12345678', cursor: null });
    store.write(OVERLAND_KEY, { ...source.state(), cursor: 'k1' });
    source.configure('https://x.test', 'tok-12345678'); // unchanged → cursor kept
    expect(source.state().cursor).toBe('k1');
    source.configure('https://y.test', 'tok-12345678'); // new receiver → cursor dropped
    expect(source.state().cursor).toBeNull();
    source.forget();
    expect(source.configured()).toBe(false);
    expect(store.read(OVERLAND_KEY, null)).toBeNull();
  });

  it('pulls pages after the cursor, folds points into day tracks (merged across batches), advances the cursor per page; a re-pull adds nothing', async () => {
    const { grid, marks, tracks } = fakeGrid();
    const k = (i: number) => `tok-12345678/${String(T0 + i * 60_000).padStart(13, '0')}-0000${i}`;
    const rx = fakeReceiver({
      '': { batches: [{ key: k(1), points: [pt(0), pt(1)] }, { key: k(2), points: [pt(2, { acc: 200 }), pt(3)] }], cursor: k(2), hasMore: true },
      [k(2)]: { batches: [{ key: k(3), points: [pt(4), { ...pt(0), t: T0 + 2 * 86_400_000 }] }], cursor: k(3), hasMore: false },
    });
    const { source, store } = makeSource(grid, rx.fn);
    const r = await source.pull('open', progress);
    expect(r).toMatchObject({ added: 5, items: 3 });
    expect(r.note).toMatch(/1 fix skipped/);
    // Page 1: one day track with 3 points; page 2: the same day re-marked with 4, plus a second day.
    expect(marks.map((m) => `${m.id}:${m.points.length}`)).toEqual([`${overlandDayId(T0)}:3`, `${overlandDayId(T0)}:4`, `${overlandDayId(T0 + 2 * 86_400_000)}:1`]);
    expect(tracks.get(overlandDayId(T0))!.points.map((p) => p[2])).toEqual([T0, T0 + 10_000, T0 + 30_000, T0 + 40_000]);
    const s = store.read<OverlandState>(OVERLAND_KEY, null as never);
    expect(s.cursor).toBe(k(3));
    expect(s.lastPull).toMatchObject({ batches: 3, points: 5, tracks: 2 });
    expect(s.totalPoints).toBe(5);
    expect(rx.calls.map((c) => new URL(c.url).searchParams.get('since'))).toEqual(['', k(2)]);
    expect(rx.calls[0].auth).toBe('Bearer tok-12345678');
    // Second pull: the cursor yields nothing → no marks.
    const r2 = await source.pull('interval', progress);
    expect(r2).toEqual({ added: 0, items: 0 });
    expect(marks).toHaveLength(3);
    // The receiver forgot the cursor (reset): the same batches come back → merged, nothing new.
    store.write(OVERLAND_KEY, { ...source.state(), cursor: null });
    const r3 = await source.pull('manual', progress);
    expect(r3).toMatchObject({ added: 0, items: 3 });
    expect(marks).toHaveLength(3);
  });

  it('test(): OK with counts, a rejected token, an unreachable receiver, a non-JSON answer', async () => {
    const { grid } = fakeGrid();
    let rx = fakeReceiver({}, { status: { result: 'ok', batches: 12, latest: T0 + 3_600_000 - 3 * 60_000 } });
    let { source } = makeSource(grid, rx.fn);
    let r = await source.test();
    expect(r).toMatchObject({ ok: true, message: 'Receiver OK — 12 batches stored, latest 3 min ago' });
    expect(source.state().lastTest).toMatchObject({ ok: true });
    rx = fakeReceiver({}, { status: { result: 'ok', batches: 0, latest: null } });
    ({ source } = makeSource(grid, rx.fn));
    expect((await source.test()).message).toMatch(/no batches yet/);
    rx = fakeReceiver({}, { token: 'other-token-1' });
    ({ source } = makeSource(grid, rx.fn));
    r = await source.test();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the token/);
    rx = fakeReceiver({}, {
      fail: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    ({ source } = makeSource(grid, rx.fn));
    expect((await source.test()).message).toMatch(/Could not reach the receiver/);
    rx = fakeReceiver({}, { fail: () => new Response('<html>not a worker</html>', { status: 200 }) });
    ({ source } = makeSource(grid, rx.fn));
    expect((await source.test()).message).toMatch(/did not answer with JSON/);
    ({ source } = makeSource(grid, rx.fn, false));
    expect((await source.test()).message).toMatch(/Enter the receiver URL/);
  });

  it('pull errors: 429 with Retry-After and 5xx are retryable; 401 and 404 are not; unconfigured throws', async () => {
    const { grid } = fakeGrid();
    let rx = fakeReceiver({}, { fail: () => new Response('slow', { status: 429, headers: { 'Retry-After': '12' } }) });
    let { source } = makeSource(grid, rx.fn);
    await expect(source.pull('open', progress)).rejects.toMatchObject({ retryable: true, retryAfterMs: 12_000 });
    rx = fakeReceiver({}, { fail: () => new Response('down', { status: 503 }) });
    ({ source } = makeSource(grid, rx.fn));
    await expect(source.pull('open', progress)).rejects.toMatchObject({ retryable: true });
    rx = fakeReceiver({}, { token: 'other-token-1' });
    ({ source } = makeSource(grid, rx.fn));
    await expect(source.pull('open', progress)).rejects.toMatchObject({ retryable: false });
    rx = fakeReceiver({}, { fail: () => new Response('nope', { status: 404 }) });
    ({ source } = makeSource(grid, rx.fn));
    await expect(source.pull('open', progress)).rejects.toThrow(/HTTP 404/);
    ({ source } = makeSource(grid, rx.fn, false));
    let err: unknown;
    try {
      await source.pull('open', progress);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).message).toMatch(/not set up/);
  });
});
