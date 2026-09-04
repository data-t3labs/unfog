/**
 * Fog of World via Dropbox — path A of "always recording". Fog of World keeps recording in the
 * background and syncs its tiles to `/Apps/Fog of World/Sync` (research: fow-research.md §3.1;
 * FoW asks Dropbox for an App-folder scope, so the folder sits under /Apps). Unfog signs in to
 * the user's Dropbox (PKCE, src/sync/dropbox.ts), lists that folder once, then keeps the
 * `list_folder` cursor: every later pull is a `list_folder/continue` that returns only the tiles
 * Fog of World rewrote since. Changed tiles go through the existing importer (bare Sync tile
 * files → `importFowFilesChunked`, off-thread via the import worker when one is given) and
 * `grid.applyPayload` — FoW cells are max(count, 1), so re-pulling a tile never double counts.
 *
 * The cursor is saved only after every chunk of a pull has been applied: a pull that dies midway
 * re-lists the same entries next time.
 */
import * as Comlink from 'comlink';
import type { GridApi } from '../grid/api';
import type { ImportPayload } from '../grid/types';
import { importFowFilesChunked, isFowTileName } from '../import/fow';
import type { InputFile } from '../import/util';
import type { ImportOutcome, ImportProgress } from '../app/import-types';
import { DropboxClient, DropboxError, beginDropboxAuth, completeDropboxAuth, dropboxAppKey, toSyncError, type DropboxAccount, type DropboxEntry, type DropboxTokens, type FetchFn } from './dropbox';
import { SyncError, type PullResult, type SyncReason, type SyncSource } from './scheduler';
import { localKV, type KeyValue } from './state';

export const FOW_DROPBOX_KEY = 'unfog.fowDropbox';
/** Where Fog of World writes its Sync folder in a full Dropbox (App-folder apps live under /Apps). */
export const DEFAULT_FOW_SYNC_FOLDER = '/Apps/Fog of World/Sync';
/** Downloads in flight at once. */
const DOWNLOAD_CONCURRENCY = 3;

export interface FowDropboxPull {
  at: number;
  /** Tile files that changed (downloaded + imported). */
  files: number;
  cellsAdded: number;
  /** Warnings from the importer (corrupt tiles etc.). */
  note?: string;
}

export interface FowDropboxState {
  folder: string;
  cursor: string | null;
  account: DropboxAccount | null;
  connectedAt: number | null;
  lastPull: FowDropboxPull | null;
  totalFiles: number;
  totalCellsAdded: number;
}

const DEFAULT_STATE: FowDropboxState = { folder: DEFAULT_FOW_SYNC_FOLDER, cursor: null, account: null, connectedAt: null, lastPull: null, totalFiles: 0, totalCellsAdded: 0 };

/** The Data screen's importer contract (src/app/engines.ts `importFiles`): off-thread when real. */
export type TileImporter = (files: InputFile[], onProgress?: (p: ImportProgress) => void, onOutcome?: (o: ImportOutcome) => Promise<void>) => Promise<ImportOutcome[]>;

/** In-thread importer (tests, and a fallback when no worker is available). */
export const inThreadTileImporter: TileImporter = async (files, onProgress, onOutcome) => {
  const outcomes: ImportOutcome[] = [];
  const label = files.length === 1 ? files[0].name : `${files.length} Fog of World tiles`;
  for (const chunk of importFowFilesChunked(files, (message, done, total) => onProgress?.({ message, done, total }), label)) {
    const o: ImportOutcome = { kind: 'payload', payload: chunk };
    if (onOutcome) {
      await onOutcome(o);
      outcomes.push({ kind: 'payload', payload: { meta: chunk.meta, cellTiles: [], tracks: [] } });
    } else outcomes.push(o);
  }
  return outcomes;
};

export interface FowDropboxDeps {
  grid: GridApi;
  /** Default: parse on this thread. main.ts passes `engines.importFiles` (the import worker). */
  importer?: TileImporter;
  store?: KeyValue;
  fetchFn?: FetchFn;
  now?: () => number;
  /** Default: the build-time app key (src/sync/dropbox.ts `dropboxAppKey`). */
  appKey?: () => string;
  /** Where Dropbox sends the user back: the app's own URL. */
  redirectUri?: () => string;
}

