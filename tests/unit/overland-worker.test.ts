/**
 * The Overland receiver's handlers (workers/overland/src/worker.ts) against an in-memory KV
 * double — no miniflare, no Cloudflare types. Lives here because the root vitest config includes
 * tests/unit/** and the Worker is not part of src/.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_ORIGIN, batchKey, compactBatch, handleRequest, keyEpoch, type Env, type KvLike, type KvListResult } from '../../workers/overland/src/worker';

/** Sorted in-memory KV with prefix / limit / cursor paging and recorded TTLs. */
class MemoryKV implements KvLike {
  readonly map = new Map<string, { value: string; ttl?: number }>();
  lists = 0;
  async get(key: string): Promise<string | null> {
    return this.map.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, { value, ttl: options?.expirationTtl });
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<KvListResult> {
    this.lists++;
    const all = [...this.map.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = all.slice(start, start + limit);
    const done = start + limit >= all.length;
    const out: KvListResult = { keys: page.map((name) => ({ name })), list_complete: done };
    if (!done) out.cursor = String(start + limit);
    return out;
  }
}

const TOKEN = 'a1b2c3d4e5f6a7b8';
const ORIGIN = DEFAULT_APP_ORIGIN;
const BASE = 'https://unfog-overland.example.workers.dev';

function env(kv: MemoryKV, over: Partial<Env> = {}): Env {
  return { OVERLAND_KV: kv, OVERLAND_TOKENS: `${TOKEN}, other-token-000`, ...over };
}

const req = (method: string, path: string, opts: { token?: string | null; body?: unknown; origin?: string; query?: Record<string, string> } = {}): Request => {
  const u = new URL(path, BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) u.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.origin) headers.Origin = opts.origin;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  return new Request(u.toString(), init);
};

/** The README's example batch, plus a point with unknown accuracy/speed (-1) and a broken one. */
const overlandBatch = (ts: string[], device = 'jacob-iphone') => ({
  locations: ts.map((t, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-122.030581 + i * 0.001, 37.3318] },
    properties: { timestamp: t, altitude: 0, speed: i === 1 ? -1 : 4, course: 0, horizontal_accuracy: i === 1 ? -1 : 30, vertical_accuracy: -1, motion: ['walking'], battery_state: 'charging', battery_level: 0.8, wifi: '', device_id: device },
  })),
  current: {},
  trip: {},
});

let clock = Date.UTC(2026, 8, 3, 20, 0, 0);
const now = () => clock;

describe('Overland receiver — pure helpers', () => {
  it('batchKey pads for chronological sorting and keyEpoch reads it back', () => {
    const k = batchKey(TOKEN, 1_757_000_000_000, 7);
    expect(k).toBe(`${TOKEN}/1757000000000-00007`);
    expect(keyEpoch(k)).toBe(1_757_000_000_000);
    expect(keyEpoch('junk')).toBeNull();
    expect(batchKey(TOKEN, 1_757_000_000_000, 100_007)).toBe(`${TOKEN}/1757000000000-00007`);
    expect(batchKey(TOKEN, 5, 1) < batchKey(TOKEN, 6, 0)).toBe(true);
  });

  it('compactBatch keeps t/lon/lat, optional acc/speed (never -1), sorts by time, drops the unusable', () => {
    const body = overlandBatch(['2026-09-03T12:00:10Z', '2026-09-03T12:00:00Z']);
    (body.locations as unknown[]).push({ type: 'Feature', geometry: { type: 'Point', coordinates: [999, 0] }, properties: { timestamp: '2026-09-03T12:00:20Z' } });
    (body.locations as unknown[]).push({ type: 'Feature', geometry: { type: 'Point' }, properties: {} });
    (body.locations as unknown[]).push({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { timestamp: 'never' } });
    const r = compactBatch(body);
    expect(r.dropped).toBe(3);
    expect(r.device).toBe('jacob-iphone');
    expect(r.points).toEqual([
      { t: Date.parse('2026-09-03T12:00:00Z'), lon: -122.029581, lat: 37.3318 },
      { t: Date.parse('2026-09-03T12:00:10Z'), lon: -122.030581, lat: 37.3318, acc: 30, speed: 4 },
    ]);
    expect(compactBatch(null)).toEqual({ points: [], dropped: 0, device: '' });
    expect(compactBatch({ locations: 'x' }).points).toEqual([]);
  });
});

