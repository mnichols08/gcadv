// Asks USGS PAD-US (public domain) what land each public trail page in Garrett and Allegany crosses, and
// keeps only the land areas in land-rules.json. Run it again after a trail re-bake, then read the printed
// list by eye: tests can't catch a plausible but wrong match. The site never calls USGS itself.
import fs from 'node:fs';
import { loadLines, publishableRoutes } from './trail-pages.mjs';

const DATA = new URL('../apps/trails/public/data/', import.meta.url);
const readData = name => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));
const SERVICE = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Public_Access/FeatureServer/0/query';
const COUNTIES = new Set(['Garrett County, MD', 'Allegany County, MD']);
const SAMPLES = 24;
const AT_ONCE = 6;

// PAD-US names for each land area. Easement records are dropped below, even under a park's name, since an
// easement doesn't make land public.
const ALIASES = {
  'savage-river-state-forest': ['savage river sf', 'savage river state forest'],
  'potomac-garrett-state-forest': ['potomac sf', 'potomac state forest', 'garrett sf', 'garrett state forest'],
  'green-ridge-state-forest': ['green ridge sf', 'green ridge state forest'],
  'big-run-state-park': ['big run sp'],
  'casselman-river-bridge-state-park': ['casselman river bridge sp'],
  'deep-creek-lake-state-park': ['deep creek lake sp'],
  'herrington-manor-state-park': ['herrington manor sp'],
  'new-germany-state-park': ['new germany sp'],
  'sang-run-state-park': ['sang run state park'],
  'swallow-falls-state-park': ['swallow falls sp'],
  'wolf-den-run-state-park': ['wolf den run sp'],
  'dans-mountain-state-park': ['dans mountain state park'],
  'rocky-gap-state-park': ['rocky gap sp'],
  'wills-mountain-state-park': ['wills mountain state park'],
  'deep-creek-lake-natural-resources-management-area': ['deep creek lake nrma', 'deep creek lake natural resource management area'],
  'youghiogheny-wild-river-natural-environmental-area': ['youghiogheny wild river nea', 'youghiogheny wild river natural environment area', 'youghiogheny river natural environment area'],
  'mt-nebo-wildlife-management-area': ['mount nebo wildlife management area'],
  'cunningham-swamp-wildlife-management-area': ['cunningham swamp wma'],
  'belle-grove-wildlife-management-area': ['belle grove wma'],
  'billmeyer-wildlife-management-area': ['billmeyer wma', 'billmeyer wildlife management area'],
  'dans-mountain-wildlife-management-area': ['dans mountain wma'],
  'islands-of-the-potomac-wildlife-management-area': ['islands of the potomac wma'],
  'sideling-hill-wildlife-management-area': ['sideling hill wma'],
  'warrior-mountain-wildlife-management-area': ['warrior mountain wma', 'warrior mountain wildlife management area'],
  'north-branch-potomac-fishery-management-area': ['north branch potomac fma pfa', 'north branch potomac fish management area'],
  'evitts-creek-pond-fishery-management-area': ['evitts creek pond fma pfa'],
  'gary-a-yoder-fishery-management-area': ['gary a yoder fma pfa'],
  'chesapeake-and-ohio-canal-national-historical-park': ['chesapeake and ohio canal national historical park'],
  'jennings-randolph-lake': ['jennings randolph recreation area', 'jennings randolph lake'],
  'youghiogheny-river-lake': ['youghiogheny river lake'],
  'finzel-swamp-preserve': ['finzel swamp preserve'],
  'cranesville-swamp-preserve': ['cranesville swamp preserve', 'cranesville swamp fee'],
  'sideling-hill-creek-preserve': ['sideling hill creek preserve'],
  'selinger-marsh': ['selinger marsh preserve'],
  'caroline-w-wilson-sanctuary': ['caroline wilson sanctuary'],
};

