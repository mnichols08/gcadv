import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const policy = read('content/privacy.html');

// Any new outside service has to be explained to visitors before the browser is allowed to reach it.
const DISCLOSED_AS = {
  'basemap.nationalmap.gov': 'US Geological Survey',
  'api.waterdata.usgs.gov': 'river levels',
  'api.weather.gov': 'National Weather Service',
  'mapservices.weather.noaa.gov': 'NOAA',
  '*.mapbox.com': 'Mapbox',
  'events.mapbox.com': 'usage and performance events',
};

test('every outside service the trail app may reach is in the privacy policy', () => {
  const headers = read('public/_headers');
  const connect = headers.match(/connect-src ([^;]+);/)[1].split(/\s+/).filter(source => source.startsWith('https://')).map(source => source.slice(8));
  assert.ok(connect.length >= 5);
  for (const host of connect) {
    assert.ok(DISCLOSED_AS[host], `${host} isn't covered: add it to the privacy policy and to this list`);
    assert.ok(policy.includes(DISCLOSED_AS[host]), `The privacy policy doesn't mention ${DISCLOSED_AS[host]}`);
  }
});

test('the policy covers what the app does', () => {
  for (const phrase of ['no cookies', 'stay on your phone', 'rounded to within', 'clear this site', 'no working backup', 'Google Maps', 'Overpass']) {
    assert.ok(policy.includes(phrase), phrase);
  }
});

test('the rounding the policy describes is what the code does', async () => {
  const { roughly } = await import('../../../apps/trails/public/modules/conditions.js');
  const { distanceMiles } = await import('../../../apps/trails/public/modules/geo.js');
  const exact = { lat: 39.0549, lon: -79.5151 };
  assert.ok(distanceMiles(exact, roughly(exact)) < 0.5, 'a third of a mile north-south, and a little more on the diagonal');
});

test('every page links to the policy', () => {
  for (const file of ['index.html', 'explore.html', 'scripts/content-site.js', 'apps/trails/public/index.html']) {
    assert.match(read(file), /privacy\.html/, file);
  }
});

test('the contact address has been filled in before publishing', { todo: 'Needs the contact email from the site owner' }, () => {
  assert.doesNotMatch(policy, /\[CONTACT EMAIL\]/);
});