describe('Overland receiver — handlers', () => {
  it('GET / is an unauthenticated banner; unknown paths are 404', async () => {
    const kv = new MemoryKV();
    const r = await handleRequest(req('GET', '/', { token: null }), env(kv), now);
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/Unfog Overland receiver/);
    expect((await handleRequest(req('GET', '/nope'), env(kv), now)).status).toBe(404);
  });

  it('CORS: preflight and headers only for the app origin', async () => {
    const kv = new MemoryKV();
    const ok = await handleRequest(req('OPTIONS', '/pull', { token: null, origin: ORIGIN }), env(kv), now);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    const bad = await handleRequest(req('OPTIONS', '/pull', { token: null, origin: 'https://evil.example' }), env(kv), now);
    expect(bad.status).toBe(403);
    const list = await handleRequest(req('OPTIONS', '/pull', { token: null, origin: 'http://localhost:5173' }), env(kv, { APP_ORIGIN: `${ORIGIN}, http://localhost:5173/` }), now);
    expect(list.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    // A real request from the app carries the header; Overland's POST (no Origin) gets none.
    const pull = await handleRequest(req('GET', '/pull', { origin: ORIGIN }), env(kv), now);
    expect(pull.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(pull.headers.get('Vary')).toBe('Origin');
    const post = await handleRequest(req('POST', '/', { body: overlandBatch([]) }), env(kv), now);
    expect(post.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('auth: missing / unknown / malformed tokens → 401; no tokens configured → 503; ?token= works', async () => {
    const kv = new MemoryKV();
    expect((await handleRequest(req('POST', '/', { token: null, body: {} }), env(kv), now)).status).toBe(401);
    expect((await handleRequest(req('POST', '/', { token: 'not-in-the-list-1', body: {} }), env(kv), now)).status).toBe(401);
    expect((await handleRequest(req('POST', '/', { token: 'x', body: {} }), env(kv), now)).status).toBe(401);
    const none = await handleRequest(req('POST', '/', { body: {} }), env(kv, { OVERLAND_TOKENS: '' }), now);
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ result: 'error', error: expect.stringMatching(/OVERLAND_TOKENS/) });
    const q = await handleRequest(req('GET', '/status', { token: null, query: { token: TOKEN } }), env(kv), now);
    expect(q.status).toBe(200);
  });

  it('POST stores a compact batch under <token>/<epoch>-<seq> with a 30-day TTL and answers exactly {"result":"ok"}', async () => {
    const kv = new MemoryKV();
    const r = await handleRequest(req('POST', '/', { body: overlandBatch(['2026-09-03T19:50:00Z', '2026-09-03T19:55:00Z']) }), env(kv), now);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"result":"ok"}');
    expect(r.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(r.headers.get('X-Points')).toBe('2');
    expect(kv.map.size).toBe(1);
    const [key, entry] = [...kv.map.entries()][0];
    expect(key).toMatch(new RegExp(`^${TOKEN}/${String(clock).padStart(13, '0')}-\\d{5}$`));
    expect(entry.ttl).toBe(30 * 86_400);
    const stored = JSON.parse(entry.value) as { v: number; received: number; device: string; points: unknown[] };
    expect(stored).toMatchObject({ v: 1, received: clock, device: 'jacob-iphone' });
    expect(stored.points).toHaveLength(2);
    // /overland is an alias; a custom TTL is honoured; an empty batch is ok but stores nothing.
    clock += 1000;
    expect((await handleRequest(req('POST', '/overland', { body: overlandBatch(['2026-09-03T19:56:00Z']) }), env(kv, { BATCH_TTL_DAYS: '7' }), now)).status).toBe(200);
    expect([...kv.map.values()][1].ttl).toBe(7 * 86_400);
    clock += 1000;
    const empty = await handleRequest(req('POST', '/', { body: overlandBatch([]) }), env(kv), now);
    expect(await empty.text()).toBe('{"result":"ok"}');
    expect(kv.map.size).toBe(2);
    // Not JSON → 400 (Overland would retry; its payloads are always JSON).
    const bad = await handleRequest(req('POST', '/', { body: '{not json' }), env(kv), now);
    expect(bad.status).toBe(400);
    // Another token's batches are kept apart.
    clock += 1000;
    await handleRequest(req('POST', '/', { token: 'other-token-000', body: overlandBatch(['2026-09-03T19:57:00Z']) }), env(kv), now);
    expect([...kv.map.keys()].filter((k) => k.startsWith('other-token-000/'))).toHaveLength(1);
  });

  it('GET /pull returns batches after the cursor oldest first, pages with limit/hasMore, and never crosses tokens', async () => {
    const kv = new MemoryKV();
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock = Date.UTC(2026, 8, 3, 20, i, 0);
      await handleRequest(req('POST', '/', { body: overlandBatch([`2026-09-03T19:5${i}:00Z`]) }), env(kv), now);
      keys.push([...kv.map.keys()].sort().filter((k) => k.startsWith(`${TOKEN}/`))[i]);
    }
    await handleRequest(req('POST', '/', { token: 'other-token-000', body: overlandBatch(['2026-09-03T19:59:00Z']) }), env(kv), now);
    const all = (await (await handleRequest(req('GET', '/pull'), env(kv), now)).json()) as { result: string; batches: Array<{ key: string; received: number; points: Array<{ t: number }> }>; cursor: string; hasMore: boolean };
    expect(all.result).toBe('ok');
    expect(all.batches.map((b) => b.key)).toEqual(keys);
    expect(all.batches[0].points[0].t).toBe(Date.parse('2026-09-03T19:50:00Z'));
    expect(all.batches[0].received).toBe(Date.UTC(2026, 8, 3, 20, 0, 0));
    expect(all.cursor).toBe(keys[4]);
    expect(all.hasMore).toBe(false);
    // After a cursor: only the newer ones.
    const after = (await (await handleRequest(req('GET', '/pull', { query: { since: keys[2] } }), env(kv), now)).json()) as typeof all;
    expect(after.batches.map((b) => b.key)).toEqual([keys[3], keys[4]]);
    // Paging: limit 2 → the first two + hasMore; then from that cursor.
    const p1 = (await (await handleRequest(req('GET', '/pull', { query: { limit: '2' } }), env(kv), now)).json()) as typeof all;
    expect(p1.batches.map((b) => b.key)).toEqual([keys[0], keys[1]]);
    expect(p1.cursor).toBe(keys[1]);
    expect(p1.hasMore).toBe(true);
    const p2 = (await (await handleRequest(req('GET', '/pull', { query: { limit: '2', since: p1.cursor } }), env(kv), now)).json()) as typeof all;
    expect(p2.batches.map((b) => b.key)).toEqual([keys[2], keys[3]]);
    expect(p2.hasMore).toBe(true);
    const p3 = (await (await handleRequest(req('GET', '/pull', { query: { limit: '2', since: p2.cursor } }), env(kv), now)).json()) as typeof all;
    expect(p3.batches.map((b) => b.key)).toEqual([keys[4]]);
    expect(p3.hasMore).toBe(false);
    // Nothing new: the cursor comes back unchanged.
    const none = (await (await handleRequest(req('GET', '/pull', { query: { since: keys[4] } }), env(kv), now)).json()) as typeof all;
    expect(none).toEqual({ result: 'ok', batches: [], cursor: keys[4], hasMore: false });
  });

  it('GET /status counts batches and reports the newest time; DELETE wipes only this token', async () => {
    const kv = new MemoryKV();
    const empty = (await (await handleRequest(req('GET', '/status'), env(kv), now)).json()) as { result: string; batches: number; latest: number | null };
    expect(empty).toMatchObject({ result: 'ok', batches: 0, latest: null });
    clock = Date.UTC(2026, 8, 3, 21, 0, 0);
    await handleRequest(req('POST', '/', { body: overlandBatch(['2026-09-03T20:50:00Z']) }), env(kv), now);
    clock = Date.UTC(2026, 8, 3, 21, 5, 0);
    await handleRequest(req('POST', '/', { body: overlandBatch(['2026-09-03T21:04:00Z']) }), env(kv), now);
    await handleRequest(req('POST', '/', { token: 'other-token-000', body: overlandBatch(['2026-09-03T21:04:30Z']) }), env(kv), now);
    const st = (await (await handleRequest(req('GET', '/status'), env(kv), now)).json()) as typeof empty;
    expect(st).toMatchObject({ result: 'ok', batches: 2, latest: Date.UTC(2026, 8, 3, 21, 5, 0) });
    const del = (await (await handleRequest(req('DELETE', '/'), env(kv), now)).json()) as { result: string; deleted: number };
    expect(del).toEqual({ result: 'ok', deleted: 2 });
    expect(kv.map.size).toBe(1);
    expect([...kv.map.keys()][0]).toMatch(/^other-token-000\//);
  });
});
