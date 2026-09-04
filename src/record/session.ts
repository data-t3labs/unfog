/**
 * Foreground tracking session: geolocation watch + Screen Wake Lock, fix filtering, continuous
 * persistence to localStorage (process death is normal on iOS), checkpoints every few seconds
 * and a final grid.markTrack under ONE track id so the store counts the session as a single visit.
 *
 * A checkpoint re-marks the whole session under its id; the store subtracts what the previous
 * version already counted (src/grid/store.ts), so it costs milliseconds however long the walk is.
 * Each checkpoint that changed cells is reported through `onData` so the map can re-render the
 * touched tiles live (feedback-1 item 1: the fog only redrew on Stop or a layer toggle).
 *
 * Since feedback-2 the session is passive (src/app/tracking.ts owns start/stop): it runs whenever
 * "Track my movement" is on and the app is open. A session left behind by a previous run (iOS
 * killed the app, an update reloaded it) is saved as a track at the next boot — `saveUnfinishedSession`.
 * When that save fails (IndexedDB refused, the grid worker is slow) the session is moved aside to
 * `PENDING_SESSIONS_KEY` and retried at every boot; `SESSION_KEY` always belongs to the running
 * session, and `Recorder.start()` puts aside anything it finds there rather than overwrite it.
 * The location watch pauses while the page is hidden (src/map/location.ts) and the grid breaks a
 * track on gaps > 500 m (src/grid/cell.ts), so a pause never draws a straight line.
 */
import type { ApplyResult, GridApi } from '../grid/api';
import { cellsAlong, cellToTile, cellIndex, distanceM } from '../grid/cell';
import type { Track } from '../grid/types';
import type { Fix, LocationManager } from '../map/location';
import { readJSON, removeKey, writeJSON } from '../app/settings';

export const SESSION_KEY = 'unfog.session';
/** Sessions a boot (or a Stop) could not write to the grid; retried at every boot. */
export const PENDING_SESSIONS_KEY = 'unfog.sessions.pending';
/** Pending sessions kept, newest last (localStorage is small; a day's walk is a few hundred KB). */
export const MAX_PENDING_SESSIONS = 8;
/** Checkpoint cadence: the fog follows the walk within ~5 s (plus one tile render). */
export const CHECKPOINT_MS = 5_000;
const MAX_ACCURACY_M = 50;
const MAX_SPEED_MPS = 60;

export interface SessionState {
  id: string;
  startMs: number;
  /** [lon, lat, timeMs] accepted fixes. */
  points: Array<[number, number, number]>;
  distanceM: number;
  /** Approximate count of cells first visited in this session. */
  newCells: number;
  lastCheckpointMs: number;
  /** Fixes dropped (accuracy / speed). */
  dropped: number;
}

export type RecorderStatus = 'idle' | 'recording' | 'stopping';

export interface RecorderEvents {
  onUpdate(state: SessionState, status: RecorderStatus): void;
  onWakeLock(ok: boolean, reason?: string): void;
  onFix?(fix: Fix, accepted: boolean): void;
  /** A checkpoint wrote new cells to the grid (the final markTrack on Stop is reported by the caller). */
  onData?(result: ApplyResult): void;
}

export function loadUnfinishedSession(): SessionState | null {
  const s = readJSON<SessionState | null>(SESSION_KEY, null);
  return s && Array.isArray(s.points) && s.id ? s : null;
}

export function sessionTrack(state: SessionState): Track {
  return { id: state.id, source: 'session', name: sessionName(state), points: state.points };
}

