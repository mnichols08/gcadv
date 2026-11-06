import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchConditions, gaugeText, gaugeUrl, isFresh, nearbyGauges, parseAlerts, parseForecast, parseGauges, parseSnowInches, roughly, SAVED_FOR_MS, snowText, snowUrl, withSaved } from '../../../apps/trails/public/modules/conditions.js';
import { climbAndDescent, detailFacts, effortRating, lineMiles, profilePath, resample, trailDetails } from '../../../apps/trails/public/modules/trail-details.js';
import { ATV, HIKE } from '../../../apps/trails/public/modules/activities.js';

const NOW = Date.parse('2026-11-06T01:00:00Z');
const gauges = [{ id: '03076100', name: 'Near', lat: 39.5, lon: -79.4 }, { id: '01595500', name: 'Far', lat: 40.3, lon: -79.4 }, { id: '03081500', name: 'Stale', lat: 39.5, lon: -79.4 }];
const reading = (id, parameter_code, value, time = '2026-11-06T00:45:00+00:00') => ({ properties: { monitoring_location_id: `USGS-${id}`, parameter_code, value: String(value), time } });

test('location is rounded before it leaves the phone, and the river request has none', () => {
  assert.deepEqual(roughly({ lat: 39.05361, lon: -79.51549 }), { lat: 39.05, lon: -79.52 });
  assert.match(gaugeUrl(), /bbox=-80\.05%2C38\.75%2C-78\.3%2C40\.35/);
  assert.match(gaugeUrl(), /api\.waterdata\.usgs\.gov/, 'the older USGS service shuts down in 2027');
  assert.match(snowUrl({ lat: 39.05, lon: -79.52 }), /geometry=-79\.52%2C39\.05/);
});

test('gauges combine flow and stage, and old or unknown readings are dropped', () => {
  const parsed = parseGauges({ features: [reading('03076100', '00060', 339), reading('03076100', '00065', 3.25), reading('03081500', '00060', 433, '2002-09-30T23:30:00Z'), reading('99999999', '00060', 5), reading('01595500', '00060', 'nope')] }, gauges, NOW);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].cfs, 339);
  assert.equal(parsed[0].feet, 3.25);
  assert.equal(gaugeText(parsed[0]), '339 cubic feet per second, 3.25 ft stage');
  assert.equal(gaugeText({ feet: 2 }), '2.00 ft stage');
  assert.deepEqual(parseGauges(null, gauges, NOW), []);
});

test('nearby gauges are closest first and within reach', () => {
  const place = { lat: 39.5, lon: -79.4 };
  const names = nearbyGauges([{ ...gauges[1] }, { ...gauges[0] }], place).map(({ name }) => name);
  assert.deepEqual(names, ['Near']);
});

test('snow reads meters as inches, and unknown stays unknown', () => {
  assert.ok(Math.abs(parseSnowInches({ results: [{ attributes: { 'Service Pixel Value': '0.42' } }] }) - 16.5) < 0.1, 'matches the 9.8 to 20 inch legend class NOAA gives that value');
  assert.equal(parseSnowInches({ results: [] }), null);
  assert.equal(parseSnowInches({ results: [{ attributes: { 'Service Pixel Value': 'NoData' } }] }), null);
  assert.equal(snowText(0), 'No snow estimated');
  assert.equal(snowText(0.7), 'Under 1 inch estimated');
  assert.equal(snowText(16.5), 'About 17 inches estimated');
  assert.equal(snowText(null), '');
});

test('alerts and forecast read cleanly, and an empty answer is not a failure', () => {
  assert.deepEqual(parseAlerts({ features: [] }), []);
  assert.equal(parseAlerts({ features: [{ properties: { event: 'Winter Storm Warning', headline: 'Winter Storm Warning until 6 PM' } }] })[0].headline, 'Winter Storm Warning until 6 PM');
  const [period] = parseForecast({ properties: { periods: [{ name: 'Tonight', temperature: 45, temperatureUnit: 'F', shortForecast: 'Mostly Cloudy', windSpeed: '3 mph', windDirection: 'W' }] } });
  assert.deepEqual(period, { name: 'Tonight', temperature: '45°F', summary: 'Mostly Cloudy', wind: 'W 3 mph' });
});

