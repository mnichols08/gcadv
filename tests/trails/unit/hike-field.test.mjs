import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEET_PER_MILE } from '../../../apps/trails/public/modules/geo.js';
import { cacheFacts, decodeEntities, mergeCaches, nearestFirst, parseGpx } from '../../../apps/trails/public/modules/geocaches.js';
import { accessFact, directionsUrl, nearestAccess } from '../../../apps/trails/public/modules/hikes.js';
import { nearestMarker, placePhoto, positionAtTime, readExif, scaledSize } from '../../../apps/trails/public/modules/photos.js';
import { averagePosition, createRecorder, routeLine, summarize } from '../../../apps/trails/public/modules/tracker.js';

const FEET_PER_DEGREE_LAT = 69.09 * FEET_PER_MILE;
const fix = (feetNorth, seconds, extra = {}) => ({ lat: 39.5 + feetNorth / FEET_PER_DEGREE_LAT, lon: -79.3, t: seconds * 1000, accFeet: 16, altFeet: null, altAccFeet: null, ...extra });

test('high resolution: every good fix is kept, while distance stays true', () => {
  const recorder = createRecorder();
  // Walking 1,000 ft at 4 ft a second, reading once a second, with a little GPS wobble.
  for (let second = 0; second <= 250; second += 1) recorder.offer(fix(second * 4 + (second % 2 ? 0.4 : -0.4), second));
  assert.ok(recorder.points.length >= 245, `kept ${recorder.points.length}`);
  const feet = recorder.stats.miles * FEET_PER_MILE;
  assert.ok(Math.abs(feet - 1000) < 40, `measured ${feet} ft`);
  assert.ok(recorder.line.length < recorder.points.length);
  assert.ok(recorder.line.length >= 20);
});

test('high resolution: wobble while resting never turns into miles', () => {
  const recorder = createRecorder();
  recorder.offer(fix(0, 0));
  for (let second = 1; second < 3600; second += 1) recorder.offer(fix(Math.sin(second) * 8, second));
  assert.equal(recorder.stats.miles, 0);
});

test('high resolution: identical fixes do not pile up', () => {
  const recorder = createRecorder();
  for (let second = 0; second < 100; second += 1) recorder.offer(fix(1, second));
  assert.equal(recorder.points.length, 1);
});

test('restoring rebuilds the same line and distance from saved points', () => {
  const original = createRecorder();
  for (let second = 0; second <= 120; second += 1) original.offer(fix(second * 4, second));
  const restored = createRecorder(original.points);
  assert.deepEqual(restored.line, original.line);
  assert.deepEqual(routeLine(original.points), original.line);
  assert.deepEqual(summarize(original.points), original.stats);
  assert.equal(restored.stats.miles, original.stats.miles);
});

test('averaging: favors sharp readings and ignores someone walking off', () => {
  const position = averagePosition([fix(0, 0, { accFeet: 10 }), fix(10, 1, { accFeet: 10 }), fix(4, 2, { accFeet: 100 }), fix(500, 3, { accFeet: 10 })]);
  assert.equal(position.count, 3);
  assert.equal(position.bestFeet, 10);
  const feetNorth = (position.lat - 39.5) * FEET_PER_DEGREE_LAT;
  assert.ok(feetNorth > 4 && feetNorth < 6, `averaged to ${feetNorth}`);
  assert.equal(averagePosition([fix(0, 0, { accFeet: 500 })]), null);
  assert.equal(averagePosition([]), null);
});

// A minimal JPEG with an EXIF block, built the way a camera lays one out.
function jpegWithExif({ lat, latRef = 'N', lon, lonRef = 'W', time, little = true }) {
  const bytes = new DataView(new ArrayBuffer(400));
  const tiff = 12;
  const u16 = (at, value) => bytes.setUint16(tiff + at, value, little);
  const u32 = (at, value) => bytes.setUint32(tiff + at, value, little);
  const entry = (ifdAt, index, tag, type, count, value) => {
    const at = ifdAt + 2 + index * 12;
    u16(at, tag);
    u16(at + 2, type);
    u32(at + 4, count);
    if (type === 2 && count <= 4) bytes.setUint8(tiff + at + 8, value.charCodeAt(0));
    else u32(at + 8, value);
  };
  bytes.setUint16(0, 0xffd8);
  bytes.setUint16(2, 0xffe1);
  bytes.setUint16(4, 380);
  bytes.setUint32(6, 0x45786966);
  bytes.setUint16(tiff, little ? 0x4949 : 0x4d4d);
  u16(2, 42);
  u32(4, 8);
  u16(8, 2);
  entry(8, 0, 0x8769, 4, 1, 60);
  entry(8, 1, 0x8825, 4, 1, 100);
  u16(60, 1);
  if (time) {
    entry(60, 0, 0x9003, 2, 20, 200);
    [...time].forEach((char, index) => bytes.setUint8(tiff + 200 + index, char.charCodeAt(0)));
  } else {
    u16(60, 0);
  }
  u16(100, lat === undefined ? 0 : 4);
  if (lat !== undefined) {
    entry(100, 0, 1, 2, 2, latRef);
    entry(100, 1, 2, 5, 3, 240);
    entry(100, 2, 3, 2, 2, lonRef);
    entry(100, 3, 4, 5, 3, 270);
    const rational = (at, [d, m, s]) => {
      [[d, 1], [m, 1], [Math.round(s * 100), 100]].forEach(([top, bottom], index) => {
        u32(at + index * 8, top);
        u32(at + index * 8 + 4, bottom);
      });
    };
    rational(240, lat);
    rational(270, lon);
  }
  return bytes.buffer;
}

