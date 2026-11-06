import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arrivalCheck, arrivedAt, groupCheckpoints, progress, progressText, STALE_SECONDS } from '../../../apps/trails/public/modules/checkpoints.js';
import { distanceMiles, FEET_PER_MILE } from '../../../apps/trails/public/modules/geo.js';
import { decodeTrail } from '../../../apps/trails/public/modules/trails.js';

const json = path => JSON.parse(readFileSync(new URL(`../../../apps/trails/${path}`, import.meta.url), 'utf8'));
const FEET_PER_DEGREE_LAT = 69.09 * FEET_PER_MILE;
const spot = { id: 'a', name: 'A', lat: 39.5, lon: -79.3, radiusFeet: 200, group: 'G' };
const other = { id: 'b', name: 'B', lat: 39.5002, lon: -79.3, radiusFeet: 200, group: 'H' };
const northOf = (feet, accFeet = 16) => ({ lat: 39.5 + feet / FEET_PER_DEGREE_LAT, lon: -79.3, accFeet });

test('arrival: close enough counts, with a little allowance for GPS error', () => {
  assert.equal(arrivalCheck(spot, northOf(100)).status, 'here');
  assert.equal(arrivalCheck(spot, northOf(210, 16)).status, 'here');
  assert.equal(arrivalCheck(spot, northOf(240, 16)).status, 'far');
  // The allowance is capped, so a vague fix can't stretch the reach far.
  assert.equal(arrivalCheck(spot, northOf(240, 100)).status, 'here');
  assert.equal(arrivalCheck(spot, northOf(260, 100)).status, 'far');
});

test('arrival: weak, old or missing GPS does not count', () => {
  assert.equal(arrivalCheck(spot, northOf(0, 400)).status, 'weak');
  assert.equal(arrivalCheck(spot, northOf(0), STALE_SECONDS + 1).status, 'stale');
  assert.equal(arrivalCheck(spot, null).status, 'no-fix');
});

test('arrival: offers the closest unreached checkpoint and skips finished ones', () => {
  const near = northOf(20);
  assert.equal(arrivedAt([spot, other], [], near).id, 'a');
  assert.equal(arrivedAt([spot, other], [{ id: 'a' }], near).id, 'b');
  assert.equal(arrivedAt([spot, other], [{ id: 'a' }, { id: 'b' }], near), null);
  assert.equal(arrivedAt([spot], [], northOf(5000)), null);
  assert.equal(arrivedAt([spot], [], null), null);
});

test('progress counts each place once and celebrates finishing', () => {
  assert.deepEqual(progress([spot, other], [{ id: 'a' }, { id: 'a' }, { id: 'retired' }]), { reached: 1, total: 2, complete: false });
  assert.equal(progressText(progress([spot, other], [{ id: 'a' }])), '1 of 2 reached.');
  assert.equal(progressText(progress([spot, other], [{ id: 'a' }, { id: 'b' }])), 'All 2 reached. Nicely done.');
  assert.equal(progress([], []).complete, false);
});

test('checkpoints group by home area in catalog order', () => {
  assert.deepEqual(groupCheckpoints([spot, other]).map(group => group.name), ['G', 'H']);
});

test('baked checkpoints: ten places across all three home areas', () => {
  const { checkpoints } = json('public/data/checkpoints.json');
  assert.equal(checkpoints.length, 10);
  assert.equal(new Set(checkpoints.map(item => item.id)).size, 10);
  for (const group of ['Near Gormania', 'Garrett County', 'Tucker County']) assert.ok(checkpoints.some(item => item.group === group), group);
});

test('baked checkpoints: each belongs to a real hike and sits near its trail', () => {
  const { checkpoints } = json('public/data/checkpoints.json');
  const { hikes } = json('public/data/hikes.json');
  for (const checkpoint of checkpoints) {
    const hike = hikes.find(item => item.id === checkpoint.hikeId);
    assert.ok(hike, checkpoint.id);
    if (hike.kind !== 'route') continue;
    const feet = Math.min(...hike.lines.flatMap(line => decodeTrail(line).points).map(point => distanceMiles(checkpoint, point))) * FEET_PER_MILE;
    assert.ok(feet <= 300, `${checkpoint.id} is ${Math.round(feet)} ft from its trail`);
  }
});

test('baked checkpoints: the right Table Rock, the hazard warning, and no private-land approach', () => {
  const { checkpoints } = json('public/data/checkpoints.json');
  const tableRock = checkpoints.find(item => item.id === 'table-rock');
  assert.ok(tableRock.lat < 39.1, 'should be the Canaan Mountain one, not the one near Cheat Lake');
  assert.match(checkpoints.find(item => item.id === 'bear-rocks').note, /Unexploded/);
  assert.ok(!checkpoints.some(item => /hoye/i.test(item.id)));
});
