import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { distanceMiles, FEET_PER_MILE } from '../../../apps/trails/public/modules/geo.js';
import { BACK_ON_ROUTE_FEET, decodeHike, groupHikes, hikeFacts, OFF_ROUTE_FEET, routeProgress, withMargin } from '../../../apps/trails/public/modules/hikes.js';
import { shardKey } from '../../../apps/trails/public/modules/landscape.js';
import { planArea } from '../../../apps/trails/public/modules/offline.js';
import { classifyOsm, classifyUsgs, cleanName, conflate, decodeTrail, encodeTrail } from '../../../apps/trails/public/modules/trails.js';

const here = path => new URL(`../../../apps/trails/${path}`, import.meta.url);
const json = path => JSON.parse(readFileSync(here(path), 'utf8'));
const FEET_PER_DEGREE_LAT = 69.09 * FEET_PER_MILE;
const north = (feet, lon = -79.3) => [lon, 39.5 + feet / FEET_PER_DEGREE_LAT];
const line = (names, coords, kind = 'foot') => ({ names, kind, coords });

test('names: junk is dropped, shouting and bad capitals are fixed', () => {
  assert.equal(cleanName('None'), '');
  assert.equal(cleanName('Unnamed 11'), '');
  assert.equal(cleanName('OTTER CREEK TRAIL'), 'Otter Creek Trail');
  assert.equal(cleanName("Dale'S Trail"), "Dale's Trail");
});

test('USGS: a blank hiker flag still counts as a trail, motor routes do not', () => {
  assert.equal(classifyUsgs({ name: 'OTTER CREEK TRAIL', trailtype: 'Terra Trail', hikerpedestrian: null }), 'foot');
  assert.equal(classifyUsgs({ name: 'Snaggy Mtn Snowmobile', trailtype: 'Terra Trail', hikerpedestrian: 'Y' }), 'shared');
  assert.equal(classifyUsgs({ name: 'Any', trailtype: 'Terra Trail', ohvover50inches: 'Y' }), 'shared');
  assert.equal(classifyUsgs({ name: 'Harr Farm', trailtype: 'Snow Trail' }), 'ski');
  assert.equal(classifyUsgs({ name: 'Ramsey Road', trailtype: 'Terra Trail', hikerpedestrian: 'Y' }), 'track');
  assert.equal(classifyUsgs({ name: 'Paddle', trailtype: 'Water Trail' }), null);
});

test('OSM: private ways and sidewalks stay off the map; tracks are not called trails', () => {
  assert.equal(classifyOsm({ highway: 'track', access: 'private' }), null);
  assert.equal(classifyOsm({ highway: 'path', foot: 'no' }), null);
  assert.equal(classifyOsm({ highway: 'footway', footway: 'sidewalk' }), null);
  assert.equal(classifyOsm({ highway: 'track' }), 'track');
  assert.equal(classifyOsm({ highway: 'track', foot: 'designated' }), 'foot');
  assert.equal(classifyOsm({ highway: 'path', snowmobile: 'designated' }), 'shared');
  assert.equal(classifyOsm({ highway: 'path' }), 'foot');
});

test('merge: a USGS line retracing an OSM line becomes one line with both credits', () => {
  const osm = line([], [north(0), north(1000), north(2000)]);
  const usgs = line(['Ridge Trail'], [north(0, -79.30001), north(1000, -79.30001), north(2000, -79.30001)]);
  const merged = conflate([osm], [usgs]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].names, ['Ridge Trail']);
  assert.deepEqual(merged[0].sources, ['osm', 'usgs']);
});

test('merge: crossing another trail must not hand it a name', () => {
  // A long north-south trail, and a short USGS trail that shares only its southern end.
  const crossed = line(['Long Trail'], [north(0), north(5000), north(10000)]);
  const usgs = line(['Short Trail'], [north(0), north(50), north(80)]);
  const merged = conflate([crossed], [usgs]);
  const long = merged.find(item => item.names.includes('Long Trail'));
  assert.ok(!long.names.includes('Short Trail'));
});

test('merge: the same trail drawn apart by each source still counts once', () => {
  const osm = line(['Lostland Run Trail'], [north(0), north(4000)]);
  // About 250 ft west of the OSM line, past the normal match distance.
  const usgs = line(['Lostland Run'], [north(0, -79.30094), north(2000, -79.30094), north(4000, -79.30094)]);
  const merged = conflate([osm], [usgs]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].names.includes('Lostland Run'));
});

