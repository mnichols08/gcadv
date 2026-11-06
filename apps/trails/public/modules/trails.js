import { isClosed, osmActivities } from './activities.js';

// Sorts trail records from USGS and OpenStreetMap into what a hiker needs to know about them.
//   foot:   a trail people walk.
//   shared: a named snowmobile or motorized route; walking may be fine, but expect traffic.
//   track:  a road or two-track of unknown standing. Being mapped does not grant access.
//   ski:    a groomed snow trail, not a summer path.

const JUNK_NAMES = /^(none|unnamed.*|undesignated trail|social trail|other system trails|foot trails|north section \(unknown\)|unimproved road)$/i;
const MOTOR_NAME = /snowmobile|\bORV\b|\bOHV\b|\bATV\b/i;
const ROAD_NAME = /\b(road|rd\.?|highway|boulevard)\s*$|road spur$|class q road/i;

export function cleanName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name || JUNK_NAMES.test(name)) return '';
  // Some sources shout, and some title-casers capitalize after an apostrophe.
  const cased = name === name.toUpperCase() ? name.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase()) : name;
  return cased.replace(/'S\b/g, "'s");
}

export function classifyUsgs({ name, trailtype, ohvover50inches, ohvisorunder50inches, motorcycle, osvm }) {
  if (trailtype === 'Water Trail') return null;
  const motor = [ohvover50inches, ohvisorunder50inches, motorcycle, osvm].includes('Y');
  if (motor || MOTOR_NAME.test(name || '')) return 'shared';
  if (trailtype === 'Snow Trail') return 'ski';
  if (ROAD_NAME.test(name || '')) return 'track';
  // Forest Service records usually leave the hiker flag blank, so blank does not mean no.
  return 'foot';
}

export function classifyOsm(tags) {
  if (isClosed(tags, osmActivities(tags))) return null;
  if (['private', 'no'].includes(tags.foot) && !osmActivities(tags)) return null;
  if (['sidewalk', 'crossing', 'access_aisle', 'traffic_island'].includes(tags.footway)) return null;
  if (['yes', 'designated', 'permissive'].includes(tags.atv) || ['yes', 'designated', 'permissive'].includes(tags.ohv) || tags.motorcycle === 'designated' || ['yes', 'designated', 'permissive'].includes(tags.snowmobile) || MOTOR_NAME.test(tags.name || '')) return 'shared';
  if (tags.piste === 'nordic' || tags['piste:type']) return 'ski';
  if (tags.highway === 'track') return tags.foot === 'designated' ? 'foot' : 'track';
  return 'foot';
}

const CELL = 0.002; // About 700 ft, comfortably wider than the match distance.
const cellKey = (lon, lat) => `${Math.floor(lon / CELL)}_${Math.floor(lat / CELL)}`;

function feetToSegment([px, py], [ax, ay], [bx, by]) {
  const scale = Math.cos((py * Math.PI) / 180);
  const dx = (bx - ax) * scale;
  const dy = by - ay;
  const span = dx * dx + dy * dy;
  const t = span ? Math.max(0, Math.min(1, ((px - ax) * scale * dx + (py - ay) * dy) / span)) : 0;
  return Math.hypot((px - ax) * scale - t * dx, py - ay - t * dy) * 364000; // Feet per degree of latitude.
}

export function indexSegments(lines) {
  const cells = new Map();
  lines.forEach((line, lineIndex) => {
    for (let index = 0; index < line.coords.length - 1; index += 1) {
      const a = line.coords[index];
      const b = line.coords[index + 1];
      const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / CELL);
      for (let step = 0; step <= steps; step += 1) {
        const t = steps ? step / steps : 0;
        const key = cellKey(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ lineIndex, a, b });
      }
    }
  });
  return cells;
}

function nearestLine(cells, point, maxFeet) {
  let best = null;
  const column = Math.floor(point[0] / CELL);
  const row = Math.floor(point[1] / CELL);
  for (let x = column - 1; x <= column + 1; x += 1) {
    for (let y = row - 1; y <= row + 1; y += 1) {
      for (const segment of cells.get(`${x}_${y}`) || []) {
        const feet = feetToSegment(point, segment.a, segment.b);
        if (feet <= maxFeet && (!best || feet < best.feet)) best = { lineIndex: segment.lineIndex, feet };
      }
    }
  }
  return best;
}

function lineNearby(cells, point, maxFeet, accepts) {
  const column = Math.floor(point[0] / CELL);
  const row = Math.floor(point[1] / CELL);
  for (let x = column - 1; x <= column + 1; x += 1) {
    for (let y = row - 1; y <= row + 1; y += 1) {
      for (const segment of cells.get(`${x}_${y}`) || []) {
        if (accepts(segment.lineIndex) && feetToSegment(point, segment.a, segment.b) <= maxFeet) return segment.lineIndex;
      }
    }
  }
  return null;
}

const baseName = name => String(name || '').toLowerCase().replace(/\b(trail|hiking|path|mtn\.?|mountain)\b/g, '').replace(/\W+/g, ' ').trim();

function shareNear(coords, cells, maxFeet) {
  return coords.filter(point => nearestLine(cells, point, maxFeet)).length / coords.length;
}

