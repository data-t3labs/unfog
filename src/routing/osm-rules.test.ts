import { describe, expect, it } from 'vitest';
import { classifyWay } from './osm-rules';

type T = Record<string, string>;
const c = (tags: T) => classifyWay(tags);
const modes = (tags: T) => { const w = c(tags); return [w.walk, w.bike, w.drive]; };

describe('classifyWay — keep / drop', () => {
  it.each([
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'residential', 'living_street', 'unclassified', 'pedestrian', 'footway', 'path',
    'cycleway', 'track', 'steps', 'bridleway',
  ])('keeps highway=%s', (hw) => {
    expect(c({ highway: hw }).keep).toBe(true);
  });

  it.each(['construction', 'proposed', 'raceway', 'abandoned', 'platform', 'bus_stop', 'elevator', 'corridor', 'services', 'rest_area', 'escape', 'busway', 'road'])(
    'drops highway=%s', (hw) => { expect(c({ highway: hw }).keep).toBe(false); },
  );

  it('drops ways without a highway tag', () => {
    expect(c({}).keep).toBe(false);
    expect(c({ railway: 'rail' }).keep).toBe(false);
  });

  it('footway=sidewalk is a GLUE candidate (a street counts once); dropped with glueSidewalks:false', () => {
    expect(c({ highway: 'footway', footway: 'sidewalk' })).toMatchObject({ keep: true, glue: true, walk: true, bike: true, dismount: true, drive: false });
    expect(classifyWay({ highway: 'footway', footway: 'sidewalk' }, { glueSidewalks: false }).keep).toBe(false);
    expect(classifyWay({ highway: 'footway', footway: 'crossing' }, { glueSidewalks: false }).glue).toBe(true);
  });
  it.each(['crossing', 'traffic_island'])('keeps footway=%s as GLUE (walk + bike dismount, never drive)', (ft) => {
    expect(c({ highway: 'footway', footway: ft })).toMatchObject({ keep: true, glue: true, walk: true, bike: true, dismount: true, drive: false });
    expect(c({ highway: 'footway', footway: ft, bicycle: 'yes' })).toMatchObject({ glue: true, bike: true, dismount: false });
    expect(c({ highway: 'footway', footway: ft, foot: 'no' }).keep).toBe(false);
  });
  it('keeps plain footways and footway=access_aisle as ordinary (non-glue) ways', () => {
    expect(c({ highway: 'footway' })).toMatchObject({ keep: true, glue: false });
    expect(c({ highway: 'footway', footway: 'access_aisle' })).toMatchObject({ keep: true, glue: false });
    expect(c({ highway: 'residential' }).glue).toBe(false);
  });

  it.each(['drive-through', 'emergency_access'])('drops service=%s even when named', (sv) => {
    expect(c({ highway: 'service', service: sv, name: 'X Lane' }).keep).toBe(false);
  });
  it.each(['driveway', 'parking_aisle'])('service=%s is a GLUE candidate (walk + bike, never drive), dropped with glueService:false', (sv) => {
    expect(c({ highway: 'service', service: sv, name: 'X Lane' })).toMatchObject({ keep: true, glue: true, walk: true, bike: true, drive: false });
    expect(classifyWay({ highway: 'service', service: sv }, { glueService: false }).keep).toBe(false);
  });
  it('unnamed service roads are GLUE candidates; alleys and named service roads are ordinary', () => {
    expect(c({ highway: 'service' })).toMatchObject({ keep: true, glue: true, drive: false });
    expect(classifyWay({ highway: 'service' }, { glueService: false }).keep).toBe(false);
    expect(c({ highway: 'service', service: 'alley' })).toMatchObject({ keep: true, glue: false, drive: true });
    expect(c({ highway: 'service', name: 'Mews Lane' })).toMatchObject({ keep: true, glue: false, drive: true });
  });

  it('drops area=yes', () => {
    expect(c({ highway: 'pedestrian', area: 'yes' }).keep).toBe(false);
    expect(c({ highway: 'pedestrian', area: 'no' }).keep).toBe(true);
  });

  it('drops access=private|no unless a mode re-allows, then keeps only that mode', () => {
    expect(c({ highway: 'residential', access: 'private' }).keep).toBe(false);
    expect(c({ highway: 'residential', access: 'no' }).keep).toBe(false);
    expect(modes({ highway: 'residential', access: 'private', foot: 'yes' })).toEqual([true, false, false]);
    expect(modes({ highway: 'residential', access: 'no', bicycle: 'designated' })).toEqual([false, true, false]);
    expect(modes({ highway: 'residential', access: 'private', motor_vehicle: 'destination' })).toEqual([false, false, true]);
    expect(modes({ highway: 'path', access: 'no', foot: 'permissive', bicycle: 'yes' })).toEqual([true, true, false]);
    expect(c({ highway: 'residential', access: 'permissive' }).keep).toBe(true);
    expect(c({ highway: 'residential', access: 'destination' }).keep).toBe(true);
  });

  it('drops a way whose every mode is denied', () => {
    expect(c({ highway: 'footway', foot: 'no' }).keep).toBe(false);
    expect(c({ highway: 'cycleway', foot: 'no', bicycle: 'no' }).keep).toBe(false);
    expect(c({ highway: 'motorway', motor_vehicle: 'no' }).keep).toBe(false);
  });
});

