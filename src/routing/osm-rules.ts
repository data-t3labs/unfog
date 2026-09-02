/**
 * OSM tag rules — the single table that decides which ways enter the routing graph and which
 * modes may use them. Pure (no DOM, no Node); runs in the build CLI and in route.worker's
 * on-demand Overpass downloader. Unit-tested row by row in osm-rules.test.ts.
 *
 * "What counts" follows the Wandrer rule (research §3f): a street counts once, so sidewalks,
 * crossings, driveways, parking aisles and unnamed service roads are dropped.
 */
import type { WayClass } from './osm-types';

export interface ClassifyOptions {
  /** Offer footway=sidewalk as GLUE candidates (default true; graph-build keeps only the connecting spans). */
  glueSidewalks?: boolean;
  /** Offer driveways, parking aisles and unnamed service roads as GLUE candidates (default true). */
  glueService?: boolean;
}

/** WayClass plus the builder-only GLUE marker (connector that routes but never counts as new). */
export interface WayClassEx extends WayClass {
  glue: boolean;
}

/** highway=* values that can enter the graph (anything else is dropped). */
export const KEPT_HIGHWAYS: ReadonlySet<string> = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'residential', 'living_street', 'unclassified', 'service', 'pedestrian', 'footway',
  'path', 'cycleway', 'track', 'steps', 'bridleway',
]);

/** highway=* values motor vehicles may use (track only with motor_vehicle=yes). */
const DRIVE_HIGHWAYS: ReadonlySet<string> = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'residential', 'living_street', 'unclassified', 'service',
]);

/**
 * footway=* sub-types that duplicate a street. They are GLUE candidates: OSM's only link between
 * bridge walkways / park paths / plazas and the street grid (without crossings walk mode cannot
 * cross the East River). graph-build keeps just the spans that connect otherwise separate parts.
 */
const GLUE_FOOTWAY: ReadonlySet<string> = new Set(['crossing', 'traffic_island', 'sidewalk']);
/** service=* sub-types that are never worth exploring — but may connect a path to the street (glue). */
const GLUE_SERVICE: ReadonlySet<string> = new Set(['driveway', 'parking_aisle']);
const DROPPED_SERVICE: ReadonlySet<string> = new Set(['drive-through', 'emergency_access']);
/** Pedestrian-ish highways where a bike must dismount unless explicitly allowed. */
const DISMOUNT_HIGHWAYS: ReadonlySet<string> = new Set(['footway', 'pedestrian', 'bridleway']);

const ALLOW: ReadonlySet<string> = new Set(['yes', 'designated', 'permissive', 'destination', 'official']);
const DENY: ReadonlySet<string> = new Set(['no', 'private']);

const DROPPED: WayClassEx = Object.freeze({
  keep: false, walk: false, bike: false, drive: false, steps: false, dismount: false,
  onewayFwd: false, onewayBack: false, bikeBothWays: false, glue: false,
});

const allows = (v: string | undefined) => v !== undefined && ALLOW.has(v);
const denies = (v: string | undefined) => v !== undefined && DENY.has(v);

/** Classify one way by its tags. Returns `keep: false` (all bits off) for ways that never enter the graph. */
export function classifyWay(tags: Readonly<Record<string, string>>, opts: ClassifyOptions = {}): WayClassEx {
  const highway = tags.highway;
  if (!highway || !KEPT_HIGHWAYS.has(highway)) return DROPPED;
  if (tags.area === 'yes') return DROPPED;
  let glue = false;
  if (highway === 'footway' && tags.footway !== undefined && GLUE_FOOTWAY.has(tags.footway)) {
    if (tags.footway === 'sidewalk' && opts.glueSidewalks === false) return DROPPED;
    glue = true;
  }
  if (highway === 'service') {
    const service = tags.service;
    if (service !== undefined && DROPPED_SERVICE.has(service)) return DROPPED;
    if ((service !== undefined && GLUE_SERVICE.has(service)) || (!tags.name && service !== 'alley')) {
      if (opts.glueService === false) return DROPPED;
      glue = true;
    }
  }

  const foot = tags.foot, bicycle = tags.bicycle, vehicle = tags.vehicle;
  const motor = tags.motor_vehicle ?? tags.motorcar;

  // --- walk ---
  let walk = true;
  if (highway === 'motorway' || highway === 'motorway_link') walk = false;
  else if (highway === 'trunk' || highway === 'trunk_link') {
    const sw = tags.sidewalk;
    walk = allows(foot) || sw === 'yes' || sw === 'left' || sw === 'right' || sw === 'both';
  }
  if (denies(foot)) walk = false;

  // --- bike ---
  let bike = true;
  let dismount = false;
  if (highway === 'motorway' || highway === 'motorway_link') bike = false;
  else if (highway === 'trunk' || highway === 'trunk_link') bike = bicycle === 'yes' || bicycle === 'designated';
  else if (highway === 'steps') dismount = true;
  else if (DISMOUNT_HIGHWAYS.has(highway)) dismount = !(bicycle === 'yes' || bicycle === 'designated');
  if (bicycle === 'dismount') dismount = true;
  if (denies(vehicle) && !allows(bicycle) && bicycle !== 'dismount') bike = false;
  if (denies(bicycle)) bike = false;
  if (dismount && !walk) bike = false; // walking the bike needs foot access

  // --- drive (never on glue: connectors route pedestrians and bikes, not cars) ---
  let drive = !glue && (DRIVE_HIGHWAYS.has(highway) || (highway === 'track' && allows(motor)));
  if (denies(vehicle) && !allows(motor)) drive = false;
  if (denies(motor)) drive = false;

  // --- access=private|no: only explicitly re-allowed modes survive ---
  const access = tags.access;
  if (access !== undefined && DENY.has(access)) {
    walk = walk && allows(foot);
    bike = bike && (allows(bicycle) || bicycle === 'dismount') && !(dismount && !walk);
    drive = drive && allows(motor);
  }

  if (!walk && !bike && !drive) return DROPPED;

  // --- oneway (vehicles only; walking ignores it) ---
  const oneway = tags.oneway;
  let onewayFwd = oneway === 'yes' || oneway === '1' || oneway === 'true';
  const onewayBack = oneway === '-1' || oneway === 'reverse';
  const junction = tags.junction;
  if ((junction === 'roundabout' || junction === 'circular') && oneway !== 'no' && !onewayBack) onewayFwd = true;
  const bikeBothWays =
    tags['oneway:bicycle'] === 'no' ||
    isOpposite(tags.cycleway) || isOpposite(tags['cycleway:left']) || isOpposite(tags['cycleway:right']) || isOpposite(tags['cycleway:both']);

  return {
    keep: true, walk, bike, drive,
    steps: highway === 'steps',
    dismount: bike && dismount,
    onewayFwd, onewayBack, bikeBothWays,
    glue,
  };
}

function isOpposite(v: string | undefined): boolean {
  return v !== undefined && v.startsWith('opposite');
}
