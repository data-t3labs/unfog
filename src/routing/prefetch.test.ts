import { describe, expect, it } from 'vitest';
import { createPrefetchDriver } from '../app/prefetch-driver';
import { graphTileBounds, lonLatToGraphTile } from './graph-format';
import { DEFAULT_PREFETCH, Prefetcher, decidePrefetch, initialPrefetchState, mapMoveCounts, planEviction, ringTiles, type PrefetchCache, type PrefetchEnv } from './prefetch';

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

  it('map-centre moves near a fresh position fix are ignored; a far pan counts at once; fixes keep priority nearby; idle pans always count', async () => {
    const cache = fakeCache(() => true);
    const p = new Prefetcher(cache);
    // Bedford & N 7th (tile 1206/1539): a fix, then the ring.
    const [lon, lat] = centreOf(1206, 1539);
    p.notify(lon, lat, 'position', 0);
    await p.tick(env({ now: 0 }));
    expect(p.state.lastPosition).toEqual([lon, lat]);
    // A glance around: 0.02° ≈ 1.7 km east, inside the ring and within farPanM → ignored while the fix is fresh.
    const near: [number, number] = [lon + 0.02, lat];
    expect(mapMoveCounts(p.state, near[0], near[1], 10_000, DEFAULT_PREFETCH)).toBe(false);
    expect(p.notify(near[0], near[1], 'map', 10_000)).toBe(false);
    expect(p.state.centre).toEqual([1206, 1539]);
    // Panning to Jamaica, Queens (≈ 13 km): farther than farPanM → counts even though the fix is 10 s old.
    const [lon2, lat2] = centreOf(1208, 1540);
    expect(mapMoveCounts(p.state, lon2, lat2, 10_000, DEFAULT_PREFETCH)).toBe(true);
    expect(p.notify(lon2, lat2, 'map', 10_000)).toBe(true);
    expect(p.state.centre).toEqual([1208, 1540]);
    const r = await p.tick(env({ now: 10_000 }));
    expect(r.decision.action).toBe('fetch');
    expect(r.fetched).toBeGreaterThan(0);
    expect(cache.tiles.has('1210/1542')).toBe(true); // the far ring's corner arrived
    // The next fix (the user has not moved) re-centres the ring on the user: fixes keep priority.
    expect(p.notify(lon, lat, 'position', 11_000)).toBe(true);
    expect(p.state.centre).toEqual([1206, 1539]);
    // A pan near the user right after that fix is a glance again.
    expect(p.notify(near[0], near[1], 'map', 12_000)).toBe(false);
    // Idle for > positionPriorityMs: any pan counts, near or far.
    expect(mapMoveCounts(p.state, near[0], near[1], 80_000, DEFAULT_PREFETCH)).toBe(true);
    const [lon3, lat3] = centreOf(900, 900);
    expect(p.notify(lon3, lat3, 'map', 80_000)).toBe(true);
    const r3 = await p.tick(env({ now: 80_000 }));
    expect(r3.fetched).toBe(25);
    expect(lonLatToGraphTile(lon3, lat3)).toEqual([900, 900]);
    // No fix ever: map moves always count (a phone with location off).
    const q = new Prefetcher(fakeCache(() => true));
    expect(q.notify(lon, lat, 'map', 0)).toBe(true);
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

describe('createPrefetchDriver (src/app/prefetch-driver.ts)', () => {
  it('starts on the map centre, rounds at once on a fix in a new tile, ignores a glance near a fresh fix, honours a far pan, and stops cleanly', async () => {
    const cache = fakeCache(() => true);
    const route = { packsHasTile: cache.hasTile, packsFetchTiles: cache.fetchTiles, packsListCached: cache.listCached, packsEvict: cache.evict };
    let fix: ((lon: number, lat: number) => void) | null = null;
    let move: (() => void) | null = null;
    let centre = centreOf(500, 600);
    let online = true;
    let unsubscribed = 0;
    const driver = createPrefetchDriver({
      route,
      onFix: (cb) => { fix = cb; return () => { fix = null; unsubscribed++; }; },
      onMapMove: (cb) => { move = cb; return () => { move = null; unsubscribed++; }; },
      mapCentre: () => centre,
      env: () => ({ online, saveData: false, now: Date.now() }),
      tickMs: 3_600_000,
      onlineTarget: null,
      config: { ...DEFAULT_PREFETCH, minIntervalMs: 0 },
    });
    // The saved map centre is where the user was: its ring is fetched right away.
    await driver.tick();
    expect(driver.prefetcher.state.centre).toEqual([500, 600]);
    expect(cache.tiles.size).toBe(25);
    // A fix in another tile → a round at once (no wait for the timer).
    const user = centreOf(700, 700);
    fix!(...user);
    await driver.tick();
    expect(cache.tiles.size).toBe(50);
    // A glance around right after the fix (≈ 2 km, inside the ring) does not move the ring — with or
    // without a tracking session, the rule is distance, not mode; a far pan (another city) does.
    centre = [user[0] + 0.02, user[1]];
    move!();
    await driver.tick();
    expect(driver.prefetcher.state.centre).toEqual([700, 700]);
    expect(cache.tiles.size).toBe(50);
    centre = centreOf(900, 900);
    move!();
    await driver.tick();
    expect(driver.prefetcher.state.centre).toEqual([900, 900]);
    expect(cache.tiles.size).toBe(75);
    // Offline: nothing is fetched; a tick when back online resumes.
    online = false;
    fix!(...centreOf(300, 300));
    expect((await driver.tick()).decision).toEqual({ action: 'skip', reason: 'offline' });
    expect(cache.tiles.size).toBe(75);
    online = true;
    expect((await driver.tick()).fetched).toBe(25);
    driver.stop();
    expect(unsubscribed).toBe(2);
    expect(fix).toBeNull();
    expect(move).toBeNull();
  });
});
