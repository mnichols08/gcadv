import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collection, fromMapboxZoom, line, point, readToken, routeFeatures, routeSegments, streamFeatures, toMapboxZoom, trailFeatures, uniqueLines } from '../../../apps/trails/public/modules/mapbox-data.js';

const a = { lat: 39.1, lon: -79.5 };
const b = { lat: 39.2, lon: -79.4 };
const c = { lat: 39.3, lon: -79.3 };

test('zoom converts between the two map worlds', () => {
  assert.equal(toMapboxZoom(15), 14);
  assert.equal(fromMapboxZoom(toMapboxZoom(12.5)), 12.5);
});

test('only a public token is accepted', () => {
  assert.equal(readToken({ mapboxToken: 'pk.abc_1.def-2' }), 'pk.abc_1.def-2');
  assert.equal(readToken({ mapboxToken: 'sk.abc.def' }), null);
  assert.equal(readToken({ mapboxToken: 'pk.abc' }), null);
  assert.equal(readToken({ mapboxToken: 7 }), null);
  assert.equal(readToken({}), null);
  assert.equal(readToken(null), null);
});

test('features put longitude first', () => {
  assert.deepEqual(point(a).geometry.coordinates, [-79.5, 39.1]);
  assert.deepEqual(line([a, b]).geometry.coordinates, [[-79.5, 39.1], [-79.4, 39.2]]);
  assert.deepEqual(collection([]), { type: 'FeatureCollection', features: [] });
});

test('a trail stored in two shards is drawn once', () => {
  const trail = { name: 'Lostland', kind: 'foot', points: [a, b] };
  const other = { name: 'Lostland', kind: 'foot', points: [b, c] };
  assert.deepEqual(uniqueLines([{ lines: [trail, other] }, { lines: [{ ...trail }] }, null]), [trail, other]);
});

test('trails carry what the map needs to style them, and single points are dropped', () => {
  const [feature, ...rest] = trailFeatures([{ lines: [{ name: 'Lostland', kind: 'shared', points: [a, b] }, { name: 'Dot', kind: 'foot', points: [a] }] }]);
  assert.deepEqual(feature.properties, { kind: 'shared', name: 'Lostland' });
  assert.equal(rest.length, 0);
});

test('stream width follows stream order', () => {
  const tiers = streamFeatures([{ lines: [{ order: 1, points: [a, b] }, { order: 3, points: [a, b] }, { order: 6, points: [a, b] }] }]).map(feature => feature.properties.tier);
  assert.deepEqual(tiers, [0, 1, 2]);
});

test('a paused route breaks into separate lines', () => {
  const route = [{ ...a, seg: 0 }, { ...b, seg: 0 }, { ...c, seg: 1 }, { ...a, seg: 2 }, { ...b, seg: 2 }];
  assert.equal(routeSegments(route).length, 2);
  const features = routeFeatures(route, '#123456');
  assert.equal(features.length, 2);
  assert.equal(features[0].properties.color, '#123456');
});

test('the Mapbox library is copied in by the build, not committed', () => {
  const config = readFileSync(new URL('../../../vite.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /mapbox-gl\.js/);
  assert.match(config, /!name\.startsWith\("trails\/"\)/);
});
