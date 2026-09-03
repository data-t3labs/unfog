/**
 * Route sheet (docs/mockups/route.jpg): destination title + direct distance, a one-line note on
 * what a route is, detour slider, candidate rows, Go. Go = follow mode with a compact bar and End.
 *
 * Loop mode ("Explore from here") is the same sheet with a loop-length row (2 / 3 / 5 / 8 km
 * chips + a 1–15 km slider) instead of the detour slider: `route.loop()` returns round trips from
 * the user's position (else the map centre), listed as Loop A / B / C and drawn like routes.
 *
 * One travel mode (feedback-2, data: "one mode, the most permissive"): every request goes to the
 * engine as `walk` — footpaths, stairs, both directions of every street — and times are at
 * walking pace. The Walk/Bike/Drive chips are gone; the engine keeps its Mode type for tools/tests.
 */
import type { LonLat, RouteCandidate, RouteResult } from '../routing/api';
import type { Mode } from '../routing/graph-format';
import { distanceM } from '../grid/cell';
import { candidateColor } from '../map/routes';
import type { AppContext, Destination } from './context';
import { fmtDistance, fmtDistanceTidy, fmtMinutes } from './format';
import { icons } from './icons';
import { readJSON, writeJSON } from './settings';
import { REGION_DL_KEY, ROUTE_PREFS_KEY, type RegionDownloads } from './store-keys';
import { clear, debounce, el, svg, toast } from './ui';

export type SheetKind = 'route' | 'loop';

export interface RouteSheet {
  open(dest: Destination): void;
  /** Loop mode: round trips from `from` (default: the user's position, else the map centre). */
  openLoop(from?: LonLat): void;
  close(): void;
  readonly isOpen: boolean;
  readonly following: boolean;
  readonly kind: SheetKind | null;
}

interface Prefs {
  detour: number;
  /** Loop-mode target length, km. */
  loopKm: number;
}

/** The one mode the app asks for: the most permissive network the engine has. */
export const TRAVEL_MODE: Mode = 'walk';

export const LOOP_CHIPS_KM = [2, 3, 5, 8];
export const LOOP_KM = { min: 1, max: 15, step: 0.5, default: 3 };
const LOOP_LABELS = ['A', 'B', 'C', 'D', 'E'];

function loadPrefs(): Prefs {
  const p = readJSON<Partial<Prefs>>(ROUTE_PREFS_KEY, {});
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt);
  return {
    detour: num(p.detour, 0.1, 1, 0.25),
    loopKm: num(p.loopKm, LOOP_KM.min, LOOP_KM.max, LOOP_KM.default),
  };
}

