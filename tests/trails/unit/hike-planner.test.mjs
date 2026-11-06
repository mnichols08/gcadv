import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATV, BIKE, HIKE, SKI, seasonText, SNOWMOBILE, usfsUse } from '../../../apps/trails/public/modules/activities.js';
import { applyOfficial, decodeTrail, encodeTrail } from '../../../apps/trails/public/modules/trails.js';
import { isSnowSeason, NEARBY_MILES, nearbyDirectory, planTrip, seasonalActivities, TRAILS_PER_ACTIVITY } from '../../../apps/trails/public/modules/planner.js';

const data = name => JSON.parse(readFileSync(new URL(`../../../apps/trails/public/data/${name}`, import.meta.url), 'utf8'));
const stay = { lat: 39.5, lon: -79.4, county: 'Garrett County, MD' };
const route = (name, activities, lat, miles = 3) => ({ name, activities, miles, center: { lat, lon: -79.4 } });

test('Forest Service dates read as words', () => {
  assert.equal(seasonText('04/01-01/15'), 'Apr 1 to Jan 15');
  assert.equal(seasonText(''), '');
  assert.equal(seasonText(null), '');
});

test('the Forest Service can open, close, and season a trail', () => {
  const closed = usfsUse({ atv_restricted: '01/01-12/31', bicycle_managed: '01/01-12/31' });
  assert.equal(closed.blocked, ATV);
  assert.equal(closed.allowed, BIKE);
  assert.deepEqual(closed.seasons, {});
  const seasonal = usfsUse({ atv_managed: '04/01-01/15', atv_restricted: '01/16-03/31' });
  assert.equal(seasonal.allowed, ATV);
  assert.equal(seasonal.blocked, 0, 'closed part of the year still lists, with its season');
  assert.equal(seasonal.seasons[ATV], 'Apr 1 to Jan 15');
  assert.deepEqual(usfsUse({}), { allowed: 0, blocked: 0, seasons: {} });
});

const coords = [[-79.5, 39.1], [-79.499, 39.101], [-79.498, 39.102]];
const official = (fields = {}) => ({ names: ['Official'], kind: 'foot', coords, allowed: 0, blocked: 0, seasons: {}, ...fields });

test('where an official line runs along a mapped one, its word wins', () => {
  const [line] = applyOfficial([{ names: ['Mapped'], kind: 'foot', sources: ['osm'], activities: HIKE | ATV, coords }], [official({ allowed: BIKE, blocked: ATV })]);
  assert.equal(line.activities, HIKE | BIKE);
  assert.equal(line.blocked, ATV);
  assert.deepEqual(line.sources, ['osm', 'usfs']);
  assert.deepEqual(line.names, ['Mapped']);
});

test('a trail only the Forest Service has becomes its own line, and elsewhere is untouched', () => {
  const far = [[-79, 39.5], [-78.999, 39.501]];
  const lines = applyOfficial([{ names: ['Far'], kind: 'foot', sources: ['osm'], activities: ATV, coords: far }], [official({ allowed: SKI })]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].activities, ATV);
  assert.deepEqual(lines[1].sources, ['usfs']);
  assert.equal(lines[1].activities, SKI);
});

test('the Forest Service survives encoding as a source', () => {
  const decoded = decodeTrail(encodeTrail({ names: ['A'], kind: 'foot', sources: ['osm', 'usfs'], coords, activities: HIKE }));
  assert.deepEqual(decoded.sources, ['osm', 'usfs']);
});

test('snow activities lead in winter and follow in summer', () => {
  assert.equal(isSnowSeason(0), true);
  assert.equal(isSnowSeason(6), false);
  assert.equal(seasonalActivities(0)[0].id, 'ski');
  assert.equal(seasonalActivities(6)[0].id, 'hike');
  assert.equal(seasonalActivities(6).length, seasonalActivities(0).length);
});

test('a plan gives the nearest real trails for each activity', () => {
  const routes = [route('Far', HIKE, 39.9), route('Near', HIKE, 39.51), route('Stub', HIKE, 39.5, 0.1), route('Mid', HIKE, 39.6), route('Next', HIKE, 39.62), route('Sled', SNOWMOBILE, 39.5)];
  const [hike, sled] = planTrip({ stay, activityIds: ['hike', 'snowmobile'], routes }).sections;
  assert.deepEqual(hike.trails.map(({ entry }) => entry.name), ['Near', 'Mid', 'Next']);
  assert.equal(hike.trails.length, TRAILS_PER_ACTIVITY);
  assert.deepEqual(sled.trails.map(({ entry }) => entry.name), ['Sled']);
});

