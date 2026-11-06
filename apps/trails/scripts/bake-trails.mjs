// Merges the USGS and OpenStreetMap trail snapshots into offline shards plus the hike list.
//
//   node apps/trails/scripts/bake-trails.mjs
//
// The output combines OSM data, so it is a derived database under the ODbL and must stay
// publicly available, with credit. It keeps its own folder and license file for that reason.
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { distanceMiles, simplifyLine } from '../public/modules/geo.js';
import { shardKey, SHARD_DEGREES } from '../public/modules/landscape.js';
import { blockAt, BLOCK_SAMPLES } from '../public/modules/terrain.js';
import { activityNames, osmActivities, pointInRings, routeActivities, usgsActivities } from '../public/modules/activities.js';
import { classifyOsm, classifyUsgs, cleanName, conflate, decodeTrail, encodeTrail } from '../public/modules/trails.js';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sources = resolve(here, '../data-sources');
const data = resolve(here, '../public/data');
const readGz = name => JSON.parse(gunzipSync(readFileSync(join(sources, name))).toString('utf8'));
const SIMPLIFY_DEGREES = 0.00004; // About 15 ft: finer than the streams, because people walk these.

const usgs = readGz('usgs-trails.json.gz');
const osm = readGz('osm-trails.json.gz');

const relationNames = new Map();
const relationRoutes = new Map();
for (const element of osm.elements) {
  if (element.type !== 'relation') continue;
  for (const member of element.members || []) {
    if (member.type !== 'way') continue;
    if (!relationRoutes.has(member.ref)) relationRoutes.set(member.ref, []);
    relationRoutes.get(member.ref).push({ route: element.tags?.route, piste: element.tags?.['piste:type'] });
    if (!element.tags?.name) continue;
    if (!relationNames.has(member.ref)) relationNames.set(member.ref, []);
    relationNames.get(member.ref).push(cleanName(element.tags.name));
  }
}

const osmLines = [];
for (const element of osm.elements) {
  if (element.type !== 'way' || !element.geometry) continue;
  const kind = classifyOsm(element.tags);
  if (!kind) continue;
  const names = [cleanName(element.tags.name), ...(relationNames.get(element.id) || [])].filter(Boolean);
  const surface = element.tags.surface || '';
  osmLines.push({ names: [...new Set(names)], kind, surface, activities: osmActivities(element.tags, relationRoutes.get(element.id)), coords: element.geometry.map(({ lon, lat }) => [lon, lat]) });
}

const usgsLines = [];
for (const trail of usgs.trails) {
  const kind = classifyUsgs(trail);
  if (!kind) continue;
  const name = cleanName(trail.name);
  const details = { surface: trail.trailsurface || '', season: trail.seasonopen || '', pets: trail.pets || '' };
  for (const coords of trail.paths) if (coords.length > 1) usgsLines.push({ names: name ? [name] : [], kind, activities: usgsActivities(trail, kind), ...details, coords });
}

const merged = conflate(osmLines, usgsLines).map(line => ({ ...line, coords: simplifyLine(line.coords, SIMPLIFY_DEGREES) }));
const counts = {};
for (const line of merged) counts[line.kind] = (counts[line.kind] || 0) + 1;
console.log(`osm ${osmLines.length} + usgs ${usgsLines.length} -> ${merged.length} lines`, counts);
const activityMiles = new Map();
for (const line of merged) {
  for (const name of activityNames(line.activities)) activityMiles.set(name, (activityMiles.get(name) || 0) + 1);
}
console.log('lines by activity', Object.fromEntries(activityMiles));

const shards = new Map();
for (const line of merged) {
  const entry = encodeTrail(line);
  for (const key of new Set(line.coords.map(([lon, lat]) => shardKey(lat, lon)))) {
    if (!shards.has(key)) shards.set(key, []);
    shards.get(key).push(entry);
  }
}
rmSync(join(data, 'trails'), { recursive: true, force: true });
mkdirSync(join(data, 'trails'), { recursive: true });
let bytes = 0;
for (const [key, lines] of shards) {
  const body = JSON.stringify({ lines });
  bytes += body.length;
  writeFileSync(join(data, 'trails', `${key}.json`), body);
}
console.log(`${shards.size} trail shards, ${(bytes / 1048576).toFixed(1)} MB raw`);

