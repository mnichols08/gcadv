// Captures National Forest System trails for the region, including what each one is open and
// closed to. Run rarely, then bake.
//
//   node apps/trails/scripts/capture-usfs.mjs
//
// USDA Forest Service data, published without access limits and with no warranty.
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USFS_FIELDS } from '../public/modules/activities.js';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERVICE = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query';
const REGION = { south: 38.75, west: -80.05, north: 40.35, east: -78.3 }; // Matches capture-trails.
const SUFFIXES = ['managed', 'accpt', 'accpt_disc', 'restricted'];
const outFields = ['trail_name', 'trail_no', 'admin_org', 'trail_surface', ...USFS_FIELDS.flatMap(({ field }) => SUFFIXES.map(suffix => `${field}_${suffix}`))].join(',');

const trails = [];
for (let offset = 0; ; offset += 1000) {
  const query = new URLSearchParams({
    where: '1=1',
    geometry: `${REGION.west},${REGION.south},${REGION.east},${REGION.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    orderByFields: 'objectid',
    resultOffset: String(offset),
    resultRecordCount: '1000',
    f: 'json',
  });
  const response = await fetch(`${SERVICE}?${query}`);
  if (!response.ok) throw new Error(`Forest Service ${response.status}`);
  const page = await response.json();
  if (page.error) throw new Error(JSON.stringify(page.error));
  trails.push(...page.features.map(({ attributes, geometry }) => ({ ...attributes, paths: geometry?.paths || [] })));
  if (!page.exceededTransferLimit) break;
}
writeFileSync(join(resolve(here, '../data-sources'), 'usfs-trails.json.gz'), gzipSync(JSON.stringify({
  source: { title: 'USDA Forest Service National Forest System Trails', service: SERVICE, capturedAt: new Date().toISOString().slice(0, 10), region: REGION, license: 'No access limits. No warranty; the Forest Service disclaims liability for errors and omissions.' },
  trails,
}), { level: 9 }));
console.log(`${trails.length} Forest Service trail records`);
