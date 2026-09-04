/** Help screen (FoW export, install, tracking, location, how routes work), settings, and the iOS install card. */
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

function bullets(items: Array<string | HTMLElement>): HTMLElement {
  return el('ul', { class: 'plain bullets' }, items.map((i) => el('li', typeof i === 'string' ? { text: i } : {}, typeof i === 'string' ? null : i)));
}

export function createHelpScreen(ctx: AppContext): HelpScreen {
  const host = ctx.shell.screens.help;
  const settingsBody = el('div', { class: 'settings' });

  function renderSettings(): void {
    const s = getSettings();
    settingsBody.replaceChildren(
      // The once-a-year switch (feedback-2). The prompt for location comes from this tap the first time.
      switchRow('Track my movement', s.tracking, (on) => ctx.tracking.setEnabled(on)),
      el(
        'p',
        { class: 'muted small setting-note' },
        'Clears the fog as you move, whenever Unfog is open and on screen — nothing to start or stop. iOS only lets a web app record while it is open and the screen is on; for the rest of the day see ',
        el('button', { class: 'text-link', type: 'button', onclick: () => ctx.openHelp('always') }, 'Always recording'),
        '.',
      ),
      segRow('Basemap', [['bright', 'Map'], ['dark', 'Dark'], ['satellite', 'Satellite']], s.basemap, (v) => updateSettings({ basemap: v as AppSettings['basemap'] })),
      segRow('Units', [['metric', 'km'], ['imperial', 'miles']], s.units, (v) => updateSettings({ units: v as AppSettings['units'] })),
      segRow('Cleared core', [['1', 'Normal (≈20 m)'], ['0', 'Tight (≈7 m)']], String(s.coreRadius), (v) => updateSettings({ coreRadius: v === '0' ? 0 : 1 })),
      // Softness is a blur radius in cells (2–6); shown as a percentage of that range like the other sliders.
      rangeRow('Fog softness', 2, 6, 0.25, s.feather, (v) => `${Math.round(((v - 2) / 4) * 100)}%`, (v) => updateSettings({ feather: v })),
      rangeRow('Reveal (halo)', 0, 0.8, 0.05, s.halo, (v) => `${Math.round(v * 100)}%`, (v) => updateSettings({ halo: v })),
      rangeRow('Fog strength', 0.5, 0.95, 0.05, s.fogAlpha, (v) => `${Math.round(v * 100)}%`, (v) => updateSettings({ fogAlpha: v })),
    );
  }

  /** An iOS-style switch; `onChange` resolves to the state that actually took (location may be refused). */
  function switchRow(label: string, checked: boolean, onChange: (on: boolean) => Promise<boolean>): HTMLElement {
    const sw = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label }, el('span', { class: 'knob' }));
    sw.addEventListener('click', async () => {
      const want = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      sw.setAttribute('aria-checked', String(want));
      try {
        sw.setAttribute('aria-checked', String(await onChange(want)));
      } finally {
        sw.disabled = false;
      }
    });
    return el('div', { class: 'setting' }, el('label', { text: label }), sw);
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
    tracking: section(
      'tracking',
      'Tracking',
      p('Turn on Track my movement (Settings, below) and Unfog clears the fog as you move, whenever it is open and on screen. There is nothing to start or stop; a small "Tracking" pill on the map is the only sign.'),
      bullets([
        'Unfog keeps the screen awake while it tracks (except in Low Power Mode). Lock the phone or switch apps and the trail pauses until you come back — see Always recording for why.',
        'GPS fixes worse than 50 m are skipped, so indoors or just after launch the pill may say "waiting for GPS" until you are outside.',
        'Each day the app is open is one session (a fresh launch starts a new one). Data → Sessions lists them with GPX export for Fog of World’s Import folder.',
        'Location is asked for when you flip the switch. If iOS says no, see Location not working.',
      ]),
    ),
    always: section(
      'always',
      'Always recording',
      p('iOS only lets a web app record while it is open and the screen is on. Lock the phone or switch apps and the trail pauses until you come back. No web app can do better, and Unfog will not pretend to.'),
      p('For a record of everywhere you go:'),
      bullets([
        'Fog of World records in the background. Keep it as your recorder and import its Sync.zip now and then (Get your history out of Fog of World, above) — the map lines up exactly.',
        'Overland, a free iOS app that logs your location in the background, is next: an import path for its logs is coming.',
      ]),
      p('Either way nothing needs an account: you hand Unfog a file, and it reads it on the phone.', 'muted small'),
    ),
    location: section(
      'location',
      'Location not working',
      p('Location only starts from a tap: the locate button, Go, or the Track my movement switch. If iOS says location is denied:'),
      steps([
        'Settings › Privacy & Security › Location Services — on',
        'Same screen → Safari Websites → "While Using the App", and Precise Location on',
        'Settings › Apps › Safari › Location → Ask or Allow',
        'In Safari (before installing): tap "AA" / page menu → Website Settings → Location → Allow',
      ]),
      p('iOS 26.0–26.0.1 had a bug where an installed web app got "denied" while the same site worked in Safari. Fix: Settings › General › Transfer or Reset iPhone › Reset › Reset Location & Privacy, then open Unfog and allow again.', 'muted small'),
      p('If accuracy is in kilometres, Precise Location is off. If your position stops updating when the screen locks, that is iOS — web apps cannot track in the background; keep the screen on while tracking (Unfog keeps it awake, except in Low Power Mode).', 'muted small'),
    ),
    routes: section(
      'routes',
      'What the routes do',
      p('Pick a destination, and Unfog searches the street map for routes that spend as much distance as possible on streets you have never been on — within the detour budget you set.'),
      bullets([
        'Routes follow paths where they exist — streets, footpaths, stairs, park paths, in either direction — and straight lines where they don’t (drawn dashed, with the off-path distance noted). Times are at walking pace.',
        'Detour budget: +25% means any candidate may be up to 25% longer than the shortest route.',
        '"% new" is the share of the route on never-visited streets; "unexplored" is that distance.',
        'Most new maximises unexplored distance; Balanced trades a little; Direct is the shortest and is always shown.',
        'No destination in mind? "Where to?" → "Explore a loop from here" gives round trips of a length you choose.',
        'Street data comes by itself: as you move around (and wherever you plan a route), Unfog downloads the streets of that area in the background — Wi-Fi or mobile, paused when Low Data Mode is on — and keeps them for routes offline. Data → Routing data shows what is on your phone; nothing is lost by clearing it. Where no streets are known yet, routes are straight lines you can still follow, and "Download this area" fetches a place outside the automatic coverage (North America today).',
      ]),
    ),
    navigate: section(
      'navigate',
      'Navigate with Google Maps',
      p('Unfog can show a route while it is open, but a web app cannot talk you through the turns with the screen off. Google Maps can: under Go, tap Google Maps and the route opens there as walking directions, ready for turn-by-turn.'),
      bullets([
        'Google Maps takes at most 9 checkpoints per trip. Unfog picks the 9 corners that matter most; when a route needs more, it opens in parts (1 of 3, 2 of 3…), one button each. Open the next part when you reach the end of one.',
        'Between checkpoints Google walks its own streets, so it may take a small shortcut past a corner Unfog would have turned at. The checkpoints are the corners that matter.',
        'A route that starts where you stand starts turn-by-turn at once. A route planned from the map centre, and every later part, starts at its own point: Google shows a preview until you get there, then Start.',
        'Off-path and straight legs (drawn dashed) are fine: Google finds its own way to the next checkpoint.',
        'Apple Maps takes one destination and no checkpoints, so that button only walks you to the end of the route, the way Apple sees fit. Loops have no destination, so it is not offered there.',
        'Save GPX writes the route as a file for any other app (Komoot, Gaia, OsmAnd, AllTrails…): share sheet → the app, or Save to Files.',
      ]),
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
      sections.tracking,
      sections.always,
      sections.location,
      sections.routes,
      sections.navigate,
      sections.settings,
      // The build stamp tells which deploy this phone runs after an "Update available" reload.
      el(
        'p',
        { class: 'muted small about' },
        `Unfog ${APP_VERSION} · build `,
        el('span', { class: 'build', text: typeof __UNFOG_BUILD__ === 'string' ? __UNFOG_BUILD__ : 'dev' }),
        ' · Map © OpenFreeMap / OpenStreetMap contributors · Satellite tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Search by Photon (komoot) · Everything stays on this device.',
      ),
    ),
  );

  return {
    refresh() {
      renderSettings();
    },
    show(id) {
      renderSettings();
      for (const [k, d] of Object.entries(sections)) d.open = k === id;
      sections[id].scrollIntoView({ block: 'start' });
    },
  };
}

/**
 * Bottom card on iOS Safari when not installed: Share → Add to Home Screen → Add. Returns whether
 * it was shown; `onDismiss` runs when the user closes it (the tracking offer waits for that).
 */
export function showInstallCardIfNeeded(ctx: AppContext, onDismiss?: () => void): boolean {
  if (!isIOS() || isStandalone()) return false;
  const dismissedAt = readJSON<number>(INSTALL_DISMISS_KEY, 0);
  if (Date.now() - dismissedAt < 7 * 86_400_000) return false;
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
    onDismiss?.();
  }
  ctx.shell.sheetHost.appendChild(card);
  return true;
}
