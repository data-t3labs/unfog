/**
 * Overland — path B of "always recording". The free Overland iOS app logs location in the
 * background and POSTs GeoJSON batches to a receiver (workers/overland: a Cloudflare Worker +
 * KV that keeps 30 days of batches per token). Unfog pulls the batches after its cursor with
 * `GET <receiver>/pull?since=<cursor>` and folds the points into tracks.
 *
 * Tracks: one per local calendar day (`overland-YYYYMMDD`), like the Google Timeline importer's
 * "one visit per day". A pull merges its points into the day's stored track (sorted, deduped by
 * time) and re-marks it under the same id — the store only counts the cells the previous
 * version had not touched (src/grid/store.ts), so re-pulling a batch, a page or a whole month
 * never double counts, and a batch that arrives late simply joins its day. Fixes worse than 50 m
 * are dropped (the recorder's rule, src/record/session.ts); jumps over 500 m are never joined
 * (the grid's rasteriser breaks there). A gap in time inside a day is not split on its own: a
 * 30-minute pause without moving 500 m draws nothing new either way.
 *
 * The cursor is saved after each page is on the map, so a pull that dies midway repeats one
 * page at most (idempotent).
 */
import type { GridApi } from '../grid/api';
import type { Track } from '../grid/types';
import { dayKey, dayLabel } from '../import/util';
import { SyncError, type PullResult, type SyncReason, type SyncSource } from './scheduler';
import { localKV, type KeyValue } from './state';

export const OVERLAND_KEY = 'unfog.overland';
export const OVERLAND_SOURCE = 'overland';
/** Fixes worse than this are dropped (matches src/record/session.ts MAX_ACCURACY_M). */
export const OVERLAND_MAX_ACCURACY_M = 50;
/** Batches per pull page. */
const PAGE_LIMIT = 100;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** A compact point as the receiver serves it. */
export interface OverlandPoint {
  /** Epoch ms. */
  t: number;
  lon: number;
  lat: number;
  /** Horizontal accuracy, metres. */
  acc?: number;
  /** m/s. */
  speed?: number;
}

export interface OverlandBatch {
  key: string;
  points: OverlandPoint[];
}

export interface OverlandPullPage {
  result: 'ok';
  batches: OverlandBatch[];
  cursor: string;
  hasMore: boolean;
}

export interface OverlandStatus {
  result: 'ok';
  batches: number;
  /** Epoch ms of the newest batch, or null. */
  latest: number | null;
}

export interface OverlandPull {
  at: number;
  batches: number;
  points: number;
  /** Day tracks touched. */
  tracks: number;
}

export interface OverlandState {
  url: string;
  token: string;
  cursor: string | null;
  lastPull: OverlandPull | null;
  totalBatches: number;
  totalPoints: number;
  lastTest: { at: number; ok: boolean; message: string } | null;
}

const DEFAULT_STATE: OverlandState = { url: '', token: '', cursor: null, lastPull: null, totalBatches: 0, totalPoints: 0, lastTest: null };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Normalise a receiver URL: https (http only for localhost), no trailing slash, no query. */
export function normalizeReceiverUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new Error('That is not a valid URL');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The receiver URL must start with https://');
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

export function validToken(token: string): boolean {
  return TOKEN_RE.test(token.trim());
}

/** Show a token as `abcd…wxyz` (never the whole thing). */
export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export const overlandDayId = (t: number): string => `overland-${dayKey(t, 'local')}`;

/**
 * Merge points into per-day tracks. `existing` supplies the stored track for a day (so the
 * result is the full day, not just this page); points with poor accuracy are dropped, the rest
 * sorted by time and deduplicated on it. Returns the day tracks that received at least one new
 * point, plus the counts.
 */
export function mergeIntoDayTracks(points: OverlandPoint[], existing: Map<string, Track | null>): { tracks: Track[]; kept: number; dropped: number } {
  const byDay = new Map<string, OverlandPoint[]>();
  let dropped = 0;
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) {
      dropped++;
      continue;
    }
    if (p.acc !== undefined && Number.isFinite(p.acc) && p.acc > OVERLAND_MAX_ACCURACY_M) {
      dropped++;
      continue;
    }
    const id = overlandDayId(p.t);
    let list = byDay.get(id);
    if (!list) byDay.set(id, (list = []));
    list.push(p);
  }
  const tracks: Track[] = [];
  let kept = 0;
  for (const [id, list] of byDay) {
    const prev = existing.get(id) ?? null;
    const have = new Map<number, [number, number, number]>();
    if (prev) for (const pt of prev.points) if (pt[2] !== undefined) have.set(pt[2], [pt[0], pt[1], pt[2]]);
    let added = 0;
    for (const p of list) {
      if (have.has(p.t)) continue;
      have.set(p.t, [p.lon, p.lat, p.t]);
      added++;
    }
    if (added === 0) continue;
    kept += added;
    const merged = [...have.values()].sort((a, b) => a[2] - b[2]);
    const track: Track = { id, source: OVERLAND_SOURCE, name: `Overland ${dayLabel(merged[0][2], 'local')}`, points: merged };
    tracks.push(track);
  }
  return { tracks, kept, dropped };
}

export interface OverlandDeps {
  grid: GridApi;
  store?: KeyValue;
  fetchFn?: FetchFn;
  now?: () => number;
}

export class OverlandSource implements SyncSource {
  readonly id = OVERLAND_SOURCE;
  private readonly grid: GridApi;
  private readonly store: KeyValue;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(deps: OverlandDeps) {
    this.grid = deps.grid;
    this.store = deps.store ?? localKV;
    this.fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
  }

