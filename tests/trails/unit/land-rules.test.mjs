import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { areaForName, areasOnTrail, samplePoints, withHandKept } from '../../../scripts/bake-trail-land.mjs';
import { buildTrailPages, LAND_RULES_PATH, landRulesPage } from '../../../scripts/trail-pages.mjs';

const readData = name => JSON.parse(readFileSync(new URL(`../../../apps/trails/public/data/${name}`, import.meta.url)));
const { areas, checkedAt } = readData('land-rules.json');
const { trails } = readData('trail-land.json');
const approved = JSON.parse(readFileSync(new URL('./land-rules.approved.json', import.meta.url)));
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const context = { siteUrl: 'https://example.test', escapeHtml };
const { source: page } = landRulesPage({ checkedAt, areas }, context);
const ACTIVITIES = ['hunting', 'trapping', 'fishing', 'gathering', 'ginseng', 'ramps'];
const LETTER = { allowed: 'A', restricted: 'L', by_permit: 'P', prohibited: 'N', not_confirmed: 'Q' };
const WORD = { allowed: 'Allowed', restricted: 'Limited', by_permit: 'Permit', prohibited: 'No', not_confirmed: 'Not confirmed' };
const area = id => areas.find(item => item.id === id);
const section = id => page.slice(page.indexOf(`<section class="land-area" id="${id}">`), page.indexOf('</section>', page.indexOf(`id="${id}"`)));
let builtPages;
const built = () => (builtPages ||= buildTrailPages(context));
const trailSource = id => built().find(item => item.name === `trail/${id}.html`)?.source;

test('every answer matches what the owner approved, so a change has to be deliberate', () => {
  const current = Object.fromEntries(areas.map(item => [item.id, ACTIVITIES.map(key => LETTER[item.rules[key].status]).join('')]));
  assert.deepEqual(current, approved);
});

