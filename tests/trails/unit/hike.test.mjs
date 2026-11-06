import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { bearingDegrees, compassPoint, distanceMiles, FEET_PER_MILE, formatDistance, formatPace, project, tilesForBounds, unproject } from '../../../apps/trails/public/modules/geo.js';
import { createRecorder, elapsedSeconds, RULES, summarize } from '../../../apps/trails/public/modules/tracker.js';
import { gpxFileName, toGpx } from '../../../apps/trails/public/modules/gpx.js';
import { buildPlaceIndex, decodeLine, encodeLine, nearestPlace, nearestWater, shardKey, shardsForBounds } from '../../../apps/trails/public/modules/landscape.js';
import { MAX_SAVE_TILES, planArea, SAVED_CACHE } from '../../../apps/trails/public/modules/offline.js';
import { scaleBar } from '../../../apps/trails/public/modules/map.js';

const app = path => new URL(`../../../apps/trails/public/${path}`, import.meta.url);
const read = url => readFileSync(url, 'utf8');
const START = { lat: 39.5, lon: -79.3 };
const FEET_PER_DEGREE_LAT = 69.09 * FEET_PER_MILE;

// A fix some feet due north of START, some seconds after the start of the test hike.
const fix = (feetNorth, seconds, extra = {}) => ({ lat: START.lat + feetNorth / FEET_PER_DEGREE_LAT, lon: START.lon, t: seconds * 1000, accFeet: 16, altFeet: null, altAccFeet: null, ...extra });

test('geo: distance, bearing and compass agree with known values', () => {
  assert.ok(Math.abs(distanceMiles({ lat: 39, lon: -79 }, { lat: 40, lon: -79 }) - 69.09) < 0.05);
  assert.equal(Math.round(bearingDegrees({ lat: 39, lon: -79 }, { lat: 40, lon: -79 })), 0);
  assert.equal(Math.round(bearingDegrees({ lat: 39, lon: -79 }, { lat: 39, lon: -80 })), 270);
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(225), 'SW');
});

test('geo: short distances read in feet, long ones in miles', () => {
  assert.equal(formatDistance(0.05), '264 ft');
  assert.equal(formatDistance(1.234), '1.23 mi');
  assert.equal(formatDistance(12.34), '12.3 mi');
});

test('geo: pace stays blank until there is enough walking to mean anything', () => {
  assert.equal(formatPace(600, 0.01), '--');
  assert.equal(formatPace(1200, 1), '20:00');
});

test('geo: projection round-trips and tile ranges include both corners', () => {
  const world = project(START.lat, START.lon, 15);
  const back = unproject(world.x, world.y, 15);
  assert.ok(Math.abs(back.lat - START.lat) < 1e-9 && Math.abs(back.lon - START.lon) < 1e-9);
  const tiles = tilesForBounds({ south: 39.49, north: 39.51, west: -79.31, east: -79.29 }, 15);
  const here = project(39.5, -79.3, 15);
  assert.ok(tiles.some(tile => tile.x === Math.floor(here.x / 256) && tile.y === Math.floor(here.y / 256)));
});

test('recorder: a steady walk adds up to the right distance and time', () => {
  const recorder = createRecorder();
  for (let step = 0; step <= 10; step += 1) recorder.offer(fix(step * 100, step * 30));
  assert.equal(recorder.points.length, 11);
  assert.ok(Math.abs(recorder.stats.miles * FEET_PER_MILE - 1000) < 5);
  assert.equal(recorder.stats.movingSeconds, 300);
});

test('recorder: GPS jitter while standing still adds no distance', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  for (let second = 5; second < 300; second += 5) recorder.offer(fix(second % 2 ? 8 : -8, second));
  // Every reading is kept for the record, but none of them count as walking.
  assert.ok(recorder.points.length > 50);
  assert.equal(recorder.stats.miles, 0);
  assert.equal(recorder.stats.movingSeconds, 0);
  assert.equal(recorder.line.length, 1);
});

test('recorder: coarse fixes never join the route', () => {
  const recorder = createRecorder();
  assert.equal(recorder.offer(fix(0, 0, { accFeet: RULES.worstAccuracyFeet + 1 })).status, 'inaccurate');
  assert.equal(recorder.points.length, 0);
});

test('recorder: a lone GPS spike is dropped and the route carries on', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  assert.equal(recorder.offer(fix(3000, 5)).status, 'jump');
  assert.equal(recorder.offer(fix(50, 30)).status, 'recorded');
  assert.equal(recorder.points.length, 2);
  assert.ok(recorder.stats.miles * FEET_PER_MILE < 60);
});

test('recorder: fixes that keep agreeing elsewhere are believed, without bridging the jump', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  recorder.offer(fix(30000, 5));
  recorder.offer(fix(30010, 10));
  const result = recorder.offer(fix(30020, 15));
  assert.equal(result.status, 'recorded');
  assert.equal(result.point.seg, recorder.points[0].seg + 1);
  assert.equal(recorder.stats.miles, 0);
});

