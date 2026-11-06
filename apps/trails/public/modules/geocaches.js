// Reads geocache listings from a GPX file the hiker supplies. Listings are never bundled or
// fetched here: Geocaching.com's API is for approved partners, and its data isn't ours to ship.
// Everything parsed from a file is untrusted, so it only ever reaches the page as plain text.
import { distanceMiles } from './geo.js';

export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_CACHES = 5000;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const unwrap = text => text.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
// Listing descriptions are often HTML. Keep the words and drop the markup.
const plainText = text => decodeEntities(unwrap(text).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function tagValue(block, ...names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) {
      const value = plainText(match[1]);
      // A listing's description can decode back into markup, so strip once more.
      if (value) return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

const attribute = (attributes, name) => attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];

export function parseGpx(text) {
  const caches = [];
  for (const [, attributes, block] of text.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi)) {
    const lat = Number(attribute(attributes, 'lat'));
    const lon = Number(attribute(attributes, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) continue;
    const code = tagValue(block, 'name');
    const title = tagValue(block, 'groundspeak:name', 'urlname') || code || 'Unnamed waypoint';
    const typeText = tagValue(block, 'groundspeak:type', 'type');
    caches.push({
      id: code || `${lat},${lon},${title}`,
      code: code && code !== title ? code : '',
      name: title,
      lat,
      lon,
      type: typeText.replace(/^Geocache\|/i, ''),
      difficulty: tagValue(block, 'groundspeak:difficulty'),
      terrain: tagValue(block, 'groundspeak:terrain'),
      size: tagValue(block, 'groundspeak:container'),
      owner: tagValue(block, 'groundspeak:owner', 'groundspeak:placed_by'),
      hint: tagValue(block, 'groundspeak:encoded_hints', 'groundspeak:long_hint'),
      description: tagValue(block, 'groundspeak:short_description', 'desc', 'cmt').slice(0, 2000),
      found: null,
    });
    if (caches.length >= MAX_CACHES) break;
  }
  return caches;
}

// Re-importing updates the listing but must not forget that the hiker already found it.
export function mergeCaches(existing, incoming) {
  const merged = new Map(existing.map(cache => [cache.id, cache]));
  let added = 0;
  for (const cache of incoming) {
    const previous = merged.get(cache.id);
    if (!previous) added += 1;
    merged.set(cache.id, { ...cache, found: previous?.found ?? null });
  }
  return { caches: [...merged.values()], added, updated: incoming.length - added };
}

export const nearestFirst = (caches, position) => [...caches].sort((a, b) => distanceMiles(position, a) - distanceMiles(position, b));

export function cacheFacts({ type, difficulty, terrain, size }) {
  return [type, difficulty && `difficulty ${difficulty}`, terrain && `terrain ${terrain}`, size && size.toLowerCase()].filter(Boolean).join(' · ');
}