test('merge: a closer unrelated line does not hide the same-named one', () => {
  const namesake = line(['Lostland Run Trail'], [north(0, -79.30094), north(4000, -79.30094)]);
  const closer = line([], [north(0), north(4000)], 'track');
  const usgs = line(['Lostland Run'], [north(0), north(2000), north(4000)]);
  const merged = conflate([closer, namesake], [usgs]);
  assert.equal(merged.filter(item => item.sources.includes('usgs') && item.sources.length === 1).length, 0);
});

test('merge: USGS trails missing from OSM are kept', () => {
  const merged = conflate([line(['A'], [north(0), north(100)])], [line(['B'], [north(0, -79.4), north(100, -79.4)])]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1].sources, ['usgs']);
});

test('trail encoding round-trips kind, sources and shape', () => {
  const decoded = decodeTrail(encodeTrail({ names: ['Canyon Trail'], kind: 'shared', sources: ['osm', 'usgs'], coords: [[-79.41, 39.5], [-79.42, 39.51]] }));
  assert.equal(decoded.name, 'Canyon Trail');
  assert.equal(decoded.kind, 'shared');
  assert.deepEqual(decoded.sources, ['osm', 'usgs']);
  assert.ok(Math.abs(decoded.points[1].lon + 79.42) < 1e-9);
});

const route = decodeHike({ kind: 'route', name: 'Test', lines: [encodeTrail({ names: ['T'], kind: 'foot', sources: ['osm'], coords: [north(0), north(10000)] })] });
const atFeetEast = feet => ({ lat: 39.5 + 5000 / FEET_PER_DEGREE_LAT, lon: -79.3 + feet / (FEET_PER_MILE * 53.3) });

test('off route: leaving takes real distance, and returning takes coming back', () => {
  assert.equal(routeProgress(route, atFeetEast(50)).off, false);
  assert.equal(routeProgress(route, atFeetEast(OFF_ROUTE_FEET - 40)).off, false);
  assert.equal(routeProgress(route, atFeetEast(OFF_ROUTE_FEET + 40)).off, true);
  // Between the two limits the previous answer holds, so the warning doesn't flicker.
  const between = atFeetEast((OFF_ROUTE_FEET + BACK_ON_ROUTE_FEET) / 2);
  assert.equal(routeProgress(route, between, true).off, true);
  assert.equal(routeProgress(route, between, false).off, false);
  assert.equal(routeProgress(route, atFeetEast(BACK_ON_ROUTE_FEET - 40), true).off, false);
});

test('off route: reports the way back to the trail', () => {
  const progress = routeProgress(route, atFeetEast(1000));
  assert.ok(Math.abs(progress.feet - 1000) < 30);
  assert.ok(Math.abs(progress.bearing - 270) < 2);
});

test('a destination guides to its point and is never "off route"', () => {
  const progress = routeProgress({ kind: 'destination', point: { lat: 39.2, lon: -79.5 } }, { lat: 39.3, lon: -79.5 });
  assert.equal(progress.off, false);
  assert.equal(progress.onRoute, false);
  assert.ok(Math.abs(progress.miles - 6.91) < 0.05);
});

test('hike facts state length and ground range without claiming climb', () => {
  assert.equal(hikeFacts({ kind: 'route', miles: 3.75, lowFeet: 1500, highFeet: 2800 }), '3.75 mi of mapped trail · ground 1,500 ft to 2,800 ft');
  assert.equal(hikeFacts({ kind: 'destination', lowFeet: 3200, highFeet: 3200 }), 'ground about 3,200 ft');
  assert.equal(hikeFacts({ kind: 'route', miles: 12.34 }), '12.3 mi of mapped trail');
});

test('hikes sort nearest first within their group once there is a fix', () => {
  const near = { name: 'Near', group: 'G', point: { lat: 39.3, lon: -79.3 } };
  const far = { name: 'Far', group: 'G', point: { lat: 39.9, lon: -79.3 } };
  assert.deepEqual(groupHikes([far, near], { lat: 39.3, lon: -79.3 })[0].hikes.map(hike => hike.name), ['Near', 'Far']);
  assert.deepEqual(groupHikes([far, near])[0].hikes.map(hike => hike.name), ['Far', 'Near']);
});

test('the area saved for a hike reaches past both ends of it', () => {
  const bounds = { south: 39, north: 39.1, west: -79.5, east: -79.4 };
  const padded = withMargin(bounds);
  assert.ok(padded.south < bounds.south && padded.north > bounds.north && padded.west < bounds.west && padded.east > bounds.east);
});

