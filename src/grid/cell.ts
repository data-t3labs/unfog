/**
 * Cell math — the one coordinate system every module shares.
 *
 * A cell is one Web-Mercator pixel at zoom 22 ("z22 pixel"): the world is 2^22 cells wide.
 * This is exactly Fog of World's pixel grid (world = 512 z9 tiles × 128 blocks × 64 px), so
 * FoW imports map 1:1 with no resampling. Ground size: 9.55 m at the equator, ×cos(lat)
 * elsewhere (7.2 m in NYC, 6.3 m in Vancouver).
 *
 * Cells are stored in "cell tiles": 256×256 cells keyed by the zoom-14 tile that contains
 * them (z22 − 8 = z14). Overview levels keep the same 256×256 shape at coarser zooms — see
 * ./types.ts.
 */

export const CELL_ZOOM = 22;
/** World width/height in cells at zoom 22. */
export const WORLD = 1 << CELL_ZOOM; // 4_194_304
/** Cell tiles are zoom-14 tiles. */
export const TILE_ZOOM = 14;
/** Cells per cell-tile side (2^(22−14)). */
export const TILE_SIZE = 256;
export const TILE_SHIFT = CELL_ZOOM - TILE_ZOOM; // 8
export const TILE_MASK = TILE_SIZE - 1;
/** Number of cell tiles per axis. */
export const TILES_PER_AXIS = 1 << TILE_ZOOM; // 16384

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const DEG = Math.PI / 180;
const MAX_LAT = 85.05112878;

/** Cell containing a lon/lat (floors). Latitude is clamped to the Mercator range. */
export function lonLatToCell(lon: number, lat: number): [cx: number, cy: number] {
  const [x, y] = lonLatToWorld(lon, lat);
  return [clampCell(Math.floor(x)), clampCell(Math.floor(y))];
}

/** Fractional world coordinates in cell units (no floor) — useful for sampling along lines. */
export function lonLatToWorld(lon: number, lat: number): [x: number, y: number] {
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const x = ((lon + 180) / 360) * WORLD;
  const s = Math.sin(la * DEG);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
  return [x, y];
}

/** Lon/lat of a cell; `centre` = cell centre (default), otherwise the north-west corner. */
export function cellToLonLat(cx: number, cy: number, centre = true): [lon: number, lat: number] {
  const off = centre ? 0.5 : 0;
  return worldToLonLat(cx + off, cy + off);
}

export function worldToLonLat(x: number, y: number): [lon: number, lat: number] {
  const lon = (x / WORLD) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / WORLD;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

function clampCell(v: number): number {
  return v < 0 ? 0 : v >= WORLD ? WORLD - 1 : v;
}

/** Split a cell into its cell tile (z14 x/y) and the index inside the tile. */
export function cellToTile(cx: number, cy: number): { tx: number; ty: number; ix: number; iy: number } {
  return { tx: cx >> TILE_SHIFT, ty: cy >> TILE_SHIFT, ix: cx & TILE_MASK, iy: cy & TILE_MASK };
}

/** Index of a cell inside its tile's 256×256 array (row-major, y then x). */
export function cellIndex(ix: number, iy: number): number {
  return iy * TILE_SIZE + ix;
}

/** Numeric key for a (level, tx, ty) tile — unique across levels 0..14. */
export function tileKey(level: number, tx: number, ty: number): number {
  // level in the top bits keeps keys unique across overview levels.
  return (level * TILES_PER_AXIS + tx) * TILES_PER_AXIS + ty;
}

export function parseTileKey(key: number): { level: number; tx: number; ty: number } {
  const ty = key % TILES_PER_AXIS;
  const rest = (key - ty) / TILES_PER_AXIS;
  const tx = rest % TILES_PER_AXIS;
  const level = (rest - tx) / TILES_PER_AXIS;
  return { level, tx, ty };
}

/** String key used for IndexedDB records: "level/tx/ty". */
export function tileId(level: number, tx: number, ty: number): string {
  return `${level}/${tx}/${ty}`;
}

/** Ground size of one z22 cell (metres) at a latitude. */
export function metresPerCell(lat: number): number {
  return (EARTH_CIRCUMFERENCE_M / WORLD) * Math.cos(lat * DEG);
}

/** Ground area (m²) of the cell at row `cy` (uses the row's centre latitude). */
export function cellAreaM2(cy: number): number {
  const [, lat] = worldToLonLat(0, cy + 0.5);
  const m = metresPerCell(lat);
  return m * m;
}

/**
 * Fog of World address → cell. FoW: world = 512×512 z9 tiles, tile = 128×128 blocks,
 * block = 64×64 pixels. gx = (tileX<<13)|(blockX<<6)|px, likewise gy.
 */
export function fowToCell(tileX: number, tileY: number, blockX: number, blockY: number, px: number, py: number): [cx: number, cy: number] {
  return [(tileX << 13) | (blockX << 6) | px, (tileY << 13) | (blockY << 6) | py];
}

/** Bounding box of a cell tile at a given overview level, in lon/lat. */
export function tileBounds(level: number, tx: number, ty: number): { west: number; south: number; east: number; north: number } {
  const cellsPerTileCell = 1 << (CELL_ZOOM - level - 8); // z22 cells per level cell
  const span = TILE_SIZE * cellsPerTileCell; // z22 cells per tile side
  const x0 = tx * span, y0 = ty * span;
  const [west, north] = worldToLonLat(x0, y0);
  const [east, south] = worldToLonLat(x0 + span, y0 + span);
  return { west, south, east, north };
}

/**
 * Sample a polyline (lon/lat) every `stepM` metres and return the distinct cells it touches,
 * in order, without duplicates. Consecutive points further apart than `gapM` are treated as a
 * break (no cells are marked between them). Used by the track rasteriser and novelty scoring.
 */
export function cellsAlong(
  points: ReadonlyArray<readonly [lon: number, lat: number]>,
  opts: { stepM?: number; gapM?: number } = {},
): Array<[cx: number, cy: number]> {
  const stepM = opts.stepM ?? 4;
  const gapM = opts.gapM ?? 500;
  const out: Array<[number, number]> = [];
  let lastKey = -1;
  const push = (cx: number, cy: number) => {
    const k = cy * WORLD + cx;
    if (k !== lastKey) { out.push([cx, cy]); lastKey = k; }
  };
  for (let i = 0; i < points.length; i++) {
    const [lon, lat] = points[i];
    if (i === 0) { const [cx, cy] = lonLatToCell(lon, lat); push(cx, cy); continue; }
    const [plon, plat] = points[i - 1];
    const d = distanceM(plon, plat, lon, lat);
    if (d > gapM) { const [cx, cy] = lonLatToCell(lon, lat); lastKey = -1; push(cx, cy); continue; }
    const [x0, y0] = lonLatToWorld(plon, plat);
    const [x1, y1] = lonLatToWorld(lon, lat);
    const n = Math.max(1, Math.ceil(d / stepM));
    for (let t = 1; t <= n; t++) {
      const x = x0 + ((x1 - x0) * t) / n, y = y0 + ((y1 - y0) * t) / n;
      push(clampCell(Math.floor(x)), clampCell(Math.floor(y)));
    }
  }
  return out;
}

/** Fast planar distance in metres (equirectangular; <0.5% error at city scale). */
export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const kx = 111_320 * Math.cos(((lat1 + lat2) / 2) * DEG);
  const ky = 110_574;
  const dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * ky;
  return Math.sqrt(dx * dx + dy * dy);
}
