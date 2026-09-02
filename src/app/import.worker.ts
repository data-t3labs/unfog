/**
 * Import worker: runs the (pure, worker-safe) importers from src/import/detect.ts off the main
 * thread so a 50 MB Sync.zip never blocks the UI. Falls back to the mock importer when the
 * real module is absent (build-time glob) or when the app runs in mock mode.
 */
import * as Comlink from 'comlink';
import type { ImportFile, ImportOutcome, ImportProgressCb } from './import-types';
import { mockImportFiles } from './mock/import';

/**
 * src/import/detect.ts: `importFiles(files, onProgress?(msg, done, total), { onOutcome? })`.
 * With `onOutcome` the importer streams: each outcome is handed over (and awaited) as soon as it
 * is produced, then released, so a 200-tile Sync.zip never sits in memory as one payload.
 */
type RealProgressFn = (msg: string, done: number, total: number) => void;
type RealImportFiles = (
  files: ImportFile[],
  onProgress?: RealProgressFn,
  opts?: { onOutcome?: (o: ImportOutcome) => Promise<void> | void },
) => Promise<ImportOutcome[]>;

const real = import.meta.glob<{ importFiles: RealImportFiles }>('../import/detect.ts');

export type ImportOutcomeCb = (outcome: ImportOutcome) => Promise<void>;

export interface ImportWorkerApi {
  /**
   * Returns every outcome. When `onOutcome` is given, payload outcomes are delivered through it
   * (transferred, applied by the caller, then released) and the returned list carries them with
   * empty cellTiles/tracks. The mock importer ignores `onOutcome` and just returns the list.
   */
  importFiles(files: ImportFile[], onProgress: ImportProgressCb | undefined, forceMock: boolean, onOutcome?: ImportOutcomeCb): Promise<ImportOutcome[]>;
  hasRealImporter(): Promise<boolean>;
}

/**
 * Transfer a payload's tile buffers to the main thread instead of copying them. The importer
 * strips delivered payloads from its final return list, so the detached buffers never travel
 * twice. Backup outcomes stay in that list with their bytes, so they must be cloned, not moved.
 */
function transferOutcome(o: ImportOutcome): ImportOutcome {
  if (o.kind !== 'payload') return o;
  const buffers = (o.payload.cellTiles ?? []).map((t) => t.counts.buffer as ArrayBuffer);
  return buffers.length ? Comlink.transfer(o, buffers) : o;
}

const api: ImportWorkerApi = {
  async importFiles(files, onProgress, forceMock, onOutcome) {
    const loader = real['../import/detect.ts'];
    if (loader && !forceMock) {
      const mod = await loader();
      const progress: RealProgressFn | undefined = onProgress ? (message, done, total) => void onProgress({ message, done, total }) : undefined;
      const opts = onOutcome ? { onOutcome: (o: ImportOutcome) => onOutcome(transferOutcome(o)) } : undefined;
      return mod.importFiles(files, progress, opts);
    }
    return mockImportFiles(files, onProgress);
  },
  async hasRealImporter() {
    return Boolean(real['../import/detect.ts']);
  },
};

Comlink.expose(api);