test('every area answers all six activities, and any firm answer shows its source', () => {
  for (const item of areas) {
    for (const key of ACTIVITIES) {
      const rule = item.rules[key];
      assert.ok(rule?.summary, `${item.name} ${key}`);
      if (rule.status !== 'not_confirmed') {
        assert.match(rule.source, /^https:\/\//, `${item.name} ${key}`);
        assert.ok(rule.quote, `${item.name} ${key}`);
      }
    }
  }
});

test('the rows the owner dropped or held back stay out, and nothing points to them', () => {
  for (const name of ['Fulcher', 'Boat Ramp', 'Bear Creek Hatchery', 'Fort Hill', 'Cooperative', 'Broadford']) {
    assert.ok(!areas.some(item => item.name.includes(name)), name);
  }
  assert.equal(areas.length, 44);
  assert.doesNotMatch(page, /Cooperative Wildlife Management Area has its own entry|cooperative wildlife area has its own entry/);
});

test('notes for the owner and personal contacts never reach the public data', () => {
  const text = JSON.stringify(areas);
  assert.doesNotMatch(text, /review_notes|skeptic|researcher|Simmons|Andy Freeman|McPherson/);
  assert.doesNotMatch(page, /skeptic|researcher|Simmons|McPherson/);
});

test('reviewed answers hold across the land types', () => {
  assert.equal(area('savage-river-state-forest').rules.hunting.status, 'allowed');
  assert.equal(area('big-run-state-park').rules.hunting.status, 'prohibited');
  assert.equal(area('new-germany-state-park').rules.hunting.status, 'prohibited');
  for (const item of areas.filter(({ manager, group }) => /Maryland (Department of Natural Resources|Park Service|Forest Service)/.test(manager) && /State (forests|parks)/.test(group))) {
    assert.equal(item.rules.ginseng.status, 'prohibited', item.id);
  }
  for (const id of ['savage-river-state-forest', 'potomac-garrett-state-forest', 'green-ridge-state-forest']) {
    assert.equal(area(id).rules.gathering.status, 'prohibited', id);
    assert.match(area(id).rules.gathering.summary, /DNR's stated position/, id);
  }
});

test('a limit that binds an angler is in plain view, not only in the closed water rules', () => {
  for (const id of ['sang-run-state-park', 'youghiogheny-wild-river-natural-environmental-area']) assert.match(area(id).rules.fishing.summary, /lures only/, id);
  assert.match(area('potomac-garrett-state-forest').rules.fishing.summary, /keep no trout/);
  assert.match(area('jennings-randolph-lake').rules.fishing.summary, /first 345 yards/);
  assert.match(area('deep-creek-lake-natural-resources-management-area').rules.fishing.summary, /15-inch minimum/);
});

test('each answer shows the right word, in the right column, with its summary and source', () => {
  for (const item of areas) {
    const row = page.slice(page.indexOf(`<tr id="glance-${item.id}">`), page.indexOf('</tr>', page.indexOf(`<tr id="glance-${item.id}">`)));
    const cells = [...row.matchAll(/<td><span class="land-status land-status--(\w+)">([^<]+)<\/span><\/td>/g)];
    assert.equal(cells.length, 6, item.id);
    ACTIVITIES.forEach((key, index) => {
      assert.equal(cells[index][1], item.rules[key].status, `${item.id} ${key}`);
      assert.equal(cells[index][2], WORD[item.rules[key].status], `${item.id} ${key}`);
      assert.ok(section(item.id).includes(escapeHtml(item.rules[key].summary)), `${item.id} ${key}`);
      if (item.rules[key].source) assert.ok(section(item.id).includes(`href="${escapeHtml(item.rules[key].source)}"`), `${item.id} ${key}`);
    });
    if (item.note) assert.ok(section(item.id).includes(escapeHtml(item.note)), item.id);
    if (item.waterNote) assert.match(section(item.id), /Water rules/, item.id);
  }
  assert.match(section('big-run-state-park'), /<strong>Hunting:<\/strong> <span class="land-status land-status--prohibited">No</);
  assert.match(section('savage-river-state-forest'), /<strong>Hunting:<\/strong> <span class="land-status land-status--allowed">Allowed</);
});

test('the page says it is not the law, and reads cleanly', () => {
  for (const text of ['not the law', 'no agency has reviewed it', 'does not mean', '1-800-222-1222', 'high-visibility', 'Some managers publish no rules']) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page, /undefined|NaN|\[object|\.\. |skeptic/);
  assert.doesNotMatch(page, /<script(?! type="application\/ld\+json")/);
  assert.doesNotMatch(page, /you can (hunt|fish|forage|dig|trap|pick)|(?<!says )you may (hunt|fish|forage|dig|trap|pick) (here|on this)|open to you/i);
  assert.doesNotMatch(page, /scope="colgroup"/);
});

test('web addresses in notes are short links, and no raw address reaches the page text', () => {
  const visible = page.replace(/<[^>]+>/g, ' ').replace(/\{.*\}/s, '');
  assert.doesNotMatch(visible, /https?:\/\/|eregulations\.com/);
  assert.match(section('rocky-gap-state-park'), /<a href="https:\/\/regs\.maryland\.gov\/us\/md\/exec\/comar\/08\.02\.11\.01" rel="noopener">link<\/a>\)/);
  assert.doesNotMatch(page, /Closure 0|daily 0, possession 0/);
});

test('PAD-US names map to land areas, wildlands included, and an easement never does', () => {
  assert.equal(areaForName('Savage River Sf'), 'savage-river-state-forest');
  assert.equal(areaForName('SAVAGE RIVER SF - Middle Fork Wildland'), 'savage-river-state-forest');
  assert.equal(areaForName('Garrett Sf'), 'potomac-garrett-state-forest');
  assert.equal(areaForName('Buchanan State Forest'), null);
  assert.equal(areaForName('Potomac Conservancy Easement'), null);
  assert.equal(areaForName('MET Easement'), null);
  assert.equal(areaForName('Savage River SF Easement'), null);
  assert.equal(areaForName('Savage River SF - Conservation Easement'), null);
  assert.equal(areaForName('Chesapeake and Ohio Canal National Historical Park', 'Easement'), null);
  assert.equal(areaForName('Chesapeake and Ohio Canal National Historical Park', 'Fee'), 'chesapeake-and-ohio-canal-national-historical-park');
});

test('a trail touching a park at one point still names it, and sampling keeps both ends', () => {
  assert.deepEqual(areasOnTrail([['forest'], ['forest'], ['forest', 'park'], []]), ['forest', 'park']);
  assert.deepEqual(areasOnTrail([[], []]), []);
  const points = Array.from({ length: 100 }, (_, index) => index);
  const picked = samplePoints(points, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), 99);
  assert.deepEqual(samplePoints([1, 2]), [1, 2]);
});