// Matches the data can't make. Savage Highlands opened in 2026 and has no PAD-US record, but DNR's map runs
// these two trails through it. Every PAD-US "Great Allegheny Passage" record is in Pennsylvania, while the
// row covers Allegany County's stretch, so that one can't rest on a name match. Check again after a re-bake.
const HAND_KEPT = {
  'cabin-loop-trail': ['savage-highlands-state-park'],
  'mt-aetna-loop-trail': ['savage-highlands-state-park'],
  'great-allegheny-passage': ['great-allegheny-passage'],
};

// PAD-US lists a wildland as, for example, "SAVAGE RIVER SF - Middle Fork Wildland".
export function areaForName(name, category = 'Fee') {
  const lower = name.trim().toLowerCase();
  if (category === 'Easement' || lower.includes('easement')) return null;
  for (const [id, names] of Object.entries(ALIASES)) {
    if (names.some(alias => lower === alias || lower.startsWith(`${alias} - `))) return id;
  }
  return null;
}

export const withHandKept = (routeId, found) => [...new Set([...found, ...(HAND_KEPT[routeId] || [])])];

export const samplePoints = (points, count = SAMPLES) => (points.length <= count
  ? points
  : Array.from({ length: count }, (_, index) => points[Math.floor(index * (points.length - 1) / (count - 1))]));

// Any single hit counts, most-crossed land first. Naming land a trail only touches costs little, while
// missing a park with its own rules, like the end of Monroe Run in Big Run, could get a reader cited.
export function areasOnTrail(hitsByPoint) {
  const counts = new Map();
  for (const hits of hitsByPoint) for (const id of new Set(hits)) counts.set(id, (counts.get(id) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function namesAt({ lat, lon }) {
  const params = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'Unit_Nm,Category', returnGeometry: 'false', f: 'json' });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const body = await (await fetch(`${SERVICE}?${params}`, { signal: AbortSignal.timeout(30000) })).json();
      if (body.features) return body.features.map(({ attributes }) => ({ name: attributes.Unit_Nm || '', category: attributes.Category }));
      throw new Error(JSON.stringify(body).slice(0, 200));
    } catch (error) {
      if (attempt === 3) throw error; // Better no file than one quietly missing land.
    }
  }
}

async function bake() {
  const { routes } = readData('routes.json');
  const { areas } = readData('land-rules.json');
  const known = new Set(areas.map(area => area.id));
  for (const id of [...Object.keys(ALIASES), ...Object.values(HAND_KEPT).flat()]) if (!known.has(id)) throw new Error(`No land area named ${id}`);
  const shards = new Map();
  const local = publishableRoutes(routes).filter(route => (route.counties || [route.county]).some(county => COUNTIES.has(county)));
  const trails = {};
  const skipped = new Map();
  for (let start = 0; start < local.length; start += AT_ONCE) {
    await Promise.all(local.slice(start, start + AT_ONCE).map(async route => {
      const points = samplePoints(loadLines(route, shards).flatMap(line => line.points));
      if (!points.length) return;
      const records = await Promise.all(points.map(namesAt));
      for (const { name, category } of records.flat()) if (!areaForName(name, category)) skipped.set(`${name} [${category}]`, (skipped.get(`${name} [${category}]`) || 0) + 1);
      const found = withHandKept(route.id, areasOnTrail(records.map(list => list.map(({ name, category }) => areaForName(name, category)).filter(Boolean))));
      if (found.length) trails[route.id] = found;
      console.log(`${route.name} (${route.county}) -> ${found.join(', ') || 'none'}`);
    }));
  }
  const sorted = Object.fromEntries(Object.entries(trails).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(new URL('trail-land.json', DATA), `${JSON.stringify({ source: 'USGS PAD-US, public domain', trails: sorted }, null, 1)}\n`);
  console.log(`\n${Object.keys(sorted).length} of ${local.length} trails matched a land area.`);
  console.log('PAD-US names left out:', [...skipped].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} (${count})`).join('; '));
}

if (process.argv[1]?.endsWith('bake-trail-land.mjs')) await bake();
