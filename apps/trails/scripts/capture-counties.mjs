// Captures the outlines of the counties the app covers, so trails can say where they are.
//
//   node apps/trails/scripts/capture-counties.mjs
//
// US Census TIGERweb, public domain.
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SERVICE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';
export const COUNTIES = {
  24023: { name: 'Garrett', state: 'MD' },
  24001: { name: 'Allegany', state: 'MD' },
  54093: { name: 'Tucker', state: 'WV' },
  54023: { name: 'Grant', state: 'WV' },
  54077: { name: 'Preston', state: 'WV' },
  54057: { name: 'Mineral', state: 'WV' },
  42111: { name: 'Somerset', state: 'PA' },
  42051: { name: 'Fayette', state: 'PA' },
  42009: { name: 'Bedford', state: 'PA' },
};

const query = new URLSearchParams({
  where: `GEOID IN (${Object.keys(COUNTIES).map(id => `'${id}'`).join(',')})`,
  outFields: 'GEOID,NAME',
  outSR: '4326',
  maxAllowableOffset: '0.002',
  geometryPrecision: '4',
  f: 'json',
});
const response = await fetch(`${SERVICE}?${query}`);
if (!response.ok) throw new Error(`TIGERweb ${response.status}`);
const { features, error } = await response.json();
if (error) throw new Error(JSON.stringify(error));
const counties = features.map(({ attributes, geometry }) => ({ id: attributes.GEOID, ...COUNTIES[attributes.GEOID], rings: geometry.rings }));
if (counties.length !== Object.keys(COUNTIES).length) throw new Error(`Expected ${Object.keys(COUNTIES).length} counties, got ${counties.length}`);
writeFileSync(join(here, '../data-sources/counties.json.gz'), gzipSync(JSON.stringify({
  source: { title: 'US Census TIGERweb', service: SERVICE, capturedAt: new Date().toISOString().slice(0, 10), license: 'Public domain' },
  counties,
}), { level: 9 }));
console.log(counties.map(county => `${county.name} ${county.state}`).join(', '));
