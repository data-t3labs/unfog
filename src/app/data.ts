/**
 * Data screen: import (file picker → import worker → grid), export backup (share sheet / download),
 * backup-age nag, prebuilt regions + downloaded areas, recorded sessions (GPX export / delete),
 * delete everything.
 */
import type { TrackSummary } from '../grid/api';
import type { ImportPayload } from '../grid/types';
import type { RegionManifest } from '../routing/graph-format';
import type { DownloadProgress } from '../routing/api';
import type { AppContext } from './context';
import { fmtArea, fmtBytes, fmtDate, fmtDateTime, fmtDistance, fmtInt, fmtRelative } from './format';
import { icons } from './icons';
import type { ImportOutcome, ImportProgress } from './import-types';
import { requestPersistentStorage } from './pwa';
import { exportTrackGpx, shareOrDownload } from './record-ui';
import { readJSON, writeJSON } from './settings';
import { BACKUP_NAG_KEY, LAST_BACKUP_KEY, LAST_IMPORT_KEY, REGION_DL_KEY, type LastBackup, type LastImport, type RegionDownloads } from './store-keys';
import { clear, confirmSheet, el, svg, toast } from './ui';

export interface DataScreen {
  refresh(): Promise<void>;
  /** Show the "back up your data" toast when the last backup is older than 14 days. */
  maybeNag(): void;
}

const NAG_AFTER_MS = 14 * 86_400_000;
const NAG_EVERY_MS = 2 * 86_400_000;
const ACCEPT = '.zip,.fwss,.gpx,.json,application/zip,application/gpx+xml,application/json,application/octet-stream';

