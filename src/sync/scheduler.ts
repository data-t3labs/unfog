/**
 * SyncScheduler — runs the "always recording" sources (Fog of World via Dropbox, Overland) at
 * the moments a web app can act: when the app opens, after a tracking rollover (midnight), when
 * the app comes back on screen or online, and every 15 minutes while it stays open and online.
 * iOS gives a web app no background time, so nothing here runs while the app is closed; the
 * Help screen says so.
 *
 * One run per source at a time; a trigger during a run queues one follow-up run. Failures back
 * off per source: `Retry-After` when the server sent one, else 1 min doubling to 1 h. A manual
 * "Pull now" ignores the backoff and the visibility gate.
 */

export type SyncReason = 'open' | 'interval' | 'rollover' | 'online' | 'visible' | 'manual';

export interface PullResult {
  /** Cells (Fog of World) or points (Overland) added to the map by this pull. */
  added: number;
  /** Files (tiles) or batches processed. */
  items: number;
  note?: string;
}

/** A source failure. `retryable` = try again after a delay (network, 429, 5xx); else wait for the next trigger. */
export class SyncError extends Error {
  override name = 'SyncError';
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface SyncSource {
  readonly id: string;
  /** Configured and connected — the scheduler skips sources that are not. */
  ready(): boolean;
  pull(reason: SyncReason, progress: (message: string) => void): Promise<PullResult>;
}

export interface SourceStatus {
  id: string;
  running: boolean;
  /** Last message the running pull reported ('' when idle). */
  progress: string;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastResult: PullResult | null;
  lastError: string | null;
  /** Scheduled ticks skip the source until this instant (backoff); manual runs ignore it. */
  nextRetryAt: number | null;
  failures: number;
}

export interface SchedulerOptions {
  /** Periodic tick while visible + online. Default 15 min. */
  intervalMs?: number;
  /** First backoff delay after a failure. Default 60 s. */
  baseBackoffMs?: number;
  /** Backoff cap. Default 1 h. */
  maxBackoffMs?: number;
  now?: () => number;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  /** Event target for visibilitychange / online / rollover; default document + window when present. */
  events?: { document?: EventTarget | null; window?: EventTarget | null };
}

export const DEFAULT_SYNC_INTERVAL_MS = 15 * 60_000;
export const ROLLOVER_EVENT = 'unfog:rollover';

const DEFAULTS = { intervalMs: DEFAULT_SYNC_INTERVAL_MS, baseBackoffMs: 60_000, maxBackoffMs: 3_600_000 };

interface Slot {
  source: SyncSource;
  status: SourceStatus;
  queued: SyncReason | null;
}

type Listener = (status: SourceStatus) => void;

export class SyncScheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<Listener>();
  private readonly opts: Required<Pick<SchedulerOptions, 'intervalMs' | 'baseBackoffMs' | 'maxBackoffMs'>> & { now: () => number; isVisible: () => boolean; isOnline: () => boolean };
  private readonly targets: { document: EventTarget | null; window: EventTarget | null };
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly onVisible = () => {
    if (!this.opts.isVisible()) return;
    void this.kick('visible');
  };
  private readonly onOnline = () => void this.kick('online');
  private readonly onRollover = () => void this.kick('rollover');

