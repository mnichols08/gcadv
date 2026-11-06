import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ATV, HIKE, SNOWMOBILE } from '../../../apps/trails/public/modules/activities.js';
import { buildTrailPages, holdReason, outlineSvg, publishableRoutes, trailPage, trailPath } from '../../../scripts/trail-pages.mjs';

const require = createRequire(import.meta.url);
const { buildSite } = require('../../../scripts/content-site.js');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const context = { siteUrl: 'https://example.test', escapeHtml };
const route = overrides => ({
  id: 'sample-trail', name: 'Sample Trail', county: 'Garrett County, MD', activities: HIKE, miles: 3, climbFeet: 400, effort: 'Moderate',
  center: { lat: 39.5, lon: -79.3 }, bounds: { south: 39.49, north: 39.51, west: -79.31, east: -79.29 }, sources: ['osm'],
  access: [{ lat: 39.5, lon: -79.3, type: 'parking', name: '', feet: 100 }], ...overrides,
});
const lines = [{ name: 'Sample Trail', points: [{ lat: 39.49, lon: -79.31 }, { lat: 39.51, lon: -79.29 }] }];
const pages = buildTrailPages(context);
const trailPages = pages.filter(page => page.name.startsWith('trail/'));

test('only real destinations get a page', () => {
  assert.equal(holdReason(route()), null);
  assert.equal(holdReason(route({ miles: 0.3 })), 'short');
  assert.equal(holdReason(route({ name: 'Connector' })), 'generic name');
  assert.equal(holdReason(route({ name: 'Blue Trail' })), 'generic name');
  assert.equal(holdReason(route({ name: 'Campground Access' })), 'not a destination');
  assert.equal(holdReason(route({ name: 'Buffalo Road' })), 'road');
  assert.equal(holdReason(route({ name: 'Old Mail Trail (not correct)' })), 'mapping note');
  assert.equal(holdReason(route({ access: undefined, miles: 1 })), 'thin');
});

test('a motorized marking needs the land manager behind it', () => {
  for (const bit of [ATV, SNOWMOBILE]) {
    assert.equal(holdReason(route({ activities: HIKE | bit })), 'motorized, not confirmed');
    assert.equal(holdReason(route({ activities: HIKE | bit, sources: ['osm', 'usfs'] })), null);
    assert.equal(holdReason(route({ activities: HIKE | bit, official: { note: '', label: '', url: 'https://example.test' } })), null);
  }
});

test('published data has no unconfirmed motorized page', () => {
  const data = JSON.parse(readFileSync(new URL('../../../apps/trails/public/data/routes.json', import.meta.url)));
  for (const item of publishableRoutes(data.routes)) assert.equal(holdReason(item), null, item.name);
  const snaggy = trailPages.find(page => page.name === 'trail/snaggy-mountain-road.html');
  assert.ok(snaggy, 'the one DNR-confirmed riding trail gets a page');
  assert.ok(snaggy.source.includes('dnr.maryland.gov'));
});

test('a repeated name in a county becomes one page, the longest', () => {
  const kept = publishableRoutes([route({ id: 'a', miles: 1.6 }), route({ id: 'b', miles: 4 }), route({ id: 'c', miles: 2, county: 'Tucker County, WV' })]);
  assert.deepEqual(kept.map(item => item.id).sort(), ['b', 'c']);
});

test('no two pages share a title or description', () => {
  for (const pattern of [/<title>(.*?)<\/title>/, /name="description" content="(.*?)"/]) {
    const found = pages.map(page => pattern.exec(page.source)[1]);
    assert.equal(new Set(found).size, found.length);
  }
});

test('names are escaped everywhere', () => {
  const name = '<img src=x onerror=alert(1)> "Trail"';
  const { source } = trailPage(route({ name }), lines, [], context);
  assert.doesNotMatch(source, /<img/);
  assert.match(outlineSvg(route({ name }), lines, escapeHtml), /aria-label="Outline of &lt;img/);
});

test('pages say marked, cite sources, and carry the caution', () => {
  assert.ok(trailPages.length > 200);
  for (const { name, source } of trailPages) {
    assert.match(source, /Marked for/, name);
    assert.match(source, /Confirm the rules, closures and any permit/, name);
    assert.match(source, /TRAILS-LICENSE\.txt/, name);
    assert.doesNotMatch(source, /\b(allowed|legal to ride)\b/i, name);
    assert.doesNotMatch(source, /undefined|NaN/, name);
  }
});

test('an OpenStreetMap trail credits OpenStreetMap', () => {
  const { source } = trailPage(route(), lines, [], context);
  assert.match(source, /© OpenStreetMap contributors/);
});

test('every internal trail link goes to a page that exists', () => {
  const names = new Set(pages.map(page => page.name));
  for (const { source } of pages) {
    for (const [, target] of source.matchAll(/href="\/((?:trail|trails-in)\/[^"#]+)"/g)) assert.ok(names.has(target), target);
  }
});

test('pages use no scripts and no outside map', () => {
  for (const { name, source } of pages) {
    assert.doesNotMatch(source, /<script(?! type="application\/ld\+json")/, name);
    assert.doesNotMatch(source, /mapbox/i, name);
  }
});

test('the sitemap lists the pages and the home page links to them', () => {
  const sitemap = buildSite().pages.find(page => page.name === 'sitemap.xml').source;
  assert.ok(sitemap.includes('https://garrettcountyadventures.com/trail-directory.html'));
  assert.ok(sitemap.includes('https://garrettcountyadventures.com' + trailPath(route({ id: 'rohrbaugh-trail' }))));
  assert.match(readFileSync(new URL('../../../index.html', import.meta.url), 'utf8'), /trail-directory\.html/);
});

test('a long route or a rail grade shows no climb or effort', () => {
  const gap = trailPages.find(page => page.name === 'trail/great-allegheny-passage.html').source;
  assert.doesNotMatch(gap, /climbing|strenuous/i);
  assert.doesNotMatch(gap, /mapped surface/);
  const rail = trailPage(route({ name: 'Sample Rail Trail', climbFeet: 900, effort: 'Strenuous' }), lines, [], context).source;
  assert.doesNotMatch(rail, /900 ft|Strenuous/);
  assert.match(trailPage(route(), lines, [], context).source, /400 ft/);
});
