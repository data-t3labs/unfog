import { describe, expect, it } from 'vitest';
import { graphTileBounds, lonLatToGraphTile } from './graph-format';
import { DEFAULT_PREFETCH, Prefetcher, decidePrefetch, initialPrefetchState, planEviction, ringTiles, type PrefetchCache, type PrefetchEnv } from './prefetch';

/** In-memory PrefetchCache: every tile in `covered` is fetchable at `tileBytes` each. */
function fakeCache(covered: (x: number, y: number) => boolean, tileBytes = 1000) {
  const tiles = new Map<string, { size: number; lastUsed: number }>();
  let clock = 0;
  const calls: Array<Array<[number, number]>> = [];
  let failNext = false;
  const cache: PrefetchCache & { tiles: typeof tiles; calls: typeof calls; failNext(): void } = {
    tiles, calls,
    failNext() { failNext = true; },
    async hasTile(x, y) { return tiles.has(`${x}/${y}`); },
    async fetchTiles(list) {
      calls.push(list);
      const out = { fetched: 0, bytes: 0, failed: [] as string[], uncovered: [] as string[] };
      for (const [x, y] of list) {
        const k = `${x}/${y}`;
        if (!covered(x, y)) { out.uncovered.push(k); continue; }
        if (failNext) { out.failed.push(k); continue; }
        tiles.set(k, { size: tileBytes, lastUsed: clock++ });
        out.fetched++; out.bytes += tileBytes;
      }
      failNext = false;
      return out;
    },
    async listCached() { return [...tiles].map(([key, v]) => ({ key, ...v })); },
    async evict(keys) { for (const k of keys) tiles.delete(k); },
  };
  return cache;
}

const centreOf = (x: number, y: number): [number, number] => {
  const b = graphTileBounds(x, y);
  return [(b.west + b.east) / 2, (b.south + b.north) / 2];
};
const env = (over: Partial<PrefetchEnv> = {}): PrefetchEnv => ({ online: true, saveData: false, now: 100_000, ...over });

describe('ringTiles', () => {
  it('5×5 ring, centre first, then by distance; clamped at the grid edge', () => {
    const r = ringTiles(100, 100, 2);
    expect(r.length).toBe(25);
    expect(r[0]).toEqual([100, 100]);
    expect(r.slice(1, 9).every(([x, y]) => Math.max(Math.abs(x - 100), Math.abs(y - 100)) === 1)).toBe(true);
    expect(r.slice(9).every(([x, y]) => Math.max(Math.abs(x - 100), Math.abs(y - 100)) === 2)).toBe(true);
    expect(new Set(r.map(([x, y]) => `${x}/${y}`)).size).toBe(25);
    expect(ringTiles(0, 0, 2).length).toBe(9);
    expect(ringTiles(4095, 0, 1).length).toBe(4);
    expect(ringTiles(7, 7, 0)).toEqual([[7, 7]]);
  });
});

describe('planEviction', () => {
  it('evicts least-recently-used tiles outside the protected set until under budget', () => {
    const cached = [
      { key: 'a', size: 40, lastUsed: 1 }, { key: 'b', size: 40, lastUsed: 5 }, { key: 'c', size: 40, lastUsed: 3 }, { key: 'd', size: 40, lastUsed: 2 },
    ];
    expect(planEviction(cached, 200, new Set())).toEqual([]);
    expect(planEviction(cached, 100, new Set())).toEqual(['a', 'd']);
    expect(planEviction(cached, 100, new Set(['a']))).toEqual(['d', 'c']);
    expect(planEviction(cached, 0, new Set(['a', 'b', 'c', 'd']))).toEqual([]); // nothing evictable
  });
});

describe('decidePrefetch', () => {
  it('skips without a centre, offline, on data-saver, when throttled or unchanged', () => {
    const s = initialPrefetchState();
    expect(decidePrefetch(s, env()).action).toBe('skip');
    s.centre = [100, 100]; s.pending = true;
    expect(decidePrefetch(s, env({ online: false }))).toEqual({ action: 'skip', reason: 'offline' });
    expect(decidePrefetch(s, env({ saveData: true }))).toEqual({ action: 'skip', reason: 'save-data' });
    s.lastRoundAt = 99_000;
    expect(decidePrefetch(s, env({ now: 100_000 }))).toEqual({ action: 'skip', reason: 'throttled' });
    const d = decidePrefetch(s, env({ now: 110_000 }));
    expect(d.action).toBe('fetch');
    if (d.action === 'fetch') expect(d.tiles.length).toBe(25);
    s.pending = false;
    expect(decidePrefetch(s, env({ now: 120_000 }), DEFAULT_PREFETCH, [100, 100])).toEqual({ action: 'skip', reason: 'unchanged' });
    expect(decidePrefetch(s, env({ now: 120_000 }), DEFAULT_PREFETCH, [101, 100]).action).toBe('fetch');
  });
});

