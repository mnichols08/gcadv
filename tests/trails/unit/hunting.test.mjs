import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { huntingNotice } from '../../../apps/trails/public/modules/hunting.js';
import { huntingPage } from '../../../scripts/trail-pages.mjs';

const data = JSON.parse(readFileSync(new URL('../../../apps/trails/public/data/hunting.json', import.meta.url)));
const on = day => new Date(day + 'T12:00:00');
const notice = day => huntingNotice(on(day), data.firearms);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

test('the dates are the ones read from each state', () => {
  const dates = Object.fromEntries(data.firearms.map(({ state, from, to }) => [state, [from, to]]));
  assert.deepEqual(dates, { WV: ['2026-11-23', '2026-12-06'], MD: ['2026-11-28', '2026-12-12'], PA: ['2026-11-28', '2026-12-13'] });
});

test('a general note comes before the two-week heads-up', () => {
  assert.match(notice('2026-11-06'), /Hunting seasons are open around here/);
  assert.doesNotMatch(notice('2026-11-06'), /Firearms/);
});

test('it warns ahead of a season, in the order they start', () => {
  assert.match(notice('2026-11-15'), /Firearms deer season starts in WV on Nov 23, MD on Nov 28 and PA on Nov 28/);
  assert.match(notice('2026-11-10'), /starts in WV on Nov 23\./);
});

test('it says which states are open and which are still coming', () => {
  const both = notice('2026-11-25');
  assert.match(both, /on in WV through Dec 6\./);
  assert.match(both, /It starts in MD on Nov 28 and PA on Nov 28/);
  assert.match(notice('2026-12-01'), /on in WV through Dec 6, MD through Dec 12 and PA through Dec 13/);
});

test('each state drops out when its season ends', () => {
  assert.doesNotMatch(notice('2026-12-08'), /WV/);
  assert.match(notice('2026-12-13'), /on in PA through Dec 13/);
  assert.match(notice('2026-12-14'), /Hunting seasons are open around here/);
});

test('summer has no note, and old dates never show as current', () => {
  assert.equal(notice('2026-07-15'), null);
  assert.equal(notice('2027-07-15'), null);
  assert.match(notice('2027-11-28'), /Hunting seasons are open around here/);
  assert.equal(huntingNotice(on('2027-07-15'), []), null);
});

test('the note still works with no dates loaded', () => {
  assert.match(huntingNotice(on('2026-12-01'), []), /Hunting seasons are open around here/);
});

test('the page gives dates, every official link, and says it is not the law', () => {
  const { source } = huntingPage(data, { siteUrl: 'https://example.test', escapeHtml });
  for (const text of ['Nov 23, 2026', 'Dec 6, 2026', 'Dec 12, 2026', 'Dec 13, 2026', 'not the law', 'stay on your phone']) assert.ok(source.includes(text), text);
  for (const { links } of data.states) for (const { url } of links) assert.ok(source.includes(escapeHtml(url)), url);
  assert.doesNotMatch(source, /undefined|NaN/);
});

test('every link is on the state agency sites', () => {
  for (const { links } of data.states) {
    for (const { url } of links) assert.match(url, /^https:\/\/(dnr\.maryland\.gov|wvdnr\.gov|www\.wvhunt\.com|www\.pa\.gov)\//);
  }
});

test('non-hunters are told to wear high-visibility colors, whenever the note shows', () => {
  for (const day of ['2026-11-06', '2026-11-15', '2026-12-01', '2027-04-20']) assert.match(notice(day), /high-visibility colors/, day);
  const { source } = huntingPage(data, { siteUrl: 'https://example.test', escapeHtml });
  for (const text of ['Wear high-visibility colors', 'on your dog', 'Avoid white, tan, brown and black', 'dawn and dusk']) assert.ok(source.includes(text), text);
});