describe('classifyWay — walk', () => {
  it('everything kept is walkable except motorways', () => {
    for (const hw of ['primary', 'residential', 'service', 'footway', 'path', 'cycleway', 'track', 'steps', 'bridleway', 'pedestrian', 'living_street'])
      expect(c({ highway: hw, name: 'n' }).walk).toBe(true);
    expect(c({ highway: 'motorway' }).walk).toBe(false);
    expect(c({ highway: 'motorway_link' }).walk).toBe(false);
    expect(c({ highway: 'motorway', foot: 'yes' }).walk).toBe(false);
  });
  it('trunk only with foot=yes or a sidewalk', () => {
    expect(c({ highway: 'trunk' }).walk).toBe(false);
    expect(c({ highway: 'trunk_link' }).walk).toBe(false);
    expect(c({ highway: 'trunk', foot: 'yes' }).walk).toBe(true);
    for (const sw of ['yes', 'left', 'right', 'both']) expect(c({ highway: 'trunk', sidewalk: sw }).walk).toBe(true);
    expect(c({ highway: 'trunk', sidewalk: 'no' }).walk).toBe(false);
    expect(c({ highway: 'trunk', sidewalk: 'separate' }).walk).toBe(false);
  });
  it('foot=no drops walk (and only walk)', () => {
    expect(modes({ highway: 'cycleway', foot: 'no' })).toEqual([false, true, false]);
    expect(modes({ highway: 'residential', foot: 'no' })).toEqual([false, true, true]);
    expect(modes({ highway: 'residential', foot: 'private' })).toEqual([false, true, true]);
  });
  it('walking ignores oneway', () => {
    const w = c({ highway: 'residential', oneway: 'yes' });
    expect(w.walk).toBe(true); expect(w.onewayFwd).toBe(true);
  });
});

describe('classifyWay — bike', () => {
  it('bikes on roads, cycleways, paths, tracks', () => {
    for (const hw of ['primary', 'residential', 'living_street', 'unclassified', 'cycleway', 'path', 'track'])
      expect(c({ highway: hw })).toMatchObject({ bike: true, dismount: false });
  });
  it('never on motorways; trunk only with bicycle=yes', () => {
    expect(c({ highway: 'motorway' }).bike).toBe(false);
    expect(c({ highway: 'motorway_link', bicycle: 'yes' }).bike).toBe(false);
    expect(c({ highway: 'trunk' }).bike).toBe(false);
    expect(c({ highway: 'trunk', bicycle: 'yes' })).toMatchObject({ bike: true, dismount: false });
    expect(c({ highway: 'trunk_link', bicycle: 'designated' }).bike).toBe(true);
  });
  it('footway/pedestrian/bridleway = dismount unless bicycle=yes|designated', () => {
    for (const hw of ['footway', 'pedestrian', 'bridleway']) {
      expect(c({ highway: hw })).toMatchObject({ bike: true, dismount: true });
      expect(c({ highway: hw, bicycle: 'yes' })).toMatchObject({ bike: true, dismount: false });
      expect(c({ highway: hw, bicycle: 'designated' })).toMatchObject({ bike: true, dismount: false });
    }
  });
  it('steps = walkable, bikes dismount, steps flag', () => {
    expect(c({ highway: 'steps' })).toMatchObject({ walk: true, bike: true, dismount: true, steps: true, drive: false });
    expect(c({ highway: 'steps', bicycle: 'yes' })).toMatchObject({ bike: true, dismount: true, steps: true });
    expect(c({ highway: 'residential' }).steps).toBe(false);
  });
  it('bicycle=no drops bike; bicycle=dismount keeps it as dismount', () => {
    expect(modes({ highway: 'residential', bicycle: 'no' })).toEqual([true, false, true]);
    expect(modes({ highway: 'path', bicycle: 'no' })).toEqual([true, false, false]);
    expect(c({ highway: 'path', bicycle: 'dismount' })).toMatchObject({ bike: true, dismount: true });
    expect(c({ highway: 'cycleway', bicycle: 'no' }).bike).toBe(false);
  });
  it('vehicle=no drops bike + drive unless re-allowed', () => {
    expect(modes({ highway: 'pedestrian', vehicle: 'no' })).toEqual([true, false, false]);
    expect(modes({ highway: 'residential', vehicle: 'no', bicycle: 'yes' })).toEqual([true, true, false]);
  });
  it('dismount is never set when bike is off', () => {
    expect(c({ highway: 'footway', bicycle: 'no' }).dismount).toBe(false);
  });
});