test('saving an area also keeps its trail data', () => {
  const key = shardKey(39.5, -79.3);
  const plan = planArea({ south: 39.48, north: 39.52, west: -79.32, east: -79.28 }, [], [key]);
  assert.deepEqual(plan.trailShards, [key]);
  assert.deepEqual(plan.shards, []);
});

// Lengths both sources agree on, to catch a merge that doubles or inflates a hike.
const CROSS_CHECKED_MILES = {
  'lostland-run': 3.75,
  'big-stonecoal': 4.2,
  rohrbaugh: 3.55,
  'lindy-point': 0.38,
  'blackbird-knob': 5.4,
  'otter-creek': 11.3,
  'red-creek': 7.5,
  plantation: 7.85,
  'swallow-herrington': 5.5,
};

test('baked hikes: lengths match what the sources report', () => {
  const { hikes } = json('public/data/hikes.json');
  for (const [id, expected] of Object.entries(CROSS_CHECKED_MILES)) {
    const hike = hikes.find(item => item.id === id);
    assert.ok(Math.abs(hike.miles - expected) / expected < 0.05, `${id} is ${hike.miles} mi, sources say about ${expected}`);
  }
});

test('baked hikes: cover all three home areas, with notes that exist where needed', () => {
  const { hikes } = json('public/data/hikes.json');
  for (const group of ['Near Gormania', 'Garrett County', 'Tucker County']) assert.ok(hikes.some(hike => hike.group === group), group);
  assert.ok(hikes.filter(hike => hike.group === 'Tucker County').length >= 10);
  assert.ok(hikes.filter(hike => hike.group === 'Garrett County').length >= 5);
  for (const hike of hikes.filter(item => item.area === 'Dolly Sods Wilderness')) assert.match(hike.note, /Unexploded/);
  // No Gormania-area road walk is offered as a hike without solid data behind it.
  assert.ok(!hikes.some(hike => hike.id === 'wallman-road'));
});

test('baked hikes: every route stays near its area and has ground elevation', () => {
  const { hikes } = json('public/data/hikes.json');
  const catalog = new Map(json('data-sources/hikes.source.json').hikes.map(hike => [hike.id, hike]));
  for (const hike of hikes) {
    assert.ok(hike.lowFeet > 500 && hike.highFeet < 5000 && hike.lowFeet <= hike.highFeet, `${hike.id} elevation`);
    if (hike.kind !== 'route') continue;
    const { near, radius } = catalog.get(hike.id);
    const touches = hike.lines.map(decodeTrail).every(({ points }) => points.some(point => distanceMiles({ lat: near[0], lon: near[1] }, point) <= radius));
    assert.ok(touches, `${hike.id} has a stray line`);
  }
});

test('baked trails: OSM-derived data ships with its license, and the source snapshots keep theirs', () => {
  const license = readFileSync(here('public/data/TRAILS-LICENSE.txt'), 'utf8');
  assert.match(license, /OpenStreetMap contributors/);
  assert.match(license, /Open Database License/);
  const osm = JSON.parse(gunzipSync(readFileSync(here('data-sources/osm-trails.json.gz'))).toString('utf8'));
  assert.match(osm.source.license, /ODbL/);
  assert.match(readFileSync(here('public/index.html'), 'utf8'), /OpenStreetMap contributors/);
});

test('baked trails: private ways were left out', () => {
  const { trailShards } = json('public/data/index.json');
  assert.ok(trailShards.length >= 20);
  const { lines } = json(`public/data/trails/${shardKey(39.5, -79.42)}.json`);
  assert.ok(lines.map(decodeTrail).some(({ name, kind }) => name === 'Canyon Trail' && kind === 'foot'));
});

test('climb and effort are left out where the numbers would mislead', async () => {
  const { climbIsReliable, detailFacts } = await import('../../../apps/trails/public/modules/trail-details.js');
  assert.equal(climbIsReliable({ miles: 3, name: 'Rohrbaugh Trail' }), true);
  assert.equal(climbIsReliable({ miles: 130, name: 'Great Allegheny Passage' }), false);
  assert.equal(climbIsReliable({ miles: 4, name: 'Western Maryland Rail Trail' }), false);
  const facts = detailFacts({ miles: 130, name: 'Long Trail', climbFeet: 20450, effort: 'Very strenuous', dogs: 'yes' });
  assert.deepEqual(facts, ['Mapped as open to dogs']);
});