for (const little of [true, false]) {
  test(`EXIF: reads location and time from a ${little ? 'little' : 'big'}-endian photo`, () => {
    const exif = readExif(jpegWithExif({ lat: [39, 30, 0], lon: [79, 18, 36], time: '2026:11:05 14:30:00', little }));
    assert.ok(Math.abs(exif.lat - 39.5) < 1e-6);
    assert.ok(Math.abs(exif.lon + 79.31) < 1e-6);
    assert.equal(exif.time, new Date(2026, 10, 5, 14, 30, 0).getTime());
  });
}

test('EXIF: south and east stay in the right hemisphere', () => {
  const exif = readExif(jpegWithExif({ lat: [10, 0, 0], latRef: 'S', lon: [20, 0, 0], lonRef: 'E' }));
  assert.equal(exif.lat, -10);
  assert.equal(exif.lon, 20);
});

test('EXIF: missing or damaged data is treated as nothing, never a crash', () => {
  const none = { lat: null, lon: null, time: null };
  assert.deepEqual(readExif(new ArrayBuffer(4)), none);
  assert.deepEqual(readExif(new ArrayBuffer(0)), none);
  assert.deepEqual(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66]).buffer), none);
  // Null Island zeros are a camera with no fix, not a place.
  assert.equal(readExif(jpegWithExif({ lat: [0, 0, 0], lon: [0, 0, 0] })).lat, null);
  for (let cut = 10; cut < 400; cut += 37) readExif(jpegWithExif({ lat: [39, 30, 0], lon: [79, 18, 36], time: '2026:11:05 14:30:00' }).slice(0, cut));
});

const route = [
  { seg: 0, lat: 39.5, lon: -79.3, t: 100000 },
  { seg: 0, lat: 39.6, lon: -79.3, t: 200000 },
  { seg: 1, lat: 39.9, lon: -79.3, t: 2000000 },
];
const NONE = { lat: null, lon: null, time: null };

test('photo time: finds the spot along the route, and refuses to guess across a gap', () => {
  assert.ok(Math.abs(positionAtTime(route, 150000).lat - 39.55) < 1e-9);
  assert.equal(positionAtTime(route, 1000000), null);
  assert.equal(positionAtTime(route, 100000 - 600000), null);
  assert.equal(positionAtTime([], 5), null);
  assert.equal(positionAtTime(route, 2100000).lat, 39.9);
});

test('photo placement: uses the best evidence available, in order', () => {
  const here = { lat: 1, lon: 2 };
  assert.equal(placePhoto({ exif: { lat: 39, lon: -79, time: 150000 }, points: route, fix: here, now: 150000 }).source, 'photo');
  assert.equal(placePhoto({ exif: { ...NONE, time: 150000 }, points: route, fix: here, now: 150000 }).source, 'route');
  assert.equal(placePhoto({ exif: NONE, fileTime: 9000000, points: route, fix: here, now: 9000000 }).source, 'here');
});

test('photo placement: an old library photo never lands where you happen to stand', () => {
  const old = placePhoto({ exif: NONE, fileTime: 1000, points: [], fix: { lat: 1, lon: 2 }, now: 900000000 });
  assert.equal(old.lat, null);
  assert.equal(old.source, null);
  assert.equal(placePhoto({ exif: NONE, fileTime: null, now: 500 }).t, 500);
});

