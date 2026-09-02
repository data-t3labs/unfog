/** Help screen (FoW export, install, location, how routes work), settings, and the iOS install card. */
import type { AppContext, HelpSection } from './context';
import { icons } from './icons';
import { getSettings, readJSON, updateSettings, writeJSON, type AppSettings } from './settings';
import { INSTALL_DISMISS_KEY } from './store-keys';
import { el, isIOS, isStandalone, svg } from './ui';

export interface HelpScreen {
  refresh(): void;
  /** Expand one section (collapsing the others) and scroll it into view. */
  show(section: HelpSection): void;
}

const APP_VERSION = '0.1.0';

/** Shown on Data and in Help: iOS greys out extension-less files in the picker when a zip is expected. */
export const GREYED_OUT_HINT = 'If Sync.zip is greyed out in the Files picker, open the Sync folder and select the files inside it instead.';

function section(id: HelpSection, title: string, ...body: HTMLElement[]): HTMLDetailsElement {
  return el('details', { class: 'help-section', id: `help-${id}` }, el('summary', {}, el('span', { text: title }), svg(icons.chevron, 'ic dim')), el('div', { class: 'help-body' }, ...body));
}

function steps(items: Array<string | HTMLElement>): HTMLElement {
  return el('ol', { class: 'steps' }, items.map((i) => el('li', typeof i === 'string' ? { text: i } : {}, typeof i === 'string' ? null : i)));
}

function p(text: string, cls = ''): HTMLElement {
  return el('p', { class: cls, text });
}

export function createHelpScreen(ctx: AppContext): HelpScreen {
  const host = ctx.shell.screens.help;
  const settingsBody = el('div', { class: 'settings' });

  function renderSettings(): void {
    const s = getSettings();
    settingsBody.replaceChildren(
      segRow('Basemap', [['bright', 'Bright'], ['dark', 'Dark']], s.basemap, (v) => updateSettings({ basemap: v as AppSettings['basemap'] })),
      segRow('Units', [['metric', 'km'], ['imperial', 'miles']], s.units, (v) => updateSettings({ units: v as AppSettings['units'] })),
      segRow('Cleared core', [['1', 'Normal (≈20 m)'], ['0', 'Tight (≈7 m)']], String(s.coreRadius), (v) => updateSettings({ coreRadius: v === '0' ? 0 : 1 })),
      // Softness is a blur radius in cells (2–6); shown as a percentage of that range like the other sliders.
      rangeRow('Fog softness', 2, 6, 0.25, s.feather, (v) => `${Math.round(((v - 2) / 4) * 100)}%`, (v) => updateSettings({ feather: v })),
      rangeRow('Reveal (halo)', 0, 0.8, 0.05, s.halo, (v) => `${Math.round(v * 100)}%`, (v) => updateSettings({ halo: v })),
      rangeRow('Fog strength', 0.5, 0.95, 0.05, s.fogAlpha, (v) => `${Math.round(v * 100)}%`, (v) => updateSettings({ fogAlpha: v })),
    );
  }

  function segRow(label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLElement {
    const seg = el('div', { class: 'seg inline', role: 'group', 'aria-label': label });
    for (const [v, text] of options) {
      const b = el('button', { type: 'button', class: v === value ? 'on' : '', 'aria-pressed': String(v === value), text });
      b.addEventListener('click', () => {
        onChange(v);
        for (const x of seg.children) {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        }
      });
      seg.appendChild(b);
    }
    return el('div', { class: 'setting' }, el('label', { text: label }), seg);
  }

  function rangeRow(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void): HTMLElement {
    const out = el('span', { class: 'muted', text: fmt(value) });
    const input = el('input', { type: 'range', min, max, step, value, class: 'range', 'aria-label': label });
    const fill = () => input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    fill();
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      fill();
    });
    input.addEventListener('change', () => onChange(Number(input.value)));
    return el('div', { class: 'setting col' }, el('div', { class: 'setting-head' }, el('label', { text: label }), out), input);
  }

  const sections: Record<HelpSection, HTMLDetailsElement> = {
    export: section(
      'export',
      'Get your history out of Fog of World',
      p('Fog of World keeps its data in a Sync folder. Copy it out once, then import the zip here:'),
      steps([
        'In Fog of World: Settings → Sync → choose iCloud Drive → Sync Now (wait for it to finish)',
        'Open the Files app → iCloud Drive → Fog of World',
        'Long-press the "Sync" folder → Compress. You get Sync.zip',
        'In Unfog: Data → Import files → pick Sync.zip',
      ]),
      p(`${GREYED_OUT_HINT} You can select several at once.`, 'muted small'),
      p('Also works: a .fwss snapshot (Fog of World → Settings → Snapshot), or the Sync folder from Dropbox/OneDrive → Apps → Fog of World. Re-importing is safe: the map lines up exactly and nothing is double counted.', 'muted small'),
      p('GPX from Apple Health (Health → Profile → Export All Health Data, then workout-routes/*.gpx), Strava, and Google Timeline JSON (Google Maps → Your timeline → Export) import the same way.', 'muted small'),
    ),
    install: section(
      'install',
      'Install on your iPhone',
      p('Unfog runs as a Home Screen app. In Safari:'),
      steps([
        el('span', {}, 'Tap the ', svg(icons.iosShare, 'ic inline'), ' Share button'),
        'Scroll down and tap "Add to Home Screen"',
        el('span', {}, 'Tap ', el('b', { text: 'Add' }), ' (keep "Open as Web App" on)'),
      ]),
      p('The installed app keeps its own data and permissions — import your history and allow location once inside it. Deleting the icon deletes its data, so export a backup from Data now and then.', 'muted small'),
    ),
    location: section(
      'location',
      'Location not working',
      p('Location only starts when you tap the locate button, Record or Go. If iOS says location is denied:'),
      steps([
        'Settings › Privacy & Security › Location Services — on',
        'Same screen → Safari Websites → "While Using the App", and Precise Location on',
        'Settings › Apps › Safari › Location → Ask or Allow',
        'In Safari (before installing): tap "AA" / page menu → Website Settings → Location → Allow',
      ]),
      p('iOS 26.0–26.0.1 had a bug where an installed web app got "denied" while the same site worked in Safari. Fix: Settings › General › Transfer or Reset iPhone › Reset › Reset Location & Privacy, then open Unfog and allow again.', 'muted small'),
      p('If accuracy is in kilometres, Precise Location is off. If your position stops updating when the screen locks, that is iOS — web apps cannot track in the background; keep the screen on while recording (Unfog keeps it awake, except in Low Power Mode).', 'muted small'),
    ),
    routes: section(
      'routes',
      'What the routes do',
      p('Pick a destination, and Unfog searches the street map for routes that spend as much distance as possible on streets you have never been on — within the detour budget you set.'),
      el(
        'ul',
        { class: 'plain bullets' },
        el('li', { text: 'Detour budget: +25% means any candidate may be up to 25% longer than the shortest route.' }),
        el('li', { text: '"% new" is the share of the route on never-visited streets; "unexplored" is that distance.' }),
        el('li', { text: 'Most new maximises unexplored distance; Balanced trades a little; Direct is the shortest and is always shown.' }),
        el('li', { text: 'Walk ignores one-way streets and allows steps; Bike follows one-way rules; Drive skips footpaths.' }),
        el('li', { text: 'No destination in mind? "Where to?" → "Explore a loop from here" gives round trips of a length you choose.' }),
        el('li', { text: 'Routing needs street data: prebuilt regions (Data → Routing data) or "Download this area" when you plan a route somewhere new (needs a connection once).' }),
      ),
    ),
    settings: section('settings', 'Settings', settingsBody),
  };

  host.append(
    el('header', { class: 'screen-head' }, el('h1', { text: 'Help' })),
    el(
      'div',
      { class: 'screen-body' },
      sections.export,
      sections.install,
      sections.location,
      sections.routes,
      sections.settings,
      el('p', { class: 'muted small about', text: `Unfog ${APP_VERSION} · Map © OpenFreeMap / OpenStreetMap contributors · Search by Photon (komoot) · Everything stays on this device.` }),
    ),
  );

  return {
    refresh() {
      renderSettings();
    },
    show(id) {
      for (const [k, d] of Object.entries(sections)) d.open = k === id;
      sections[id].scrollIntoView({ block: 'start' });
    },
  };
}

