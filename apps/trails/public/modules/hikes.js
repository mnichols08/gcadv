// Picking and following a hike. Pure, so the off-route rules can be tested without a phone.
import { bearingDegrees, distanceMiles, FEET_PER_MILE, formatFeet } from './geo.js';
import { nearestOnLines } from './landscape.js';
import { decodeTrail } from './trails.js';

// Two thresholds, so a walker near the edge doesn't flicker between on and off route.
export const OFF_ROUTE_FEET = 300;
export const BACK_ON_ROUTE_FEET = 150;

export const decodeHike = hike => ({ ...hike, decoded: (hike.lines || []).map(decodeTrail) });

export function groupHikes(hikes, position = null) {
  const groups = new Map();
  for (const hike of hikes) {
    if (!groups.has(hike.group)) groups.set(hike.group, []);
    groups.get(hike.group).push(hike);
  }
  if (position) {
    const miles = hike => distanceMiles(position, entryPoint(hike));
    for (const list of groups.values()) list.sort((a, b) => miles(a) - miles(b));
  }
  return [...groups].map(([name, list]) => ({ name, hikes: list }));
}

export const boundsCenter = ({ south, north, west, east }) => ({ lat: (south + north) / 2, lon: (west + east) / 2 });
// About half a mile of map around a hike, so it isn't cut off at the edge of what's saved.
export const withMargin = ({ south, north, west, east }, degrees = 0.008) => ({ south: south - degrees, north: north + degrees, west: west - degrees, east: east + degrees });

// The closest mapped way in, for someone who hasn't reached the trail yet.
export function nearestAccess(hike, position) {
  let best = null;
  for (const place of hike.access || []) {
    const miles = distanceMiles(position, place);
    if (!best || miles < best.miles) best = { ...place, miles };
  }
  return best;
}

export const directionsUrl = ({ lat, lon }) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

export function accessFact(hike) {
  const first = hike.access?.[0];
  if (!first) return 'No trailhead or parking in the data.';
  const label = first.type === 'trailhead' ? 'Trailhead' : 'Parking';
  const name = first.name ? ` (${first.name})` : '';
  return first.feet < 100 ? `${label}${name} at the trail.` : `${label}${name} about ${formatFeet(first.feet)} from the trail.`;
}

const entryPoint = hike => hike.point || boundsCenter(hike.bounds);

export function hikeFacts(hike) {
  const facts = [];
  if (hike.kind === 'route') facts.push(`${hike.miles.toFixed(hike.miles < 10 ? 2 : 1)} mi of mapped trail`);
  if (Number.isFinite(hike.lowFeet)) {
    facts.push(hike.lowFeet === hike.highFeet || hike.kind === 'destination'
      ? `ground about ${formatFeet(hike.highFeet)}`
      : `ground ${formatFeet(hike.lowFeet)} to ${formatFeet(hike.highFeet)}`);
  }
  return facts.join(' · ');
}

// Where the hiker stands relative to a chosen hike, carrying the previous answer forward.
export function routeProgress(hike, position, wasOff = false) {
  if (hike.kind === 'destination') {
    const miles = distanceMiles(position, hike.point);
    return { off: false, onRoute: false, miles, feet: miles * FEET_PER_MILE, point: hike.point, bearing: bearingDegrees(position, hike.point) };
  }
  const nearest = nearestOnLines(hike.decoded, position, Infinity);
  const feet = nearest.miles * FEET_PER_MILE;
  const off = wasOff ? feet > BACK_ON_ROUTE_FEET : feet > OFF_ROUTE_FEET;
  return { off, onRoute: !off, miles: nearest.miles, feet, point: nearest.point, bearing: nearest.bearing };
}