// OSM drawing is usually finer and USGS naming more official, so a USGS line that retraces an
// OSM line donates its name and walkable status. Anything OSM lacks stays as its own line.
// A name only moves between lines that follow each other along their length; merely crossing
// or touching another trail must not rename it.
export function conflate(osmLines, usgsLines, { matchFeet = 100, sameNameFeet = 350, share = 0.8, sameNameShare = 0.5, donorShare = 0.6, unnamedDonorShare = 0.3 } = {}) {
  const lines = osmLines.map(line => ({ ...line, names: [...line.names], sources: ['osm'] }));
  const cells = indexSegments(lines);
  const added = [];
  for (const usgs of usgsLines) {
    const touched = new Set();
    let near = 0;
    let looselyNear = 0;
    const usgsBase = baseName(usgs.names[0]);
    for (const point of usgs.coords) {
      const match = nearestLine(cells, point, matchFeet);
      if (match) {
        near += 1;
        touched.add(match.lineIndex);
      }
      // Another line may run closer, so look for the same-named line specifically.
      const namesake = !usgsBase ? null : lineNearby(cells, point, sameNameFeet, index => lines[index].names.some(name => baseName(name) === usgsBase));
      if (namesake !== null) {
        looselyNear += 1;
        touched.add(namesake);
      }
    }
    const count = usgs.coords.length;
    if (near / count >= share || looselyNear / count >= sameNameShare) {
      const donorCells = indexSegments([usgs]);
      for (const lineIndex of touched) {
        const line = lines[lineIndex];
        const sameName = usgsBase && line.names.some(name => baseName(name) === usgsBase);
        const overlap = sameName ? 1 : shareNear(line.coords, donorCells, matchFeet);
        // An unnamed line has no name of its own to lose, so it can take one more readily.
        if (overlap < (line.names.length ? donorShare : unnamedDonorShare)) continue;
        if (!line.sources.includes('usgs')) line.sources.push('usgs');
        if (usgs.names[0] && !line.names.includes(usgs.names[0])) line.names.push(usgs.names[0]);
        if (usgs.kind === 'foot' && line.kind === 'track') line.kind = 'foot';
        // A shared name isn't enough here: one line's permissions must not spread to another.
        if (shareNear(line.coords, donorCells, matchFeet) >= donorShare) line.activities = (line.activities || 0) | (usgs.activities || 0);
      }
    } else {
      added.push({ ...usgs, names: [...usgs.names], sources: ['usgs'] });
    }
  }
  return [...lines, ...added];
}

const boxOf = coords => ({
  south: Math.min(...coords.map(coord => coord[1])),
  north: Math.max(...coords.map(coord => coord[1])),
  west: Math.min(...coords.map(coord => coord[0])),
  east: Math.max(...coords.map(coord => coord[0])),
});
const boxesTouch = (a, b, margin = 0.001) => a.south - margin <= b.north && b.south - margin <= a.north && a.west - margin <= b.east && b.west - margin <= a.east;

// Forest Service lines carry the land manager's own word on each use, so where one runs along a
// mapped line, it adds and removes activities there. Trails nobody else mapped become new lines.
export function applyOfficial(lines, officialLines, { matchFeet = 100, sameNameFeet = 350, share = 0.6, retraceShare = 0.5 } = {}) {
  const boxes = lines.map(line => boxOf(line.coords));
  const everything = indexSegments(lines);
  const added = [];
  for (const official of officialLines) {
    const cells = indexSegments([official]);
    const box = boxOf(official.coords);
    const officialBase = baseName(official.names[0]);
    let matched = shareNear(official.coords, everything, sameNameFeet) >= retraceShare;
    lines.forEach((line, index) => {
      if (!boxesTouch(boxes[index], box, 0.002)) return;
      const sameName = officialBase && line.names.some(name => baseName(name) === officialBase);
      if (shareNear(line.coords, cells, sameName ? sameNameFeet : matchFeet) < share) return;
      matched = true;
      line.activities = ((line.activities || 0) | official.allowed) & ~official.blocked;
      line.blocked = (line.blocked || 0) | official.blocked;
      line.seasons = { ...line.seasons, ...official.seasons };
      if (!line.sources.includes('usfs')) line.sources.push('usfs');
      if (!line.names.length && official.names.length) line.names.push(official.names[0]);
    });
    if (!matched) {
      added.push({ names: [...official.names], kind: official.kind, coords: official.coords, activities: official.allowed, blocked: official.blocked, seasons: official.seasons, sources: ['usfs'] });
    }
  }
  return [...lines, ...added];
}

const KIND_CODES = ['foot', 'shared', 'track', 'ski'];
const SOURCE_CODES = [['osm'], ['usgs'], ['osm', 'usgs'], ['usfs'], ['osm', 'usfs'], ['usgs', 'usfs'], ['osm', 'usgs', 'usfs']];
const sourceCode = sources => SOURCE_CODES.findIndex(list => list.length === sources.length && list.every(source => sources.includes(source)));
const COORD_SCALE = 1e5;

// [name, kind, source, activities, lon, lat, dLon, dLat, ...] in integer 1e-5 degrees.
export function encodeTrail({ names, kind, sources, coords, activities = 0 }) {
  const entry = [names[0] || '', KIND_CODES.indexOf(kind), sourceCode(sources), activities];
  let lastLon = 0;
  let lastLat = 0;
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    if (entry.length > 4 && x === lastLon && y === lastLat) continue;
    entry.push(x - lastLon, y - lastLat);
    lastLon = x;
    lastLat = y;
  }
  return entry;
}

export function decodeTrail(entry) {
  const points = [];
  let x = 0;
  let y = 0;
  for (let index = 4; index < entry.length; index += 2) {
    x += entry[index];
    y += entry[index + 1];
    points.push({ lat: y / COORD_SCALE, lon: x / COORD_SCALE });
  }
  return { name: entry[0], kind: KIND_CODES[entry[1]], sources: SOURCE_CODES[entry[2]], activities: entry[3], points };
}

export const KIND_LABELS = {
  foot: 'trail',
  shared: 'snowmobile or motorized route',
  track: 'road or track, access unknown',
  ski: 'ski trail',
};
