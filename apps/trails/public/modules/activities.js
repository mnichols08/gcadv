// What a trail is marked for. Pure. Only what a source actually says counts, because a trail wrongly
// shown as open to ATVs or snowmobiles could cost someone a fine or put them on closed land.
export const HIKE = 1;
export const BIKE = 2;
export const HORSE = 4;
export const SKI = 8;
export const SNOWSHOE = 16;
export const SNOWMOBILE = 32;
export const ATV = 64;
export const UTV = 128;
export const DIRT_BIKE = 256;

const CHECK_RULES = 'That marking can be wrong or out of date, so confirm the rules and any permit with the land manager before you go.';

export const ACTIVITIES = [
  { id: 'hike', label: 'Hike', mask: HIKE, note: '' },
  { id: 'bike', label: 'Bike', mask: BIKE, note: `Listed because a source marks them open to bikes. Difficulty isn't rated. ${CHECK_RULES}` },
  { id: 'ski', label: 'XC ski', mask: SKI, note: `Listed because a source marks them for cross-country skiing. Grooming and snow aren't shown. ${CHECK_RULES}` },
  { id: 'snowshoe', label: 'Snowshoe', mask: SNOWSHOE, note: `Listed because a source marks them for snowshoeing. Snow isn't shown. ${CHECK_RULES}` },
  { id: 'snowmobile', label: 'Snowmobile', mask: SNOWMOBILE, note: `Listed because a source marks them for snowmobiles. Season and snow aren't shown. ${CHECK_RULES}` },
  { id: 'motor', label: 'ATV / UTV', mask: ATV | UTV | DIRT_BIKE, note: `Listed because a source marks them for ATVs, UTVs or dirt bikes. Width limits vary. ${CHECK_RULES}` },
  { id: 'horse', label: 'Horse', mask: HORSE, note: `Listed because a source marks them open to horses. ${CHECK_RULES}` },
];

// Forest Service fields for each use. Four-wheel-drive isn't mapped: it says nothing about UTVs.
export const USFS_FIELDS = [
  { field: 'hiker_pedestrian', bit: HIKE },
  { field: 'pack_saddle', bit: HORSE },
  { field: 'bicycle', bit: BIKE },
  { field: 'motorcycle', bit: DIRT_BIKE },
  { field: 'atv', bit: ATV },
  { field: 'snowmobile', bit: SNOWMOBILE },
  { field: 'snowshoe', bit: SNOWSHOE },
  { field: 'xcountry_ski', bit: SKI },
];
const YEAR_ROUND = '01/01-12/31';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function seasonText(range) {
  const match = String(range || '').match(/^(\d{2})\/(\d{2})-(\d{2})\/(\d{2})$/);
  if (!match) return '';
  const [, fromMonth, fromDay, toMonth, toDay] = match.map(Number);
  return `${MONTHS[fromMonth - 1]} ${fromDay} to ${MONTHS[toMonth - 1]} ${toDay}`;
}

// What the land manager itself says, so it outranks community tags in both directions.
export function usfsUse(trail) {
  let allowed = 0;
  let blocked = 0;
  const seasons = {};
  for (const { field, bit } of USFS_FIELDS) {
    const open = trail[`${field}_managed`] || trail[`${field}_accpt`] || trail[`${field}_accpt_disc`];
    const closed = trail[`${field}_restricted`];
    if (open) {
      allowed |= bit;
      if (open !== YEAR_ROUND) seasons[bit] = seasonText(open);
    }
    // Only a closure covering the whole year removes a listing. A partial one is left to the note.
    if (closed === YEAR_ROUND && !open) blocked |= bit;
  }
  return { allowed, blocked, seasons };
}

const NAMES = [[HIKE, 'hiking'], [BIKE, 'biking'], [HORSE, 'horses'], [SKI, 'XC skiing'], [SNOWSHOE, 'snowshoeing'], [SNOWMOBILE, 'snowmobiles'], [ATV, 'ATVs'], [UTV, 'UTVs'], [DIRT_BIKE, 'dirt bikes']];

const CODES = { hike: HIKE, bike: BIKE, horse: HORSE, ski: SKI, snowshoe: SNOWSHOE, snowmobile: SNOWMOBILE, atv: ATV, utv: UTV, dirtbike: DIRT_BIKE };
export const activityBit = code => {
  if (!CODES[code]) throw new Error(`Unknown activity ${code}`);
  return CODES[code];
};

export const activityNames = bits => NAMES.filter(([bit]) => bits & bit).map(([, name]) => name);
export const activityById = id => ACTIVITIES.find(activity => activity.id === id) || null;
export const matchesActivity = (bits, activity) => !activity || Boolean(bits & activity.mask);

// The activities a route as a whole can be listed under. One marked piece of a long trail says
// nothing about the rest, so an activity must cover at least half of the mapped length.
export const ROUTE_SHARE = 0.5;
export function routeActivities(lines) {
  const total = lines.reduce((sum, { miles }) => sum + miles, 0);
  let bits = 0;
  for (let bit = 1; bit <= DIRT_BIKE; bit *= 2) {
    const marked = lines.reduce((sum, { miles, activities }) => sum + (activities & bit ? miles : 0), 0);
    if (total > 0 && marked / total >= ROUTE_SHARE) bits |= bit;
  }
  return bits;
}