const toPoint = ([lon, lat]) => ({ lat, lon });
const lineMiles = coords => coords.slice(1).reduce((total, coord, index) => total + distanceMiles(toPoint(coords[index]), toPoint(coord)), 0);

const catalog = JSON.parse(readFileSync(join(sources, 'hikes.source.json'), 'utf8'));
const { counties } = readGz('counties.json.gz');
const countyAt = point => {
  const found = counties.find(county => pointInRings(point, county.rings));
  return found ? `${found.name} County, ${found.state}` : '';
};
// Ground range from the captured 3DEP blocks, sampled at every mapped point. This is the low and
// high ground only: cumulative climb needs more care than a hike list should imply.
const blockFiles = new Map();
function groundAt([lon, lat]) {
  const { key, column, row } = blockAt(lat, lon);
  if (!blockFiles.has(key)) {
    const file = readFileSync(join(data, 'terrain', `${key}.bin`));
    blockFiles.set(key, new Int16Array(file.buffer, file.byteOffset, file.length / 2));
  }
  return blockFiles.get(key)[row * BLOCK_SAMPLES + column];
}
const elevationRange = coords => {
  const values = coords.map(groundAt);
  return { lowFeet: Math.min(...values), highFeet: Math.max(...values) };
};
// Mapped ways in, nearest the trail first. Trailheads outrank parking, which could be anything
// from a forest lot to a shop's, so the app says "mapped" and points people at the land manager.
const accessPlaces = readGz('osm-access.json.gz').places.filter(place => !['private', 'no', 'customers'].includes(place.access));
const REACH_MILES = 0.2;
const SEPARATE_MILES = 0.5;
function accessFor(coords, reach = REACH_MILES) {
  const candidates = [];
  for (const place of accessPlaces) {
    let closest = Infinity;
    for (const coord of coords) closest = Math.min(closest, distanceMiles(place, toPoint(coord)));
    if (closest <= reach) candidates.push({ place, closest });
  }
  candidates.sort((a, b) => (a.place.type === 'trailhead' ? 0 : 1) - (b.place.type === 'trailhead' ? 0 : 1) || a.closest - b.closest);
  const chosen = [];
  for (const { place, closest } of candidates) {
    if (chosen.length === 3 || chosen.some(other => distanceMiles(other, place) < SEPARATE_MILES)) continue;
    chosen.push({ lat: Math.round(place.lat * 1e5) / 1e5, lon: Math.round(place.lon * 1e5) / 1e5, type: place.type, name: cleanName(place.name), feet: Math.round(closest * 5280) });
  }
  return chosen;
}
const decodeTrail2Points = entry => decodeTrail(entry).points;
const hikes = [];
const problems = [];
for (const hike of catalog.hikes) {
  const note = hike.note || catalog.notes[hike.noteKey] || '';
  const base = { id: hike.id, name: hike.name, group: hike.group, area: hike.area, note };
  if (hike.destination) {
    const [lat, lon] = hike.destination;
    hikes.push({ ...base, activities: hike.activities ?? 1, county: countyAt({ lat, lon }), ...elevationRange([[lon, lat]]), access: accessFor([[lon, lat]], 0.3), kind: 'destination', point: { lat, lon }, bounds: { south: lat - 0.01, north: lat + 0.01, west: lon - 0.013, east: lon + 0.013 } });
    continue;
  }
  const pattern = new RegExp(hike.match, 'i');
  const center = { lat: hike.near[0], lon: hike.near[1] };
  const lines = merged.filter(line => line.names.some(name => pattern.test(name)) && line.coords.some(coord => distanceMiles(center, toPoint(coord)) <= hike.radius));
  if (!lines.length) {
    problems.push(hike.id);
    continue;
  }
  const lats = lines.flatMap(line => line.coords.map(coord => coord[1]));
  const lons = lines.flatMap(line => line.coords.map(coord => coord[0]));
  const usedSources = new Set(lines.flatMap(line => line.sources));
  hikes.push({
    ...base,
    activities: lines.reduce((bits, line) => bits | line.activities, 1),
    county: countyAt({ lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 }),
    ...elevationRange(lines.flatMap(line => line.coords)),
    access: accessFor(lines.flatMap(line => line.coords)),
    kind: 'route',
    miles: Math.round(lines.reduce((total, line) => total + lineMiles(line.coords), 0) * 100) / 100,
    sources: [...usedSources].sort(),
    bounds: { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) },
    lines: lines.map(encodeTrail),
  });
}
if (problems.length) throw new Error(`No mapped trail matched: ${problems.join(', ')}`);