test('photos shrink in proportion and never grow', () => {
  assert.deepEqual(scaledSize(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(scaledSize(3000, 4000, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(scaledSize(800, 600, 1600), { width: 800, height: 600 });
});

test('a tap picks the closest marker within fingertip reach', () => {
  const near = { x: 100, y: 100 };
  const nearer = { x: 110, y: 100 };
  assert.equal(nearestMarker([near, nearer], 112, 100), nearer);
  assert.equal(nearestMarker([near], 200, 200), null);
});

const GPX = `<?xml version="1.0"?><gpx xmlns:groundspeak="http://www.groundspeak.com/cache/1/0/1">
<wpt lat="39.50000" lon="-79.42000"><time>2020-01-01</time><name>GC12345</name><desc>Falls Cache by Someone</desc><urlname>Falls Cache</urlname><type>Geocache|Traditional Cache</type>
  <groundspeak:cache><groundspeak:name>Falls &amp; Hemlocks</groundspeak:name><groundspeak:owner>Someone</groundspeak:owner><groundspeak:type>Traditional Cache</groundspeak:type><groundspeak:container>Small</groundspeak:container><groundspeak:difficulty>1.5</groundspeak:difficulty><groundspeak:terrain>2</groundspeak:terrain>
  <groundspeak:short_description html="True">&lt;p&gt;Near the &lt;b&gt;falls&lt;/b&gt;&lt;/p&gt;</groundspeak:short_description><groundspeak:encoded_hints>Under the log</groundspeak:encoded_hints></groundspeak:cache></wpt>
<wpt lat='39.1' lon='-79.5'><name>Plain Spot</name></wpt>
<wpt lat="not-a-number" lon="-79.5"><name>Broken</name></wpt>
<wpt lat="95" lon="-79.5"><name>Off the planet</name></wpt>
<wpt lat="0" lon="0"><name>Null Island</name></wpt>
</gpx>`;

test('GPX: reads a geocache listing with all its details', () => {
  const [cache] = parseGpx(GPX);
  assert.equal(cache.name, 'Falls & Hemlocks');
  assert.equal(cache.code, 'GC12345');
  assert.equal(cache.lat, 39.5);
  assert.equal(cache.type, 'Traditional Cache');
  assert.equal(cache.difficulty, '1.5');
  assert.equal(cache.size, 'Small');
  assert.equal(cache.hint, 'Under the log');
  assert.equal(cache.description, 'Near the falls');
  assert.equal(cacheFacts(cache), 'Traditional Cache · difficulty 1.5 · terrain 2 · small');
});

test('GPX: accepts plain waypoints and drops impossible ones', () => {
  const caches = parseGpx(GPX);
  assert.deepEqual(caches.map(cache => cache.name), ['Falls & Hemlocks', 'Plain Spot']);
  assert.equal(caches[1].code, '');
  assert.deepEqual(parseGpx('<gpx></gpx>'), []);
  assert.deepEqual(parseGpx('not xml at all'), []);
});

test('GPX: markup in a hostile file comes out as harmless text', () => {
  const [cache] = parseGpx(`<wpt lat="39" lon="-79"><name>&lt;img src=x onerror=alert(1)&gt;Sneaky</name><desc>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;Words</desc></wpt>`);
  assert.equal(cache.name, 'Sneaky');
  assert.doesNotMatch(cache.description, /<script/);
});

test('GPX: entity decoding handles numbers and leaves nonsense alone', () => {
  assert.equal(decodeEntities('&#65;&#x42;&amp;&unknown;'), 'AB&&unknown;');
  assert.equal(decodeEntities('&#x110000;'), '');
});

test('re-importing keeps what the hiker already found', () => {
  const [first] = parseGpx(GPX);
  const { caches, added, updated } = mergeCaches([{ ...first, found: 12345 }], parseGpx(GPX));
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(caches.find(cache => cache.id === first.id).found, 12345);
});

test('caches list nearest first', () => {
  const sorted = nearestFirst(parseGpx(GPX), { lat: 39.1, lon: -79.5 });
  assert.equal(sorted[0].name, 'Plain Spot');
});

test('access: states what is mapped, and admits when nothing is', () => {
  assert.equal(accessFact({ access: [] }), 'No trailhead or parking in the data.');
  assert.equal(accessFact({ access: [{ type: 'trailhead', name: 'Bear Rocks', feet: 50 }] }), 'Trailhead (Bear Rocks) at the trail.');
  assert.equal(accessFact({ access: [{ type: 'parking', name: '', feet: 400 }] }), 'Parking about 400 ft from the trail.');
  assert.equal(nearestAccess({ access: [] }, { lat: 39, lon: -79 }), null);
  assert.equal(nearestAccess({ access: [{ lat: 40, lon: -79 }, { lat: 39.1, lon: -79 }] }, { lat: 39, lon: -79 }).lat, 39.1);
  assert.equal(directionsUrl({ lat: 39.5, lon: -79.4 }), 'https://www.google.com/maps/dir/?api=1&destination=39.5,-79.4');
});

test('baked access: known trailheads are attached to their hikes', () => {
  const { hikes } = JSON.parse(readFileSync(new URL('../../../apps/trails/public/data/hikes.json', import.meta.url), 'utf8'));
  const bearRocks = hikes.find(hike => hike.id === 'bear-rocks');
  assert.equal(bearRocks.access[0].type, 'trailhead');
  assert.ok(Math.abs(bearRocks.access[0].lat - 39.0636) < 0.001);
  assert.ok(hikes.filter(hike => hike.access.length).length >= 15, 'most hikes should have a way in');
  for (const hike of hikes) for (const place of hike.access) assert.ok(Math.abs(place.lat - (hike.bounds.south + hike.bounds.north) / 2) < 0.5, hike.id);
});