export function createDataScreen(ctx: AppContext): DataScreen {
  const { shell, engines } = ctx;
  const host = shell.screens.data;
  const units = () => ctx.settings().units;

  // ---- import
  const fileInput = el('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'visually-hidden', 'aria-hidden': 'true', tabindex: -1 });
  const importBtn = el('button', { class: 'btn primary wide', type: 'button', onclick: () => fileInput.click() }, svg(icons.upload), 'Import files');
  const importProgress = el('div', { class: 'progress', hidden: true }, el('div', { class: 'bar' }));
  const importStatus = el('div', { class: 'muted small' });
  const importResult = el('div', { class: 'import-result' });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length) void runImport(files);
  });

  async function runImport(files: File[]): Promise<void> {
    importBtn.disabled = true;
    importProgress.hidden = false;
    clear(importResult);
    const bar = importProgress.firstElementChild as HTMLElement;
    bar.style.width = '2%';
    importStatus.textContent = `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`;
    const lines: string[] = [];
    let addedCells = 0;
    let addedArea = 0;
    let anyOk = false;
    try {
      const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const onProgress = (p: ImportProgress) => {
        const label = p.message ?? (p.name || p.fileName ? `Reading ${p.name ?? p.fileName}` : p.phase ?? 'Importing…');
        importStatus.textContent = p.total ? `${label} (${p.done ?? 0}/${p.total})` : label;
        if (p.total) bar.style.width = `${Math.max(2, Math.min(60, Math.round((60 * (p.done ?? 0)) / p.total)))}%`;
      };
      const before = await engines.grid.getStats();
      // Streamed path: the import worker hands each outcome over as soon as it is produced and
      // waits for us to apply it, so a big Sync.zip is folded into the store chunk by chunk.
      let applied = 0;
      const onOutcome = async (o: ImportOutcome): Promise<void> => {
        applied++;
        bar.style.width = `${Math.min(98, 60 + Math.round((40 * applied) / (applied + 2)))}%`;
        const r = await applyOutcome(o, importStatus);
        lines.push(r.line);
        if (r.ok) anyOk = true;
      };
      const outcomes = await engines.importFiles(inputs, onProgress, onOutcome);
      if (applied === 0) {
        // Importer without streaming support (mock mode): apply the returned list instead.
        let i = 0;
        for (const o of outcomes) {
          i++;
          bar.style.width = `${60 + Math.round((40 * i) / outcomes.length)}%`;
          const r = await applyOutcome(o, importStatus);
          lines.push(r.line);
          if (r.ok) anyOk = true;
        }
      }
      const after = await engines.grid.getStats();
      addedCells = Math.max(0, after.visitedCells - before.visitedCells);
      addedArea = Math.max(0, after.areaM2 - before.areaM2);
    } catch (e) {
      lines.push(`Import failed: ${String((e as Error)?.message ?? e)}`);
    }
    importProgress.hidden = true;
    importStatus.textContent = '';
    clear(importResult);
    const summary = anyOk ? `${fmtInt(addedCells)} new cells, ${fmtArea(addedArea, units())} added` : 'Nothing imported';
    importResult.append(el('div', { class: 'name', text: summary }), el('ul', { class: 'plain small' }, lines.map((l) => el('li', { text: l }))));
    if (anyOk) {
      writeJSON(LAST_IMPORT_KEY, { at: Date.now(), summary } satisfies LastImport);
      await ctx.dataChanged();
      void requestPersistentStorage();
      toast(summary, { kind: 'success' });
    }
    importBtn.disabled = false;
    void renderSessions();
  }

  async function applyOutcome(o: ImportOutcome, status: HTMLElement): Promise<{ ok: boolean; line: string }> {
    if (o.kind === 'error') return { ok: false, line: `${o.name}: ${o.message}` };
    if (o.kind === 'backup') {
      status.textContent = `Restoring backup ${o.name}…`;
      try {
        const r = await engines.grid.importBackup(o.bytes);
        return { ok: true, line: `${o.name}: backup restored (${fmtInt(r.stats.visitedCells)} cells total)` };
      } catch (e) {
        return { ok: false, line: `${o.name}: restore failed — ${String((e as Error)?.message ?? e)}` };
      }
    }
    const p = o.payload;
    status.textContent = `Applying ${p.meta.fileName ?? p.meta.source}…`;
    try {
      await engines.grid.applyPayload(p);
      return { ok: true, line: describePayload(p) };
    } catch (e) {
      return { ok: false, line: `${p.meta.fileName ?? p.meta.source}: ${String((e as Error)?.message ?? e)}` };
    }
  }

  function describePayload(p: ImportPayload): string {
    const name = p.meta.fileName ?? p.meta.source;
    const parts: string[] = [];
    // "map tiles" = z14 cell tiles (the Stats screen's "map tiles with data"), not Fog of World tiles.
    if (p.cellTiles?.length) parts.push(`${fmtInt(p.cellTiles.length)} map tiles`);
    if (p.tracks?.length) parts.push(`${fmtInt(p.tracks.length)} track${p.tracks.length === 1 ? '' : 's'}`);
    const src = sourceName(p.meta.source);
    // Bare FoW tiles picked together arrive as "2 Fog of World tiles" — don't repeat the source after it.
    const head = name.includes(src) ? name : `${name}: ${src}`;
    return `${head}${parts.length ? ` — ${parts.join(', ')}` : ''}${p.meta.note ? ` (${p.meta.note})` : ''}`;
  }

  // ---- export
  const backupInfo = el('div', { class: 'muted small' });
  const exportBtn = el('button', { class: 'btn wide', type: 'button', onclick: () => void exportBackup() }, svg(icons.share), 'Export backup');
  async function exportBackup(): Promise<void> {
    exportBtn.disabled = true;
    try {
      const bytes = await engines.grid.exportBackup();
      const d = new Date();
      const name = `unfog-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.${engines.gridMock ? 'json' : 'zip'}`;
      const r = await shareOrDownload(name, new Uint8Array(bytes), engines.gridMock ? 'application/json' : 'application/zip');
      if (r === 'cancelled') {
        // Share sheet dismissed: no file left the device, so this is not a backup.
        toast('Backup cancelled', { duration: 2500 });
        return;
      }
      writeJSON(LAST_BACKUP_KEY, { at: Date.now() } satisfies LastBackup);
      renderBackupInfo();
      toast(r === 'shared' ? 'Backup shared — save it to Files or iCloud Drive' : 'Backup downloaded', { kind: 'success', duration: 5000 });
    } catch (e) {
      toast(`Export failed: ${String((e as Error)?.message ?? e)}`, { kind: 'error' });
    } finally {
      exportBtn.disabled = false;
    }
  }
  function renderBackupInfo(): void {
    const last = readJSON<LastBackup | null>(LAST_BACKUP_KEY, null);
    const old = !last || Date.now() - last.at > NAG_AFTER_MS;
    backupInfo.textContent = last ? `Last backup ${fmtRelative(last.at)} (${fmtDate(last.at)})` : 'No backup yet';
    backupInfo.classList.toggle('warn', old);
  }

  // ---- regions
  const regionsList = el('div', { class: 'list' });
  async function renderRegions(): Promise<void> {
    clear(regionsList);
    let regions: RegionManifest[] = [];
    let downloads: Awaited<ReturnType<typeof engines.route.listDownloads>> = [];
    try {
      [regions, downloads] = await Promise.all([engines.route.listRegions(), engines.route.listDownloads()]);
    } catch (e) {
      regionsList.appendChild(el('div', { class: 'error', text: `Could not list regions: ${String((e as Error)?.message ?? e)}` }));
      return;
    }
    const dl = readJSON<RegionDownloads>(REGION_DL_KEY, {});
    if (!regions.length && !downloads.length) regionsList.appendChild(el('p', { class: 'muted', text: 'No prebuilt regions published yet. Routing will offer to download an area when you plan a route.' }));
    for (const r of regions) {
      const got = dl[r.id];
      const sub = got
        ? `Offline since ${fmtDate(got.at)} · ${fmtInt(got.tiles)} tiles · ${fmtBytes(got.bytes)}`
        : `${fmtInt(r.stats.km)} km of streets · ${r.tiles.length ? `${fmtInt(r.tiles.length)} tiles · ` : ''}built ${r.builtAt}`;
      const progress = el('div', { class: 'progress', hidden: true }, el('div', { class: 'bar' }));
      const btn = el('button', { class: `btn small ${got ? 'ghost' : ''}`, type: 'button' }, got ? 'Update' : 'Download');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        progress.hidden = false;
        try {
          const res = await engines.route.downloadRegion(
            r.id,
            engines.proxy((p: DownloadProgress) => {
              (progress.firstElementChild as HTMLElement).style.width = `${p.total ? Math.round((100 * p.done) / p.total) : 0}%`;
            }),
          );
          const cur = readJSON<RegionDownloads>(REGION_DL_KEY, {});
          cur[r.id] = { at: Date.now(), tiles: res.tiles, bytes: res.bytes };
          writeJSON(REGION_DL_KEY, cur);
          toast(`${r.name} ready for offline routing`, { kind: 'success' });
        } catch (e) {
          toast(`Download failed: ${String((e as Error)?.message ?? e)}`, { kind: 'error' });
        }
        void renderRegions();
      });
      regionsList.appendChild(el('div', { class: 'row-item' }, el('div', { class: 't' }, el('div', { class: 'name', text: r.name }), el('div', { class: 'st', text: sub }), progress), btn));
    }
    for (const d of downloads) {
      const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete area' }, svg(icons.trash));
      del.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: 'Delete this downloaded area?', okLabel: 'Delete', danger: true }))) return;
        await engines.route.deleteDownload(d.id);
        void renderRegions();
      });
      regionsList.appendChild(
        el(
          'div',
          { class: 'row-item' },
          el('div', { class: 't' }, el('div', { class: 'name', text: `Area · ${d.radiusKm} km around ${d.center[1].toFixed(3)}, ${d.center[0].toFixed(3)}` }), el('div', { class: 'st', text: `${fmtInt(d.tiles)} tiles · ${fmtBytes(d.bytes)} · ${fmtDate(Date.parse(d.builtAt))}` })),
          del,
        ),
      );
    }
  }

  // ---- sessions
  const sessionsList = el('div', { class: 'list' });
  async function renderSessions(): Promise<void> {
    clear(sessionsList);
    let tracks: TrackSummary[] = [];
    try {
      tracks = (await engines.grid.listTracks()).filter((t) => t.source === 'session').sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
    } catch (e) {
      sessionsList.appendChild(el('div', { class: 'error', text: `Could not list sessions: ${String((e as Error)?.message ?? e)}` }));
      return;
    }
    if (!tracks.length) {
      sessionsList.appendChild(el('p', { class: 'muted', text: 'No recorded sessions yet. Tap Record on the map to start one.' }));
      return;
    }
    for (const t of tracks.slice(0, 50)) {
      const exp = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Export GPX' }, svg(icons.share));
      exp.addEventListener('click', async () => {
        const track = await engines.grid.getTrack(t.id);
        if (track) await exportTrackGpx(track);
      });
      const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete session' }, svg(icons.trash));
      del.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: 'Delete this session?', body: 'The track is removed from the list. Cells it visited stay marked.', okLabel: 'Delete', danger: true }))) return;
        await engines.grid.deleteTrack(t.id);
        await ctx.dataChanged();
        void renderSessions();
      });
      sessionsList.appendChild(
        el(
          'div',
          { class: 'row-item' },
          el('div', { class: 't' }, el('div', { class: 'name', text: t.name ?? 'Session' }), el('div', { class: 'st', text: `${fmtDateTime(t.startMs)} · ${fmtDistance(t.lengthM, units())} · ${fmtInt(t.points)} fixes` })),
          exp,
          del,
        ),
      );
    }
  }

  // ---- delete all
  const deleteBtn = el('button', { class: 'btn danger-text wide', type: 'button' }, 'Delete all data');
  deleteBtn.addEventListener('click', async () => {
    const ok = await confirmSheet({ title: 'Delete everything?', body: 'All visited cells, tracks and sessions on this device will be erased. Export a backup first if you want to keep them.', okLabel: 'Delete all', danger: true });
    if (!ok) return;
    try {
      await engines.grid.deleteAll();
      await ctx.dataChanged();
      toast('All data deleted');
      void refresh();
    } catch (e) {
      toast(`Delete failed: ${String((e as Error)?.message ?? e)}`, { kind: 'error' });
    }
  });

  host.append(
    el('header', { class: 'screen-head' }, el('h1', { text: 'Data' })),
    el(
      'div',
      { class: 'screen-body' },
      el('h3', { text: 'Import' }),
      el('p', { class: 'muted', text: 'Fog of World Sync.zip / raw Sync files / .fwss, GPX (Apple Health, Strava), Google Timeline JSON, Unfog backups. Pick several at once.' }),
      importBtn,
      fileInput,
      importProgress,
      importStatus,
      importResult,
      el('h3', { text: 'Backup' }),
      el('p', { class: 'muted', text: 'Deleting the Home Screen icon deletes this app’s data. Export a backup to Files or iCloud Drive now and then; importing a backup merges it back.' }),
      exportBtn,
      backupInfo,
      el('h3', { text: 'Routing data' }),
      regionsList,
      el('h3', { text: 'Recorded sessions' }),
      sessionsList,
      el('h3', { text: 'Danger zone' }),
      deleteBtn,
    ),
  );

  async function refresh(): Promise<void> {
    renderBackupInfo();
    await Promise.all([renderRegions(), renderSessions()]);
  }

  return {
    refresh,
    maybeNag() {
      const last = readJSON<LastBackup | null>(LAST_BACKUP_KEY, null);
      const lastNag = readJSON<number>(BACKUP_NAG_KEY, 0);
      const lastImport = readJSON<LastImport | null>(LAST_IMPORT_KEY, null);
      if (!lastImport && !last) return; // nothing to back up yet
      if (last && Date.now() - last.at < NAG_AFTER_MS) return;
      if (Date.now() - lastNag < NAG_EVERY_MS) return;
      writeJSON(BACKUP_NAG_KEY, Date.now());
      toast(last ? `Last backup ${fmtRelative(last.at)} — export a new one` : 'No backup yet — export one to Files', {
        duration: 8000,
        action: { label: 'Data', onClick: () => shell.showTab('data') },
      });
    },
  };
}

function sourceName(src: string): string {
  switch (src) {
    case 'fow':
      return 'Fog of World';
    case 'gpx':
      return 'GPX';
    case 'timeline':
      return 'Google Timeline';
    case 'backup':
      return 'Unfog backup';
    default:
      return src;
  }
}
