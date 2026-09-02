/* Unfog mockup: real basemap + real streets; synthetic visited grid on the FoW z22 cell grid;
   route candidates from a real penalised Dijkstra (cost = len * (1 + λ(1-novelty))). */
(async function () {
  const q = new URLSearchParams(location.search);
  const VIEW = q.get('view') || 'fog';          // fog | heat | off | route
  const BASE = q.get('base') || 'light';        // light | dark
  const SEED = +(q.get('seed') || 7);
  const FEATHER = +(q.get('feather') || 1.1);   // wide blur radius in cells (the deep feather)
  const CORE = +(q.get('core') || 3);            // ribbon core width in cells (1 or 3)
  const HALO = +(q.get('halo') || 0);            // how much of the fog the wide halo lifts (0..1); 0 = single-scale mode
  if (BASE === 'light') document.documentElement.classList.add('light');

  const HOME = [-73.9568, 40.7176];   // Bedford Av & N 7th St
  const DEST = [-73.9678, 40.7142];   // Domino Park
  const W22 = 1 << 22;

  // ---- helpers ---------------------------------------------------------
  function worldPx(lon, lat) {
    const x = (lon + 180) / 360 * W22;
    const s = Math.sin(lat * Math.PI / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W22;
    return [x, y];
  }
  function lonLatOfPx(x, y) {
    const lon = x / W22 * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / W22;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lon, lat];
  }
  const KX = 111320 * Math.cos(40.716 * Math.PI / 180), KY = 110574; // metres per degree (cheap ruler)
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
  let s = SEED >>> 0; const rnd = () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // ---- streets -> synthetic visited grid ---------------------------------
  const data = await (await fetch('streets.json')).json();
  const ways = data.elements.filter(e => e.type === 'way' && e.geometry && e.nodes);
  const cells = new Map(); // key -> count
  const key = (cx, cy) => cy * W22 + cx;
  function mark(lon, lat, count) {
    const [x, y] = worldPx(lon, lat); const cx = Math.floor(x), cy = Math.floor(y);
    const r = CORE >= 3 ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = key(cx + dx, cy + dy); const c = cells.get(k) || 0; if (count > c) cells.set(k, count);
    }
  }
  const visitedWay = new Array(ways.length).fill(0);
  ways.forEach((w, i) => {
    const g = w.geometry; const mid = g[Math.floor(g.length / 2)];
    const d = dist([mid.lon, mid.lat], HOME);
    const p = 0.92 * Math.exp(-d / 420) + 0.07;
    if (rnd() < p) {
      const count = 1 + Math.floor(Math.pow(rnd(), 1.4) * 9 * Math.exp(-d / 380));
      visitedWay[i] = count;
      for (let j = 1; j < g.length; j++) {
        const a = [g[j - 1].lon, g[j - 1].lat], b = [g[j].lon, g[j].lat];
        const n = Math.max(1, Math.ceil(dist(a, b) / 3));
        for (let t = 0; t <= n; t++) mark(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n, count);
      }
    }
  });
  const visitedAt = (lon, lat) => { const [x, y] = worldPx(lon, lat); return cells.has(key(Math.floor(x), Math.floor(y))); };
  const CELL_M2 = Math.pow(40075016.686 / W22 * Math.cos(40.716 * Math.PI / 180), 2);
  document.getElementById('area').textContent = (cells.size * CELL_M2 / 1e6).toFixed(1) + ' km²';
  document.getElementById('newwk').textContent = '0.6 km²';

  // ---- graph + penalised Dijkstra -------------------------------------------
  const nodes = new Map(); const adj = new Map();
  const edges = []; // {a,b,len,nov}
  function addEdge(a, b, len, nov, wi) {
    const id = edges.length; edges.push({ a, b, len, nov, wi });
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(id); adj.get(b).push(id);
  }
  ways.forEach((w, wi) => {
    for (let j = 0; j < w.nodes.length; j++) nodes.set(w.nodes[j], [w.geometry[j].lon, w.geometry[j].lat]);
    for (let j = 1; j < w.nodes.length; j++) {
      const a = w.nodes[j - 1], b = w.nodes[j]; const pa = nodes.get(a), pb = nodes.get(b);
      const len = dist(pa, pb); if (len < 0.01) continue;
      const n = Math.max(1, Math.ceil(len / 5)); let seen = 0;
      for (let t = 0; t <= n; t++) if (visitedAt(pa[0] + (pb[0] - pa[0]) * t / n, pa[1] + (pb[1] - pa[1]) * t / n)) seen++;
      addEdge(a, b, len, 1 - seen / (n + 1), wi);
    }
  });
  function nearest(p) { let best = null, bd = 1e9; for (const [id, c] of nodes) { const d = dist(c, p); if (d < bd && (adj.get(id) || []).length) { bd = d; best = id; } } return best; }
  const S = nearest(HOME), T = nearest(DEST);
  // binary heap
  class Heap { constructor() { this.a = []; } push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } get size() { return this.a.length; } }
  function route(lambda) {
    const distv = new Map([[S, 0]]), prev = new Map(); const h = new Heap(); h.push(0, S);
    while (h.size) { const [d, u] = h.pop(); if (d > distv.get(u)) continue; if (u === T) break;
      for (const eid of adj.get(u)) { const e = edges[eid]; const v = e.a === u ? e.b : e.a;
        const nd = d + e.len * (1 + lambda * (1 - e.nov)); if (nd < (distv.get(v) ?? Infinity)) { distv.set(v, nd); prev.set(v, eid); h.push(nd, v); } } }
    const path = []; let u = T; let len = 0, nlen = 0; const eset = new Set();
    while (u !== S) { const eid = prev.get(u); if (eid === undefined) return null; const e = edges[eid]; path.push(nodes.get(u)); len += e.len; nlen += e.len * e.nov; eset.add(eid); u = e.a === u ? e.b : e.a; }
    path.push(nodes.get(S)); path.reverse();
    return { lambda, path, len, nlen, eset };
  }
  const shortest = route(0); const BUDGET = shortest.len * 1.25;
  const sweep = [0.35, 0.7, 1, 1.5, 2, 3, 4, 6, 9].map(route).filter(r => r && r.len <= BUDGET + 1);
  const cands = [];
  for (const r of sweep.sort((a, b) => b.nlen - a.nlen)) {
    let dup = false; for (const c of cands) { let inter = 0; for (const e of r.eset) if (c.eset.has(e)) inter++; if (inter / Math.min(r.eset.size, c.eset.size) > 0.6) dup = true; }
    if (!dup) cands.push(r); if (cands.length === 2) break;
  }
  cands.push(shortest);
  const names = cands.length === 3 ? ['Most new', 'Balanced', 'Direct'] : ['Most new', 'Direct']; const colors = cands.length === 3 ? ['#ff8a3d', '#ffc857', '#7fb2ff'] : ['#ff8a3d', '#7fb2ff'];
  const eta = m => Math.round(m / 1000 / 4.8 * 60) + ' min';
  const km = m => (m / 1000).toFixed(1) + ' km';

  // ---- map ----------------------------------------------------------------------
  const STYLE = q.get('style') || (BASE === 'light' ? 'bright' : 'dark');
  const style = 'https://tiles.openfreemap.org/styles/' + STYLE;
  const center = VIEW === 'route' ? [-73.9628, 40.7148] : [-73.9585, 40.7160];
  const map = new maplibregl.Map({ container: 'map', style, center, zoom: 15.35, attributionControl: false, interactive: false, pixelRatio: window.devicePixelRatio });
  await new Promise(res => map.once('load', res));
  for (const l of map.getStyle().layers) if (l.type === 'symbol' && /^poi|transit|housenumber|airport|station/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');

  // fog / heat overlay: cells rasterised at 3x device resolution, feathered with a blur, then mapped to soft fog or a heat glow
  function drawOverlay(mode) {
    const b = map.getBounds();
    const [x0f, y0f] = worldPx(b.getWest(), b.getNorth()); const [x1f, y1f] = worldPx(b.getEast(), b.getSouth());
    const cx0 = Math.floor(x0f) - 2, cy0 = Math.floor(y0f) - 2, cx1 = Math.ceil(x1f) + 2, cy1 = Math.ceil(y1f) + 2;
    const W = cx1 - cx0, H = cy1 - cy0;
    const cellPx = map.getContainer().clientWidth / (x1f - x0f);          // css px per cell at this zoom
    const K = Math.max(2, Math.round(cellPx * 3));                        // canvas px per cell (3x device)
    const small = document.createElement('canvas'); small.width = W; small.height = H;
    const sctx = small.getContext('2d'); const img = sctx.createImageData(W, H); const px = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = cells.get(key(cx0 + x, cy0 + y)) || 0; if (!c) continue; const i = (y * W + x) * 4;
      const v = mode === 'heat' ? Math.round(255 * Math.min(1, 0.22 + 0.78 * (c - 1) / 7)) : 255;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const big = document.createElement('canvas'); big.width = W * K; big.height = H * K;
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.filter = `blur(${Math.round(K * (HALO > 0 ? 0.9 : FEATHER))}px)`;
    bctx.drawImage(small, 0, 0, W * K, H * K);
    bctx.filter = 'none';
    const field = bctx.getImageData(0, 0, big.width, big.height); const f = field.data;
    let fw = f;
    if (HALO > 0) {
      const wide = document.createElement('canvas'); wide.width = big.width; wide.height = big.height;
      const wctx = wide.getContext('2d'); wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'high';
      wctx.filter = `blur(${Math.round(K * FEATHER)}px)`; wctx.drawImage(small, 0, 0, W * K, H * K); wctx.filter = 'none';
      fw = wctx.getImageData(0, 0, big.width, big.height).data;
    }
    const out = bctx.createImageData(big.width, big.height); const o = out.data;
    const fog = BASE === 'light' ? [16, 20, 30, 0.80] : [205, 208, 218, 0.55];
    const dim = BASE === 'light' ? [12, 15, 24, 0.68] : [5, 8, 18, 0.55];
    const smooth = (a, b, t) => { const u = Math.min(1, Math.max(0, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
    const ramp = v => { // heat glow: transparent -> amber -> orange -> red -> hot
      if (v < 0.08) return [255, 200, 110, 0];
      const stops = [[0.08, [255, 214, 120], 0.55], [0.3, [255, 168, 70], 0.85], [0.55, [255, 104, 56], 0.92], [0.8, [255, 56, 70], 0.96], [1.0, [255, 40, 120], 1]];
      for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) { const [a0, c0, o0] = stops[i - 1], [a1, c1, o1] = stops[i]; const t = (v - a0) / (a1 - a0);
        return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t, o0 + (o1 - o0) * t]; }
      return [255, 40, 120, 1];
    };
    for (let i = 0; i < f.length; i += 4) {
      const m = (f[i + 3] / 255) * (f[i] / 255);   // coverage x intensity
      if (mode === 'fog') {
        const cover = f[i + 3] / 255;
        let clear = smooth(FEATHER > 2 && HALO === 0 ? 0.06 : 0.2, FEATHER > 2 && HALO === 0 ? 0.45 : 0.68, cover);
        if (HALO > 0) { const wc = fw[i + 3] / 255; clear = Math.max(smooth(0.3, 0.85, cover), HALO * smooth(0.03, 0.5, wc)); }
        const a = fog[3] * (1 - clear);
        o[i] = fog[0]; o[i + 1] = fog[1]; o[i + 2] = fog[2]; o[i + 3] = Math.round(a * 255);
      } else {
        const [r, g, bb, ha] = ramp(m); const a = ha * smooth(0.02, 0.2, f[i + 3] / 255);
        // composite heat over the dim layer
        const da = dim[3];
        const outA = a + da * (1 - a);
        o[i] = Math.round((r * a + dim[0] * da * (1 - a)) / outA); o[i + 1] = Math.round((g * a + dim[1] * da * (1 - a)) / outA);
        o[i + 2] = Math.round((bb * a + dim[2] * da * (1 - a)) / outA); o[i + 3] = Math.round(outA * 255);
      }
    }
    bctx.putImageData(out, 0, 0);
    const nw = lonLatOfPx(cx0, cy0), ne = lonLatOfPx(cx1, cy0), se = lonLatOfPx(cx1, cy1), sw = lonLatOfPx(cx0, cy1);
    map.addSource('overlay', { type: 'canvas', canvas: big, coordinates: [nw, ne, se, sw], animate: false });
    const before = map.getStyle().layers.find(l => l.type === 'symbol')?.id; // keep labels above the fog
    map.addLayer({ id: 'overlay', type: 'raster', source: 'overlay', paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear', 'raster-opacity': VIEW === 'route' ? 0.9 : 1 } }, before);
  }
  if (VIEW === 'route') {
    let w = 180, e = -180, so = 90, n = -90;
    for (const c of cands) for (const [x, y] of c.path) { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); }
    map.fitBounds([[w, so], [e, n]], { padding: { top: 150, bottom: 420, left: 40, right: 40 }, animate: false });
    await new Promise(res => map.once('idle', res));
  }
  const overlayMode = VIEW === 'route' ? 'fog' : VIEW;
  if (overlayMode !== 'off') drawOverlay(overlayMode);
  if (VIEW === 'heat') document.getElementById('legend').classList.remove('hidden');

  // chrome state
  document.querySelectorAll('#seg button').forEach(bt => bt.classList.toggle('on', bt.dataset.v === (VIEW === 'route' ? 'fog' : VIEW)));
  const homeEl = document.createElement('div');
  homeEl.style.cssText = 'width:44px;height:44px;border-radius:50%;background:rgba(10,132,255,0.18);display:flex;align-items:center;justify-content:center';
  homeEl.innerHTML = '<div style="width:16px;height:16px;border-radius:50%;background:#0a84ff;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>';
  new maplibregl.Marker({ element: homeEl }).setLngLat(HOME).addTo(map);

  if (VIEW === 'route') {
    document.getElementById('float').classList.add('hidden');
    document.getElementById('tabs').classList.add('hidden');
    document.getElementById('sheet').classList.remove('hidden');
    document.getElementById('searchText').textContent = 'Domino Park';
    document.getElementById('searchText').className = 'val';
    document.getElementById('direct').textContent = km(shortest.len) + ' direct';
    document.getElementById('budget').textContent = km(BUDGET);
    const list = document.getElementById('cands');
    cands.forEach((c, i) => {
      const row = document.createElement('div'); row.className = 'cand' + (i === 0 ? ' on' : '');
      row.innerHTML = `<div class="sw" style="background:${colors[i]}"></div><div class="t"><div class="name">${names[i]}</div><div class="st">${km(c.len)} · ${eta(c.len)}</div></div><div class="new">${Math.round(100 * c.nlen / c.len)}% new<small>${km(c.nlen)} unexplored</small></div>`;
      list.appendChild(row);
    });
    const fc = { type: 'FeatureCollection', features: cands.map((c, i) => ({ type: 'Feature', properties: { i, color: colors[i] }, geometry: { type: 'LineString', coordinates: c.path } })) };
    map.addSource('routes', { type: 'geojson', data: fc });
    map.addLayer({ id: 'routes-alt-casing', type: 'line', source: 'routes', filter: ['!=', ['get', 'i'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 6.5, 'line-opacity': 0.85 } });
    map.addLayer({ id: 'routes-alt', type: 'line', source: 'routes', filter: ['!=', ['get', 'i'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'routes-sel-glow', type: 'line', source: 'routes', filter: ['==', ['get', 'i'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors[0], 'line-width': 18, 'line-blur': 10, 'line-opacity': 0.55 } });
    map.addLayer({ id: 'routes-sel-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'i'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'routes-sel', type: 'line', source: 'routes', filter: ['==', ['get', 'i'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors[0], 'line-width': 5.5 } });
    const pin = document.createElement('div');
    pin.innerHTML = '<svg width="30" height="40" viewBox="0 0 30 40"><path d="M15 39C15 39 2 22 2 14a13 13 0 0 1 26 0c0 8-13 25-13 25Z" fill="#ff8a3d" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>';
    new maplibregl.Marker({ element: pin, anchor: 'bottom' }).setLngLat(DEST).addTo(map);
    window.__routes = cands.map((c, i) => ({ name: names[i], lambda: c.lambda, len: Math.round(c.len), nlen: Math.round(c.nlen), pctNew: Math.round(100 * c.nlen / c.len) }));
  }
  await new Promise(res => map.once('idle', res));
  window.__ready = true;
})();