test('one service failing leaves the others, and old readings fill only that gap', async () => {
  const fetcher = async url => {
    if (url.includes('alerts')) return { ok: true, json: async () => ({ features: [] }) };
    if (url.includes('/points/')) return { ok: true, json: async () => ({ properties: { forecast: 'https://api.weather.gov/forecast' } }) };
    if (url.includes('/forecast')) return { ok: false, status: 503 };
    if (url.includes('identify')) throw new Error('offline');
    return { ok: true, json: async () => ({ features: [reading('03076100', '00060', 339)] }) };
  };
  const fresh = await fetchConditions({ lat: 39.5, lon: -79.4 }, gauges, { fetcher, now: NOW });
  assert.deepEqual(fresh.alerts, []);
  assert.equal(fresh.forecast, null);
  assert.equal(fresh.snowInches, null);
  assert.equal(fresh.rivers[0].name, 'Near');
  const merged = withSaved(fresh, { fetchedAt: NOW - 3600000, alerts: [{ headline: 'old' }], forecast: [{ name: 'old' }], snowInches: 4, rivers: [] });
  assert.deepEqual(merged.alerts, [], 'a fresh "no alerts" must not be replaced by an old alert');
  assert.equal(merged.forecast[0].name, 'old');
  assert.equal(merged.snowInches, 4);
  assert.deepEqual(merged.savedSections, ['forecast', 'snowInches']);
  assert.equal(merged.savedAt, NOW - 3600000);
  assert.deepEqual(withSaved(fresh, null).savedSections, []);
});

test('saved readings count as fresh only briefly', () => {
  assert.equal(isFresh({ fetchedAt: NOW - 1000 }, NOW), true);
  assert.equal(isFresh({ fetchedAt: NOW - SAVED_FOR_MS - 1 }, NOW), false);
  assert.equal(isFresh(null, NOW), false);
});

test('climb ignores small wiggles and counts real change', () => {
  assert.deepEqual(climbAndDescent([100, 110, 100, 105, 100]), { up: 0, down: 0 });
  assert.deepEqual(climbAndDescent([100, 150, 120, 200]), { up: 130, down: 30 });
});

test('the effort rating matches the National Park Service worked example and bands', () => {
  assert.equal(effortRating(2200, 10), 'Very strenuous', 'NPS: 209.8');
  assert.equal(effortRating(100, 1), 'Easiest');
  assert.equal(effortRating(1000, 4), 'Moderate', 'score 89');
  assert.equal(effortRating(2000, 4), 'Moderately strenuous', 'score 126');
  assert.equal(effortRating(2000, 8), 'Strenuous', 'score 179');
});

const straight = [[-79.5, 39.1], [-79.49, 39.1]];

test('resampling keeps both ends and even spacing', () => {
  const points = resample(straight, 500);
  assert.deepEqual(points[0], straight[0]);
  assert.deepEqual(points.at(-1), straight[1]);
  assert.ok(points.length >= 5 && points.length <= 7, String(points.length));
});

test('details: climb is direction-neutral, with effort only for walkable trails', () => {
  const rising = ([lon]) => (lon + 79.5) * 50000; // 500 ft over the line.
  const forward = trailDetails([{ coords: straight }], rising, HIKE);
  const backward = trailDetails([{ coords: [...straight].reverse() }], rising, HIKE);
  assert.equal(forward.climbFeet, backward.climbFeet);
  assert.ok(forward.climbFeet >= 450 && forward.climbFeet <= 500, 'the whole 500 ft, whichever way the line was drawn');
  assert.ok(forward.effort);
  assert.equal(trailDetails([{ coords: straight }], rising, ATV).effort, undefined);
  assert.ok(forward.profile.length <= 24);
  assert.equal(forward.profileMiles, Math.round(lineMiles(straight) * 100) / 100);
});

test('details: no climb is claimed when elevation is missing', () => {
  const details = trailDetails([{ coords: straight }], () => null, HIKE);
  assert.equal(details.climbFeet, undefined);
  assert.equal(details.effort, undefined);
});