describe('Prefetcher', () => {
  it('prefetches the 5×5 ring when the position enters a tile, only once per centre, and re-plans on a new tile', async () => {
    const cache = fakeCache(() => true);
    const p = new Prefetcher(cache);
    const [lon, lat] = centreOf(1206, 1539);
    expect(p.notify(lon, lat, 'position', 1000)).toBe(true);
    const r1 = await p.tick(env({ now: 1000 }));
    expect(r1.decision.action).toBe('fetch');
    expect(r1.fetched).toBe(25);
    expect(cache.calls[0][0]).toEqual([1206, 1539]); // centre first
    expect(cache.tiles.size).toBe(25);
    // same tile again: nothing to do
    p.notify(lon + 1e-4, lat, 'position', 2000);
    const r2 = await p.tick(env({ now: 20_000 }));
    expect(r2.decision).toEqual({ action: 'skip', reason: 'unchanged' });
    expect(cache.calls.length).toBe(1);
    // move one tile east: only the new column (5 tiles) is fetched
    const [lon2, lat2] = centreOf(1207, 1539);
    expect(p.notify(lon2, lat2, 'position', 30_000)).toBe(true);
    const r3 = await p.tick(env({ now: 30_000 }));
    expect(r3.fetched).toBe(5);
    expect(cache.tiles.size).toBe(30);
    expect(p.stats).toEqual({ rounds: 2, fetched: 30, bytes: 30_000, evicted: 0, failed: 0 });
  });

  it('is throttled, retries pending work after the interval, and never fetches on data-saver or offline', async () => {
    const cache = fakeCache(() => true);
    const p = new Prefetcher(cache);
    const [lon, lat] = centreOf(500, 600);
    p.notify(lon, lat, 'position', 0);
    expect((await p.tick(env({ now: 0, saveData: true }))).decision).toEqual({ action: 'skip', reason: 'save-data' });
    expect((await p.tick(env({ now: 0, online: false }))).decision).toEqual({ action: 'skip', reason: 'offline' });
    expect(cache.calls.length).toBe(0);
    cache.failNext();
    const r = await p.tick(env({ now: 0 }));
    expect(r.failed).toBe(25);
    expect(p.state.pending).toBe(true);
    expect((await p.tick(env({ now: 1000 }))).decision).toEqual({ action: 'skip', reason: 'throttled' });
    const retry = await p.tick(env({ now: 6000 }));
    expect(retry.decision.action).toBe('fetch');
    expect(retry.fetched).toBe(25);
    expect(p.state.pending).toBe(false);
  });

  it('map-centre moves are ignored shortly after a position fix, honoured when idle', async () => {
    const cache = fakeCache(() => true);
    const p = new Prefetcher(cache);
    const [lon, lat] = centreOf(500, 600);
    p.notify(lon, lat, 'position', 0);
    await p.tick(env({ now: 0 }));
    const [lon2, lat2] = centreOf(900, 900);
    expect(p.notify(lon2, lat2, 'map', 10_000)).toBe(false); // navigating: map pans do not steal the prefetch
    expect(p.state.centre).toEqual([500, 600]);
    expect(p.notify(lon2, lat2, 'map', 70_000)).toBe(true); // idle for > positionPriorityMs
    const r = await p.tick(env({ now: 70_000 }));
    expect(r.fetched).toBe(25);
    expect(lonLatToGraphTile(lon2, lat2)).toEqual([900, 900]);
  });

  it('keeps the cache under the budget with LRU eviction that spares the current ring; uncovered tiles are reported', async () => {
    const cache = fakeCache((x) => x < 1000, 1000);
    const p = new Prefetcher(cache, { ...DEFAULT_PREFETCH, budgetBytes: 30_000, maxTilesPerRound: 100 });
    const a = centreOf(500, 600);
    p.notify(a[0], a[1], 'position', 0);
    await p.tick(env({ now: 0 }));
    const b = centreOf(510, 600);
    p.notify(b[0], b[1], 'position', 10_000);
    const r = await p.tick(env({ now: 10_000 }));
    expect(r.fetched).toBe(25);
    expect(r.evicted).toBe(20); // 50 tiles × 1000 B > 30 KB budget → 20 oldest (all outside the new ring) go
    expect(cache.tiles.size).toBe(30);
    for (const [x, y] of ringTiles(510, 600, 2)) expect(cache.tiles.has(`${x}/${y}`)).toBe(true);
    // partially uncovered ring (east of x=1000: no pack)
    const c = centreOf(999, 600);
    p.notify(c[0], c[1], 'position', 20_000);
    const r2 = await p.tick(env({ now: 20_000 }));
    expect(r2.uncovered).toBe(10); // x = 1000, 1001 columns
    expect(r2.fetched).toBe(15);
    expect(p.state.pending).toBe(false); // uncovered is not pending work
  });

  it('a large ring is fetched in rounds of maxTilesPerRound', async () => {
    const cache = fakeCache(() => true);
    const p = new Prefetcher(cache, { ...DEFAULT_PREFETCH, maxTilesPerRound: 10, minIntervalMs: 0 });
    const a = centreOf(500, 600);
    p.notify(a[0], a[1], 'position', 0);
    expect((await p.tick(env({ now: 0 }))).fetched).toBe(10);
    expect(p.state.pending).toBe(true);
    expect((await p.tick(env({ now: 1 }))).fetched).toBe(10);
    expect((await p.tick(env({ now: 2 }))).fetched).toBe(5);
    expect(p.state.pending).toBe(false);
    expect((await p.tick(env({ now: 3 }))).decision).toEqual({ action: 'skip', reason: 'unchanged' });
  });
});