export class FowDropboxSource implements SyncSource {
  readonly id = 'fow-dropbox';
  private readonly grid: GridApi;
  private readonly importer: TileImporter;
  private readonly store: KeyValue;
  private readonly fetchFn: FetchFn | undefined;
  private readonly now: () => number;
  private readonly appKeyFn: () => string;
  private readonly redirectUriFn: () => string;
  private client: DropboxClient | null = null;

  constructor(deps: FowDropboxDeps) {
    this.grid = deps.grid;
    this.importer = deps.importer ?? inThreadTileImporter;
    this.store = deps.store ?? localKV;
    this.fetchFn = deps.fetchFn;
    this.now = deps.now ?? (() => Date.now());
    this.appKeyFn = deps.appKey ?? dropboxAppKey;
    this.redirectUriFn = deps.redirectUri ?? (() => new URL(import.meta.env.BASE_URL ?? '/', location.origin).toString());
  }

  /** The build-time app key; '' means "not set up yet" (the UI shows the steps). */
  appKey(): string {
    return this.appKeyFn();
  }

  configured(): boolean {
    return this.appKey() !== '';
  }

  private dropbox(): DropboxClient {
    if (!this.client) this.client = new DropboxClient({ appKey: this.appKey(), store: this.store, fetchFn: this.fetchFn, now: this.now });
    return this.client;
  }

  connected(): boolean {
    return this.configured() && this.dropbox().connected();
  }

  ready(): boolean {
    return this.connected();
  }

  state(): FowDropboxState {
    const s = this.store.read<Partial<FowDropboxState>>(FOW_DROPBOX_KEY, {});
    return { ...DEFAULT_STATE, ...s, folder: typeof s.folder === 'string' && s.folder.trim() ? s.folder : DEFAULT_FOW_SYNC_FOLDER };
  }

  private patch(p: Partial<FowDropboxState>): FowDropboxState {
    const next = { ...this.state(), ...p };
    this.store.write(FOW_DROPBOX_KEY, next);
    return next;
  }