test('recorder: a silent phone is reported as a gap, not walked across', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  recorder.offer(fix(100, 30));
  const result = recorder.offer(fix(5000, 930));
  assert.equal(result.point.gapSeconds, 900);
  assert.equal(result.point.seg, 1);
  assert.equal(recorder.stats.gaps, 1);
  assert.equal(recorder.stats.untrackedSeconds, 900);
  assert.ok(recorder.stats.miles * FEET_PER_MILE < 110);
});

test('recorder: standing still with fixes still arriving is not a gap', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  for (let second = 30; second < 900; second += 30) recorder.offer(fix(2, second));
  const result = recorder.offer(fix(100, 900));
  assert.equal(result.status, 'recorded');
  assert.equal(result.point.gapSeconds, undefined);
  assert.equal(recorder.stats.gaps, 0);
});

test('recorder: pausing breaks the line and pause time is not untracked time', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  recorder.offer(fix(100, 30));
  recorder.pause();
  recorder.resume();
  const result = recorder.offer(fix(4000, 1000));
  assert.equal(result.point.seg, 1);
  assert.equal(recorder.stats.gaps, 0);
  assert.ok(recorder.stats.miles * FEET_PER_MILE < 110);
});

test('recorder: climbing ignores small altitude wander and counts real climbs', () => {
  const recorder = createRecorder();
  const altitudes = [1000, 1010, 995, 1005, 1040, 1080, 1120, 1085];
  altitudes.forEach((altFeet, index) => recorder.offer(fix(index * 100, index * 30, { altFeet })));
  assert.equal(recorder.stats.gainFeet, 120);
  assert.equal(recorder.stats.lossFeet, 35);
  assert.equal(recorder.stats.highFeet, 1120);
});

test('recorder: unreliable altitude is left out', () => {
  const recorder = createRecorder();
  const { point } = recorder.offer(fix(0, 0, { altFeet: 2000, altAccFeet: RULES.worstAltitudeAccuracyFeet + 1 }));
  assert.equal(point.altFeet, null);
});

test('recorder: a restored hike reproduces its stats and keeps recording', () => {
  const original = createRecorder();
  for (let step = 0; step <= 5; step += 1) original.offer(fix(step * 100, step * 30, { altFeet: 1000 + step * 20 }));
  const restored = createRecorder(original.points);
  assert.deepEqual(restored.stats, summarize(original.points));
  assert.equal(restored.stats.miles, original.stats.miles);
  const result = restored.offer(fix(600, 180));
  assert.equal(result.point.seq, 6);
  assert.equal(result.point.seg, 0);
});

test('elapsed time leaves out pauses and stops at the finish', () => {
  assert.equal(elapsedSeconds({ startedAt: 0, pausedSeconds: 60 }, 300000), 240);
  assert.equal(elapsedSeconds({ startedAt: 0, pausedSeconds: 0, pausedAt: 100000 }, 300000), 100);
  assert.equal(elapsedSeconds({ startedAt: 0, pausedSeconds: 0, endedAt: 50000 }, 300000), 50);
});

test('gpx: segments stay separate, names are escaped, and elevation is in metres', () => {
  const hike = { name: 'Ridge & <Run>', startedAt: Date.UTC(2026, 10, 5) };
  const points = [
    { seg: 0, lat: 39.5, lon: -79.3, t: 1000, altFeet: 3280.84 },
    { seg: 1, lat: 39.6, lon: -79.3, t: 2000, altFeet: null },
  ];
  const gpx = toGpx(hike, points, [{ name: 'Car', lat: 39.5, lon: -79.3, t: 1000, altFeet: null }]);
  assert.equal(gpx.match(/<trkseg>/g).length, 2);
  assert.match(gpx, /Ridge &amp; &lt;Run&gt;/);
  assert.match(gpx, /<ele>1000\.0<\/ele>/);
  assert.match(gpx, /<wpt lat="39.5" lon="-79.3">.*<name>Car<\/name>/);
  assert.equal(gpxFileName(hike), '2026-11-05-ridge-run.gpx');
});

test('landscape: stream lines survive encoding at about 3 ft precision', () => {
  const coords = [[-79.34406, 40.42525], [-79.34414, 40.42532], [-79.34414, 40.42532], [-79.34421, 40.42551]];
  const line = decodeLine(encodeLine({ name: 'Spruce Run', into: 'Casselman River', order: 3, coords }));
  assert.equal(line.name, 'Spruce Run');
  assert.equal(line.into, 'Casselman River');
  assert.equal(line.points.length, 3);
  assert.ok(Math.abs(line.points[2].lat - 40.42551) < 1e-9);
});

