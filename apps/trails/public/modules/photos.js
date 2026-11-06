// Works out where a photo was taken. Pure, so every fallback can be tested without a camera.

const TRACK_MATCH_MS = 5 * 60 * 1000; // A photo this close in time to the route can be placed on it.
const RECENT_MS = 10 * 60 * 1000;
const TAG = { exifPointer: 0x8769, gpsPointer: 0x8825, original: 0x9003, latRef: 1, lat: 2, lonRef: 3, lon: 4 };

function readIfd(view, tiffStart, offset, little) {
  const entries = new Map();
  const count = view.getUint16(tiffStart + offset, little);
  for (let index = 0; index < count; index += 1) {
    const at = tiffStart + offset + 2 + index * 12;
    entries.set(view.getUint16(at, little), { type: view.getUint16(at + 2, little), count: view.getUint32(at + 4, little), valueAt: at + 8 });
  }
  return entries;
}

const asciiValue = (view, tiffStart, entry, little) => {
  const from = entry.count <= 4 ? entry.valueAt : tiffStart + view.getUint32(entry.valueAt, little);
  let text = '';
  for (let index = 0; index < entry.count; index += 1) {
    const code = view.getUint8(from + index);
    if (!code) break;
    text += String.fromCharCode(code);
  }
  return text;
};

function degrees(view, tiffStart, entry, little) {
  const from = tiffStart + view.getUint32(entry.valueAt, little);
  const part = index => view.getUint32(from + index * 8, little) / view.getUint32(from + index * 8 + 4, little);
  return part(0) + part(1) / 60 + part(2) / 3600;
}

// Reads GPS and capture time from a JPEG's EXIF. Anything malformed just returns what it found.
export function readExif(buffer) {
  const found = { lat: null, lon: null, time: null };
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xffd8) return found;
    let at = 2;
    while (at + 4 < view.byteLength) {
      const marker = view.getUint16(at);
      const size = view.getUint16(at + 2);
      if (marker === 0xffe1 && view.getUint32(at + 4) === 0x45786966) {
        const tiffStart = at + 10;
        const little = view.getUint16(tiffStart) === 0x4949;
        const first = readIfd(view, tiffStart, view.getUint32(tiffStart + 4, little), little);
        if (first.has(TAG.exifPointer)) {
          const exif = readIfd(view, tiffStart, view.getUint32(first.get(TAG.exifPointer).valueAt, little), little);
          if (exif.has(TAG.original)) found.time = parseExifTime(asciiValue(view, tiffStart, exif.get(TAG.original), little));
        }
        if (first.has(TAG.gpsPointer)) {
          const gps = readIfd(view, tiffStart, view.getUint32(first.get(TAG.gpsPointer).valueAt, little), little);
          if (gps.has(TAG.lat) && gps.has(TAG.lon)) {
            const lat = degrees(view, tiffStart, gps.get(TAG.lat), little);
            const lon = degrees(view, tiffStart, gps.get(TAG.lon), little);
            const south = gps.has(TAG.latRef) && asciiValue(view, tiffStart, gps.get(TAG.latRef), little) === 'S';
            const west = gps.has(TAG.lonRef) && asciiValue(view, tiffStart, gps.get(TAG.lonRef), little) === 'W';
            if (Number.isFinite(lat) && Number.isFinite(lon) && lat <= 90 && lon <= 180 && (lat || lon)) {
              found.lat = south ? -lat : lat;
              found.lon = west ? -lon : lon;
            }
          }
        }
        return found;
      }
      if (marker === 0xffda || (marker & 0xff00) !== 0xff00) return found;
      at += 2 + size;
    }
  } catch { /* A damaged header is the same as no header. */ }
  return found;
}

// "2026:11:05 14:30:00", in the camera's local time.
function parseExifTime(text) {
  const parts = text.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const time = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(time) ? time : null;
}

// Where the recorded route was at a moment, between the two nearest points when it can be.
export function positionAtTime(points, time) {
  if (!points.length || time < points[0].t - TRACK_MATCH_MS || time > points.at(-1).t + TRACK_MATCH_MS) return null;
  let after = points.findIndex(point => point.t >= time);
  if (after === -1) after = points.length - 1;
  const b = points[after];
  const a = points[Math.max(0, after - 1)];
  if (Math.min(Math.abs(time - a.t), Math.abs(time - b.t)) > TRACK_MATCH_MS) return null;
  const share = b.t === a.t ? 0 : Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)));
  // Across a gap in tracking, nobody knows the path, so use whichever end is closer in time.
  if (a.seg !== b.seg) return Math.abs(time - a.t) < Math.abs(time - b.t) ? { lat: a.lat, lon: a.lon } : { lat: b.lat, lon: b.lon };
  return { lat: a.lat + (b.lat - a.lat) * share, lon: a.lon + (b.lon - a.lon) * share };
}

export const PLACE_LABELS = {
  photo: 'Location saved in the photo',
  route: 'Placed from your recorded route, by time',
  here: 'Placed where you were when you added it',
  manual: 'Placed by hand on the map',
};

// Best evidence first. Current position only counts for a photo taken just now: an old photo
// chosen from the library must not silently land wherever the hiker happens to be standing.
export function placePhoto({ exif, fileTime, points = [], fix = null, now }) {
  const time = exif.time ?? fileTime ?? now;
  if (exif.lat !== null && exif.lon !== null) return { lat: exif.lat, lon: exif.lon, t: time, source: 'photo' };
  const onRoute = positionAtTime(points, time);
  if (onRoute) return { ...onRoute, t: time, source: 'route' };
  if (fix && Math.abs(now - time) <= RECENT_MS) return { lat: fix.lat, lon: fix.lon, t: time, source: 'here' };
  return { lat: null, lon: null, t: time, source: null };
}

// Keeps the proportions and never enlarges.
export function scaledSize(width, height, longest) {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The closest marker to a tap, if it's within reach of a fingertip.
export function nearestMarker(markers, x, y, reach = 26) {
  let best = null;
  for (const marker of markers) {
    const away = Math.hypot(marker.x - x, marker.y - y);
    if (away <= reach && (!best || away < best.away)) best = { marker, away };
  }
  return best?.marker || null;
}
