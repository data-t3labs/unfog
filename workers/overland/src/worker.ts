/**
 * Unfog Overland receiver — a Cloudflare Worker + KV (free tier) that accepts the batches the
 * Overland iOS app POSTs and hands them to the Unfog app when it asks.
 *
 * Overland (https://github.com/aaronpk/Overland-iOS): POST {"locations": [GeoJSON Feature …],
 * "current": …, "trip": …} with `Authorization: Bearer <token>`; the batch is deleted on the
 * phone only when the reply body is exactly {"result":"ok"}, otherwise it is kept and re-sent.
 *
 * Routes (bearer token per user, `Authorization: Bearer <token>` — Overland sends it that way;
 * a token in the URL would land in request logs, so `?token=` is not accepted):
 *   POST   /            store one batch under `<token>/<epochMs13>-<seq5>` (30-day TTL) → {"result":"ok"}
 *   GET    /pull?since=<cursor>&limit=<n>   batches after the cursor, oldest first, at most 25:
 *                       {result:"ok", batches:[{key, received, points:[{t, lon, lat, acc?, speed?}]}], cursor, hasMore}
 *                       `key` and `cursor` are the `<epochMs13>-<seq5>` part only — never the token,
 *                       because the cursor travels in the next pull's URL (an old `<token>/…` cursor
 *                       is still accepted).
 *   GET    /status      {result:"ok", batches:<count>, latest:<epochMs|null>}  (the app's "Test")
 *   DELETE /            delete up to 40 of the token's batches → {result:"ok", deleted:<n>, more:<bool>};
 *                       repeat while `more`
 *   GET    /            plain-text banner (no auth) so a deploy can be checked in a browser
 * CORS: only the app origin(s) in APP_ORIGIN (comma-separated; default the GitHub Pages site).
 * Free-tier arithmetic: KV allows 1 000 writes/day — one per batch — so Overland's Send Interval
 * should be 5 min or longer; reads (100 000/day) and list calls cover many pulls a day. Every KV
 * call is a subrequest and the Free plan allows 50 per invocation: a pull is ≤ MAX_LIST_PAGES list
 * calls + PULL_MAX_LIMIT gets (45), a DELETE ≤ 1 list + DELETE_CHUNK deletes (41).
 *
 * No Cloudflare type package: the KV surface used here is declared structurally so the handlers
 * unit-test with a plain in-memory double (tests/unit/overland-worker.test.ts).
 */

export interface KvListKey {
  name: string;
  expiration?: number;
}
export interface KvListResult {
  keys: KvListKey[];
  list_complete: boolean;
  cursor?: string;
}
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>;
}

export interface Env {
  OVERLAND_KV: KvLike;
  /** Allowed bearer tokens, comma/space separated (a Worker secret). */
  OVERLAND_TOKENS?: string;
  /** Allowed browser origins, comma separated. */
  APP_ORIGIN?: string;
  /** Batch retention in days (default 30). */
  BATCH_TTL_DAYS?: string;
}

export interface CompactPoint {
  t: number;
  lon: number;
  lat: number;
  acc?: number;
  speed?: number;
}

export interface StoredBatch {
  v: 1;
  received: number;
  device: string;
  points: CompactPoint[];
}

export const DEFAULT_APP_ORIGIN = 'https://data-t3labs.github.io';
export const DEFAULT_TTL_DAYS = 30;
/**
 * KV calls per invocation (Cloudflare Free plan: 50 subrequests, KV calls included). A pull
 * lists up to MAX_LIST_PAGES pages (a full 30-day backlog is ~9 pages of 1 000) and gets one
 * value per batch on the page; the two must stay under the plan's 50 together.
 */
export const PULL_DEFAULT_LIMIT = 25;
export const PULL_MAX_LIMIT = 25;
/** Batches deleted per DELETE call (1 list + DELETE_CHUNK deletes ≤ 50). */
export const DELETE_CHUNK = 40;
const LIST_PAGE = 1000;
const MAX_LIST_PAGES = 20;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const OK = '{"result":"ok"}';