export function createRouteSheet(ctx: AppContext): RouteSheet {
  const { shell, map } = ctx;
  const prefs = loadPrefs();
  let kind: SheetKind | null = null;
  let dest: Destination | null = null;
  let loopFrom: LonLat | null = null;
  let origin: LonLat | null = null;
  let originNote = '';
  let result: RouteResult | null = null;
  let selected = 0;
  let seq = 0;
  let open = false;
  let following = false;

  // ---- DOM
  const title = el('h2');
  const closeBtn = el('button', { class: 'icon-btn sheet-close', type: 'button', 'aria-label': 'Close', onclick: () => api.close() }, svg(icons.close));
  // What a route is, in one line (where the mode chips used to be). Off-path metres go in the status line.
  const note = el('p', { class: 'sheet-note muted small' });
  // Route mode: detour budget.
  const detourLabel = el('b');
  const budgetLabel = el('span');
  const slider = el('input', { type: 'range', min: 10, max: 100, step: 5, value: Math.round(prefs.detour * 100), class: 'range', 'aria-label': 'Detour budget' });
  const sliderRow = el('div', { class: 'slider' }, el('span', { text: 'Detour budget' }), el('span', {}, detourLabel, ' · up to ', budgetLabel));
  const routeControls = el('div', { class: 'controls' }, sliderRow, slider);
  // Loop mode: target length (chips + slider).
  const loopLabel = el('b');
  const loopSlider = el('input', { type: 'range', min: LOOP_KM.min, max: LOOP_KM.max, step: LOOP_KM.step, value: prefs.loopKm, class: 'range', 'aria-label': 'Loop length' });
  const loopRow = el('div', { class: 'slider-loop' }, el('span', { text: 'Loop length' }), loopLabel);
  const chipBtns = new Map<number, HTMLButtonElement>();
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Preset lengths' });
  for (const k of LOOP_CHIPS_KM) {
    const b = el('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setLoopKm(k) });
    chipBtns.set(k, b);
    chips.appendChild(b);
  }
  const loopControls = el('div', { class: 'controls', hidden: true }, loopRow, chips, loopSlider);
  const cands = el('div', { class: 'cands' });
  const status = el('div', { class: 'route-status' });
  const goBtn = el('button', { class: 'go', type: 'button', onclick: () => void go() }, 'Go');
  const sheet = el('div', { class: 'sheet route', hidden: true }, el('div', { class: 'grab' }), closeBtn, title, note, routeControls, loopControls, cands, status, goBtn);

  const barText = el('div', { class: 't' });
  const barSwatch = el('div', { class: 'sw' });
  const bar = el(
    'div',
    { class: 'follow-bar', hidden: true },
    barSwatch,
    barText,
    el('button', { class: 'btn small', type: 'button', onclick: () => api.close() }, 'End'),
  );
  shell.sheetHost.append(sheet, bar);

  // ---- helpers
  const units = () => ctx.settings().units;
  const km = (m: number) => fmtDistance(m, units());
  /** Loop target as a label: "3 km", "4.5 km". */
  const target = () => fmtDistanceTidy(prefs.loopKm * 1000, units());
  const candName = (c: RouteCandidate, i: number) => (kind === 'loop' ? `Loop ${LOOP_LABELS[i] ?? i + 1}` : c.name);

  function savePrefs(): void {
    writeJSON(ROUTE_PREFS_KEY, prefs);
  }

  function setLoopKm(k: number): void {
    if (prefs.loopKm === k) return;
    prefs.loopKm = k;
    savePrefs();
    renderLoopControls();
    void run();
  }

  function renderControls(): void {
    routeControls.hidden = kind !== 'route';
    loopControls.hidden = kind !== 'loop';
    note.textContent =
      kind === 'loop'
        ? 'Round trips on streets and paths, timed at walking pace.'
        : 'Routes follow paths where they exist and straight lines where they don’t, timed at walking pace.';
    renderSlider();
    renderLoopControls();
  }

  function renderSlider(): void {
    detourLabel.textContent = `+${Math.round(prefs.detour * 100)}%`;
    const base = result?.shortestM ?? (dest && origin ? distanceM(origin[0], origin[1], dest.lonlat[0], dest.lonlat[1]) : 0);
    budgetLabel.textContent = base ? km(base * (1 + prefs.detour)) : '—';
    slider.style.setProperty('--fill', `${((prefs.detour * 100 - 10) / 90) * 100}%`);
  }

  function renderLoopControls(): void {
    loopLabel.textContent = target();
    loopSlider.value = String(prefs.loopKm);
    loopSlider.style.setProperty('--fill', `${((prefs.loopKm - LOOP_KM.min) / (LOOP_KM.max - LOOP_KM.min)) * 100}%`);
    for (const [k, b] of chipBtns) {
      b.textContent = fmtDistanceTidy(k * 1000, units());
      const on = Math.abs(prefs.loopKm - k) < 0.01;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function renderTitle(): void {
    clear(title);
    if (kind === 'loop') {
      title.append('Explore from here');
      const n = result?.candidates.length ?? 0;
      title.appendChild(el('small', { text: result ? `${n} loop${n === 1 ? '' : 's'} of about ${target()}` : `loops of about ${target()}` }));
      return;
    }
    if (!dest) return;
    title.append(dest.name);
    const direct = result ? `${km(result.shortestM)} direct` : origin ? `${km(distanceM(origin[0], origin[1], dest.lonlat[0], dest.lonlat[1]))} straight line` : '';
    if (direct) title.appendChild(el('small', { text: direct }));
  }

  function renderCands(): void {
    clear(cands);
    if (!result) {
      goBtn.disabled = true;
      return;
    }
    const n = result.candidates.length;
    result.candidates.forEach((c, i) => {
      const row = el(
        'button',
        { class: `cand ${i === selected ? 'on' : ''}`, type: 'button', 'aria-pressed': String(i === selected), onclick: () => select(i) },
        el('div', { class: 'sw', style: `background:${candidateColor(i, n)}` }),
        el('div', { class: 't' }, el('div', { class: 'name', text: candName(c, i) }), el('div', { class: 'st', text: `${km(c.lengthM)} · ${fmtMinutes(c.etaMin)}` })),
        el('div', { class: 'new' }, `${Math.round(c.pctNew)}% new`, el('small', { text: `${km(c.newM)} unexplored` })),
      );
      cands.appendChild(row);
    });
    goBtn.disabled = n === 0;
  }

  function setStatus(node: HTMLElement | string | null): void {
    clear(status);
    if (typeof node === 'string') status.textContent = node;
    else if (node) status.appendChild(node);
  }

  function select(i: number): void {
    selected = i;
    renderCands();
    if (result) map.showRoutes(result.candidates, selected);
  }

  /** Fit every candidate between the top chrome and the sheet (docs/BUILD-PLAN §2.2). */
  function fit(): void {
    if (!result || !result.candidates.length) return;
    const coords = result.candidates.flatMap((c) => c.coords);
    if (origin) coords.push(origin);
    if (dest) coords.push(dest.lonlat);
    map.fitCoords(coords, { top: shell.top.offsetHeight + 12, bottom: sheet.offsetHeight + 24, left: 32, right: 32 });
  }

  async function resolveOrigin(): Promise<LonLat> {
    if (kind === 'route' && dest?.origin) {
      originNote = 'from the map centre';
      return dest.origin;
    }
    if (kind === 'loop' && loopFrom) {
      originNote = 'from the map centre';
      return loopFrom;
    }
    if (map.lastFix && Date.now() - map.lastFix.timeMs < 60_000) {
      originNote = 'from your location';
      return [map.lastFix.lon, map.lastFix.lat];
    }
    try {
      const fix = await ctx.location.getOnce(8_000, 60_000);
      originNote = 'from your location';
      map.setUserPosition(fix);
      return [fix.lon, fix.lat];
    } catch {
      originNote = 'from the map centre (no location)';
      return map.center();
    }
  }

  const fromMapCentre = () => originNote.includes('map centre');
  /** Status line when the start is the map centre: says why, and how to start from your own position. */
  const originLine = () => {
    const what = kind === 'loop' ? 'Loops' : 'Routes';
    return originNote.includes('no location')
      ? `${what} start at the map centre — no location yet. Tap the locate button to start from where you are.`
      : `${what} start at the map centre.`;
  };

  async function run(): Promise<void> {
    if (!kind || (kind === 'route' && !dest)) return;
    const my = ++seq;
    result = null;
    renderCands();
    map.clearRoutes();
    setStatus(el('div', { class: 'spinner-row' }, el('span', { class: 'spinner' }), kind === 'loop' ? 'Finding loops…' : 'Finding routes…'));
    origin = await resolveOrigin();
    if (my !== seq) return;
    renderTitle();
    renderSlider();
    // Loops start where the user is; a pin marks the start only when that is the map centre.
    if (kind === 'loop') map.setDestination(fromMapCentre() ? origin : null);
    try {
      const res =
        kind === 'loop'
          ? await ctx.engines.route.loop({ from: origin, mode: TRAVEL_MODE, targetKm: prefs.loopKm })
          : await ctx.engines.route.route({ from: origin, to: dest!.lonlat, mode: TRAVEL_MODE, detour: prefs.detour });
      if (my !== seq) return;
      if (!res.candidates.length) {
        throw new Error(
          kind === 'loop'
            ? `No loop of about ${target()} found from here. Try another length.`
            : 'No route found between these points. Try a closer destination.',
        );
      }
      showResult(res);
    } catch (e) {
      if (my !== seq) return;
      const err = e as Error;
      // Show where the ends are (the pin may be off-screen) so the next step makes sense.
      if (kind === 'route' && dest) map.fitCoords([origin, dest.lonlat], { top: shell.top.offsetHeight + 12, bottom: sheet.offsetHeight + 24, left: 48, right: 48 }, 15.5);
      if (isNoCoverage(err)) {
        await offerDownload(origin, kind === 'loop' ? origin : dest!.lonlat, kind === 'loop' ? Math.min(8, Math.max(3, Math.ceil(prefs.loopKm * 0.4) + 1)) : undefined);
      } else {
        setStatus(
          el(
            'div',
            { class: 'route-error' },
            el('div', { class: 'error', text: describeError(err) }),
            // The empty route sheet offers loop mode instead.
            kind === 'route' ? el('button', { class: 'btn ghost small', type: 'button', onclick: () => api.openLoop() }, svg(icons.loop), 'Explore a loop from here instead') : null,
          ),
        );
      }
    }
  }

  /** A result (routes, loops or the straight line) is in: list it, draw it, fit it. */
  function showResult(res: RouteResult): void {
    result = res;
    selected = 0;
    // Only worth a line when we could not start from the user's position, or the route leaves the streets.
    const lines: string[] = [];
    if (fromMapCentre()) lines.push(originLine());
    const legs = kind === 'route' ? describeLegs(res) : '';
    if (legs) lines.push(legs);
    setStatus(lines.length ? el('div', { class: 'muted small', text: lines.join(' ') }) : null);
    renderTitle();
    renderSlider();
    renderCands();
    map.showRoutes(res.candidates, selected);
    fit();
  }

  /**
   * The off-path / straight parts every candidate shares (the snaps are the same for all): "Starts
   * with 240 m off-path to the nearest street", "ends with …", "1.4 km straight across a gap the
   * street map cannot join", or the whole trip as the crow flies. Short off-path legs (< 50 m: a
   * sidewalk offset, a driveway) are not worth a line.
   */
  function describeLegs(res: RouteResult): string {
    const parts = res.candidates[0]?.parts;
    if (!parts?.length) return '';
    const streetM = parts.filter((p) => p.kind === 'street').reduce((s, p) => s + p.lengthM, 0);
    const straight = parts.filter((p) => p.kind === 'straight');
    const straightM = straight.reduce((s, p) => s + p.lengthM, 0);
    if (straightM > 0 && streetM === 0) return `No street data between these points — ${km(straightM)} as the crow flies. Fog clears wherever you actually go.`;
    const bits: string[] = [];
    const first = parts[0], last = parts[parts.length - 1];
    if (first.kind === 'offroad' && first.lengthM >= 50) bits.push(`starts with ${km(first.lengthM)} off-path to the nearest street`);
    if (last.kind === 'offroad' && last.lengthM >= 50) bits.push(`ends with ${km(last.lengthM)} off-path`);
    if (straightM > 0) bits.push(`${km(straightM)} straight across a gap the street map cannot join (dashed)`);
    if (!bits.length) return '';
    const s = bits.join(', ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  }

  /**
   * Route worker errors keep their `name` across Comlink: NoCoverageError (no tiles) → offer a
   * download (and the straight line); SnapError (loops: no road for the mode near the start) →
   * a message with a next step. Anything else: the message as is.
   */
  function isNoCoverage(err: Error): boolean {
    const msg = String(err?.message ?? err);
    if (err?.name === 'NoCoverageError') return true;
    if (err?.name === 'SnapError') return false;
    return /coverage|no graph|graph data|not covered|routing data/i.test(msg);
  }

  function describeError(err: Error): string {
    const msg = String(err?.message ?? err);
    if (err?.name === 'SnapError') return 'No street or path within 5 km of your start. Move the map to a town and try again.';
    if (/timed out/i.test(msg)) return 'Routing took too long. Try a shorter distance or a smaller detour.';
    return msg;
  }

  /** "Route anyway" on no coverage: the straight line, drawn dashed, honest about what it is. */
  async function routeAnyway(from: LonLat, to: LonLat): Promise<void> {
    const my = ++seq;
    setStatus(el('div', { class: 'spinner-row' }, el('span', { class: 'spinner' }), 'Drawing the straight line…'));
    try {
      const res = await ctx.engines.route.directLine({ from, to, mode: TRAVEL_MODE, detour: prefs.detour });
      if (my !== seq) return;
      showResult(res);
    } catch (e) {
      if (my !== seq) return;
      setStatus(el('div', { class: 'route-error' }, el('div', { class: 'error', text: describeError(e as Error) })));
    }
  }

  async function offerDownload(from: LonLat, to: LonLat, radius?: number): Promise<void> {
    const centre: LonLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const span = distanceM(from[0], from[1], to[0], to[1]);
    const radiusKm = radius ?? Math.min(8, Math.max(3, Math.ceil(span / 2000) + 1));
    const box = el('div', { class: 'download-offer' }, el('div', { class: 'name', text: 'No routing data for this area yet' }));
    let regions: string[] = [];
    try {
      const cov = await ctx.engines.route.coverage([Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])]);
      regions = cov.regions;
    } catch {
      /* ignore */
    }
    const progress = el('div', { class: 'progress', hidden: true }, el('div', { class: 'bar' }));
    const progressText = el('div', { class: 'muted small' });
    const runDownload = async (label: string, task: (onProgress: (p: { phase: string; done: number; total: number; note?: string }) => void) => Promise<unknown>) => {
      progress.hidden = false;
      progressText.textContent = `${label}…`;
      for (const b of box.querySelectorAll('button')) b.disabled = true;
      // Progress arrives on the callback's own MessagePort, the result on the worker's: a progress
      // event can land after the rejection and overwrite the error line, so ignore it once settled.
      let live = true;
      try {
        // Offline, the Overpass fetch would retry for minutes before failing: say so now.
        if (navigator.onLine === false) throw new Error('No internet connection');
        await task((p) => {
          if (!live) return;
          const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
          (progress.firstElementChild as HTMLElement).style.width = `${pct}%`;
          // A note (e.g. "Overpass is busy — retrying in 15 s") replaces the bare phase counter.
          progressText.textContent = p.note ? `${label}: ${p.note}` : `${label}: ${p.phase} ${p.done}/${p.total}`;
        });
        live = false;
        toast('Routing data ready', { kind: 'success' });
        void run();
      } catch (e) {
        live = false;
        const err = e as Error;
        // EmptyAreaError (worker, name kept across Comlink): the server answered, the box has no streets.
        progressText.textContent = err?.name === 'EmptyAreaError' ? String(err.message) : `Download failed: ${String(err?.message ?? e)}. Check your connection and try again.`;
        progress.hidden = true;
        for (const b of box.querySelectorAll('button')) b.disabled = false;
      }
    };
    if (regions.length) {
      let manifests: Array<{ id: string; name: string }> = [];
      try {
        manifests = await ctx.engines.route.listRegions();
      } catch {
        /* ignore */
      }
      for (const id of regions) {
        const name = manifests.find((m) => m.id === id)?.name ?? id;
        box.appendChild(
          el('button', { class: 'btn primary', type: 'button', onclick: () => void runDownload(`Downloading ${name}`, (cb) => ctx.engines.route.downloadRegion(id, ctx.engines.proxy(cb)).then((r) => markRegion(id, r))) }, `Download ${name} for offline`),
        );
      }
    }
    box.appendChild(
      el('button', { class: `btn ${regions.length ? 'ghost' : 'primary'}`, type: 'button', onclick: () => void runDownload('Downloading area', (cb) => ctx.engines.route.downloadArea(centre, radiusKm, ctx.engines.proxy(cb))) }, `Download this area (${radiusKm} km around here)`),
    );
    // A→B without any street data can still be a straight line to follow (a loop cannot).
    if (kind === 'route') box.appendChild(el('button', { class: 'btn ghost', type: 'button', onclick: () => void routeAnyway(from, to) }, 'Route anyway (straight line)'));
    box.append(progress, progressText);
    setStatus(box);
  }

  function markRegion(id: string, r: { tiles: number; bytes: number }): void {
    const dl = readJSON<RegionDownloads>(REGION_DL_KEY, {});
    dl[id] = { at: Date.now(), tiles: r.tiles, bytes: r.bytes };
    writeJSON(REGION_DL_KEY, dl);
  }

  async function go(): Promise<void> {
    if (!result || !result.candidates[selected]) return;
    const ok = await ctx.requestLocation();
    const c = result.candidates[selected];
    following = true;
    sheet.hidden = true;
    bar.hidden = false;
    barSwatch.style.background = candidateColor(selected, result.candidates.length);
    clear(barText);
    barText.append(
      el('div', { class: 'name', text: `${candName(c, selected)} · ${km(c.lengthM)} · ${fmtMinutes(c.etaMin)}` }),
      el('div', { class: 'st', text: `${Math.round(c.pctNew)}% new · ${kind === 'loop' ? 'round trip from here' : dest?.name ?? ''}` }),
    );
    map.showRoutes([c], 0);
    if (ok) map.setFollow(true, 16.5);
    else toast('Showing the route without your location — tap the locate button to see yourself on it. End closes it.');
  }

  const rerun = debounce(() => void run(), 350);
  slider.addEventListener('input', () => {
    prefs.detour = Number(slider.value) / 100;
    renderSlider();
  });
  slider.addEventListener('change', () => {
    savePrefs();
    rerun();
  });
  loopSlider.addEventListener('input', () => {
    prefs.loopKm = Number(loopSlider.value);
    renderLoopControls();
  });
  loopSlider.addEventListener('change', () => {
    savePrefs();
    rerun();
  });

  /** Common start of open() / openLoop(): show the sheet, take over the search pill. */
  function begin(k: SheetKind, pillText: string): void {
    kind = k;
    open = true;
    following = false;
    result = null;
    bar.hidden = true;
    sheet.hidden = false;
    sheet.classList.toggle('loop', k === 'loop');
    sheet.dataset.kind = k;
    shell.setMapChromeHidden(true);
    shell.searchText.textContent = pillText;
    shell.searchText.className = 'val';
    shell.searchClear.hidden = false;
    map.setRouteMode(true);
    renderTitle();
    renderControls();
    renderCands();
    void run();
  }

  const api: RouteSheet = {
    get isOpen() {
      return open;
    },
    get following() {
      return following;
    },
    get kind() {
      return open ? kind : null;
    },
    open(d) {
      dest = d;
      loopFrom = null;
      map.setDestination(d.lonlat);
      begin('route', d.name);
    },
    openLoop(from) {
      dest = null;
      loopFrom = from ?? null;
      map.setDestination(null);
      begin('loop', 'Loop from here');
    },
    close() {
      if (!open) return;
      open = false;
      following = false;
      seq++;
      kind = null;
      dest = null;
      loopFrom = null;
      result = null;
      sheet.hidden = true;
      sheet.classList.remove('loop');
      delete sheet.dataset.kind;
      bar.hidden = true;
      shell.setMapChromeHidden(false);
      shell.searchText.textContent = 'Where to?';
      shell.searchText.className = 'ph';
      shell.searchClear.hidden = true;
      map.clearRoutes();
      map.setDestination(null);
      map.setRouteMode(false);
      map.setFollow(false);
    },
  };
  return api;
}

export type { RouteCandidate };