  /** Change the Sync folder path (normalised to `/Leading/Path`); drops the cursor so the next pull re-lists. */
  setFolder(path: string): FowDropboxState {
    let p = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === '') p = DEFAULT_FOW_SYNC_FOLDER;
    if (!p.startsWith('/')) p = `/${p}`;
    return this.patch({ folder: p, cursor: null });
  }

  /** Start the sign-in: returns the Dropbox URL to navigate to (the UI does `location.assign`). */
  async connectUrl(): Promise<string> {
    if (!this.configured()) throw new SyncError('Dropbox is not set up yet (no app key)', false);
    return beginDropboxAuth({ appKey: this.appKey(), redirectUri: this.redirectUriFn(), store: this.store });
  }

  /**
   * Finish a sign-in from the URL the app was opened with. Returns true when tokens were
   * obtained, false when the URL carries no OAuth parameters. Throws a DropboxError on refusal.
   */
  async completeRedirect(url: string): Promise<boolean> {
    if (!this.configured()) return false;
    const tokens: DropboxTokens | null = await completeDropboxAuth({ url, appKey: this.appKey(), store: this.store, fetchFn: this.fetchFn, now: this.now });
    if (!tokens) return false;
    this.client = null;
    this.patch({ connectedAt: this.now(), cursor: null, account: null });
    try {
      const account = await this.dropbox().currentAccount();
      this.patch({ account });
    } catch (e) {
      console.warn('[sync] get_current_account failed', e);
    }
    return true;
  }

  /** Forget the tokens and the cursor (the folder setting and totals stay). */
  disconnect(): void {
    this.dropbox().disconnect();
    this.client = null;
    this.patch({ cursor: null, account: null, connectedAt: null });
  }

  /** Changed tile entries since the cursor (or everything on the first pull) + the new cursor. */
  private async listChanges(progress: (m: string) => void): Promise<{ tiles: DropboxEntry[]; cursor: string }> {
    const db = this.dropbox();
    const s = this.state();
    const tiles: DropboxEntry[] = [];
    let cursor = s.cursor;
    let page;
    try {
      page = cursor ? await db.listFolderContinue(cursor) : await db.listFolder(s.folder);
    } catch (e) {
      if (e instanceof DropboxError && e.reset && cursor) {
        // Dropbox forgot the cursor: start over (harmless — FoW cells are max(count, 1)).
        this.patch({ cursor: null });
        cursor = null;
        page = await db.listFolder(s.folder);
      } else if (e instanceof DropboxError && e.notFound) {
        throw new SyncError(`Folder ${s.folder} was not found in your Dropbox. In Fog of World: Settings → Sync → Dropbox → Sync Now, then pull again.`, false);
      } else throw e;
    }
    for (;;) {
      for (const e of page.entries) if (e.tag === 'file' && isFowTileName(e.name)) tiles.push(e);
      progress(`Checking Dropbox… ${tiles.length} changed tile${tiles.length === 1 ? '' : 's'}`);
      if (!page.hasMore) return { tiles, cursor: page.cursor };
      page = await db.listFolderContinue(page.cursor);
    }
  }

  private async downloadAll(tiles: DropboxEntry[], progress: (m: string) => void): Promise<InputFile[]> {
    const db = this.dropbox();
    const files: InputFile[] = new Array(tiles.length);
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= tiles.length) return;
        const t = tiles[i];
        try {
          files[i] = { name: t.name, bytes: await db.download(t.pathLower || t.pathDisplay) };
        } catch (e) {
          // A tile deleted between list and download: skip it; anything else aborts the pull.
          if (e instanceof DropboxError && e.notFound) files[i] = { name: t.name, bytes: new Uint8Array(0) };
          else throw e;
        }
        done++;
        progress(`Downloading ${done}/${tiles.length}…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tiles.length) }, worker));
    return files.filter((f) => f.bytes.length > 0);
  }

  async pull(_reason: SyncReason, progress: (m: string) => void): Promise<PullResult> {
    if (!this.connected()) throw new SyncError('Not connected to Dropbox', false);
    try {
      const { tiles, cursor } = await this.listChanges(progress);
      if (tiles.length === 0) {
        this.patch({ cursor, lastPull: { at: this.now(), files: 0, cellsAdded: 0 } });
        return { added: 0, items: 0 };
      }
      const files = await this.downloadAll(tiles, progress);
      const before = await this.grid.getStats();
      const notes: string[] = [];
      let applied = 0;
      const onOutcome = async (o: ImportOutcome): Promise<void> => {
        if (o.kind !== 'payload') {
          if (o.kind === 'error') notes.push(`${o.name}: ${o.message}`);
          return;
        }
        applied++;
        progress(`Adding to the map… (${applied})`);
        const p: ImportPayload = o.payload;
        if (p.meta.note) notes.push(p.meta.note);
        // Hand the tile buffers on to the grid worker without copying (same as the Data screen).
        const buffers = (p.cellTiles ?? []).map((t) => t.counts.buffer as ArrayBuffer);
        await this.grid.applyPayload(buffers.length ? Comlink.transfer(p, buffers) : p);
      };
      const outcomes = await this.importer(files, (p) => progress(p.message ?? 'Importing…'), onOutcome);
      if (applied === 0) {
        // An importer without streaming (the mock): apply the returned list.
        for (const o of outcomes) await onOutcome(o);
      }
      const after = await this.grid.getStats();
      const cellsAdded = Math.max(0, after.visitedCells - before.visitedCells);
      const note = notes.length ? notes.join('; ') : undefined;
      const s = this.state();
      const lastPull: FowDropboxPull = { at: this.now(), files: files.length, cellsAdded };
      if (note) lastPull.note = note;
      this.patch({ cursor, lastPull, totalFiles: s.totalFiles + files.length, totalCellsAdded: s.totalCellsAdded + cellsAdded });
      const result: PullResult = { added: cellsAdded, items: files.length };
      if (note) result.note = note;
      return result;
    } catch (e) {
      throw toSyncError(e);
    }
  }
}
