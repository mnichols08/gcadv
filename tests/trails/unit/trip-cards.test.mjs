import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardHtml, cardPlace, cardUrl } from '../../../scripts/trip-cards.mjs';

const { stays } = JSON.parse(readFileSync(new URL('../../../apps/trails/public/data/stays.json', import.meta.url)));

test('a town card links to the planner with that town, and nothing that could track a scan', () => {
  assert.equal(cardUrl({ id: 'oakland-md' }), 'https://garrettcountyadventures.com/trails/#plan=oakland-md');
  assert.equal(cardUrl(null), 'https://garrettcountyadventures.com/trails/#plan');
  assert.doesNotMatch(cardUrl({ id: 'oakland-md' }), /[?&]/);
});

test('every town id fits what the app reads from a link', () => {
  for (const stay of stays) assert.match(stay.id, /^[\w-]+$/);
});

test('place names are escaped on the card', () => {
  assert.doesNotMatch(cardHtml('<b>Town</b>', ''), /<b>/);
  assert.equal(cardPlace(null), 'Garrett County and nearby');
});

test('a QR code keeps the full blank margin that scanners expect', () => {
  assert.match(readFileSync(new URL('../../../scripts/trip-cards.mjs', import.meta.url), 'utf8'), /margin: 4,/);
});
