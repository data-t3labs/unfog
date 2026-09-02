/** Stats screen: honest numbers from grid.getStats + listTracks, plus dates kept by the Data screen. */
import type { AppContext } from './context';
import { fmtArea, fmtBytes, fmtDate, fmtInt, fmtRelative, fmtDistance } from './format';
import { storageEstimate } from './pwa';
import { readJSON } from './settings';
import { LAST_BACKUP_KEY, LAST_IMPORT_KEY, type LastBackup, type LastImport } from './store-keys';
import { clear, el } from './ui';

export interface StatsScreen {
  refresh(): Promise<void>;
}

export function createStatsScreen(ctx: AppContext): StatsScreen {
  const host = ctx.shell.screens.stats;
  const body = el('div', { class: 'screen-body' });
  host.append(el('header', { class: 'screen-head' }, el('h1', { text: 'Stats' })), body);

  const tile = (value: string, label: string, big = false) =>
    el('div', { class: `stat ${big ? 'big' : ''}` }, el('div', { class: 'v', text: value }), el('div', { class: 'l', text: label }));

  async function refresh(): Promise<void> {
    const units = ctx.settings().units;
    clear(body);
    body.appendChild(el('div', { class: 'muted', text: 'Loading…' }));
    try {
      const [stats, tracks, est] = await Promise.all([ctx.engines.grid.getStats(), ctx.engines.grid.listTracks(), storageEstimate()]);
      const bySource = new Map<string, { n: number; m: number }>();
      for (const t of tracks) {
        const e = bySource.get(t.source) ?? { n: 0, m: 0 };
        e.n++;
        e.m += t.lengthM;
        bySource.set(t.source, e);
      }
      const sessions = bySource.get('session');
      const lastImport = readJSON<LastImport | null>(LAST_IMPORT_KEY, null);
      const lastBackup = readJSON<LastBackup | null>(LAST_BACKUP_KEY, null);
      clear(body);
      body.append(
        el('div', { class: 'stat-grid' }, tile(fmtArea(stats.areaM2, units), 'explored', true), tile(fmtInt(stats.visitedCells), 'visited cells'), tile(fmtInt(stats.tiles), 'map tiles with data')),
        el('h3', { text: 'Tracks' }),
        el(
          'div',
          { class: 'stat-grid' },
          tile(fmtInt(tracks.length), 'tracks stored'),
          tile(sessions ? fmtInt(sessions.n) : '0', 'recorded sessions'),
          tile(sessions ? fmtDistance(sessions.m, units) : fmtDistance(0, units), 'recorded distance'),
        ),
        bySource.size
          ? el(
              'ul',
              { class: 'plain' },
              [...bySource.entries()].map(([src, e]) => el('li', {}, el('span', { text: sourceLabel(src) }), el('span', { class: 'muted', text: `${e.n} · ${fmtDistance(e.m, units)}` }))),
            )
          : el('p', { class: 'muted', text: 'No tracks yet. Import your history or record a walk.' }),
        el('h3', { text: 'Housekeeping' }),
        el(
          'ul',
          { class: 'plain' },
          el('li', {}, el('span', { text: 'Last import' }), el('span', { class: 'muted', text: lastImport ? `${fmtRelative(lastImport.at)} — ${lastImport.summary}` : 'never' })),
          el('li', {}, el('span', { text: 'Last backup' }), el('span', { class: 'muted', text: lastBackup ? `${fmtRelative(lastBackup.at)} (${fmtDate(lastBackup.at)})` : 'never' })),
          el('li', {}, el('span', { text: 'Data version' }), el('span', { class: 'muted', text: String(stats.version) })),
          est ? el('li', {}, el('span', { text: 'Storage used' }), el('span', { class: 'muted', text: `${fmtBytes(est.usage)}${est.quota ? ` of ${fmtBytes(est.quota)}` : ''}` })) : null,
          ctx.engines.gridMock || ctx.engines.routeMock
            ? el('li', {}, el('span', { text: 'Engines' }), el('span', { class: 'muted', text: `${ctx.engines.gridMock ? 'mock grid' : 'grid worker'} · ${ctx.engines.routeMock ? 'mock router' : 'route worker'}` }))
            : null,
        ),
        el('p', { class: 'muted small', text: 'Cells are Fog of World pixels (about 7 m in New York). Area is the sum of visited cell areas — not a walked-distance estimate.' }),
      );
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'error', text: `Could not load stats: ${String((e as Error)?.message ?? e)}` }));
    }
  }

  return { refresh };
}

function sourceLabel(src: string): string {
  switch (src) {
    case 'session':
      return 'Recorded sessions';
    case 'gpx':
      return 'GPX imports';
    case 'timeline':
      return 'Google Timeline';
    case 'fow':
      return 'Fog of World';
    case 'backup':
      return 'Unfog backups';
    default:
      return src;
  }
}
