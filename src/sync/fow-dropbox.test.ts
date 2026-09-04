import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApplyResult, GridApi } from '../grid/api';
import type { GridStats, ImportPayload, Track } from '../grid/types';
import { DROPBOX_PKCE_KEY, DROPBOX_TOKENS_KEY, type FetchFn } from './dropbox';
import { DEFAULT_FOW_SYNC_FOLDER, FOW_DROPBOX_KEY, FowDropboxSource, inThreadTileImporter, type FowDropboxState } from './fow-dropbox';
import { SyncError } from './scheduler';
import { memoryKV } from './state';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/fow/${name}`, import.meta.url)));
const TILE_A = '23e4lltkkoke'; // 3,757 visited px
const TILE_B = 'cd36lltksiwo'; // 33,226 visited px
const FOLDER_LOWER = '/apps/fog of world/sync';
const TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 4_000_000_000_000 };

/** A grid double that keeps the union of visited cells (FoW semantics: max(count, 1)). */
function fakeGrid(): GridApi & { cells: Set<string>; payloads: ImportPayload[] } {
  const cells = new Set<string>();
  const payloads: ImportPayload[] = [];
  const stats = (): GridStats => ({ visitedCells: cells.size, areaM2: cells.size * 80, tiles: 0, version: payloads.length, updatedAt: 0 });
  const result = (): ApplyResult => ({ stats: stats(), touched: [] });
  return {
    cells,
    payloads,
    init: async () => stats(),
    getStats: async () => stats(),
    async applyPayload(p) {
      payloads.push(p);
      for (const t of p.cellTiles ?? []) for (let i = 0; i < t.counts.length; i++) if (t.counts[i]) cells.add(`${t.tx}/${t.ty}/${i}`);
      return result();
    },
    markTrack: async () => result(),
    renderTile: async () => new Uint8ClampedArray(0),
    getTileCounts: async () => null,
    listBaseTiles: async () => [],
    exportBackup: async () => new Uint8Array(0),
    importBackup: async () => result(),
    listTracks: async () => [],
    getTrack: async () => null as Track | null,
    deleteTrack: async () => stats(),
    deleteAll: async () => stats(),
  };
}

interface Entry {
  name: string;
  tag?: 'file' | 'folder' | 'deleted';
}

/** A Dropbox double: list pages by cursor, downloads by path, and injectable failures. */
function fakeDropbox(opts: { entries: Entry[]; changes?: Record<string, Entry[]> } = { entries: [] }) {
  const calls: string[] = [];
  const state = { failListWith: null as null | (() => Response), continueMode: 'ok' as 'ok' | 'reset' };
  const page = (entries: Entry[], cursor: string) =>
    new Response(
      JSON.stringify({
        entries: entries.map((e) => ({ '.tag': e.tag ?? 'file', name: e.name, path_lower: `${FOLDER_LOWER}/${e.name.toLowerCase()}`, path_display: `${DEFAULT_FOW_SYNC_FOLDER}/${e.name}`, id: `id:${e.name}`, rev: 'r', size: 1 })),
        cursor,
        has_more: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  let listN = 0;
  const fn: FetchFn = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url.replace(/^https:\/\/[^/]+\/2\//, '')}`);
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, account_id: 'dbid:1' }), { status: 200 });
    if (url.endsWith('users/get_current_account')) return new Response(JSON.stringify({ account_id: 'dbid:1', email: 'jacob@example.com' }), { status: 200 });
    if (url.endsWith('files/list_folder/continue')) {
      const { cursor } = JSON.parse(init.body as string) as { cursor: string };
      if (state.continueMode === 'reset') return new Response(JSON.stringify({ error_summary: 'reset/', error: { '.tag': 'reset' } }), { status: 409 });
      const changes = opts.changes?.[cursor] ?? [];
      return page(changes, `${cursor}+`);
    }
    if (url.endsWith('files/list_folder')) {
      if (state.failListWith) return state.failListWith();
      const { path } = JSON.parse(init.body as string) as { path: string };
      if (path.toLowerCase() !== FOLDER_LOWER) return new Response(JSON.stringify({ error_summary: 'path/not_found/', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), { status: 409 });
      listN++;
      return page(opts.entries, `cur-${listN}`);
    }
    if (url.endsWith('files/download')) {
      const arg = JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg']) as { path: string };
      const name = arg.path.slice(arg.path.lastIndexOf('/') + 1);
      if (name === TILE_A || name === TILE_B) return new Response(fixture(name).buffer as ArrayBuffer, { status: 200 });
      if (name === 'gone') return new Response(JSON.stringify({ error_summary: 'path/not_found/', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), { status: 409 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response('no route', { status: 404 });
  };
  return { fn, calls, state };
}

function makeSource(grid: GridApi, fetchFn: FetchFn, store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS }), appKey = 'k1') {
  return { source: new FowDropboxSource({ grid, importer: inThreadTileImporter, store, fetchFn, now: () => 1_700_000_000_000, appKey: () => appKey, redirectUri: () => 'https://x.test/unfog/' }), store };
}

const progress: string[] = [];
const onProgress = (m: string) => progress.push(m);

describe('FowDropboxSource', () => {
  it('without an app key it is "not set up": not ready, no sign-in, redirect ignored', async () => {
    const grid = fakeGrid();
    const { source } = makeSource(grid, fakeDropbox().fn, memoryKV(), '');
    expect(source.configured()).toBe(false);
    expect(source.connected()).toBe(false);
    expect(source.ready()).toBe(false);
    await expect(source.connectUrl()).rejects.toThrow(/not set up/);
    expect(await source.completeRedirect('https://x.test/unfog/?code=c&state=s')).toBe(false);
    expect(source.state()).toMatchObject({ folder: DEFAULT_FOW_SYNC_FOLDER, cursor: null, account: null, totalCellsAdded: 0 });
  });

  it('sign-in: connectUrl stores the PKCE record; completeRedirect exchanges the code and reads the account', async () => {
    const grid = fakeGrid();
    const store = memoryKV();
    const db = fakeDropbox();
    const { source } = makeSource(grid, db.fn, store);
    expect(source.connected()).toBe(false);
    const url = await source.connectUrl();
    expect(url).toMatch(/^https:\/\/www\.dropbox\.com\/oauth2\/authorize\?/);
    const st = store.read<{ state: string }>(DROPBOX_PKCE_KEY, null as never).state;
    expect(await source.completeRedirect(`https://x.test/unfog/?code=c&state=${st}`)).toBe(true);
    expect(source.connected()).toBe(true);
    expect(source.ready()).toBe(true);
    expect(source.state().account).toEqual({ accountId: 'dbid:1', email: 'jacob@example.com' });
    expect(source.state().connectedAt).toBe(1_700_000_000_000);
    expect(store.read(DROPBOX_TOKENS_KEY, null)).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    source.disconnect();
    expect(source.connected()).toBe(false);
    expect(store.read(DROPBOX_TOKENS_KEY, null)).toBeNull();
    expect(source.state()).toMatchObject({ cursor: null, account: null, connectedAt: null });
  });

  it('first pull lists the folder, downloads only tile files and puts 36,983 cells on the map; the cursor makes the next pull a no-op', async () => {
    const grid = fakeGrid();
    const db = fakeDropbox({
      entries: [{ name: TILE_A }, { name: TILE_B }, { name: 'FoW-Sync-Lock' }, { name: 'Import', tag: 'folder' }, { name: 'README.txt' }, { name: TILE_A, tag: 'deleted' }],
      changes: { 'cur-1': [], 'cur-1+': [{ name: TILE_A }] },
    });
    const { source, store } = makeSource(grid, db.fn);
    progress.length = 0;
    const r1 = await source.pull('open', onProgress);
    expect(r1).toEqual({ added: 3757 + 33226, items: 2 });
    expect(grid.cells.size).toBe(36_983);
    expect(db.calls.filter((c) => c.includes('files/download'))).toHaveLength(2);
    expect(progress.some((m) => /Downloading 2\/2/.test(m))).toBe(true);
    const s1 = store.read<FowDropboxState>(FOW_DROPBOX_KEY, null as never);
    expect(s1.cursor).toBe('cur-1');
    expect(s1.lastPull).toMatchObject({ files: 2, cellsAdded: 36_983 });
    expect(s1.totalFiles).toBe(2);
    expect(s1.totalCellsAdded).toBe(36_983);
    // Nothing changed: continue with the saved cursor, no downloads, cursor advanced.
    const r2 = await source.pull('interval', onProgress);
    expect(r2).toEqual({ added: 0, items: 0 });
    expect(db.calls.filter((c) => c.includes('files/download'))).toHaveLength(2);
    expect(db.calls.filter((c) => c.includes('list_folder/continue'))).toHaveLength(1);
    expect(store.read<FowDropboxState>(FOW_DROPBOX_KEY, null as never).cursor).toBe('cur-1+');
    // Fog of World rewrote tile A: re-downloaded, re-applied, no new cells (max(count, 1)).
    const r3 = await source.pull('interval', onProgress);
    expect(r3).toEqual({ added: 0, items: 1 });
    expect(grid.cells.size).toBe(36_983);
    expect(store.read<FowDropboxState>(FOW_DROPBOX_KEY, null as never)).toMatchObject({ cursor: 'cur-1++', totalFiles: 3, totalCellsAdded: 36_983 });
  });

  it('a "reset" on continue drops the cursor and re-lists from scratch — idempotent', async () => {
    const grid = fakeGrid();
    const db = fakeDropbox({ entries: [{ name: TILE_A }] });
    const { source, store } = makeSource(grid, db.fn);
    await source.pull('open', onProgress);
    expect(grid.cells.size).toBe(3757);
    db.state.continueMode = 'reset';
    const r = await source.pull('interval', onProgress);
    expect(r).toEqual({ added: 0, items: 1 });
    expect(grid.cells.size).toBe(3757);
    expect(store.read<FowDropboxState>(FOW_DROPBOX_KEY, null as never).cursor).toBe('cur-2');
    expect(db.calls.filter((c) => c.endsWith('files/list_folder'))).toHaveLength(2);
  });

  it('a missing folder is a clear, non-retryable error naming the folder; the cursor stays unset', async () => {
    const grid = fakeGrid();
    const db = fakeDropbox({ entries: [{ name: TILE_A }] });
    const { source, store } = makeSource(grid, db.fn);
    source.setFolder('Apps/Fog of World/Sync-old/');
    expect(source.state().folder).toBe('/Apps/Fog of World/Sync-old');
    let err: SyncError | null = null;
    try {
      await source.pull('open', onProgress);
    } catch (e) {
      err = e as SyncError;
    }
    expect(err).toBeInstanceOf(SyncError);
    expect(err!.retryable).toBe(false);
    expect(err!.message).toMatch(/\/Apps\/Fog of World\/Sync-old was not found/);
    expect(store.read<FowDropboxState>(FOW_DROPBOX_KEY, null as never).cursor).toBeNull();
    expect(grid.cells.size).toBe(0);
    source.setFolder('  ');
    expect(source.state().folder).toBe(DEFAULT_FOW_SYNC_FOLDER);
  });

  it('rate limiting and outages are retryable with the server delay; nothing is recorded', async () => {
    const grid = fakeGrid();
    const db = fakeDropbox({ entries: [{ name: TILE_A }] });
    const { source, store } = makeSource(grid, db.fn);
    db.state.failListWith = () => new Response(JSON.stringify({ error_summary: 'too_many_requests/', error: { '.tag': 'too_many_requests' } }), { status: 429, headers: { 'Retry-After': '30' } });
    await expect(source.pull('open', onProgress)).rejects.toMatchObject({ retryable: true, retryAfterMs: 30_000 });
    db.state.failListWith = () => new Response('bad gateway', { status: 502 });
    await expect(source.pull('open', onProgress)).rejects.toMatchObject({ retryable: true });
    expect(source.state().lastPull).toBeNull();
    expect(store.read(FOW_DROPBOX_KEY, null)).toBeNull();
    expect(grid.payloads).toHaveLength(0);
  });

  it('a tile deleted between list and download is skipped, and a corrupt tile is reported in the note', async () => {
    const grid = fakeGrid();
    const db = fakeDropbox({ entries: [{ name: TILE_A }, { name: 'gone' }, { name: 'e10alhwjskwk' }] });
    // "gone" is not a tile name → never downloaded; e10alhwjskwk is a valid name whose bytes are junk.
    const { source } = makeSource(grid, db.fn);
    const r = await source.pull('open', onProgress);
    expect(r.added).toBe(3757);
    expect(r.items).toBe(2);
    expect(r.note).toMatch(/e10alhwjskwk: skipped/);
    expect(source.state().lastPull?.note).toMatch(/skipped/);
  });

  it('pull without a connection is a non-retryable error', async () => {
    const grid = fakeGrid();
    const { source } = makeSource(grid, fakeDropbox().fn, memoryKV());
    await expect(source.pull('open', onProgress)).rejects.toMatchObject({ retryable: false });
  });
});