export function sessionName(state: SessionState): string {
  const d = new Date(state.startMs);
  return `Tracked ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Sessions roll over at local midnight: true when both instants fall on the same local calendar day. */
export function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function loadPendingSessions(): SessionState[] {
  const list = readJSON<unknown>(PENDING_SESSIONS_KEY, []);
  return Array.isArray(list) ? (list as SessionState[]).filter((s) => s && typeof s.id === 'string' && Array.isArray(s.points)) : [];
}

/**
 * Put a session aside for a later boot — never under SESSION_KEY, which the next `start()` owns.
 * Sessions with fewer than 2 points are nothing to keep; the list is deduped by id and capped.
 */
export function stashSession(s: SessionState): void {
  if (s.points.length < 2) return;
  const list = loadPendingSessions().filter((p) => p.id !== s.id);
  list.push(s);
  writeJSON(PENDING_SESSIONS_KEY, list.slice(-MAX_PENDING_SESSIONS));
}

/**
 * Save the session a previous run left behind (crash, iOS kill, update reload): marked under its
 * own id like a Stop would (the checkpoints already counted most of it — the store is incremental),
 * then forgotten. Sessions whose save failed at an earlier boot are retried here too; whatever
 * still fails stays pending. Returns a track that was written (the left-behind session's when
 * there was one), or null when nothing was.
 */
export async function saveUnfinishedSession(grid: GridApi): Promise<Track | null> {
  // First move the session out of SESSION_KEY: whatever happens next, a Recorder.start() must
  // not find it there and overwrite it (stash, then remove — a kill in between leaves both, and
  // the stash dedupes by id).
  const left = loadUnfinishedSession();
  if (left) stashSession(left);
  removeKey(SESSION_KEY);
  let saved: Track | null = null;
  const remaining: SessionState[] = [];
  for (const s of loadPendingSessions()) {
    const track = sessionTrack(s);
    try {
      await grid.markTrack(track);
      if (!saved || s.id === left?.id) saved = track;
    } catch (e) {
      console.warn(`[record] saving session ${s.id} failed — kept for the next boot`, e);
      remaining.push(s);
    }
  }
  if (remaining.length) writeJSON(PENDING_SESSIONS_KEY, remaining);
  else removeKey(PENDING_SESSIONS_KEY);
  return saved;
}

export class Recorder {
  state: SessionState | null = null;
  status: RecorderStatus = 'idle';
  wakeLockOk = false;
  private lock: WakeLockSentinel | null = null;
  private unsubFix: (() => void) | null = null;
  private checkpointTimer = 0;
  private sessionCells = new Set<number>();
  private tileSnapshots = new Map<string, Promise<Uint8Array | null>>();
  /** points.length the last checkpoint wrote; a checkpoint with nothing new is skipped. */
  private pointsAtCheckpoint = 0;
  private checkpointing = false;

  constructor(
    private readonly grid: GridApi,
    private readonly location: LocationManager,
    private readonly events: RecorderEvents,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status === 'recording') void this.keepAwake();
    });
  }

  /**
   * Start (or resume) a session. The first time on a device this must come from a user gesture
   * (the location prompt); once permission is granted, boot may call it too.
   */
  async start(resume?: SessionState): Promise<void> {
    if (this.status !== 'idle') return;
    // A session a previous run left behind and boot could not save (or did not try): put it
    // aside for the next boot instead of overwriting it with this one.
    const left = loadUnfinishedSession();
    if (left && left.id !== resume?.id) stashSession(left);
    this.state = resume ?? {
      id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startMs: Date.now(),
      points: [],
      distanceM: 0,
      newCells: 0,
      lastCheckpointMs: Date.now(),
      dropped: 0,
    };
    this.status = 'recording';
    this.sessionCells.clear();
    this.tileSnapshots.clear();
    this.pointsAtCheckpoint = 0; // a resumed session is re-marked once (incremental in the store)
    if (resume) for (const [cx, cy] of cellsAlong(resume.points.map((p) => [p[0], p[1]] as [number, number]))) this.sessionCells.add(cy * 4194304 + cx);
    this.persist();
    this.unsubFix = this.location.onFix((f) => this.onFix(f));
    this.location.retain('record');
    await this.keepAwake();
    this.checkpointTimer = window.setInterval(() => void this.checkpoint(), CHECKPOINT_MS);
    this.emit();
  }

  /** Stop: final markTrack (same id as the checkpoints), clear the persisted session. */
  async stop(): Promise<{ track: Track; state: SessionState } | null> {
    if (!this.state || this.status !== 'recording') return null;
    this.status = 'stopping';
    this.emit();
    this.teardown();
    const state = this.state;
    const track = sessionTrack(state);
    if (state.points.length >= 2) {
      try {
        await this.grid.markTrack(track);
      } catch (e) {
        console.warn('[record] final markTrack failed — the session is kept for the next boot', e);
        stashSession(state);
      }
    }
    removeKey(SESSION_KEY);
    this.state = null;
    this.status = 'idle';
    this.emit(state);
    return { track, state };
  }

  /** Throw the running session away without saving it. */
  discard(): void {
    this.teardown();
    removeKey(SESSION_KEY);
    this.state = null;
    this.status = 'idle';
  }

  private teardown(): void {
    this.unsubFix?.();
    this.unsubFix = null;
    this.location.release('record');
    window.clearInterval(this.checkpointTimer);
    this.checkpointTimer = 0;
    void this.lock?.release().catch(() => undefined);
    this.lock = null;
    this.wakeLockOk = false;
  }

  private async keepAwake(): Promise<void> {
    if (!('wakeLock' in navigator)) {
      this.wakeLockOk = false;
      this.events.onWakeLock(false, 'Screen Wake Lock not supported here — keep the screen on manually.');
      return;
    }
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.wakeLockOk = true;
      this.lock.addEventListener('release', () => {
        this.lock = null;
        this.wakeLockOk = false;
      });
      this.events.onWakeLock(true);
    } catch (e) {
      this.wakeLockOk = false;
      const name = (e as Error)?.name;
      this.events.onWakeLock(false, name === 'NotAllowedError' ? 'Screen may sleep (Low Power Mode?). Keep the screen on while tracking.' : 'Screen may sleep — keep the screen on while tracking.');
    }
  }

  private onFix(fix: Fix): void {
    const s = this.state;
    if (!s || this.status !== 'recording') return;
    let accepted = fix.accuracy <= MAX_ACCURACY_M;
    const last = s.points[s.points.length - 1];
    let d = 0;
    if (accepted && last) {
      d = distanceM(last[0], last[1], fix.lon, fix.lat);
      const dt = (fix.timeMs - last[2]) / 1000;
      if (dt <= 0 || d / Math.max(dt, 0.5) > MAX_SPEED_MPS) accepted = false;
      if (accepted && d < 1.5) accepted = false; // standing still: no new point, not a drop
      else if (!accepted) s.dropped++;
    } else if (!accepted) {
      s.dropped++;
    }
    this.events.onFix?.(fix, accepted);
    if (!accepted) {
      this.emit();
      return;
    }
    s.points.push([fix.lon, fix.lat, fix.timeMs]);
    if (last && d < 500) s.distanceM += d;
    if (last) this.countNewCells(last, [fix.lon, fix.lat]);
    else this.countNewCells([fix.lon, fix.lat], [fix.lon, fix.lat]);
    this.persist();
    this.emit();
  }

  /** Cells first touched this session that the grid did not have before (approximate, async). */
  private countNewCells(a: readonly [number, number, number?], b: readonly [number, number]): void {
    const s = this.state;
    if (!s) return;
    for (const [cx, cy] of cellsAlong([[a[0], a[1]], b])) {
      const key = cy * 4194304 + cx;
      if (this.sessionCells.has(key)) continue;
      this.sessionCells.add(key);
      const t = cellToTile(cx, cy);
      const id = `${t.tx}/${t.ty}`;
      let snap = this.tileSnapshots.get(id);
      if (!snap) {
        snap = this.grid.getTileCounts(14, t.tx, t.ty).catch(() => null);
        this.tileSnapshots.set(id, snap);
      }
      void snap.then((counts) => {
        if (!counts || counts[cellIndex(t.ix, t.iy)] === 0) {
          if (this.state === s) s.newCells++;
        }
      });
    }
  }

  private async checkpoint(): Promise<void> {
    const s = this.state;
    if (!s || this.status !== 'recording' || s.points.length < 2 || this.checkpointing) return;
    const n = s.points.length;
    if (n === this.pointsAtCheckpoint) return; // standing still: nothing new to write
    this.checkpointing = true;
    try {
      const result = await this.grid.markTrack(sessionTrack(s));
      this.pointsAtCheckpoint = n;
      s.lastCheckpointMs = Date.now();
      this.persist();
      // Stop may have run meanwhile (its own markTrack + the caller's dataChanged cover it).
      if (this.state === s && this.status === 'recording' && result.touched.length) this.events.onData?.(result);
    } catch (e) {
      console.warn('[record] checkpoint failed', e);
    } finally {
      this.checkpointing = false;
    }
  }

  private persist(): void {
    if (this.state) writeJSON(SESSION_KEY, this.state);
  }

  private emit(state = this.state): void {
    if (state) this.events.onUpdate(state, this.status);
  }
}
