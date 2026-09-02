/**
 * Structural mirror of the importer contract (src/import/detect.ts, agent B) so the UI and the
 * import worker type-check before that module lands. Keep in sync with detect.ts.
 */
import type { ImportPayload } from '../grid/types';

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

export type ImportOutcome =
  | { kind: 'payload'; payload: ImportPayload }
  | { kind: 'backup'; bytes: Uint8Array; name: string }
  | { kind: 'error'; name: string; message: string };

/** Progress messages are free-form; the UI displays whatever fields are present. */
export interface ImportProgress {
  name?: string;
  fileName?: string;
  phase?: string;
  message?: string;
  done?: number;
  total?: number;
}

export type ImportProgressCb = (p: ImportProgress) => void;

export type ImportFilesFn = (files: ImportFile[], onProgress?: ImportProgressCb) => Promise<ImportOutcome[]>;