// A route for permit holders, not an open riding trail.
const RESTRICTED_NAME = /disabled|handicap/i;
const motorName = name => /\b(ATV|OHV|ORV)\b/i.test(name || '') && !RESTRICTED_NAME.test(name || '');

const allowed = value => ['yes', 'designated', 'permissive'].includes(value);
const listIncludes = (value, wanted) => String(value || '').split(';').map(part => part.trim()).includes(wanted);

// routes are the route relations a way belongs to: [{ route, piste }].
export function osmActivities(tags, routes = []) {
  const routeIs = (...kinds) => routes.some(({ route }) => kinds.includes(route));
  const relationPiste = wanted => routes.some(({ piste }) => listIncludes(piste, wanted));
  const piste = wanted => listIncludes(tags['piste:type'], wanted) || relationPiste(wanted);
  let bits = 0;

  const walkway = ['path', 'footway', 'steps'].includes(tags.highway);
  if (tags.foot !== 'no' && (allowed(tags.foot) || walkway || routeIs('hiking', 'foot'))) bits |= HIKE;
  if (tags.bicycle !== 'no' && (allowed(tags.bicycle) || tags['mtb:scale'] !== undefined || tags['mtb:scale:imba'] !== undefined || tags.highway === 'cycleway' || routeIs('mtb', 'bicycle'))) bits |= BIKE;
  if (tags.horse !== 'no' && (allowed(tags.horse) || tags.highway === 'bridleway' || routeIs('horse'))) bits |= HORSE;
  if (allowed(tags.ski) || allowed(tags['ski:nordic']) || piste('nordic')) bits |= SKI;
  if (allowed(tags.snowshoe) || piste('hike') || piste('snowshoe')) bits |= SNOWSHOE;
  if (tags.snowmobile !== 'no' && (allowed(tags.snowmobile) || piste('snowmobile') || routeIs('snowmobile') || /snowmobile/i.test(tags.name || ''))) bits |= SNOWMOBILE;
  if (tags.atv !== 'no' && !RESTRICTED_NAME.test(tags.name || '') && (allowed(tags.atv) || allowed(tags.ohv) || routeIs('atv', 'ohv') || motorName(tags.name))) bits |= ATV;
  if (tags.motorcycle === 'designated') bits |= DIRT_BIKE;
  return bits;
}

// A blank flag means the source didn't say, so most stay off. Walking is the exception: Forest
// Service records leave it blank on ordinary footpaths, and only a plain "N" rules it out.
export function usgsActivities(trail, kind) {
  const yes = field => trail[field] === 'Y';
  let bits = 0;
  if (yes('hikerpedestrian') || (kind === 'foot' && trail.hikerpedestrian !== 'N')) bits |= HIKE;
  if (yes('bicycle')) bits |= BIKE;
  if (yes('packsaddle')) bits |= HORSE;
  if (yes('crosscountryski')) bits |= SKI;
  if (yes('snowshoe')) bits |= SNOWSHOE;
  if (yes('osvm') || /snowmobile/i.test(trail.name || '')) bits |= SNOWMOBILE;
  if (RESTRICTED_NAME.test(trail.name || '')) return bits;
  if (yes('ohvisorunder50inches') || motorName(trail.name)) bits |= ATV;
  if (yes('ohvover50inches')) bits |= UTV;
  if (yes('motorcycle')) bits |= DIRT_BIKE;
  return bits;
}

// One way of tagging a trail as closed outright beats everything else.
export function isClosed(tags, bits) {
  if (!['private', 'no'].includes(tags.access)) return false;
  return ![tags.foot, tags.bicycle, tags.horse, tags.snowmobile, tags.atv, tags.ohv].includes('designated') || !bits;
}

export function pointInRings({ lat, lon }, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let at = 0, before = ring.length - 1; at < ring.length; before = at, at += 1) {
      const [x1, y1] = ring[at];
      const [x2, y2] = ring[before];
      if ((y1 > lat) !== (y2 > lat) && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
    }
  }
  return inside;
}

// Routes for the finder, nearest first, narrowed to an activity and a county.
// Long routes cross county lines, so a route is listed under every county it reaches.
export function filterRoutes(routes, { activity = null, county = '', position = null, distance = null } = {}) {
  const list = routes.filter(route => matchesActivity(route.activities, activity) && (!county || (route.counties || [route.county]).includes(county)));
  if (position && distance) {
    const away = new Map(list.map(route => [route, distance(position, route.center)]));
    list.sort((a, b) => away.get(a) - away.get(b));
  }
  return list;
}

// The lines that make up a route, from the trail shards already holding them.
export function routeLines(shards, route) {
  const { south, north, west, east } = route.bounds;
  const seen = new Set();
  const lines = [];
  for (const shard of shards) {
    for (const line of shard?.lines || []) {
      if (line.name !== route.name) continue;
      if (!line.points.some(({ lat, lon }) => lat >= south && lat <= north && lon >= west && lon <= east)) continue;
      const key = `${line.points[0].lat},${line.points[0].lon}|${line.points.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines;
}
