// Captures trail snapshots for the home region. Run rarely, then bake from the snapshots.
//
//   node apps/trails/scripts/capture-trails.mjs
//
// USGS National Digital Trails are public domain. OpenStreetMap data is (c) OpenStreetMap
// contributors under the Open Database License, so its snapshot keeps its own file.
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = resolve(here, '../data-sources');
const capturedAt = new Date().toISOString().slice(0, 10);

// Garrett and Allegany MD; Tucker, Grant, Preston and Mineral WV; Somerset, Fayette and Bedford PA.
export const REGION = { south: 38.75, west: -80.05, north: 40.35, east: -78.3 };
const USGS = 'https://cartowfs.nationalmap.gov/arcgis/rest/services/transportation/MapServer/8/query';
const OVERPASS_SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const AGENT = 'garrett-county-adventures-capture/0.2 (https://garrettcountyadventures.com)';

async function captureUsgs() {
  const features = [];
  for (let offset = 0; ; offset += 2000) {
    const query = new URLSearchParams({
      geometry: `${REGION.west},${REGION.south},${REGION.east},${REGION.north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      where: '1=1',
      outFields: 'name,trailtype,hikerpedestrian,bicycle,packsaddle,motorcycle,ohvover50inches,ohvisorunder50inches,osvm,crosscountryski,snowshoe,primarytrailmaintainer,sourceoriginator,lengthmiles,nationaltraildesignation,ebike,pets,seasonopen,trailsurface,dogsled',
      orderByFields: 'objectid',
      resultOffset: String(offset),
      resultRecordCount: '2000',
      f: 'json',
    });
    const response = await fetch(`${USGS}?${query}`, { headers: { 'User-Agent': AGENT } });
    if (!response.ok) throw new Error(`USGS ${response.status}`);
    const page = await response.json();
    if (page.error) throw new Error(JSON.stringify(page.error));
    features.push(...page.features);
    if (!page.exceededTransferLimit) break;
  }
  return {
    source: { title: 'USGS National Digital Trails', service: USGS, capturedAt, region: REGION, license: 'Public domain; credit USGS The National Map' },
    trails: features.map(({ attributes, geometry }) => ({ ...attributes, paths: geometry?.paths || [] })),
  };
}

async function captureOsm() {
  const box = `${REGION.south},${REGION.west},${REGION.north},${REGION.east}`;
  const query = `[out:json][timeout:290];
(
  way["highway"~"^(path|footway|track|bridleway|cycleway|steps)$"]["footway"!~"^(sidewalk|crossing)$"](${box});
  way["piste:type"](${box});
  way["ski:nordic"](${box});
  way["snowmobile"~"^(yes|designated|permissive)$"](${box});
  way["atv"~"^(yes|designated|permissive)$"](${box});
  way["ohv"~"^(yes|designated|permissive)$"](${box});
  relation["route"~"^(hiking|foot|mtb|bicycle|horse|piste|ski|snowmobile|atv|ohv)$"](${box});
  node["highway"="trailhead"](${box});
  node["natural"~"^(waterfall|peak)$"]["name"](${box});
  node["waterway"="waterfall"]["name"](${box});
  node["tourism"="viewpoint"]["name"](${box});
);
out tags geom;`;
  let body = null;
  let service = null;
  for (const server of OVERPASS_SERVERS) {
    const response = await fetch(server, {
      method: 'POST',
      headers: { 'User-Agent': AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) {
      console.log(`${server}: ${response.status}`);
      continue;
    }
    body = await response.json();
    // A query that ran out of time still answers 200, with a partial result and a remark.
    if (body.remark) throw new Error(`Overpass stopped early: ${body.remark}`);
    service = server;
    break;
  }
  if (!body) throw new Error('No Overpass server answered');
  const { elements, osm3s } = body;
  return {
    source: { title: 'OpenStreetMap via Overpass API', service, capturedAt, region: REGION, osmBase: osm3s?.timestamp_osm_base, license: 'Open Database License (ODbL) 1.0; (c) OpenStreetMap contributors, https://www.openstreetmap.org/copyright' },
    elements,
  };
}

const save = (name, data) => {
  const body = gzipSync(JSON.stringify(data), { level: 9 });
  writeFileSync(join(out, name), body);
  console.log(`${name}: ${(body.length / 1048576).toFixed(2)} MB`);
};

mkdirSync(out, { recursive: true });
const usgs = await captureUsgs();
console.log(`USGS trails: ${usgs.trails.length}`);
save('usgs-trails.json.gz', usgs);
const osm = await captureOsm();
console.log(`OSM elements: ${osm.elements.length}`);
save('osm-trails.json.gz', osm);
