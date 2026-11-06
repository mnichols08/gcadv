// Distances are miles, short lengths and elevations are feet. Metres appear only at the
// edges where the outside world insists on them (the Geolocation API, GPX files).
const EARTH_RADIUS_MILES = 3958.8;
export const FEET_PER_MILE = 5280;
export const FEET_PER_METER = 3.28084;
export const TILE_SIZE = 256;

const radians = degrees => (degrees * Math.PI) / 180;

export function distanceMiles(a, b) {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const distanceFeet = (a, b) => distanceMiles(a, b) * FEET_PER_MILE;

export function bearingDegrees(a, b) {
  const y = Math.sin(radians(b.lon - a.lon)) * Math.cos(radians(b.lat));
  const x = Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) - Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(radians(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassPoint = degrees => POINTS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];

export function formatDistance(miles) {
  if (miles < 0.1) return `${Math.round(miles * FEET_PER_MILE)} ft`;
  return `${miles < 10 ? miles.toFixed(2) : miles.toFixed(1)} mi`;
}

export function formatDuration(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function formatPace(movingSeconds, miles) {
  if (miles < 0.05 || movingSeconds <= 0) return '--';
  const minutes = movingSeconds / 60 / miles;
  if (minutes > 99) return '--';
  return `${Math.floor(minutes)}:${String(Math.round((minutes % 1) * 60) % 60).padStart(2, '0')}`;
}

export const formatFeet = feet => `${Math.round(feet).toLocaleString('en-US')} ft`;
export const formatCoordinates = ({ lat, lon }) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

// Web Mercator, in pixels at a whole or fractional zoom.
export function project(lat, lon, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin(radians(Math.max(-85.05, Math.min(85.05, lat))));
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

export function unproject(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI, lon: (x / scale) * 360 - 180 };
}

export const feetPerPixel = (lat, zoom) => (Math.cos(radians(lat)) * 2 * Math.PI * EARTH_RADIUS_MILES * FEET_PER_MILE) / (TILE_SIZE * 2 ** zoom);

function tileRange({ south, west, north, east }, zoom) {
  const topLeft = project(north, west, zoom);
  const bottomRight = project(south, east, zoom);
  return {
    left: Math.floor(topLeft.x / TILE_SIZE),
    right: Math.floor(bottomRight.x / TILE_SIZE),
    top: Math.floor(topLeft.y / TILE_SIZE),
    bottom: Math.floor(bottomRight.y / TILE_SIZE),
  };
}

export function countTiles(bounds, zoom) {
  const { left, right, top, bottom } = tileRange(bounds, zoom);
  return (right - left + 1) * (bottom - top + 1);
}

export function tilesForBounds(bounds, zoom) {
  const { left, right, top, bottom } = tileRange(bounds, zoom);
  const tiles = [];
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

// Ramer-Douglas-Peucker over raw degrees; good enough at this tolerance and latitude.
export function simplifyLine(coords, tolerance) {
  if (coords.length < 3) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    const [ax, ay] = coords[from];
    const [bx, by] = coords[to];
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy || 1e-18;
    let worst = -1;
    let worstDistance = tolerance * tolerance;
    for (let index = from + 1; index < to; index += 1) {
      const [px, py] = coords[index];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span));
      const distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (distance > worstDistance) {
        worst = index;
        worstDistance = distance;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([from, worst], [worst, to]);
    }
  }
  return coords.filter((_, index) => keep[index]);
}
