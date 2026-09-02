/** "Where to?" — full-screen search panel with Photon typeahead, current location, and a long-press hint. */
import { geocode, type GeoResult } from '../geocode/photon';
import type { AppContext } from './context';
import { icons } from './icons';
import { clear, debounce, el, svg, toast } from './ui';

export interface SearchPanel {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function createSearch(ctx: AppContext): SearchPanel {
  const input = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Where to?',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Destination',
  });
  const list = el('div', { class: 'search-list', role: 'listbox' });
  const status = el('div', { class: 'search-status muted' });
  const backBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back' }, svg(icons.back));
  const panel = el(
    'section',
    { class: 'search-panel', hidden: true, 'aria-label': 'Search' },
    el('div', { class: 'search-head' }, backBtn, el('div', { class: 'search-field' }, svg(icons.search), input)),
    el('div', { class: 'search-body' }, quickRows(), status, list),
  );
  document.body.appendChild(panel);

  let open = false;
  let abort: AbortController | null = null;
  let seq = 0;

  function quickRows(): HTMLElement {
    return el(
      'div',
      { class: 'quick' },
      row(svg(icons.target), 'Current location', 'Route to where you are now', async () => {
        const ok = await ctx.requestLocation();
        if (!ok) return;
        try {
          const fix = await ctx.location.getOnce(12_000);
          api.close();
          ctx.openRoute({ name: 'Current location', lonlat: [fix.lon, fix.lat], origin: ctx.map.center() });
        } catch {
          toast('No GPS position yet — try again in a moment.');
        }
      }),
      row(svg(icons.loop), 'Explore a loop from here', 'A round trip through streets you have never walked', () => {
        api.close();
        ctx.openLoop();
      }),
      // A visible way in: drops the pin at the map centre (pan first), and names the hidden gesture.
      row(svg(icons.pin), 'Drop a pin at the map centre', 'Or touch and hold anywhere on the map', () => {
        const c = ctx.map.center();
        api.close();
        ctx.openRoute({ name: 'Dropped pin', locality: `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, lonlat: c });
      }),
    );
  }

  function row(icon: HTMLElement, title: string, sub: string, onClick: () => void): HTMLElement {
    return el(
      'button',
      { class: 'result', type: 'button', role: 'option', onclick: onClick },
      icon,
      el('div', { class: 't' }, el('div', { class: 'name', text: title }), el('div', { class: 'st', text: sub })),
      svg(icons.chevron, 'ic dim'),
    );
  }

  function render(results: GeoResult[]): void {
    clear(list);
    for (const r of results) {
      list.appendChild(
        row(svg(icons.pin), r.name, r.locality || r.kind, () => {
          api.close();
          ctx.openRoute({ name: r.name, locality: r.locality, lonlat: [r.lon, r.lat] });
        }),
      );
    }
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    abort?.abort();
    if (q.length < 3) {
      status.textContent = '';
      render([]);
      return;
    }
    const my = ++seq;
    abort = new AbortController();
    status.textContent = 'Searching…';
    try {
      const c = ctx.map.center();
      const res = await geocode(q, { lon: c[0], lat: c[1] }, abort.signal);
      if (my !== seq) return;
      status.textContent = res.length ? '' : 'No matches — try a street or place name';
      render(res);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || my !== seq) return;
      status.textContent = navigator.onLine ? 'Search failed — try again' : 'Search needs a connection';
      render([]);
    }
  }, 300);

  input.addEventListener('input', () => search());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.close();
    if (e.key === 'Enter') {
      const first = list.querySelector<HTMLButtonElement>('button.result');
      if (first) first.click();
    }
  });
  backBtn.addEventListener('click', () => api.close());

  const api: SearchPanel = {
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      panel.hidden = false;
      requestAnimationFrame(() => {
        panel.classList.add('show');
        input.focus();
        input.select();
      });
    },
    close() {
      if (!open) return;
      open = false;
      abort?.abort();
      input.blur();
      panel.classList.remove('show');
      window.setTimeout(() => {
        if (!open) panel.hidden = true;
      }, 200);
    },
  };
  return api;
}