// Checkpoints must resolve to a real place near their hike's trail, or the bake stops.
const CHECKPOINT_TRAIL_FEET = 300;
const namedPlaces = osm.elements.filter(element => element.type === 'node' && element.tags?.name);
const checkpointCatalog = JSON.parse(readFileSync(join(sources, 'checkpoints.source.json'), 'utf8')).checkpoints;
const checkpoints = checkpointCatalog.map(entry => {
  const hike = hikes.find(item => item.id === entry.hikeId);
  if (!hike) throw new Error(`Checkpoint ${entry.id}: no hike ${entry.hikeId}`);
  let point;
  if (entry.fromHike) {
    point = hike.point;
  } else if (entry.alongLine) {
    const line = hike.lines.map(decodeTrail).find(item => item.name === entry.alongLine);
    if (!line) throw new Error(`Checkpoint ${entry.id}: no line ${entry.alongLine}`);
    point = line.points[Math.floor(line.points.length / 2)];
  } else {
    // Names repeat, such as a second Table Rock near Cheat Lake, so match near the expected spot.
    const center = { lat: entry.near[0], lon: entry.near[1] };
    const place = namedPlaces.find(element => element.tags.name === entry.place && distanceMiles(center, element) < 0.1);
    if (!place) throw new Error(`Checkpoint ${entry.id}: no place ${entry.place}`);
    point = { lat: place.lat, lon: place.lon };
  }
  if (hike.kind === 'route') {
    const trailFeet = Math.min(...hike.lines.flatMap(decodeTrail2Points).map(other => distanceMiles(point, other))) * 5280;
    if (trailFeet > CHECKPOINT_TRAIL_FEET) throw new Error(`Checkpoint ${entry.id} is ${Math.round(trailFeet)} ft from its trail`);
  }
  return {
    id: entry.id,
    name: entry.name,
    group: entry.group,
    area: entry.area,
    hikeId: entry.hikeId,
    about: entry.about,
    note: catalog.notes[entry.noteKey] || '',
    radiusFeet: entry.radiusFeet,
    lat: Math.round(point.lat * 1e5) / 1e5,
    lon: Math.round(point.lon * 1e5) / 1e5,
  };
});
writeFileSync(join(data, 'checkpoints.json'), JSON.stringify({ checkpoints }));
console.log(`${checkpoints.length} checkpoints`);

writeFileSync(join(data, 'hikes.json'), JSON.stringify({ hikes }));

