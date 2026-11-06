import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITIES, activityById, activityNames, ATV, BIKE, DIRT_BIKE, filterRoutes, HIKE, HORSE, isClosed, matchesActivity, osmActivities, pointInRings, routeActivities, routeLines, SKI, SNOWMOBILE, SNOWSHOE, usgsActivities, UTV } from '../../../apps/trails/public/modules/activities.js';
import { classifyOsm, decodeTrail, encodeTrail, conflate } from '../../../apps/trails/public/modules/trails.js';

test('a plain footpath is for walking, and nothing is assumed about machines', () => {
  assert.equal(osmActivities({ highway: 'path' }), HIKE);
  assert.equal(osmActivities({ highway: 'track' }), 0);
  assert.equal(osmActivities({ highway: 'path', foot: 'no' }), 0);
});

test('each activity comes only from what the tags say', () => {
  assert.ok(osmActivities({ highway: 'track', bicycle: 'yes' }) & BIKE);
  assert.ok(osmActivities({ highway: 'path', 'mtb:scale': '2' }) & BIKE);
  assert.equal(osmActivities({ highway: 'path', bicycle: 'no', 'mtb:scale': '2' }) & BIKE, 0);
  assert.ok(osmActivities({ highway: 'bridleway' }) & HORSE);
  assert.ok(osmActivities({ 'piste:type': 'nordic' }) & SKI);
  assert.ok(osmActivities({ 'piste:type': 'nordic;hike' }) & SNOWSHOE);
  assert.equal(osmActivities({ 'piste:type': 'downhill' }) & SKI, 0);
  assert.ok(osmActivities({ highway: 'track', snowmobile: 'designated' }) & SNOWMOBILE);
  assert.ok(osmActivities({ highway: 'track', atv: 'yes' }) & ATV);
  assert.ok(osmActivities({ highway: 'track', ohv: 'designated' }) & ATV);
  assert.equal(osmActivities({ highway: 'track', atv: 'no', name: 'Old ATV Road' }) & ATV, 0);
  assert.ok(osmActivities({ highway: 'path', motorcycle: 'designated' }) & DIRT_BIKE);
});

test('a route relation marks its ways', () => {
  assert.ok(osmActivities({ highway: 'track' }, [{ route: 'mtb' }]) & BIKE);
  assert.ok(osmActivities({ highway: 'track' }, [{ route: 'snowmobile' }]) & SNOWMOBILE);
  assert.ok(osmActivities({ highway: 'track' }, [{ route: 'piste', piste: 'nordic' }]) & SKI);
  assert.equal(osmActivities({ highway: 'track' }, [{ route: 'piste', piste: 'downhill' }]) & SKI, 0);
});

test('USGS flags count only when set, except ordinary walking', () => {
  assert.equal(usgsActivities({ name: 'Otter Creek' }, 'foot'), HIKE);
  assert.equal(usgsActivities({ name: 'Otter Creek', hikerpedestrian: 'N' }, 'foot'), 0);
  assert.equal(usgsActivities({ name: 'Road 12' }, 'track'), 0);
  const all = usgsActivities({ bicycle: 'Y', packsaddle: 'Y', crosscountryski: 'Y', snowshoe: 'Y', osvm: 'Y', ohvisorunder50inches: 'Y', ohvover50inches: 'Y', motorcycle: 'Y' }, 'shared');
  for (const bit of [BIKE, HORSE, SKI, SNOWSHOE, SNOWMOBILE, ATV, UTV, DIRT_BIKE]) assert.ok(all & bit);
  assert.equal(usgsActivities({ ohvisorunder50inches: 'Y' }, 'shared') & UTV, 0, 'an ATV marking says nothing about wider UTVs');
});

test('closed trails stay out, but a foot ban only removes walking', () => {
  assert.equal(classifyOsm({ highway: 'track', access: 'private' }), null);
  assert.equal(classifyOsm({ highway: 'path', foot: 'no' }), null);
  assert.equal(classifyOsm({ highway: 'path', foot: 'no', atv: 'designated' }), 'shared');
  assert.equal(osmActivities({ highway: 'path', foot: 'no', atv: 'designated' }) & HIKE, 0);
  assert.equal(isClosed({ access: 'no' }, HIKE), true);
  assert.equal(isClosed({ access: 'private', snowmobile: 'designated' }, SNOWMOBILE), false);
  assert.equal(isClosed({ highway: 'path' }, HIKE), false);
});