/** Bottom card on iOS Safari when not installed: Share → Add to Home Screen → Add. */
export function showInstallCardIfNeeded(ctx: AppContext): void {
  if (!isIOS() || isStandalone()) return;
  const dismissedAt = readJSON<number>(INSTALL_DISMISS_KEY, 0);
  if (Date.now() - dismissedAt < 7 * 86_400_000) return;
  const card = el(
    'div',
    { class: 'install-card', role: 'region', 'aria-label': 'Install Unfog' },
    el('button', { class: 'icon-btn card-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, svg(icons.close)),
    el('div', { class: 'name', text: 'Install Unfog on your Home Screen' }),
    el('div', { class: 'st', text: 'Full screen, works offline, keeps your data.' }),
    el(
      'ol',
      { class: 'install-steps' },
      el('li', {}, svg(icons.iosShare, 'ic'), el('span', {}, 'Tap ', el('b', { text: 'Share' }), ' in Safari')),
      el('li', {}, svg(icons.iosAdd, 'ic'), el('span', {}, 'Tap ', el('b', { text: 'Add to Home Screen' }))),
      el('li', {}, svg(icons.check, 'ic'), el('span', {}, 'Tap ', el('b', { text: 'Add' }))),
    ),
    el('button', { class: 'btn ghost small', type: 'button', onclick: () => { dismiss(); ctx.openHelp('install'); } }, 'More about installing'),
  );
  function dismiss(): void {
    writeJSON(INSTALL_DISMISS_KEY, Date.now());
    card.remove();
  }
  ctx.shell.sheetHost.appendChild(card);
}
