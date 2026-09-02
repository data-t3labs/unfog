import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OVERPASS_ENDPOINT, OverpassError, fetchOverpassWays, overpassQuery, parseOverpassJson } from './overpass';

const FIXTURE = new URL('../../tests/fixtures/osm/williamsburg.json.gz', import.meta.url);
const fixtureText = () => gunzipSync(readFileSync(FIXTURE)).toString('utf8');

describe('overpassQuery', () => {
  it('orders the bbox S,W,N,E and excludes never-routable highway values', () => {
    const q = overpassQuery([-73.978, 40.703, -73.938, 40.729], 45);
    expect(q).toContain('[out:json][timeout:45];');
    expect(q).toContain('(40.703,-73.978,40.729,-73.938)');
    expect(q).toContain('way["highway"]["highway"!~"^(construction|proposed|raceway|abandoned|platform|bus_stop|elevator|corridor|services|rest_area|escape|busway)$"]');
    expect(q.endsWith('out geom;')).toBe(true);
  });
});

describe('parseOverpassJson', () => {
  it('parses the Williamsburg fixture (1,760 ways, refs aligned with coords)', () => {
    const ways = parseOverpassJson(fixtureText());
    expect(ways.length).toBe(1760);
    for (const w of ways) {
      expect(w.refs.length).toBe(w.coords.length);
      expect(w.refs.length).toBeGreaterThanOrEqual(2);
      expect(typeof w.tags.highway).toBe('string');
    }
    const szold = ways.find((w) => w.id === 5668983)!;
    expect(szold.tags.name).toBe('Szold Place');
    expect(szold.refs[0]).toBe(42421837);
    expect(szold.coords[0]).toEqual([-73.975304, 40.7265403]);
    expect(szold.refs[1]).toBeGreaterThan(2 ** 33); // 11998841138 — ids exceed uint32
  });

  it('accepts a parsed object, skips non-ways, tolerates missing tags and unresolved geometry', () => {
    const ways = parseOverpassJson({
      elements: [
        { type: 'node', id: 1, lat: 1, lon: 2 },
        { type: 'way', id: 7, nodes: [1, 2, 3], geometry: [{ lat: 40, lon: -73 }, null, { lat: 40.1, lon: -73.1 }] },
        { type: 'way', id: 8, nodes: [1], geometry: [{ lat: 40, lon: -73 }] },
        { type: 'way', id: 9, nodes: [1, 2], geometry: [{ lat: 40, lon: -73 }], tags: { highway: 'path' } },
      ],
    });
    expect(ways.map((w) => w.id)).toEqual([7]);
    expect(ways[0].tags).toEqual({});
    expect(ways[0].coords[1]).toEqual([NaN, NaN]);
    expect(ways[0].coords[2]).toEqual([-73.1, 40.1]);
  });

  it('rejects documents without elements', () => {
    expect(() => parseOverpassJson('{}')).toThrow(/elements/);
  });
});

describe('fetchOverpassWays', () => {
  const bbox: [number, number, number, number] = [-73.978, 40.703, -73.938, 40.729];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const doc = { elements: [{ type: 'way', id: 1, nodes: [1, 2], geometry: [{ lat: 40, lon: -73 }, { lat: 40.1, lon: -73 }], tags: { highway: 'residential' } }] };

  it('POSTs data=<query> as text/plain and parses the result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return ok(doc); };
    const ways = await fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [0, 0, 0] });
    expect(ways.length).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DEFAULT_OVERPASS_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(String(calls[0].init.body)).toMatch(/^data=%5Bout%3Ajson%5D/);
    expect(decodeURIComponent(String(calls[0].init.body))).toContain('(40.703,-73.978,40.729,-73.938)');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toMatch(/^text\/plain/);
  });

  it('retries 429/504 on the same endpoint with backoff, then succeeds', async () => {
    const statuses = [429, 504];
    const attempts: string[] = [];
    const fetch = async (url: string | URL | Request) => { attempts.push(String(url)); const s = statuses.shift(); return s ? new Response('busy', { status: s }) : ok(doc); };
    const seen: number[] = [];
    const ways = await fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [1, 1, 1], onAttempt: (i: { attempt: number; error?: unknown }) => { if (!i.error) seen.push(i.attempt); } });
    expect(ways.length).toBe(1);
    expect(attempts).toEqual([DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('falls through to the alternate endpoint after 3 failed attempts', async () => {
    const attempts: string[] = [];
    const fetch = async (url: string | URL | Request) => { attempts.push(String(url)); return String(url).includes('alt') ? ok(doc) : new Response('', { status: 503 }); };
    const ways = await fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [0, 0, 0], alternates: ['https://alt.example/api'] });
    expect(ways.length).toBe(1);
    expect(attempts).toEqual([DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT, 'https://alt.example/api']);
  });

  it('does not retry a non-retryable status on the same endpoint (bad query) but tries the alternate', async () => {
    const attempts: string[] = [];
    const fetch = async (url: string | URL | Request) => { attempts.push(String(url)); return new Response('parse error', { status: 400 }); };
    await expect(fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [0, 0, 0], alternates: ['https://alt.example/api'] })).rejects.toBeInstanceOf(OverpassError);
    expect(attempts).toEqual([DEFAULT_OVERPASS_ENDPOINT, 'https://alt.example/api']);
  });

  it('throws the last error when every endpoint fails', async () => {
    const fetch = async () => { throw new TypeError('network down'); };
    await expect(fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [0, 0, 0], alternates: [] })).rejects.toThrow('network down');
  });

  it('honours an AbortSignal during the backoff sleep', async () => {
    const ac = new AbortController();
    let n = 0;
    const fetch = async () => { n++; return new Response('', { status: 429 }); };
    const p = fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, retryDelaysMs: [10_000, 10_000, 10_000], signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(n).toBe(1);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController(); ac.abort();
    let n = 0;
    const fetch = async () => { n++; return ok(doc); };
    await expect(fetchOverpassWays(bbox, { fetch: fetch as typeof globalThis.fetch, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(n).toBe(0);
  });

  // A server that never answers (overpass-api.de under load holds the connection open) must not
  // hold the ladder open with it: engine.downloadArea wraps fetch with a deadline per attempt.
  it('with fetchWithDeadline: a fetch that never answers is cut at the deadline and retried; an outer abort still wins', async () => {
    const { fetchWithDeadline } = await import('./engine');
    let n = 0;
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        n++;
        if (n >= 2) return resolve(ok(doc));
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const attempts: Array<{ attempt: number; error?: unknown }> = [];
    const ways = await fetchOverpassWays(bbox, { fetch: fetchWithDeadline(20, undefined, hanging), retryDelaysMs: [0, 0, 0], alternates: [], onAttempt: (a) => attempts.push(a) });
    expect(ways).toHaveLength(1);
    expect(n).toBe(2);
    expect(attempts.find((a) => a.error)?.error).toMatchObject({ message: 'Overpass did not answer within 0 s' }); // 20 ms rounds to 0 s
    expect((attempts.find((a) => a.error)?.error as Error).name).toBe('Error'); // retryable, not an abort

    // The caller's own abort (offline) is re-thrown as that abort: no retry.
    const ac = new AbortController();
    let m = 0;
    const hangForever: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        m++;
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const p = fetchOverpassWays(bbox, { fetch: fetchWithDeadline(10_000, ac.signal, hangForever), retryDelaysMs: [0, 0, 0], alternates: [], signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(Object.assign(new Error('No internet connection'), { name: 'OfflineError' }));
    await expect(p).rejects.toMatchObject({ name: 'OfflineError' });
    expect(m).toBe(1);
  });
});
