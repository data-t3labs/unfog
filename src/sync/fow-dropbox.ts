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
 * The unit of progress is one Dropbox list page (≤ ~200 entries): its tiles are downloaded and
 * applied, then the page's cursor is saved, before the next page is asked for. A first pull over a
 * multi-year Sync folder (thousands of tiles) can therefore be killed by iOS, or rate-limited,
 * and the next pull resumes after the last completed page instead of starting over.
 */
import * as Comlink from 'comlink';
import type { GridApi } from '../grid/api';
import type { ImportPayload } from '../grid/types';
import { importFowFilesChunked, isFowTileName } from '../import/fow';
import type { InputFile } from '../import/util';
import type { ImportOutcome, ImportProgress } from '../app/import-types';
import { DropboxClient, DropboxError, beginDropboxAuth, completeDropboxAuth, dropboxAppKey, toSyncError, type DropboxAccount, type DropboxEntry, type DropboxTokens, type FetchFn, type ListFolderResult } from './dropbox';
import { SyncError, type PullResult, type SyncReason, type SyncSource } from './scheduler';
import { localKV, type KeyValue } from './state';

export const FOW_DROPBOX_KEY = 'unfog.fowDropbox';
/** Where Fog of World writes its Sync folder in a full Dropbox (App-folder apps live under /Apps). */
export const DEFAULT_FOW_SYNC_FOLDER = '/Apps/Fog of World/Sync';
/** Downloads in flight at once. */
const DOWNLOAD_CONCURRENCY = 3;
/** Entries per Dropbox list page — the unit of progress (Dropbox honours `limit` approximately). */
const LIST_PAGE_LIMIT = 200;
/** Tiles downloaded + applied together, in case a page comes back larger than asked. */
const APPLY_BATCH = 200;
/** Guard against a Dropbox that never stops saying `has_more` (a 3 000-tile folder is 15 pages). */
const MAX_PAGES = 1000;

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

  /** One list page: `list_folder/continue` from the cursor, or the folder's first page. */
  private async listPage(cursor: string | null): Promise<ListFolderResult> {
    const db = this.dropbox();
    const s = this.state();
    try {
      return cursor ? await db.listFolderContinue(cursor) : await db.listFolder(s.folder, LIST_PAGE_LIMIT);
    } catch (e) {
      if (e instanceof DropboxError && e.notFound) throw new SyncError(`Folder ${s.folder} was not found in your Dropbox. In Fog of World: Settings → Sync → Dropbox → Sync Now, then pull again.`, false);
      throw e;
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

  /** Run downloaded tile files through the importer and onto the grid. */
  private async applyFiles(files: InputFile[], progress: (m: string) => void, applied: { n: number }): Promise<{ cellsAdded: number; notes: string[] }> {
    const before = await this.grid.getStats();
    const notes: string[] = [];
    let appliedHere = 0;
    const onOutcome = async (o: ImportOutcome): Promise<void> => {
      if (o.kind !== 'payload') {
        if (o.kind === 'error') notes.push(`${o.name}: ${o.message}`);
        return;
      }
      appliedHere++;
      applied.n++;
      progress(`Adding to the map… (${applied.n})`);
      const p: ImportPayload = o.payload;
      if (p.meta.note) notes.push(p.meta.note);
      // Hand the tile buffers on to the grid worker without copying (same as the Data screen).
      const buffers = (p.cellTiles ?? []).map((t) => t.counts.buffer as ArrayBuffer);
      await this.grid.applyPayload(buffers.length ? Comlink.transfer(p, buffers) : p);
    };
    const outcomes = await this.importer(files, (p) => progress(p.message ?? 'Importing…'), onOutcome);
    if (appliedHere === 0) {
      // An importer without streaming (the mock): apply the returned list.
      for (const o of outcomes) await onOutcome(o);
    }
    const after = await this.grid.getStats();
    // A stats delta (a recorder checkpoint landing inside this window would inflate it slightly).
    return { cellsAdded: Math.max(0, after.visitedCells - before.visitedCells), notes };
  }

  async pull(_reason: SyncReason, progress: (m: string) => void): Promise<PullResult> {
    if (!this.connected()) throw new SyncError('Not connected to Dropbox', false);
    try {
      let cursor = this.state().cursor;
      let files = 0;
      let cellsAdded = 0;
      let seen = 0;
      let resets = 0;
      const notes: string[] = [];
      const applied = { n: 0 };
      for (let pageN = 0; ; pageN++) {
        let page: ListFolderResult;
        try {
          page = await this.listPage(cursor);
        } catch (e) {
          if (e instanceof DropboxError && e.reset && cursor && resets++ === 0) {
            // Dropbox forgot the cursor (first call or mid-way): start over once — harmless, FoW cells are max(count, 1).
            this.patch({ cursor: null });
            cursor = null;
            continue;
          }
          throw e;
        }
        const tiles = page.entries.filter((e) => e.tag === 'file' && isFowTileName(e.name));
        seen += tiles.length;
        progress(`Checking Dropbox… ${seen} changed tile${seen === 1 ? '' : 's'}`);
        let pageFiles = 0;
        let pageCells = 0;
        for (let i = 0; i < tiles.length; i += APPLY_BATCH) {
          const got = await this.downloadAll(tiles.slice(i, i + APPLY_BATCH), progress);
          if (got.length === 0) continue;
          const r = await this.applyFiles(got, progress, applied);
          pageFiles += got.length;
          pageCells += r.cellsAdded;
          notes.push(...r.notes);
        }
        files += pageFiles;
        cellsAdded += pageCells;
        // Progress checkpoint: this page is on the map; a pull that dies now resumes after it.
        cursor = page.cursor;
        const s = this.state();
        this.patch({ cursor, totalFiles: s.totalFiles + pageFiles, totalCellsAdded: s.totalCellsAdded + pageCells });
        if (!page.hasMore) break;
        if (pageN + 1 >= MAX_PAGES) throw new SyncError('Dropbox keeps saying there is more — giving up for now', true);
      }
      const note = notes.length ? notes.join('; ') : undefined;
      const lastPull: FowDropboxPull = { at: this.now(), files, cellsAdded };
      if (note) lastPull.note = note;
      this.patch({ lastPull });
      const result: PullResult = { added: cellsAdded, items: files };
      if (note) result.note = note;
      return result;
    } catch (e) {
      throw toSyncError(e);
    }
  }
}
