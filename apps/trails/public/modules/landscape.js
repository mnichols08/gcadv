// "What is around me" from the bundled USGS data: named towns and every mapped stream.
import { bearingDegrees, distanceMiles, FEET_PER_MILE } from './geo.js';

export const SHARD_DEGREES = 0.25;
const COORD_SCALE = 1e5;

export function shardKey(lat, lon) {
  return `${Math.floor(lat / SHARD_DEGREES)}_${Math.floor(lon / SHARD_DEGREES)}`;
}

export function shardsForBounds({ south, west, north, east }) {
  const keys = [];
  for (let row = Math.floor(south / SHARD_DEGREES); row <= Math.floor(north / SHARD_DEGREES); row += 1) {
    for (let column = Math.floor(west / SHARD_DEGREES); column <= Math.floor(east / SHARD_DEGREES); column += 1) {
      keys.push(`${row}_${column}`);
    }
  }
  return keys;
}

// [name, drainsInto, streamOrder, lon, lat, dLon, dLat, ...] in integer 1e-5 degrees.
export function encodeLine({ name, into, order, coords }) {
  const entry = [name, into, order];
  let lastLon = 0;
  let lastLat = 0;
  for (const [lon, lat] of coords) {
    const x = Math.round(lon * COORD_SCALE);
    const y = Math.round(lat * COORD_SCALE);
    if (entry.length > 3 && x === lastLon && y === lastLat) continue;
    entry.push(x - lastLon, y - lastLat);
    lastLon = x;
    lastLat = y;
  }
  return entry;
}

export function decodeLine(entry) {
  const points = [];
  let x = 0;
  let y = 0;
  for (let index = 3; index < entry.length; index += 2) {
    x += entry[index];
    y += entry[index + 1];
    points.push({ lat: y / COORD_SCALE, lon: x / COORD_SCALE });
  }
  return { name: entry[0], into: entry[1], order: entry[2], points };
}

function closestOnSegment(position, a, b) {
  // Flat-earth is fine across one short segment; the result is re-measured properly.
  const scale = Math.cos((position.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * scale;
  const dy = b.lat - a.lat;
  const span = dx * dx + dy * dy;
  const t = span ? Math.max(0, Math.min(1, ((position.lon - a.lon) * scale * dx + (position.lat - a.lat) * dy) / span)) : 0;
  return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
}

// The closest point on any line, and the direction that line runs there.
export function nearestOnLines(lines, position, maxMiles) {
  let best = null;
  for (const line of lines) {
    for (let index = 0; index < line.points.length - 1; index += 1) {
      const a = line.points[index];
      const b = line.points[index + 1];
      const point = closestOnSegment(position, a, b);
      const miles = distanceMiles(position, point);
      if (miles <= maxMiles && (!best || miles < best.miles)) best = { line, point, miles, flow: bearingDegrees(a, b) };
    }
  }
  if (!best) return null;
  return {
    line: best.line,
    miles: best.miles,
    feet: best.miles * FEET_PER_MILE,
    bearing: bearingDegrees(position, best.point),
    lineBearing: best.flow,
    point: best.point,
  };
}

export function nearestWater(lines, position, maxMiles = 3) {
  const nearest = nearestOnLines(lines, position, maxMiles);
  if (!nearest) return null;
  const { line, lineBearing, ...rest } = nearest;
  return { ...rest, name: line.name, into: line.into, order: line.order, flowBearing: lineBearing };
}

export function buildPlaceIndex(rows) {
  const cells = new Map();
  for (const [name, state, lat, lon] of rows) {
    const key = `${Math.floor(lat * 4)}_${Math.floor(lon * 4)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ name, state, lat, lon });
  }
  return cells;
}

export function nearestPlace(cells, position, maxMiles = 40) {
  const row = Math.floor(position.lat * 4);
  const column = Math.floor(position.lon * 4);
  let best = null;
  // A cell is about 17 by 13 miles here. Search outward until no closer ring is possible.
  for (let ring = 0; ring <= 3; ring += 1) {
    for (let y = row - ring; y <= row + ring; y += 1) {
      for (let x = column - ring; x <= column + ring; x += 1) {
        if (Math.max(Math.abs(y - row), Math.abs(x - column)) !== ring) continue;
        for (const place of cells.get(`${y}_${x}`) || []) {
          const miles = distanceMiles(position, place);
          if (miles <= maxMiles && (!best || miles < best.miles)) best = { place, miles };
        }
      }
    }
    if (best && best.miles < ring * 13) break;
  }
  if (!best) return null;
  // Reports the direction you are from the town, which is how you would tell someone.
  return { ...best.place, miles: best.miles, bearingFromPlace: bearingDegrees(best.place, position) };
}