  state(): OverlandState {
    return { ...DEFAULT_STATE, ...this.store.read<Partial<OverlandState>>(OVERLAND_KEY, {}) };
  }

  private patch(p: Partial<OverlandState>): OverlandState {
    const next = { ...this.state(), ...p };
    this.store.write(OVERLAND_KEY, next);
    return next;
  }

  configured(): boolean {
    const s = this.state();
    return s.url !== '' && validToken(s.token);
  }

  ready(): boolean {
    return this.configured();
  }

  /** Save the receiver URL + token (validated; throws a readable message). A new receiver/token resets the cursor. */
  configure(url: string, token: string): OverlandState {
    const u = normalizeReceiverUrl(url);
    const t = token.trim();
    if (!u) throw new Error('Enter the receiver URL');
    if (!validToken(t)) throw new Error('The token must be 8–128 letters, digits, - or _');
    const s = this.state();
    const changed = s.url !== u || s.token !== t;
    return this.patch({ url: u, token: t, cursor: changed ? null : s.cursor, lastTest: changed ? null : s.lastTest });
  }

  /** Forget the receiver, the token and the cursor (tracks already on the map stay). */
  forget(): void {
    this.store.remove(OVERLAND_KEY);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const s = this.state();
    let res: Response;
    try {
      res = await this.fetchFn(`${s.url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${s.token}` } });
    } catch (e) {
      throw new SyncError(`Could not reach the receiver (${(e as Error)?.message ?? e})`, true);
    }
    if (res.status === 401 || res.status === 403) throw new SyncError('The receiver rejected the token — check it matches the receiver’s OVERLAND_TOKENS', false);
    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After'));
      throw new SyncError('The receiver is rate limiting — retrying later', true, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000);
    }
    if (res.status >= 500) throw new SyncError(`The receiver is having trouble (HTTP ${res.status})`, true);
    if (!res.ok) throw new SyncError(`The receiver answered HTTP ${res.status} — is the URL the Worker’s address?`, false);
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch {
      throw new SyncError('The receiver did not answer with JSON — is the URL the Worker’s address?', false);
    }
    return body;
  }

  /** "Test": the receiver's status line for the UI (also recorded in the state). */
  async test(): Promise<{ ok: boolean; message: string; status?: OverlandStatus }> {
    if (!this.configured()) return { ok: false, message: 'Enter the receiver URL and token first' };
    let out: { ok: boolean; message: string; status?: OverlandStatus };
    try {
      const st = await this.request<OverlandStatus>('/status');
      if (st.result !== 'ok') throw new SyncError('Unexpected reply from the receiver', false);
      const n = st.batches;
      const message = n === 0 ? 'Receiver OK — no batches yet. Check Overland is sending (Tracking Enabled, and walk a little).' : `Receiver OK — ${n} batch${n === 1 ? '' : 'es'} stored${st.latest ? `, latest ${describeAge(this.now() - st.latest)}` : ''}`;
      out = { ok: true, message, status: st };
    } catch (e) {
      out = { ok: false, message: (e as Error)?.message ?? String(e) };
    }
    this.patch({ lastTest: { at: this.now(), ok: out.ok, message: out.message } });
    return out;
  }

  async pull(_reason: SyncReason, progress: (m: string) => void): Promise<PullResult> {
    if (!this.configured()) throw new SyncError('Overland is not set up yet', false);
    let batches = 0;
    let points = 0;
    let dropped = 0;
    const touched = new Set<string>();
    for (let page = 0; ; page++) {
      const s = this.state();
      const q = new URLSearchParams({ since: s.cursor ?? '', limit: String(PAGE_LIMIT) });
      progress(page === 0 ? 'Checking the receiver…' : `Fetching batches… (${batches})`);
      const res = await this.request<OverlandPullPage>(`/pull?${q.toString()}`);
      if (res.result !== 'ok' || !Array.isArray(res.batches)) throw new SyncError('Unexpected reply from the receiver', false);
      if (res.batches.length > 0) {
        const raw: OverlandPoint[] = [];
        for (const b of res.batches) if (Array.isArray(b.points)) raw.push(...b.points);
        const ids = new Set(raw.filter((p) => Number.isFinite(p.t)).map((p) => overlandDayId(p.t)));
        const existing = new Map<string, Track | null>();
        for (const id of ids) existing.set(id, await this.grid.getTrack(id).catch(() => null));
        const merged = mergeIntoDayTracks(raw, existing);
        progress(`Adding ${merged.kept} point${merged.kept === 1 ? '' : 's'} to the map…`);
        for (const t of merged.tracks) {
          await this.grid.markTrack(t);
          touched.add(t.id);
        }
        batches += res.batches.length;
        points += merged.kept;
        dropped += merged.dropped;
      }
      if (typeof res.cursor === 'string' && res.cursor !== '') this.patch({ cursor: res.cursor });
      if (!res.hasMore) break;
      if (page > 200) throw new SyncError('The receiver keeps saying there is more — giving up for now', true);
    }
    const s = this.state();
    this.patch({ lastPull: { at: this.now(), batches, points, tracks: touched.size }, totalBatches: s.totalBatches + batches, totalPoints: s.totalPoints + points });
    const out: PullResult = { added: points, items: batches };
    if (dropped > 0) out.note = `${dropped} fix${dropped === 1 ? '' : 'es'} skipped (accuracy worse than ${OVERLAND_MAX_ACCURACY_M} m)`;
    return out;
  }
}

/** "just now" / "3 min ago" / "2 h ago" / "4 days ago" for a positive age in ms. */
export function describeAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