test('a plan keeps a short trail when nothing longer exists, and nothing beyond reach', () => {
  const [section] = planTrip({ stay, activityIds: ['ski'], routes: [route('Short', SKI, 39.5, 0.1)] }).sections;
  assert.equal(section.trails[0].entry.name, 'Short');
  const [empty] = planTrip({ stay, activityIds: ['ski'], routes: [route('Away', SKI, 42)] }).sections;
  assert.equal(empty.trails.length, 0);
});

test('outfitters and land managers appear only under activities they name', () => {
  const shop = { name: 'Shop', lat: 39.5, lon: -79.4, activities: ['bike'] };
  const general = { name: 'General', lat: 39.5, lon: -79.4 };
  assert.deepEqual(nearbyDirectory([shop, general], stay, 'bike').map(({ entry }) => entry.name), ['Shop']);
  assert.equal(nearbyDirectory([shop], stay, 'motor').length, 0);
  assert.equal(nearbyDirectory([{ ...shop, lat: 45 }], stay, 'bike').length, 0);
  const trip = planTrip({ stay, activityIds: ['bike'], routes: [], outfitters: [shop], official: [general], guides: [{ title: 'G', counties: ['Garrett County, MD'] }, { title: 'Other', counties: ['Tucker County, WV'] }] });
  assert.equal(trip.sections[0].outfitters[0].entry.name, 'Shop');
  assert.deepEqual(trip.general.map(({ entry }) => entry.name), ['General']);
  assert.deepEqual(trip.guides.map(guide => guide.title), ['G']);
  assert.ok(NEARBY_MILES > 0);
});

test('baked: every stay is placed in a covered county', () => {
  const { stays } = data('stays.json');
  assert.ok(stays.length >= 20);
  for (const place of stays) assert.ok(place.county, `${place.label} is outside the covered counties`);
  assert.equal(new Set(stays.map(place => place.id)).size, stays.length);
});

test('baked: guides point at real articles on the site', () => {
  for (const { url } of data('stays.json').guides) {
    readFileSync(new URL(`../../../content/articles/${url.replace('.html', '.md')}`, import.meta.url));
  }
});

test('baked: every directory entry is placed, linked over https, and has a checked date', () => {
  const official = data('official.json');
  assert.ok(official.checkedAt);
  const outfitters = data('outfitters.json');
  for (const entry of [...official.official, ...outfitters.outfitters]) {
    assert.ok(Number.isFinite(entry.lat) && Number.isFinite(entry.lon), entry.name);
    assert.match(entry.url, /^https:\/\//, entry.name);
  }
  for (const entry of outfitters.outfitters) {
    assert.ok(entry.sourceUrl && entry.services && entry.activities.length, entry.name);
  }
});

test('baked: corrections hold, and land manager facts stay attached', () => {
  const { routes } = data('routes.json');
  const named = name => routes.filter(item => item.name === name);
  assert.ok(named('Snaggy Mountain Road').some(item => item.activities & ATV && item.official), 'Snaggy Mountain Road is DNR-designated ORV');
  assert.ok(named('Piney Mountain Road').every(item => !(item.activities & ATV)), 'DNR contradicts the ATV tag on Piney Mountain Road');
  assert.ok(named('Burkholder Road ATV Trail').every(item => !(item.activities & ATV)));
});

test('the same trail from the Forest Service never counts twice, even mapped a little apart', () => {
  const offset = [[-79.5, 39.1004], [-79.499, 39.1014], [-79.498, 39.1024]];
  const lines = applyOfficial([{ names: ['Blackbird Knob Trail'], kind: 'foot', sources: ['osm'], activities: HIKE, coords }], [official({ names: ['Blackbird Knob'], coords: offset, blocked: ATV })]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].blocked, ATV, 'its word still applies to the matching trail');
});

test('baked: an outfitter is listed only with its source page, in the county its source names', () => {
  const { outfitters } = data('outfitters.json');
  assert.ok(outfitters.length >= 15);
  assert.equal(outfitters.some(entry => /deepcreeklakestable|westerntrails/.test(entry.url)), false);
  for (const entry of outfitters) assert.match(entry.sourceUrl, /^https?:\/\//);
});

test('the outfitter note says where listings come from and that none are paid', () => {
  const app = readFileSync(new URL('../../../apps/trails/public/modules/app.js', import.meta.url), 'utf8');
  assert.match(app, /park or tourism page\. Not paid placements/);
});