test('details: tags need real coverage, and one rough spot does not label a trail', () => {
  const short = [[-79.5, 39.1], [-79.4995, 39.1]];
  const long = [[-79.5, 39.11], [-79.45, 39.11]];
  const flat = () => 1000;
  const mixed = trailDetails([{ coords: long, tags: { dog: 'leashed', wheelchair: 'yes' } }, { coords: short, tags: { sac: 'demanding_mountain_hiking', visibility: 'bad', imba: '4', dog: 'no' } }], flat, HIKE);
  assert.equal(mixed.sac, undefined);
  assert.equal(mixed.imba, undefined);
  assert.equal(mixed.hardToSee, undefined);
  assert.equal(mixed.dogs, 'leashed');
  assert.equal(mixed.wheelchair, 'yes');
  const rough = trailDetails([{ coords: long, tags: { sac: 'mountain_hiking', imba: '3', visibility: 'horrible', wheelchair: 'no' } }], flat, HIKE);
  assert.equal(rough.sac, 2);
  assert.equal(rough.imba, 3);
  assert.equal(rough.hardToSee, true);
  assert.equal(rough.wheelchair, 'no');
});

test('facts say "mapped as", and flat trails say so', () => {
  const facts = detailFacts({ climbFeet: 840, effort: 'Moderate', sac: 2, imba: 0, hardToSee: true, dogs: 'leashed', wheelchair: 'no' });
  assert.ok(facts.includes('About 840 ft of climbing, going the harder way'), facts[0]);
  assert.ok(facts.includes('Estimated effort: Moderate, from length and climb only'));
  for (const fact of facts.slice(2)) assert.match(fact, /^Mapped/);
  assert.deepEqual(detailFacts({ climbFeet: 20 }), ['Nearly flat']);
  assert.deepEqual(detailFacts({}), []);
});

test('the sparkline runs edge to edge, with high ground at the top', () => {
  assert.equal(profilePath([100, 200], 240, 40), 'M0.0 40.0 L240.0 0.0');
  assert.equal(profilePath([5, 5], 240, 40), 'M0.0 40.0 L240.0 40.0');
});

test('baked: every gauge is in the region, and trails have believable climbs', () => {
  const data = name => JSON.parse(readFileSync(new URL(`../../../apps/trails/public/data/${name}`, import.meta.url), 'utf8'));
  const { gauges: baked } = data('gauges.json');
  assert.ok(baked.length >= 25);
  for (const { lat, lon, name } of baked) assert.ok(lat > 38.75 && lat < 40.35 && lon > -80.05 && lon < -78.3, name);
  const { routes } = data('routes.json');
  // A few long trails run past the captured elevation, and those claim no climb at all.
  assert.ok(routes.filter(route => Number.isFinite(route.climbFeet)).length >= routes.length * 0.99);
  for (const route of routes.filter(item => Number.isFinite(item.climbFeet))) {
    assert.ok(route.climbFeet / route.miles < 2500, `${route.name}: ${route.climbFeet} ft over ${route.miles} mi`);
    if (route.profile && route.profileMiles === route.miles) {
      const relief = Math.max(...route.profile) - Math.min(...route.profile);
      // Tiny rises stay under the noise filter on purpose.
      if (relief >= 100) assert.ok(route.climbFeet >= relief * 0.8 - 20, `${route.name}: ${route.climbFeet} ft climb is less than its ${relief} ft of relief`);
    }
  }
  const { hikes } = data('hikes.json');
  for (const hike of hikes.filter(item => item.kind === 'route' && item.lines.length === 1)) {
    if (hike.highFeet - hike.lowFeet >= 100) assert.ok(hike.climbFeet >= (hike.highFeet - hike.lowFeet) * 0.8 - 20, `${hike.id}: ${hike.climbFeet} ft climb, ${hike.highFeet - hike.lowFeet} ft range`);
  }
});

test('the browser is allowed to reach the conditions services', () => {
  const headers = readFileSync(new URL('../../../public/_headers', import.meta.url), 'utf8');
  for (const host of ['api.waterdata.usgs.gov', 'api.weather.gov', 'mapservices.weather.noaa.gov']) assert.ok(headers.includes(`https://${host}`), host);
});
