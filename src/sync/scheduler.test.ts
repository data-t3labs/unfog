import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLLOVER_EVENT, SyncError, SyncScheduler, type PullResult, type SyncReason, type SyncSource } from './scheduler';

interface FakeSource extends SyncSource {
  calls: SyncReason[];
  next: () => Promise<PullResult>;
  isReady: boolean;
}

function source(id: string, next?: () => Promise<PullResult>): FakeSource {
  const s: FakeSource = {
    id,
    calls: [],
    isReady: true,
    next: next ?? (async () => ({ added: 1, items: 1 })),
    ready: () => s.isReady,
    async pull(reason, progress) {
      s.calls.push(reason);
      progress(`pulling ${id}`);
      return s.next();
    },
  };
  return s;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SyncScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs a ready source on a manual kick and records the result', async () => {
    const c = clock();
    const sch = new SyncScheduler({ now: c.now, events: { document: null, window: null } });
    const a = source('a');
    sch.register(a);
    const seen: string[] = [];
    sch.onChange((st) => seen.push(`${st.running ? 'run' : 'idle'}:${st.progress}`));
    await sch.kick('manual');
    expect(a.calls).toEqual(['manual']);
    const st = sch.status('a');
    expect(st).toMatchObject({ running: false, lastRunAt: c.now(), lastOkAt: c.now(), lastResult: { added: 1, items: 1 }, lastError: null, nextRetryAt: null, failures: 0 });
    expect(seen).toEqual(['run:', 'run:pulling a', 'idle:']);
  });

  it('skips sources that are not ready, and scheduled runs while hidden or offline; manual ignores the gate', async () => {
    let visible = false;
    let online = true;
    const sch = new SyncScheduler({ isVisible: () => visible, isOnline: () => online, events: { document: null, window: null } });
    const a = source('a');
    const b = source('b');
    b.isReady = false;
    sch.register(a);
    sch.register(b);
    await sch.kick('interval');
    expect(a.calls).toEqual([]);
    visible = true;
    online = false;
    await sch.kick('interval');
    expect(a.calls).toEqual([]);
    await sch.kick('manual');
    expect(a.calls).toEqual(['manual']);
    online = true;
    await sch.kick('interval');
    expect(a.calls).toEqual(['manual', 'interval']);
    expect(b.calls).toEqual([]);
    await sch.kick('manual', 'b'); // not ready even by hand
    expect(b.calls).toEqual([]);
    expect(() => sch.status('zzz')).toThrow(/unknown/);
  });

  it('backs off retryable failures (1 min doubling, Retry-After wins) and blocks scheduled runs until then', async () => {
    const c = clock();
    const sch = new SyncScheduler({ now: c.now, events: { document: null, window: null } });
    const a = source('a');
    sch.register(a);
    a.next = async () => {
      throw new SyncError('boom', true);
    };
    await sch.kick('interval');
    expect(sch.status('a')).toMatchObject({ failures: 1, lastError: 'boom', nextRetryAt: c.now() + 60_000, lastOkAt: null });
    c.advance(30_000);
    await sch.kick('interval'); // inside the backoff: skipped
    expect(a.calls).toEqual(['interval']);
    c.advance(31_000);
    await sch.kick('interval'); // past it: runs, fails again → 2 min
    expect(a.calls).toEqual(['interval', 'interval']);
    expect(sch.status('a').nextRetryAt).toBe(c.now() + 120_000);
    // Retry-After longer than the backoff is honoured.
    a.next = async () => {
      throw new SyncError('slow down', true, 10 * 60_000);
    };
    await sch.kick('manual');
    expect(sch.status('a')).toMatchObject({ failures: 3, nextRetryAt: c.now() + 10 * 60_000 });
    // A manual run ignores the backoff; success clears it.
    a.next = async () => ({ added: 0, items: 0 });
    await sch.kick('manual');
    expect(sch.status('a')).toMatchObject({ failures: 0, lastError: null, nextRetryAt: null, lastResult: { added: 0, items: 0 } });
  });

  it('a non-retryable failure waits the maximum backoff; plain errors count as non-retryable', async () => {
    const c = clock();
    const sch = new SyncScheduler({ now: c.now, maxBackoffMs: 1_000_000, events: { document: null, window: null } });
    const a = source('a', async () => {
      throw new Error('plain');
    });
    sch.register(a);
    await sch.kick('open');
    expect(sch.status('a')).toMatchObject({ lastError: 'plain', nextRetryAt: c.now() + 1_000_000 });
  });

  it('coalesces a kick during a run into one follow-up run', async () => {
    const sch = new SyncScheduler({ events: { document: null, window: null } });
    let release: (() => void) | null = null;
    const a = source('a', () => new Promise<PullResult>((resolve) => {
      release = () => resolve({ added: 1, items: 1 });
    }));
    sch.register(a);
    const first = sch.kick('open');
    await Promise.resolve();
    expect(sch.status('a').running).toBe(true);
    const second = sch.kick('interval');
    const third = sch.kick('manual');
    // Only the first pull has started; the later kicks are queued as one follow-up.
    expect(a.calls).toEqual(['open']);
    a.next = async () => ({ added: 2, items: 2 });
    release!();
    await Promise.all([first, second, third]);
    expect(a.calls).toEqual(['open', 'manual']);
    expect(sch.status('a').lastResult).toEqual({ added: 2, items: 2 });
  });

  it("'visible' only runs when the last run is older than the interval", async () => {
    const c = clock();
    const sch = new SyncScheduler({ now: c.now, intervalMs: 1000, events: { document: null, window: null } });
    const a = source('a');
    sch.register(a);
    await sch.kick('visible');
    expect(a.calls).toEqual(['visible']);
    c.advance(500);
    await sch.kick('visible');
    expect(a.calls).toEqual(['visible']);
    c.advance(600);
    await sch.kick('visible');
    expect(a.calls).toEqual(['visible', 'visible']);
  });

  it('start() pulls at once, then on the interval, on online / visibility / rollover events; stop() disarms', async () => {
    vi.useFakeTimers();
    const doc = new EventTarget();
    const win = new EventTarget();
    let visible = true;
    const sch = new SyncScheduler({ intervalMs: 1000, isVisible: () => visible, events: { document: doc, window: win } });
    const a = source('a');
    sch.register(a);
    await sch.start();
    expect(a.calls).toEqual(['open']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.calls).toEqual(['open', 'interval']);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['open', 'interval', 'online']);
    win.dispatchEvent(new Event(ROLLOVER_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toEqual(['open', 'interval', 'online', 'rollover']);
    // Becoming visible right after a run: within the interval, so nothing.
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toHaveLength(4);
    // Hidden: the interval tick is skipped; visible again after the interval: runs.
    visible = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.calls).toHaveLength(4);
    visible = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls[4]).toBe('visible');
    sch.stop();
    await vi.advanceTimersByTimeAsync(5000);
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toHaveLength(5);
    expect(() => sch.register(a)).toThrow(/twice/);
  });
});
