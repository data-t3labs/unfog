/**
 * Wires the "always recording" sources into the app: one SyncScheduler with the Fog of World
 * via Dropbox source and the Overland source, the Dropbox sign-in completion at boot, and the
 * map/stats refresh after a pull that added something. Created once by main.ts; the Data
 * screen's Sources section reads it through `getSync()`.
 */
import type { AppContext } from '../app/context';
import { fmtInt } from '../app/format';
import { toast } from '../app/ui';
import { DropboxError, stripRedirectParams } from './dropbox';
import { FowDropboxSource } from './fow-dropbox';
import { OverlandSource } from './overland';
import { SyncScheduler, type SourceStatus } from './scheduler';

export interface Sync {
  scheduler: SyncScheduler;
  fow: FowDropboxSource;
  overland: OverlandSource;
  /** Finish a Dropbox sign-in the app was opened with (if any), then start the scheduler. */
  boot(): Promise<void>;
}

let instance: Sync | null = null;

export function getSync(): Sync | null {
  return instance;
}

export function createSync(ctx: AppContext): Sync {
  const fow = new FowDropboxSource({
    grid: ctx.engines.grid,
    importer: (files, onProgress, onOutcome) => ctx.engines.importFiles(files, onProgress, onOutcome),
  });
  const overland = new OverlandSource({ grid: ctx.engines.grid });
  const scheduler = new SyncScheduler();
  scheduler.register(fow);
  scheduler.register(overland);

  // A pull that put something on the map: redraw + stats, and a quiet toast.
  const seenOk = new Map<string, number | null>();
  scheduler.onChange((st: SourceStatus) => {
    const prev = seenOk.get(st.id) ?? null;
    if (st.lastOkAt === prev) return;
    seenOk.set(st.id, st.lastOkAt);
    const r = st.lastResult;
    if (!r || r.added <= 0) return;
    void ctx.dataChanged();
    if (st.id === fow.id) toast(`Fog of World via Dropbox: ${fmtInt(r.added)} new cells`, { kind: 'success', duration: 4000 });
    else if (st.id === overland.id) toast(`Overland: ${fmtInt(r.added)} new points on the map`, { kind: 'success', duration: 4000 });
  });

  const sync: Sync = {
    scheduler,
    fow,
    overland,
    async boot() {
      const url = location.href;
      try {
        const connected = await fow.completeRedirect(url);
        if (connected) {
          history.replaceState(null, '', stripRedirectParams(url));
          toast('Dropbox connected — pulling your Fog of World tiles', { kind: 'success', duration: 5000 });
          ctx.shell.showTab('data');
        }
      } catch (e) {
        history.replaceState(null, '', stripRedirectParams(url));
        const msg = e instanceof DropboxError ? e.message : `Dropbox sign-in failed: ${(e as Error)?.message ?? e}`;
        toast(msg, { kind: 'error', duration: 7000 });
        ctx.shell.showTab('data');
      }
      await scheduler.start();
    },
  };
  instance = sync;
  return sync;
}

/** Tests only: drop the singleton. */
export function resetSyncForTests(): void {
  instance?.scheduler.stop();
  instance = null;
}