test('activities survive the trip through a shard and join up in a merge', () => {
  const encoded = encodeTrail({ names: ['Canyon'], kind: 'foot', sources: ['osm'], activities: HIKE | SKI, coords: [[-79.5, 39.1], [-79.49, 39.11]] });
  const decoded = decodeTrail(encoded);
  assert.equal(decoded.activities, HIKE | SKI);
  assert.equal(decoded.points.length, 2);
  assert.deepEqual(decoded.points[0], { lat: 39.1, lon: -79.5 });
  const coords = [[-79.5, 39.1], [-79.499, 39.101], [-79.498, 39.102]];
  const [line] = conflate([{ names: ['Canyon'], kind: 'foot', activities: HIKE, coords }], [{ names: ['Canyon'], kind: 'foot', activities: SNOWMOBILE, coords }]);
  assert.equal(line.activities, HIKE | SNOWMOBILE);
});

test('the map filter shows only what matches, and ATV / UTV covers all three machines', () => {
  const motor = activityById('motor');
  assert.ok(matchesActivity(ATV, motor) && matchesActivity(UTV, motor) && matchesActivity(DIRT_BIKE, motor));
  assert.equal(matchesActivity(HIKE, motor), false);
  assert.equal(matchesActivity(0, motor), false);
  assert.equal(matchesActivity(0, null), true, 'no filter shows everything, including unmarked tracks');
  assert.equal(activityById('nope'), null);
  assert.deepEqual(activityNames(HIKE | SNOWMOBILE), ['hiking', 'snowmobiles']);
});

test('every activity warns about rules except walking, and none promises it is legal', () => {
  for (const { id, note } of ACTIVITIES) {
    if (id === 'hike') continue;
    assert.match(note, /land manager/);
  }
});

test('a county outline contains its middle and not the outside', () => {
  const rings = [[[-80, 39], [-79, 39], [-79, 40], [-80, 40], [-80, 39]]];
  assert.equal(pointInRings({ lat: 39.5, lon: -79.5 }, rings), true);
  assert.equal(pointInRings({ lat: 41, lon: -79.5 }, rings), false);
});

test('the finder narrows by activity and county, nearest first', () => {
  const routes = [
    { name: 'Far', activities: HIKE, county: 'A', center: 10 },
    { name: 'Near', activities: HIKE | SKI, county: 'A', center: 1 },
    { name: 'Other', activities: SKI, county: 'B', center: 2 },
  ];
  const distance = (position, center) => Math.abs(center - position);
  assert.deepEqual(filterRoutes(routes, { position: 0.5, distance }).map(route => route.name), ['Near', 'Other', 'Far']);
  assert.deepEqual(filterRoutes(routes, { activity: activityById('ski') }).map(route => route.name), ['Near', 'Other']);
  assert.deepEqual(filterRoutes(routes, { county: 'B' }).map(route => route.name), ['Other']);
});

test('a route collects its own lines, once each, and only those near it', () => {
  const near = { lat: 39.5, lon: -79.5 };
  const away = { lat: 41, lon: -79.5 };
  const line = { name: 'Canyon', points: [near, near] };
  const shards = [{ lines: [line, { name: 'Other', points: [near] }, { name: 'Canyon', points: [away, away] }] }, { lines: [{ ...line }] }, null];
  const found = routeLines(shards, { name: 'Canyon', bounds: { south: 39, north: 40, west: -80, east: -79 } });
  assert.deepEqual(found, [line]);
});

test('one marked piece of a long trail does not mark the whole trail', () => {
  assert.equal(routeActivities([{ miles: 60, activities: HIKE }, { miles: 1, activities: HIKE | SNOWMOBILE }]), HIKE);
  assert.equal(routeActivities([{ miles: 5, activities: SNOWMOBILE }, { miles: 5, activities: HIKE }]), SNOWMOBILE | HIKE);
  assert.equal(routeActivities([{ miles: 0, activities: HIKE }]), 0);
});

test('a same-named line only passes on activities where it actually runs alongside', () => {
  const here = [[-79.5, 39.1], [-79.499, 39.101], [-79.498, 39.102]];
  const elsewhere = [[-79.5, 39.1005], [-79.499, 39.1015], [-79.498, 39.1025]];
  const [line] = conflate([{ names: ['Canyon'], kind: 'foot', activities: HIKE, coords: here }], [{ names: ['Canyon'], kind: 'foot', activities: SNOWMOBILE, coords: elsewhere }]);
  assert.equal(line.activities, HIKE);
});

test('permit-only routes are not listed as open riding trails', () => {
  assert.equal(usgsActivities({ name: 'ATV/Disabled Person Route', ohvisorunder50inches: 'Y' }, 'shared') & ATV, 0);
  assert.equal(osmActivities({ highway: 'track', name: 'ATV/Disabled Person Route', atv: 'yes' }) & ATV, 0);
});

test('a route is found under every county it reaches', () => {
  const routes = [{ name: 'Long', activities: HIKE, county: 'A', counties: ['A', 'B'] }];
  assert.equal(filterRoutes(routes, { county: 'B' }).length, 1);
  assert.equal(filterRoutes(routes, { county: 'C' }).length, 0);
});