// Every named trail with a marked activity, for the finder. Geometry stays in the shards, so this
// list is small enough to keep offline. Same-named lines join up when they are close together.
const ROUTE_JOIN_DEGREES = 0.03; // About two miles.
const MIN_ROUTE_MILES = 0.1;
const boxOf = coords => ({
  south: Math.min(...coords.map(coord => coord[1])),
  north: Math.max(...coords.map(coord => coord[1])),
  west: Math.min(...coords.map(coord => coord[0])),
  east: Math.max(...coords.map(coord => coord[0])),
});
const touching = (a, b) => a.south - ROUTE_JOIN_DEGREES <= b.north && b.south - ROUTE_JOIN_DEGREES <= a.north && a.west - ROUTE_JOIN_DEGREES <= b.east && b.west - ROUTE_JOIN_DEGREES <= a.east;
const byName = new Map();
for (const line of merged) {
  // A road or track is only a route if a source marks it for something specific.
  if (!line.names[0] || !line.activities) continue;
  if (!byName.has(line.names[0])) byName.set(line.names[0], []);
  byName.get(line.names[0]).push(line);
}
const routes = [];
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const taken = new Map();
const round = value => Math.round(value * 1e5) / 1e5;
const firstValue = (lines, field) => lines.map(line => line[field]).find(value => value && value !== 'Unknown') || '';
for (const [name, lines] of byName) {
  const clusters = [];
  for (const line of lines) {
    const box = boxOf(line.coords);
    const near = clusters.filter(cluster => touching(cluster.box, box));
    const joined = { lines: [line, ...near.flatMap(cluster => cluster.lines)], box: near.reduce((all, cluster) => ({ south: Math.min(all.south, cluster.box.south), north: Math.max(all.north, cluster.box.north), west: Math.min(all.west, cluster.box.west), east: Math.max(all.east, cluster.box.east) }), box) };
    for (const cluster of near) clusters.splice(clusters.indexOf(cluster), 1);
    clusters.push(joined);
  }
  for (const cluster of clusters) {
    const miles = cluster.lines.reduce((total, line) => total + lineMiles(line.coords), 0);
    if (miles < MIN_ROUTE_MILES) continue;
    const center = { lat: round((cluster.box.south + cluster.box.north) / 2), lon: round((cluster.box.west + cluster.box.east) / 2) };
    const activities = routeActivities(cluster.lines.map(line => ({ miles: lineMiles(line.coords), activities: line.activities })));
    if (!activities) continue;
    const reached = new Map();
    for (const line of cluster.lines) {
      for (const [lon, lat] of line.coords.filter((_, index, all) => index % Math.ceil(all.length / 12) === 0)) {
        const found = countyAt({ lat, lon });
        if (found) reached.set(found, (reached.get(found) || 0) + 1);
      }
    }
    if (!reached.size) continue; // Inside the capture box but outside the counties this app covers.
    const routeCounties = [...reached].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const base = slug(name) || 'trail';
    const count = (taken.get(base) || 0) + 1;
    taken.set(base, count);
    const route = {
      id: count === 1 ? base : `${base}-${count}`,
      name,
      county: routeCounties[0],
      ...(routeCounties.length > 1 ? { counties: routeCounties } : {}),
      activities,
      miles: Math.round(miles * 100) / 100,
      center,
      bounds: { south: round(cluster.box.south), north: round(cluster.box.north), west: round(cluster.box.west), east: round(cluster.box.east) },
      sources: [...new Set(cluster.lines.flatMap(line => line.sources))].sort(),
    };
    for (const field of ['surface', 'season', 'pets']) {
      const value = firstValue(cluster.lines, field);
      if (value) route[field] = value;
    }
    const way = accessFor(cluster.lines.flatMap(line => line.coords).filter((_, index, all) => index % Math.ceil(all.length / 60) === 0));
    if (way.length) route.access = way;
    routes.push(route);
  }
}
routes.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(data, 'routes.json'), JSON.stringify({ counties: counties.map(county => `${county.name} County, ${county.state}`).sort(), routes }));
console.log(`${routes.length} routes, ${(JSON.stringify(routes).length / 1024).toFixed(0)} KB`);
for (const name of activityNames(511)) {
  const matching = routes.filter(route => activityNames(route.activities).includes(name));
  console.log(`  ${name.padEnd(12)} ${String(matching.length).padStart(5)} trails ${matching.reduce((total, route) => total + route.miles, 0).toFixed(0).padStart(6)} mi`);
}
writeFileSync(join(data, 'TRAILS-LICENSE.txt'), `The files in trails/, hikes.json, routes.json and checkpoints.json are a database derived from:

- OpenStreetMap, (c) OpenStreetMap contributors, https://www.openstreetmap.org/copyright
  captured ${osm.source.capturedAt} (data as of ${osm.source.osmBase})
- USGS National Digital Trails (public domain), captured ${usgs.source.capturedAt}
- US Census TIGERweb county outlines (public domain)

They are made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/
`);

const index = JSON.parse(readFileSync(join(data, 'index.json'), 'utf8'));
index.trailShards = [...shards.keys()].sort();
index.sources.trails = 'USGS National Digital Trails and OpenStreetMap, captured 2026-11-05';
index.shardDegrees = SHARD_DEGREES;
writeFileSync(join(data, 'index.json'), JSON.stringify(index));

for (const hike of hikes) {
  console.log(`${hike.group.padEnd(15)} ${hike.id.padEnd(24)} ${hike.kind === 'route' ? `${hike.miles.toFixed(2).padStart(6)} mi  ${String(hike.lines.length).padStart(3)} lines  ${hike.sources.join('+').padEnd(9)} [${[...new Set(hike.lines.map(line => line[0]))].join(', ').slice(0, 60)}]` : 'destination'}`);
}
console.log(`hikes with a way in: ${hikes.filter(hike => hike.access.length).length} of ${hikes.length}`);
console.log(`hikes.json: ${(JSON.stringify({ hikes }).length / 1024).toFixed(0)} KB`);
