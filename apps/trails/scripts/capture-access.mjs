// Captures mapped trailheads and parking from OpenStreetMap, for finding where a hike starts.
//
//   node apps/trails/scripts/capture-access.mjs
//
// (c) OpenStreetMap contributors, Open Database License.
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const REGION = { south: 38.75, west: -80.05, north: 40.35, east: -78.3 }; // Matches capture-trails.
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const box = `${REGION.south},${REGION.west},${REGION.north},${REGION.east}`;
const query = `[out:json][timeout:280];
(
  nwr["amenity"="parking"](${box});
  nwr["highway"="trailhead"](${box});
);
out tags center;`;

const response = await fetch(OVERPASS, {
  method: 'POST',
  headers: { 'User-Agent': 'garrett-county-adventures-capture/0.2 (https://garrettcountyadventures.com)', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ data: query }),
});
if (!response.ok) throw new Error(`Overpass ${response.status}`);
const { elements, osm3s } = await response.json();
const body = {
  source: { title: 'OpenStreetMap via Overpass API', service: OVERPASS, capturedAt: new Date().toISOString().slice(0, 10), region: REGION, osmBase: osm3s?.timestamp_osm_base, license: 'Open Database License (ODbL) 1.0; (c) OpenStreetMap contributors, https://www.openstreetmap.org/copyright' },
  places: elements.map(({ lat, lon, center, tags }) => ({
    lat: lat ?? center?.lat,
    lon: lon ?? center?.lon,
    type: tags.highway === 'trailhead' ? 'trailhead' : 'parking',
    name: tags.name || '',
    access: tags.access || '',
  })).filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon)),
};
writeFileSync(join(here, '../data-sources/osm-access.json.gz'), gzipSync(JSON.stringify(body), { level: 9 }));
const trailheads = body.places.filter(place => place.type === 'trailhead').length;
console.log(`${body.places.length} places: ${trailheads} trailheads, ${body.places.length - trailheads} parking`);
