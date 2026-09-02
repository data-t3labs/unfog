/** Record pill → session banner (elapsed / distance / new cells) → summary sheet with Export GPX. */
import { cellAreaM2, lonLatToCell } from '../grid/cell';
import type { Track } from '../grid/types';
import { gpxFileName, trackToGpx } from '../record/gpx';
import { SESSION_KEY, loadUnfinishedSession, sessionTrack, type RecorderEvents, type SessionState } from '../record/session';
import type { AppContext } from './context';
import { fmtArea, fmtDateTime, fmtDistance, fmtElapsed, fmtInt } from './format';
import { icons } from './icons';
import { removeKey } from './settings';
import { confirmSheet, el, openSheet, svg, toast } from './ui';

export interface RecordUI {
  start(): Promise<void>;
  stop(): Promise<void>;
  offerResume(): void;
  readonly recording: boolean;
}

/**
 * iOS share sheet when it takes files (Home Screen app + Safari 15+), else an <a download>.
 * 'cancelled' = the user dismissed the share sheet (AbortError): nothing left the device, so
 * callers must not record a backup/export as done.
 */
export async function shareOrDownload(name: string, content: BlobPart, type: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([content], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // NotAllowedError (no user activation), TypeError… → fall through to the download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

export async function exportTrackGpx(track: Track): Promise<void> {
  if (track.points.length < 2) {
    toast('Nothing to export — the track has fewer than 2 points');
    return;
  }
  const r = await shareOrDownload(gpxFileName(track), trackToGpx(track), 'application/gpx+xml');
  if (r === 'cancelled') return;
  toast(r === 'shared' ? 'GPX shared' : 'GPX downloaded', { kind: 'success' });
}

export function createRecordUI(ctx: AppContext, hooks: RecorderEvents): RecordUI {
  const { shell, recorder } = ctx;
  const units = () => ctx.settings().units;

  const elapsed = el('b', { text: '0:00' });
  const dist = el('span', { text: '0 m' });
  const fresh = el('span', { text: '+0 new' });
  const hint = el('div', { class: 'banner-hint', hidden: true });
  const stopBtn = el('button', { class: 'banner-stop', type: 'button', 'aria-label': 'Stop recording', onclick: () => void api.stop() }, svg(icons.stop), 'Stop');
  const banner = el(
    'div',
    { class: 'rec-banner', hidden: true, role: 'status' },
    el('div', { class: 'rec-main' }, el('span', { class: 'dot' }), elapsed, dist, fresh, stopBtn),
    hint,
  );
  shell.bannerHost.appendChild(banner);

  function render(s: SessionState): void {
    elapsed.textContent = fmtElapsed((Date.now() - s.startMs) / 1000);
    dist.textContent = fmtDistance(s.distanceM, units());
    fresh.textContent = `+${fmtInt(s.newCells)} new`;
  }

  hooks.onUpdate = (s, status) => {
    if (status === 'recording' || status === 'stopping') {
      banner.hidden = false;
      shell.root.classList.add('recording');
      render(s);
    } else {
      banner.hidden = true;
      shell.root.classList.remove('recording');
    }
  };
  hooks.onWakeLock = (ok, reason) => {
    hint.hidden = ok;
    hint.textContent = ok ? '' : reason ?? '';
  };

  async function showSummary(state: SessionState, track: Track): Promise<void> {
    const lat = track.points[0]?.[1] ?? 0;
    const cell = lonLatToCell(0, lat);
    const areaM2 = state.newCells * cellAreaM2(cell[1]);
    const stat = (label: string, value: string) => el('div', { class: 'stat' }, el('div', { class: 'v', text: value }), el('div', { class: 'l', text: label }));
    const content = el(
      'div',
      { class: 'record-summary' },
      el('h2', { text: track.points.length >= 2 ? 'Walk recorded' : 'Nothing recorded' }),
      el('p', { class: 'muted', text: `${fmtDateTime(state.startMs)} · ${track.points.length} fixes${state.dropped ? ` · ${state.dropped} dropped` : ''}` }),
      el(
        'div',
        { class: 'stat-grid' },
        stat('distance', fmtDistance(state.distanceM, units())),
        stat('time', fmtElapsed((Date.now() - state.startMs) / 1000)),
        stat('new cells', fmtInt(state.newCells)),
        stat('≈ new area', fmtArea(areaM2, units())),
      ),
      el(
        'div',
        { class: 'btn-row' },
        el('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Done'),
        el('button', { class: 'btn primary', type: 'button', disabled: track.points.length < 2, onclick: () => void exportTrackGpx(track) }, svg(icons.share), 'Export GPX'),
      ),
    );
    const close = openSheet(content);
  }

  const api: RecordUI = {
    get recording() {
      return recorder.status === 'recording';
    },
    async start() {
      if (recorder.status !== 'idle') return;
      const ok = await ctx.requestLocation();
      if (!ok) return;
      await recorder.start();
      ctx.map.setFollow(true, Math.max(ctx.map.zoom(), 16));
      // Wake-lock failures surface in the banner hint (hooks.onWakeLock); no extra toast.
    },
    async stop() {
      if (recorder.status !== 'recording') return;
      const res = await recorder.stop();
      ctx.map.setFollow(false);
      if (!res) return;
      await ctx.dataChanged();
      await showSummary(res.state, res.track);
    },
    offerResume() {
      const s = loadUnfinishedSession();
      if (!s) return;
      const content = el(
        'div',
        {},
        el('h2', { text: 'Unfinished recording' }),
        el('p', { class: 'muted', text: `Started ${fmtDateTime(s.startMs)} · ${fmtDistance(s.distanceM, units())} · ${s.points.length} fixes. The app was closed while recording.` }),
        el(
          'div',
          { class: 'btn-col' },
          el('button', { class: 'btn primary', type: 'button', onclick: async () => { close(); await ctx.requestLocation(); await recorder.start(s); ctx.map.setFollow(true); } }, 'Resume recording'),
          el('button', { class: 'btn ghost', type: 'button', onclick: async () => {
            close();
            const track = sessionTrack(s);
            if (track.points.length >= 2) {
              try {
                await ctx.engines.grid.markTrack(track);
              } catch (e) {
                toast(`Could not save the session: ${String((e as Error)?.message ?? e)}`, { kind: 'error' });
                return;
              }
            }
            removeKey(SESSION_KEY);
            await ctx.dataChanged();
            await showSummary(s, track);
          } }, 'Finish and save'),
          el('button', { class: 'btn danger-text', type: 'button', onclick: async () => {
            if (await confirmSheet({ title: 'Discard this recording?', body: 'Its points will be lost.', okLabel: 'Discard', danger: true })) {
              recorder.discard();
              close();
            }
          } }, 'Discard'),
        ),
      );
      const close = openSheet(content, { dismissible: false });
    },
  };
  return api;
}