test('Savage Highlands trails name the park, even with no PAD-US record for it', () => {
  assert.deepEqual(withHandKept('cabin-loop-trail', ['savage-river-state-forest']), ['savage-river-state-forest', 'savage-highlands-state-park']);
  for (const id of ['cabin-loop-trail', 'mt-aetna-loop-trail']) {
    assert.deepEqual(trails[id], ['savage-river-state-forest', 'savage-highlands-state-park'], id);
    assert.ok(trailSource(id).includes(`${LAND_RULES_PATH}#savage-highlands-state-park`), id);
  }
});

test('every matched trail page exists and links to all its land, and others say nothing about land', () => {
  const ids = new Set(areas.map(item => item.id));
  assert.ok(Object.keys(trails).length >= 55);
  for (const [route, found] of Object.entries(trails)) {
    const source = trailSource(route);
    assert.ok(source, route);
    assert.match(source, /Land along this trail/, route);
    assert.match(source, /Other stretches may cross other public or private land/, route);
    assert.match(source, /go by posted signs/, route);
    assert.match(source, /USGS PAD-US/, route);
    for (const id of found) {
      assert.ok(ids.has(id), `${route}: ${id}`);
      assert.ok(source.includes(`href="${LAND_RULES_PATH}#${id}"`), `${route}: ${id}`);
    }
  }
  const others = built().filter(item => item.name.startsWith('trail/') && !trails[item.name.slice(6, -5)]);
  assert.ok(others.length > 200);
  for (const { name, source } of others) {
    assert.doesNotMatch(source, /Land along this trail/, name);
    assert.doesNotMatch(source, /USGS PAD-US/, name);
  }
});

test('a trail reaching past these two counties says the rules stop at the county line', () => {
  assert.match(trailSource('mid-state-pennsylvania-trail'), /they don&#39;t apply in Bedford County, PA|don't apply in Bedford County, PA/);
  const passage = trailSource('great-allegheny-passage');
  assert.match(passage, /Great Allegheny Passage in Allegany County/);
  assert.match(passage, /don't apply in .*Somerset County, PA/);
  assert.doesNotMatch(trailSource('lostland-run-trail'), /don't apply in/);
});

test('trail pages never turn the land rules into a claim about what you can do on the trail', () => {
  for (const { source, name } of built().filter(item => item.name.startsWith('trail/'))) {
    assert.doesNotMatch(source, /land-status/, name);
    assert.doesNotMatch(source, /you can (hunt|fish|forage|dig|trap|pick)|you may (hunt|fish|forage|dig|trap|pick)|open to you/i, name);
  }
});

test('built pages load nothing from another host', () => {
  for (const { source, name } of built().filter(item => item.name.endsWith('.html'))) {
    assert.doesNotMatch(source, /<(img|iframe|script|video|audio|source|embed)\b[^>]*\bsrc="https?:/i, name);
    assert.doesNotMatch(source, /<link\b[^>]*\bhref="https?:(?![^"]*example\.test)/i, name);
  }
});

test('the page is listed with the rest of the site, and the hunting page and directory link to it', () => {
  const names = built().map(item => item.name);
  assert.ok(names.includes('land-rules.html'));
  for (const name of ['hunting.html', 'trail-directory.html']) {
    assert.ok(built().find(item => item.name === name).source.includes(`href="${LAND_RULES_PATH}"`), name);
  }
});
