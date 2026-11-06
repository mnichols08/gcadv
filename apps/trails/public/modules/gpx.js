import { FEET_PER_METER } from './geo.js';

const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GPX 1.1 defines elevation in metres, so feet convert on the way out.
const elevation = feet => (feet === null || feet === undefined ? '' : `<ele>${(feet / FEET_PER_METER).toFixed(1)}</ele>`);

export function toGpx(hike, points, waypoints = []) {
  const segments = new Map();
  for (const point of points) {
    if (!segments.has(point.seg)) segments.set(point.seg, []);
    segments.get(point.seg).push(point);
  }
  const wpts = waypoints.map(spot => `  <wpt lat="${spot.lat}" lon="${spot.lon}">${elevation(spot.altFeet)}<time>${new Date(spot.t).toISOString()}</time><name>${xml(spot.name)}</name></wpt>`);
  const segs = [...segments.values()].map(segment => {
    const rows = segment.map(point => `      <trkpt lat="${point.lat}" lon="${point.lon}">${elevation(point.altFeet)}<time>${new Date(point.t).toISOString()}</time></trkpt>`);
    return `    <trkseg>\n${rows.join('\n')}\n    </trkseg>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Garrett County Adventures" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xml(hike.name)}</name><time>${new Date(hike.startedAt).toISOString()}</time></metadata>`,
    ...wpts,
    `  <trk><name>${xml(hike.name)}</name>`,
    ...segs,
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

export function gpxFileName(hike) {
  const day = new Date(hike.startedAt).toISOString().slice(0, 10);
  const slug = hike.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hike';
  return `${day}-${slug}.gpx`;
}