test('landscape: nearest water reports direction to it and which way it flows', () => {
  const line = { name: 'Test Run', into: 'Test River', order: 2, points: [{ lat: 39.49, lon: -79.29 }, { lat: 39.51, lon: -79.29 }] };
  const water = nearestWater([line], START);
  assert.equal(compassPoint(water.bearing), 'E');
  assert.equal(compassPoint(water.flowBearing), 'N');
  assert.ok(Math.abs(water.miles - 0.533) < 0.01);
  assert.equal(nearestWater([line], START, 0.1), null);
});

test('landscape: shard lookups cover the bounds they are asked for', () => {
  const keys = shardsForBounds({ south: 39.4, north: 39.6, west: -79.4, east: -79.2 });
  assert.ok(keys.includes(shardKey(39.4, -79.4)));
  assert.ok(keys.includes(shardKey(39.6, -79.2)));
  assert.equal(keys.length, 4);
});

test('landscape: nearest town reads as a direction from the town', () => {
  const index = buildPlaceIndex([['Gormania', 'WV', 39.2809, -79.3409], ['Far', 'WV', 37.8, -80.7]]);
  const town = nearestPlace(index, { lat: 39.2954, lon: -79.3409 });
  assert.equal(town.name, 'Gormania');
  assert.equal(compassPoint(town.bearingFromPlace), 'N');
  assert.ok(Math.abs(town.miles - 1) < 0.01);
  assert.equal(nearestPlace(index, { lat: 45, lon: -70 }), null);
});

test('baked data: names real water on both sides of the Eastern Divide', () => {
  const index = JSON.parse(read(app('data/index.json')));
  const lookup = position => {
    const key = shardKey(position.lat, position.lon);
    assert.ok(index.shards.includes(key));
    const { lines } = JSON.parse(read(app(`data/streams/${key}.json`)));
    return nearestWater(lines.map(decodeLine), position);
  };
  // Near Swallow Falls in Garrett County, which drains west to the Gulf of Mexico.
  assert.equal(lookup({ lat: 39.4986, lon: -79.4097 }).into, 'Youghiogheny River');
  // At Gormania, on the Potomac side.
  assert.equal(lookup({ lat: 39.2809, lon: -79.3409 }).into, 'North Branch Potomac River');
});

test('baked data: stream shards decode into usable lines', () => {
  const key = shardKey(39.2809, -79.3409);
  const { lines } = JSON.parse(read(app(`data/streams/${key}.json`)));
  assert.ok(lines.length > 500);
  for (const entry of lines.slice(0, 200)) assert.ok(decodeLine(entry).points.length >= 2);
});

test('saving an area is refused when it would be enormous', () => {
  const small = planArea({ south: 39.48, north: 39.52, west: -79.32, east: -79.28 }, [shardKey(39.5, -79.3)]);
  assert.equal(small.tooLarge, false);
  assert.ok(small.tiles.length > 50 && small.tiles.length < MAX_SAVE_TILES);
  assert.equal(small.tiles.length, small.tileCount);
  assert.deepEqual(small.shards, [shardKey(39.5, -79.3)]);
  const huge = planArea({ south: 20, north: 50, west: -125, east: -70 });
  assert.equal(huge.tooLarge, true);
  assert.equal(huge.tiles.length, 0);
});

test('scale bar picks a round length that fits', () => {
  assert.deepEqual(scaleBar(10), { pixels: 100, label: '1,000 ft' });
  assert.deepEqual(scaleBar(100), { pixels: 106, label: '2 mi' });
});

test('service worker precaches files that exist and shares the saved cache name', () => {
  const sw = read(app('sw.js'));
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map(item => item.slice(1, -1));
  for (const path of list) if (path !== './') assert.ok(existsSync(app(path)), `${path} is in the shell list but missing`);
  for (const module of ['app', 'backup', 'checkpoints', 'device', 'geo', 'geocaches', 'gpx', 'hikes', 'landscape', 'map', 'offline', 'photos', 'store', 'terrain', 'terrain-view', 'tracker', 'trails']) assert.ok(list.includes(`modules/${module}.js`), `${module} is not precached`);
  assert.ok(sw.includes(`SAVED_CACHE = '${SAVED_CACHE}'`));
});

test('the trail app keeps tight browser limits', () => {
  const headers = read(new URL('../../../public/_headers', import.meta.url));
  assert.match(headers, /^\/trails\/\*/);
  assert.match(headers, /geolocation=\(self\)/);
  assert.match(headers, /script-src 'self';/);
  assert.match(headers, /object-src 'none'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.doesNotMatch(headers, /'unsafe-eval'/);
  assert.doesNotMatch(headers, /script-src[^;]*'unsafe/);
});

test('each release stores the app under a name from its own files', () => {
  const sw = read(app('sw.js'));
  assert.ok(sw.includes("SHELL_CACHE = 'hike-shell-__BUILD__'"), 'the build needs this to name the release');
  assert.equal(sw.split('__BUILD__').length, 2, 'the build replaces the first one it finds, so this must be the only one');
  assert.ok(read(new URL('../../../vite.config.mjs', import.meta.url)).includes('.replace("__BUILD__"'));
});
