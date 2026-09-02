/**
 * Overpass fetcher — the in-app "download this area" data path and the CLI's `--overpass` mode.
 * Pure fetch + JSON; classification is client-side (osm-rules.ts), so the query only excludes
 * highway values that can never route. Works in a Web Worker and in Node ≥ 18 (global fetch).
 */
import type { FetchOverpassWays, OsmWay, OverpassOptions } from './osm-types';

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const ALTERNATE_OVERPASS_ENDPOINTS: readonly string[] = ['https://overpass.private.coffee/api/interpreter'];
const DEFAULT_USER_AGENT = 'unfog/0.1 (+https://data-t3labs.github.io/unfog/)';
const EXCLUDED_HIGHWAYS = '^(construction|proposed|raceway|abandoned|platform|bus_stop|elevator|corridor|services|rest_area|escape|busway)$';
/** Retry sleeps after attempts 1, 2, 3 of each endpoint (research §1a: back off ≥30 s on 429). */
const DEFAULT_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Overpass QL for every candidate highway way in a bbox, geometry inline. */
export function overpassQuery(bbox: [west: number, south: number, east: number, north: number], timeoutS = 90): string {
  const [w, s, e, n] = bbox;
  return `[out:json][timeout:${Math.max(1, Math.round(timeoutS))}];way["highway"]["highway"!~"${EXCLUDED_HIGHWAYS}"](${s},${w},${n},${e});out geom;`;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number } | null>;
}

/**
 * Parse an Overpass `out geom` JSON document (string or already-parsed) into ways. Ways with fewer
 * than two resolved points are skipped; a geometry entry Overpass could not resolve becomes NaN
 * coordinates, which graph-build drops.
 */
export function parseOverpassJson(json: string | unknown): OsmWay[] {
  const doc = (typeof json === 'string' ? JSON.parse(json) : json) as { elements?: OverpassElement[] } | null;
  const elements = doc?.elements;
  if (!Array.isArray(elements)) throw new Error('Overpass JSON: missing elements[]');
  const ways: OsmWay[] = [];
  for (const el of elements) {
    if (!el || el.type !== 'way' || typeof el.id !== 'number' || !Array.isArray(el.nodes)) continue;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    const n = Math.min(el.nodes.length, geom.length);
    if (n < 2) continue;
    const refs = new Array<number>(n);
    const coords = new Array<[number, number]>(n);
    for (let i = 0; i < n; i++) {
      refs[i] = el.nodes[i];
      const g = geom[i];
      coords[i] = g && typeof g.lon === 'number' && typeof g.lat === 'number' ? [g.lon, g.lat] : [NaN, NaN];
    }
    ways.push({ id: el.id, tags: el.tags ?? {}, refs, coords });
  }
  return ways;
}

/** Extra knobs beyond the fixed OverpassOptions (tests inject zero delays and a fake fetch). */
export interface OverpassFetchOptions extends OverpassOptions {
  alternates?: readonly string[];
  retryDelaysMs?: readonly number[];
  fetch?: typeof fetch;
  onAttempt?: (info: { endpoint: string; attempt: number; error?: unknown }) => void;
}

export class OverpassError extends Error {
  constructor(message: string, readonly status?: number, readonly endpoint?: string) {
    super(message);
    this.name = 'OverpassError';
  }
}

/**
 * POST the query, parse ways. Retries 429/502/503/504 and network errors with backoff
 * (3 attempts per endpoint), then falls through to the alternate endpoints. Honours `signal`.
 */
export const fetchOverpassWays = async (
  bbox: [west: number, south: number, east: number, north: number],
  opts: OverpassFetchOptions = {},
): Promise<OsmWay[]> => {
  const endpoints = [opts.endpoint ?? DEFAULT_OVERPASS_ENDPOINT, ...(opts.alternates ?? ALTERNATE_OVERPASS_ENDPOINTS)];
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutS = opts.timeoutS ?? 90;
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox, timeoutS));
  const signal = opts.signal;
  let lastError: unknown;

  for (const endpoint of endpoints) {
    for (let attempt = 1; attempt <= delays.length; attempt++) {
      throwIfAborted(signal);
      opts.onAttempt?.({ endpoint, attempt });
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          body,
          // text/plain keeps the browser request preflight-free (research §1a). Node ignores User-Agent restrictions.
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(isBrowser() ? {} : { 'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT }) },
          signal,
        });
        if (RETRYABLE_STATUS.has(res.status)) throw new OverpassError(`Overpass ${res.status} from ${endpoint}`, res.status, endpoint);
        if (!res.ok) throw new OverpassError(`Overpass ${res.status} from ${endpoint}: ${(await safeText(res)).slice(0, 200)}`, res.status, endpoint);
        const text = await res.text();
        return parseOverpassJson(text);
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        lastError = err;
        opts.onAttempt?.({ endpoint, attempt, error: err });
        // Non-retryable HTTP status (400 bad query, 404 …): don't hammer the same endpoint again.
        if (err instanceof OverpassError && err.status !== undefined && !RETRYABLE_STATUS.has(err.status)) break;
        // Retryable: sleep, then retry (the last sleep precedes the switch to the next endpoint).
        await sleep(delays[attempt - 1] ?? 0, signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new OverpassError(`Overpass failed: ${String(lastError)}`);
};

// Compile-time check that the implementation satisfies the fixed contract in osm-types.ts.
const _contract: FetchOverpassWays = fetchOverpassWays;
void _contract;

function isBrowser(): boolean {
  return typeof (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'string' && typeof (globalThis as { process?: unknown }).process === 'undefined';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMExceptionCompat('The operation was aborted.');
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) { throwIfAborted(signal); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(t); reject(signal?.reason instanceof Error ? signal.reason : new DOMExceptionCompat('The operation was aborted.')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** AbortError with the DOM name, without relying on DOMException being present (old Node). */
class DOMExceptionCompat extends Error {
  constructor(message: string) { super(message); this.name = 'AbortError'; }
}
