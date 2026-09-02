/**
 * Foreground recording session: geolocation watch + Screen Wake Lock, fix filtering, continuous
 * persistence to localStorage (process death is normal on iOS), 60-s checkpoints and a final
 * grid.markTrack under ONE track id so the store counts the session as a single visit.
 */
import type { GridApi } from '../grid/api';
import { cellsAlong, cellToTile, cellIndex, distanceM } from '../grid/cell';
import type { Track } from '../grid/types';
import type { Fix, LocationManager } from '../map/location';
import { readJSON, removeKey, writeJSON } from '../app/settings';

export const SESSION_KEY = 'unfog.session';
const CHECKPOINT_MS = 60_000;
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
  /** Fixes dropped (accuracy / speed) — shown in the summary as an honesty signal. */
  dropped: number;
}

export type RecorderStatus = 'idle' | 'recording' | 'stopping';

export interface RecorderEvents {
  onUpdate(state: SessionState, status: RecorderStatus): void;
  onWakeLock(ok: boolean, reason?: string): void;
  onFix?(fix: Fix, accepted: boolean): void;
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
  return `Walk ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export class Recorder {
  state: SessionState | null = null;
  status: RecorderStatus = 'idle';
  wakeLockOk = false;
  private lock: WakeLockSentinel | null = null;
  private unsubFix: (() => void) | null = null;
  private checkpointTimer = 0;
  private tickTimer = 0;
  private sessionCells = new Set<number>();
  private tileSnapshots = new Map<string, Promise<Uint8Array | null>>();

  constructor(
    private readonly grid: GridApi,
    private readonly location: LocationManager,
    private readonly events: RecorderEvents,
  ) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status === 'recording') void this.keepAwake();
    });
  }

  /** Start (or resume) a session. Call from a user gesture. */
  async start(resume?: SessionState): Promise<void> {
    if (this.status !== 'idle') return;
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
    if (resume) for (const [cx, cy] of cellsAlong(resume.points.map((p) => [p[0], p[1]] as [number, number]))) this.sessionCells.add(cy * 4194304 + cx);
    this.persist();
    this.unsubFix = this.location.onFix((f) => this.onFix(f));
    this.location.retain('record');
    await this.keepAwake();
    this.checkpointTimer = window.setInterval(() => void this.checkpoint(), CHECKPOINT_MS);
    this.tickTimer = window.setInterval(() => this.emit(), 1000);
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
        console.warn('[record] final markTrack failed', e);
      }
    }
    removeKey(SESSION_KEY);
    this.state = null;
    this.status = 'idle';
    this.emit(state);
    return { track, state };
  }

  /** Throw the session away (asked from the resume dialog). */
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
    window.clearInterval(this.tickTimer);
    this.checkpointTimer = 0;
    this.tickTimer = 0;
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
      this.events.onWakeLock(false, name === 'NotAllowedError' ? 'Screen may sleep (Low Power Mode?). Keep the screen on while recording.' : 'Screen may sleep — keep the screen on while recording.');
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
    if (!s || this.status !== 'recording' || s.points.length < 2) return;
    try {
      await this.grid.markTrack(sessionTrack(s));
      s.lastCheckpointMs = Date.now();
      this.persist();
    } catch (e) {
      console.warn('[record] checkpoint failed', e);
    }
  }

  private persist(): void {
    if (this.state) writeJSON(SESSION_KEY, this.state);
  }

  private emit(state = this.state): void {
    if (state) this.events.onUpdate(state, this.status);
  }
}
