/**
 * Data screen → "Routing data": the automatic pack cache (coverage v2). Plain words for someone
 * who never wants to know what a tile is: the streets around you download as you go, here is how
 * much is on the phone, grouped by the state / province it came from, and a Clear. The prebuilt
 * Regions and Downloaded areas lists that follow it are unchanged (src/app/data.ts).
 */
import type { PackCacheCell, PackCacheStatus } from '../routing/api';
import type { AppContext } from './context';
import { fmtBytes, fmtRelative } from './format';
import { clear, el, toast } from './ui';

export interface PacksSection {
  readonly el: HTMLElement;
  refresh(): Promise<void>;
}

export const AUTO_COPY = 'Automatic: the streets around you download as you go (Wi-Fi and mobile; paused on Low Data Mode). They stay on your phone for offline routes and make room for new places by themselves.';

/**
 * "New York (US)" from a pack's source line, e.g. "Geofabrik us/new-york 2026-09-01" or
 * "Geofabrik us/washington, us/oregon (+ border merge)"; the cell key when there is no source.
 */
export function packLabel(cell: PackCacheCell): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of (cell.source ?? '').matchAll(/(?:[a-z][a-z-]*\/)+[a-z][a-z-]*/g)) {
    const parts = m[0].split('/');
    const region = parts[parts.length - 1];
    const country = parts.length >= 2 ? parts[parts.length - 2] : '';
    const title = region.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const label = country ? `${title} (${country.length <= 3 ? country.toUpperCase() : country.charAt(0).toUpperCase() + country.slice(1)})` : title;
    if (!seen.has(label)) { seen.add(label); names.push(label); }
  }
  return names.length ? names.join(', ') : `Map area ${cell.cell}`;
}

/** "coverage list updated 3 h ago" — hours below a day, days after, "not downloaded yet" when there is none. */
export function indexAgeText(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'Coverage list not downloaded yet — it arrives the next time you are online.';
  const h = Math.floor(ageMs / 3_600_000);
  if (h < 1) return 'Coverage list updated just now.';
  if (h < 48) return `Coverage list updated ${h} h ago.`;
  return `Coverage list updated ${Math.floor(h / 24)} days ago.`;
}

export function createPacksSection(ctx: AppContext): PacksSection {
  const { engines } = ctx;
  const list = el('div', { class: 'list packs-list' });
  const total = el('div', { class: 'muted small packs-total' });
  const clearBtn = el('button', { class: 'btn small ghost', type: 'button' }, 'Clear');
  const age = el('p', { class: 'muted small packs-age' });
  const root = el('div', { class: 'packs-section' }, el('p', { class: 'muted', text: AUTO_COPY }), list, el('div', { class: 'row-item packs-footer' }, el('div', { class: 't' }, total), clearBtn), age);

  clearBtn.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      await engines.route.packsClear();
      toast('Routing data cleared — it downloads again as you go');
    } catch (e) {
      toast(`Could not clear: ${String((e as Error)?.message ?? e)}. Try again.`, { kind: 'error' });
    } finally {
      clearBtn.disabled = false;
    }
    void refresh();
  });

  function render(s: PackCacheStatus): void {
    clear(list);
    if (!s.cells.length) {
      list.appendChild(el('p', { class: 'muted small', text: 'Nothing downloaded yet. Plan a route or move around, and the streets there arrive on their own.' }));
    }
    for (const c of s.cells) {
      list.appendChild(
        el(
          'div',
          { class: 'row-item packs-cell' },
          el('div', { class: 't' }, el('div', { class: 'name', text: `Streets near ${packLabel(c)}` }), el('div', { class: 'st', text: `${fmtBytes(c.bytes)} · used ${fmtRelative(c.lastUsed)}` })),
        ),
      );
    }
    total.textContent = s.totalTiles ? `${fmtBytes(s.totalBytes)} of streets on this phone` : 'No street data on this phone yet';
    clearBtn.hidden = !s.totalTiles;
    age.textContent = indexAgeText(s.indexAgeMs);
  }

  async function refresh(): Promise<void> {
    try {
      render(await engines.route.packsStatus());
    } catch (e) {
      clear(list);
      list.appendChild(el('div', { class: 'error', text: `Could not read the routing data: ${String((e as Error)?.message ?? e)}. Reload to try again.` }));
    }
  }

  return { el: root, refresh };
}
