/**
 * The app shell: full-bleed map, top chrome (search pill, Fog/Heat/Off, legend, locate), bottom
 * chrome (stat chip, Record, tab bar), screen panels (Stats / Data / Help), sheet + banner hosts.
 * Layout and tokens follow docs/mockups/mockup.html.
 */
import { icons } from './icons';
import type { OverlayLayer } from './settings';
import { el, svg } from './ui';

export type Tab = 'map' | 'stats' | 'data' | 'help';

export interface Shell {
  root: HTMLElement;
  mapEl: HTMLElement;
  top: HTMLElement;
  searchPill: HTMLButtonElement;
  searchText: HTMLElement;
  searchClear: HTMLButtonElement;
  seg: HTMLElement;
  legend: HTMLElement;
  locateBtn: HTMLButtonElement;
  bannerHost: HTMLElement;
  bottom: HTMLElement;
  floatRow: HTMLElement;
  statBig: HTMLElement;
  statSub: HTMLElement;
  recordBtn: HTMLButtonElement;
  sheetHost: HTMLElement;
  tabs: HTMLElement;
  screens: Record<Exclude<Tab, 'map'>, HTMLElement>;
  currentTab: Tab;
  showTab(tab: Tab): void;
  onTab(cb: (tab: Tab) => void): void;
  setLayer(layer: OverlayLayer): void;
  onLayer(cb: (layer: OverlayLayer) => void): void;
  setTheme(theme: 'light' | 'dark'): void;
  /** Route sheet / recording: hide the stat chip + Record + tabs. */
  setMapChromeHidden(hidden: boolean): void;
  setLocateActive(on: boolean): void;
}

export function createShell(mount: HTMLElement): Shell {
  const mapEl = el('div', { id: 'map', class: 'map' });

  const searchText = el('span', { class: 'ph', text: 'Where to?' });
  const searchClear = el('button', { class: 'search-clear', type: 'button', 'aria-label': 'Clear destination', hidden: true }, svg(icons.close));
  const searchPill = el('button', { class: 'search', type: 'button', 'aria-label': 'Search destination' }, svg(icons.search), searchText);
  const searchRow = el('div', { class: 'search-row' }, searchPill, searchClear);

  const segButtons: Record<OverlayLayer, HTMLButtonElement> = {
    fog: el('button', { type: 'button', 'data-layer': 'fog', text: 'Fog' }),
    heat: el('button', { type: 'button', 'data-layer': 'heat', text: 'Heat' }),
    off: el('button', { type: 'button', 'data-layer': 'off', text: 'Off' }),
  };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Overlay' }, segButtons.fog, segButtons.heat, segButtons.off);
  const legend = el(
    'div',
    { class: 'legend', hidden: true },
    el('span', { class: 'lbl', text: 'visits' }),
    el('i', { style: 'background:#ffc65a' }), '1',
    el('i', { style: 'background:#ff9a3c' }), '2–3',
    el('i', { style: 'background:#ff5e3a' }), '4–6',
    el('i', { style: 'background:#ff2d55' }), '7+',
  );
  const locateBtn = el('button', { class: 'fab', type: 'button', 'aria-label': 'My location' }, svg(icons.locate));
  const bannerHost = el('div', { class: 'banner-host' });
  const top = el(
    'div',
    { class: 'top' },
    searchRow,
    el('div', { class: 'row' }, bannerHost, el('div', { class: 'stack' }, seg, legend, locateBtn)),
  );

  const statBig = el('div', { class: 'big', text: '—' });
  const statSub = el('div', { class: 'sub', text: 'explored' });
  const recordBtn = el('button', { class: 'record', type: 'button' }, el('span', { class: 'dot' }), 'Record');
  const floatRow = el('div', { class: 'float' }, el('div', { class: 'chip stat-chip' }, statBig, statSub), recordBtn);
  const sheetHost = el('div', { class: 'sheet-host' });

  const tabDefs: Array<[Tab, string, string]> = [
    ['map', 'Map', icons.map],
    ['stats', 'Stats', icons.stats],
    ['data', 'Data', icons.data],
    ['help', 'Help', icons.help],
  ];
  const tabButtons = {} as Record<Tab, HTMLButtonElement>;
  const tabs = el('nav', { class: 'tabs', role: 'tablist' });
  for (const [id, label, icon] of tabDefs) {
    const b = el('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': 'false' }, svg(icon), el('span', { text: label }));
    tabButtons[id] = b;
    tabs.appendChild(b);
  }
  const bottom = el('div', { class: 'bottom' }, floatRow, sheetHost, tabs);

  const screens = {
    stats: el('section', { class: 'screen', id: 'screen-stats', hidden: true }),
    data: el('section', { class: 'screen', id: 'screen-data', hidden: true }),
    help: el('section', { class: 'screen', id: 'screen-help', hidden: true }),
  };

  const root = el('div', { class: 'app' }, mapEl, top, screens.stats, screens.data, screens.help, bottom);
  mount.replaceChildren(root);

  let currentTab: Tab = 'map';
  let tabCb: ((t: Tab) => void) | null = null;
  let layerCb: ((l: OverlayLayer) => void) | null = null;
  let chromeHidden = false;

  const applyChrome = () => {
    const onMap = currentTab === 'map';
    top.hidden = !onMap;
    floatRow.hidden = !onMap || chromeHidden;
    sheetHost.hidden = !onMap;
    tabs.hidden = onMap && chromeHidden;
  };

  const shell: Shell = {
    root, mapEl, top, searchPill, searchText, searchClear, seg, legend, locateBtn, bannerHost, bottom, floatRow,
    statBig, statSub, recordBtn, sheetHost, tabs, screens,
    get currentTab() { return currentTab; },
    showTab(tab) {
      currentTab = tab;
      for (const [id, b] of Object.entries(tabButtons)) {
        b.classList.toggle('on', id === tab);
        b.setAttribute('aria-selected', String(id === tab));
      }
      for (const [id, s] of Object.entries(screens)) s.hidden = id !== tab;
      applyChrome();
      tabCb?.(tab);
    },
    onTab(cb) { tabCb = cb; },
    setLayer(layer) {
      for (const [id, b] of Object.entries(segButtons)) b.classList.toggle('on', id === layer);
      legend.hidden = layer !== 'heat';
    },
    onLayer(cb) { layerCb = cb; },
    setTheme(theme) {
      document.documentElement.classList.toggle('light', theme === 'light');
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#17181d' : '#f4f2ee');
    },
    setMapChromeHidden(hidden) {
      chromeHidden = hidden;
      applyChrome();
    },
    setLocateActive(on) {
      locateBtn.classList.toggle('active', on);
    },
  };

  for (const b of Object.values(tabButtons)) b.addEventListener('click', () => shell.showTab(b.dataset.tab as Tab));
  for (const b of Object.values(segButtons)) {
    b.addEventListener('click', () => {
      const layer = b.dataset.layer as OverlayLayer;
      shell.setLayer(layer);
      layerCb?.(layer);
    });
  }
  shell.showTab('map');
  return shell;
}