let seq = Math.floor(Math.random() * 100_000);

/** The `<epochMs13>-<seq5>` part of a batch key: what `/pull` hands out as `key` / `cursor`. */
export function batchSuffix(epochMs: number, n: number): string {
  return `${String(Math.max(0, Math.floor(epochMs))).padStart(13, '0')}-${String(n % 100_000).padStart(5, '0')}`;
}

export function batchKey(token: string, epochMs: number, n: number): string {
  return `${token}/${batchSuffix(epochMs, n)}`;
}

/** The epoch ms encoded in a batch key or cursor (null when it is not ours). */
export function keyEpoch(key: string): number | null {
  const m = /(?:^|\/)(\d{13})-\d{5}$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** A pull cursor without the token: new clients send `<epoch>-<seq>`, older ones the full key. */
export function cursorSuffix(since: string, prefix: string): string {
  return since.startsWith(prefix) ? since.slice(prefix.length) : since;
}

/** Overland's GeoJSON batch → compact points (sorted by time); counts what was unusable. */
export function compactBatch(body: unknown): { points: CompactPoint[]; dropped: number; device: string } {
  const points: CompactPoint[] = [];
  let dropped = 0;
  let device = '';
  const locations = (body as { locations?: unknown })?.locations;
  if (!Array.isArray(locations)) return { points, dropped, device };
  for (const f of locations as Array<Record<string, unknown>>) {
    const geom = f?.geometry as { type?: string; coordinates?: unknown } | undefined;
    const props = (f?.properties ?? {}) as Record<string, unknown>;
    const coords = geom?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      dropped++;
      continue;
    }
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    const t = typeof props.timestamp === 'number' ? props.timestamp : Date.parse(String(props.timestamp ?? ''));
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(t) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      dropped++;
      continue;
    }
    const p: CompactPoint = { t, lon, lat };
    const acc = Number(props.horizontal_accuracy);
    if (Number.isFinite(acc) && acc >= 0) p.acc = acc;
    const speed = Number(props.speed);
    if (Number.isFinite(speed) && speed >= 0) p.speed = speed;
    if (!device && typeof props.device_id === 'string' && props.device_id) device = props.device_id.slice(0, 64);
    points.push(p);
  }
  points.sort((a, b) => a.t - b.t);
  return { points, dropped, device };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

function allowedOrigins(env: Env): string[] {
  return (env.APP_ORIGIN ?? DEFAULT_APP_ORIGIN)
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** CORS headers for an allowed browser origin; empty for non-browser callers (Overland) and strangers. */
export function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function allowedTokens(env: Env): string[] {
  return (env.OVERLAND_TOKENS ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => TOKEN_RE.test(s));
}

/** The bearer token of a request (the Authorization header only — a URL parameter would be logged), or null. */
export function requestToken(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The authenticated token, or a Response to send instead. */
function authenticate(req: Request, env: Env, cors: Record<string, string>): string | Response {
  const allowed = allowedTokens(env);
  if (allowed.length === 0) return json({ result: 'error', error: 'receiver has no tokens configured (wrangler secret put OVERLAND_TOKENS)' }, 503, cors);
  const token = requestToken(req);
  if (!token || !TOKEN_RE.test(token)) return json({ result: 'error', error: 'unauthorized' }, 401, cors);
  for (const t of allowed) if (constantTimeEqual(t, token)) return token;
  return json({ result: 'error', error: 'unauthorized' }, 401, cors);
}

/** Every key of a token, oldest first (batch keys sort chronologically), capped at MAX_LIST_PAGES pages. */
async function listKeys(kv: KvLike, prefix: string, stopAfter?: (names: string[]) => boolean): Promise<{ names: string[]; truncated: boolean }> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const r = await kv.list({ prefix, limit: LIST_PAGE, cursor });
    for (const k of r.keys) names.push(k.name);
    if (stopAfter?.(names)) return { names, truncated: !r.list_complete };
    if (r.list_complete || !r.cursor) return { names, truncated: false };
    cursor = r.cursor;
  }
  return { names, truncated: true };
}