describe('classifyWay — drive', () => {
  it.each(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street'])(
    'drives highway=%s', (hw) => { expect(c({ highway: hw }).drive).toBe(true); },
  );
  it('drives named service roads and alleys, never glue', () => {
    expect(c({ highway: 'service', name: 'Back Lane' }).drive).toBe(true);
    expect(c({ highway: 'service', service: 'alley' }).drive).toBe(true);
    expect(c({ highway: 'service', service: 'driveway', name: 'X', motor_vehicle: 'yes' }).drive).toBe(false);
  });
  it.each(['footway', 'path', 'pedestrian', 'cycleway', 'steps', 'bridleway'])('never drives highway=%s', (hw) => {
    expect(c({ highway: hw, motor_vehicle: 'yes' }).drive).toBe(false);
  });
  it('track only with motor_vehicle=yes', () => {
    expect(c({ highway: 'track' }).drive).toBe(false);
    expect(c({ highway: 'track', motor_vehicle: 'yes' }).drive).toBe(true);
    expect(c({ highway: 'track', motorcar: 'yes' }).drive).toBe(true);
  });
  it('motor_vehicle=no | motorcar=no drops drive', () => {
    expect(modes({ highway: 'residential', motor_vehicle: 'no' })).toEqual([true, true, false]);
    expect(modes({ highway: 'residential', motorcar: 'no' })).toEqual([true, true, false]);
    expect(modes({ highway: 'residential', motor_vehicle: 'private' })).toEqual([true, true, false]);
  });
  it('motorway = drive only', () => {
    expect(modes({ highway: 'motorway' })).toEqual([false, false, true]);
  });
});

describe('classifyWay — oneway', () => {
  it.each(['yes', '1', 'true'])('oneway=%s → onewayFwd', (v) => {
    expect(c({ highway: 'residential', oneway: v })).toMatchObject({ onewayFwd: true, onewayBack: false });
  });
  it.each(['-1', 'reverse'])('oneway=%s → onewayBack', (v) => {
    expect(c({ highway: 'residential', oneway: v })).toMatchObject({ onewayFwd: false, onewayBack: true });
  });
  it('oneway=no / absent → both ways', () => {
    expect(c({ highway: 'residential', oneway: 'no' })).toMatchObject({ onewayFwd: false, onewayBack: false });
    expect(c({ highway: 'residential' })).toMatchObject({ onewayFwd: false, onewayBack: false });
  });
  it('roundabouts and circulars imply onewayFwd unless oneway=no', () => {
    expect(c({ highway: 'primary', junction: 'roundabout' }).onewayFwd).toBe(true);
    expect(c({ highway: 'primary', junction: 'circular' }).onewayFwd).toBe(true);
    expect(c({ highway: 'primary', junction: 'roundabout', oneway: 'no' }).onewayFwd).toBe(false);
  });
  it('bikes exempt via oneway:bicycle=no or cycleway=opposite*', () => {
    expect(c({ highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' })).toMatchObject({ onewayFwd: true, bikeBothWays: true });
    expect(c({ highway: 'residential', oneway: 'yes', cycleway: 'opposite_lane' }).bikeBothWays).toBe(true);
    expect(c({ highway: 'residential', oneway: 'yes', 'cycleway:left': 'opposite' }).bikeBothWays).toBe(true);
    expect(c({ highway: 'residential', oneway: 'yes', 'cycleway:right': 'opposite_track' }).bikeBothWays).toBe(true);
    expect(c({ highway: 'residential', oneway: 'yes', cycleway: 'lane' }).bikeBothWays).toBe(false);
    expect(c({ highway: 'residential', oneway: 'yes' }).bikeBothWays).toBe(false);
  });
});

describe('classifyWay — dropped result is inert', () => {
  it('returns all-false for dropped ways', () => {
    expect(c({ highway: 'construction', oneway: 'yes' })).toEqual({
      keep: false, walk: false, bike: false, drive: false, steps: false, dismount: false,
      onewayFwd: false, onewayBack: false, bikeBothWays: false, glue: false,
    });
  });
});
