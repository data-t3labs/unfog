/**
 * Import worker: runs the (pure, worker-safe) importers from src/import/detect.ts off the main
 * thread so a 50 MB Sync.zip never blocks the UI. Falls back to the mock importer when the
 * real module is absent (build-time glob) or when the app runs in mock mode.
 */
import * as Comlink from 'comlink';
import type { ImportFile, ImportOutcome, ImportProgressCb } from './import-types';
import { mockImportFiles } from './mock/import';

/** src/import/detect.ts (agent B): `importFiles(files, onProgress?(msg, done, total))`. */
type RealProgressFn = (msg: string, done: number, total: number) => void;
type RealImportFiles = (files: ImportFile[], onProgress?: RealProgressFn) => Promise<ImportOutcome[]>;

const real = import.meta.glob<{ importFiles: RealImportFiles }>('../import/detect.ts');

export interface ImportWorkerApi {
  importFiles(files: ImportFile[], onProgress: ImportProgressCb | undefined, forceMock: boolean): Promise<ImportOutcome[]>;
  hasRealImporter(): Promise<boolean>;
}

const api: ImportWorkerApi = {
  async importFiles(files, onProgress, forceMock) {
    const loader = real['../import/detect.ts'];
    if (loader && !forceMock) {
      const mod = await loader();
      const progress: RealProgressFn | undefined = onProgress ? (message, done, total) => void onProgress({ message, done, total }) : undefined;
      return mod.importFiles(files, progress);
    }
    return mockImportFiles(files, onProgress);
  },
  async hasRealImporter() {
    return Boolean(real['../import/detect.ts']);
  },
};

Comlink.expose(api);