export async function handleRequest(req: Request, env: Env, now: () => number = () => Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(req, env);

  if (req.method === 'OPTIONS') {
    if (req.headers.get('Origin') && Object.keys(cors).length === 0) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method === 'GET' && path === '/') {
    return new Response('Unfog Overland receiver. Overland POSTs batches here; the Unfog app pulls them from /pull.\n', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
  }

  const kv = env.OVERLAND_KV;
  if (!kv) return json({ result: 'error', error: 'KV binding OVERLAND_KV missing' }, 500, cors);

  if (req.method === 'POST' && (path === '/' || path === '/overland')) {
    const auth = authenticate(req, env, cors);
    if (auth instanceof Response) return auth;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ result: 'error', error: 'body is not JSON' }, 400, cors);
    }
    const { points, dropped, device } = compactBatch(body);
    if (points.length > 0) {
      const ttlDays = Number(env.BATCH_TTL_DAYS);
      const ttl = Math.max(60, Math.round((Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS) * 86_400));
      const stored: StoredBatch = { v: 1, received: now(), device, points };
      await kv.put(batchKey(auth, now(), seq++), JSON.stringify(stored), { expirationTtl: ttl });
    }
    // Exactly what Overland waits for; extra fields are fine for Overland but the app's Test
    // reads /status, so keep this body minimal and stable.
    return new Response(OK, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Points': String(points.length), 'X-Dropped': String(dropped), ...cors } });
  }

  if (req.method === 'GET' && path === '/pull') {
    const auth = authenticate(req, env, cors);
    if (auth instanceof Response) return auth;
    const prefix = `${auth}/`;
    const since = cursorSuffix(url.searchParams.get('since') ?? '', prefix);
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(PULL_MAX_LIMIT, Math.floor(limitRaw)) : PULL_DEFAULT_LIMIT;
    // Keys sort chronologically within the prefix, so comparing suffixes is comparing keys.
    const isAfter = (name: string): boolean => name.slice(prefix.length) > since;
    const { names, truncated } = await listKeys(kv, prefix, (all) => all.filter(isAfter).length > limit);
    const after = names.filter(isAfter);
    const page = after.slice(0, limit);
    const hasMore = after.length > limit || truncated;
    const batches: Array<{ key: string; received: number; points: CompactPoint[] }> = [];
    for (const name of page) {
      const raw = await kv.get(name);
      if (!raw) continue; // expired between list and get
      try {
        const b = JSON.parse(raw) as StoredBatch;
        batches.push({ key: name.slice(prefix.length), received: b.received, points: Array.isArray(b.points) ? b.points : [] });
      } catch {
        /* skip a corrupt value */
      }
    }
    const cursor = page.length ? page[page.length - 1].slice(prefix.length) : since;
    return json({ result: 'ok', batches, cursor, hasMore }, 200, cors);
  }

  if (req.method === 'GET' && path === '/status') {
    const auth = authenticate(req, env, cors);
    if (auth instanceof Response) return auth;
    const { names, truncated } = await listKeys(kv, `${auth}/`);
    const latest = names.length ? keyEpoch(names[names.length - 1]) : null;
    return json({ result: 'ok', batches: names.length, latest, more: truncated }, 200, cors);
  }

  if (req.method === 'DELETE' && (path === '/' || path === '/overland')) {
    const auth = authenticate(req, env, cors);
    if (auth instanceof Response) return auth;
    // One chunk per call (the KV budget); the caller repeats while `more`.
    const { names, truncated } = await listKeys(kv, `${auth}/`, (all) => all.length >= DELETE_CHUNK);
    const chunk = names.slice(0, DELETE_CHUNK);
    for (const key of chunk) await kv.delete(key);
    return json({ result: 'ok', deleted: chunk.length, more: names.length > chunk.length || truncated }, 200, cors);
  }

  return json({ result: 'error', error: 'not found' }, 404, cors);
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
};