  constructor(options: SchedulerOptions = {}) {
    this.opts = {
      intervalMs: options.intervalMs ?? DEFAULTS.intervalMs,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      now: options.now ?? (() => Date.now()),
      isVisible: options.isVisible ?? (() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible')),
      isOnline: options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false)),
    };
    this.targets = {
      document: options.events?.document !== undefined ? options.events.document : typeof document === 'undefined' ? null : document,
      window: options.events?.window !== undefined ? options.events.window : typeof window === 'undefined' ? null : window,
    };
  }

  register(source: SyncSource): void {
    if (this.slots.has(source.id)) throw new Error(`sync source ${source.id} registered twice`);
    this.slots.set(source.id, {
      source,
      queued: null,
      status: { id: source.id, running: false, progress: '', lastRunAt: null, lastOkAt: null, lastResult: null, lastError: null, nextRetryAt: null, failures: 0 },
    });
  }

  sources(): SyncSource[] {
    return [...this.slots.values()].map((s) => s.source);
  }

  status(id: string): SourceStatus {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`unknown sync source ${id}`);
    return { ...slot.status };
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Boot: pull every ready source now, then keep the interval + event triggers armed. */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    this.timer = setInterval(() => void this.kick('interval'), this.opts.intervalMs);
    this.targets.document?.addEventListener('visibilitychange', this.onVisible);
    this.targets.window?.addEventListener('online', this.onOnline);
    this.targets.window?.addEventListener(ROLLOVER_EVENT, this.onRollover);
    return this.kick('open');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets.document?.removeEventListener('visibilitychange', this.onVisible);
    this.targets.window?.removeEventListener('online', this.onOnline);
    this.targets.window?.removeEventListener(ROLLOVER_EVENT, this.onRollover);
  }

  /**
   * Run one source (or all) for `reason`. Scheduled reasons respect the visibility/online gate,
   * the backoff and — for 'visible' — the interval since the last run; 'manual' runs regardless.
   * Resolves when the runs (and any queued follow-ups) are done; never rejects — failures land
   * in the status.
   */
  async kick(reason: SyncReason, sourceId?: string): Promise<void> {
    const slots = sourceId ? [this.slots.get(sourceId)].filter((s): s is Slot => Boolean(s)) : [...this.slots.values()];
    await Promise.all(slots.map((slot) => this.run(slot, reason)));
  }

  private shouldRun(slot: Slot, reason: SyncReason): boolean {
    if (!slot.source.ready()) return false;
    if (reason === 'manual') return true;
    if (!this.opts.isVisible() || !this.opts.isOnline()) return false;
    const now = this.opts.now();
    if (slot.status.nextRetryAt !== null && now < slot.status.nextRetryAt) return false;
    if (reason === 'visible' && slot.status.lastRunAt !== null && now - slot.status.lastRunAt < this.opts.intervalMs) return false;
    return true;
  }

  private async run(slot: Slot, reason: SyncReason): Promise<void> {
    if (!this.shouldRun(slot, reason)) return;
    if (slot.status.running) {
      // Coalesce: one follow-up run after the current one, keeping the stronger reason.
      if (reason === 'manual' || slot.queued === null) slot.queued = reason;
      return;
    }
    const st = slot.status;
    st.running = true;
    st.progress = '';
    st.lastRunAt = this.opts.now();
    this.emit(slot);
    try {
      const result = await slot.source.pull(reason, (message) => {
        st.progress = message;
        this.emit(slot);
      });
      st.lastResult = result;
      st.lastOkAt = this.opts.now();
      st.lastError = null;
      st.nextRetryAt = null;
      st.failures = 0;
    } catch (e) {
      st.failures++;
      const err = e as Partial<SyncError> & { message?: string };
      st.lastError = err?.message ? String(err.message) : String(e);
      const retryable = err instanceof SyncError ? err.retryable : false;
      const backoff = retryable ? Math.min(this.opts.baseBackoffMs * 2 ** (st.failures - 1), this.opts.maxBackoffMs) : this.opts.maxBackoffMs;
      st.nextRetryAt = this.opts.now() + Math.max(backoff, err instanceof SyncError && err.retryAfterMs ? err.retryAfterMs : 0);
    } finally {
      st.running = false;
      st.progress = '';
      this.emit(slot);
    }
    const queued = slot.queued;
    slot.queued = null;
    if (queued) await this.run(slot, queued);
  }

  private emit(slot: Slot): void {
    const snapshot = { ...slot.status };
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch (e) {
        console.warn('[sync] listener failed', e);
      }
    }
  }
}
