// Bakes the repo's USGS research captures into small files a phone can hold offline.
//
//   node apps/trails/scripts/bake-data.mjs --samples <dir holding the 2026-11-05 captures>
//
// The 2026-11-05 GNIS and neighbor-flowline captures live in the website checkout and are
// not committed yet, so their folder is an argument. Output is derived, so it is safe to
// regenerate; the app never reads the captures directly.
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simplifyLine } from '../public/modules/geo.js';
import { encodeLine, SHARD_DEGREES, shardKey } from '../public/modules/landscape.js';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const root = resolve(here, '../../..');
const flag = process.argv.indexOf('--samples');
const samples = flag > 0 ? resolve(process.argv[flag + 1]) : join(root, 'docs/river/samples');
const networkDir = join(root, 'river-core/data/potomac-network');
const out = resolve(here, '../public/data');
const SIMPLIFY_DEGREES = 0.0001; // Matches the network's overview LOD, about 30 ft on the ground.

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const readGz = path => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));

const reaches = new Map();
for (const file of readdirSync(networkDir).filter(name => name.startsWith('overview-'))) {
  for (const { properties: p, geometry } of readGz(join(networkDir, file)).features) {
    reaches.set(p.hydrosequence, { hs: p.hydrosequence, dn: p.dnhydrosequence, order: p.streamorder, name: p.gnisidlabel || '', coords: geometry.coordinates });
  }
}
const potomacCount = reaches.size;
for (const reach of readGz(join(samples, '2026-11-05-neighbor-flowlines.json.gz')).reaches) {
  if (!reaches.has(reach.hs)) reaches.set(reach.hs, { ...reach, name: reach.name || '', coords: simplifyLine(reach.coords, SIMPLIFY_DEGREES) });
}
console.log(`reaches: ${potomacCount} Potomac + ${reaches.size - potomacCount} neighbors`);

// Point every line downstream, and give every reach the name of the water it reaches next.
const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
let flipped = 0;
for (const reach of reaches.values()) {
  const next = reaches.get(reach.dn);
  if (!next) continue;
  const head = next.coords[0];
  const tail = next.coords.at(-1);
  const toFirst = Math.min(near(reach.coords[0], head), near(reach.coords[0], tail));
  const toLast = Math.min(near(reach.coords.at(-1), head), near(reach.coords.at(-1), tail));
  if (toFirst < toLast) {
    reach.coords = [...reach.coords].reverse();
    flipped += 1;
  }
}
console.log(`reversed ${flipped} lines so they run downstream`);

function intoName(reach) {
  let step = reaches.get(reach.dn);
  for (let guard = 0; step && guard < 4000; guard += 1) {
    if (step.name && step.name !== reach.name) return step.name;
    step = reaches.get(step.dn);
  }
  return '';
}

const shards = new Map();
for (const reach of reaches.values()) {
  const entry = encodeLine({ name: reach.name, into: intoName(reach), order: reach.order, coords: reach.coords });
  const keys = new Set(reach.coords.map(([lon, lat]) => shardKey(lat, lon)));
  for (const key of keys) {
    if (!shards.has(key)) shards.set(key, []);
    shards.get(key).push(entry);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'streams'), { recursive: true });
let streamBytes = 0;
for (const [key, lines] of shards) {
  const body = JSON.stringify({ lines });
  streamBytes += body.length;
  writeFileSync(join(out, 'streams', `${key}.json`), body);
}

const gnis = readJson(join(samples, '2026-11-05-potomac-gnis-places.json'));
// A town that no longer exists is no help when telling someone where you are.
const places = gnis.places.filter(({ name }) => !/(historical)/i.test(name)).map(({ name, state, lat, lon }) => [name, state, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
const placesBody = JSON.stringify({ places });
writeFileSync(join(out, 'places.json'), placesBody);

writeFileSync(join(out, 'index.json'), JSON.stringify({
  shardDegrees: SHARD_DEGREES,
  shards: [...shards.keys()].sort(),
  sources: {
    streams: 'USGS 3D Hydrography Program flowlines, captured 2026-10-28 and 2026-11-05',
    places: 'USGS Geographic Names Information System populated places, captured 2026-11-05',
  },
}));
console.log(`${shards.size} stream shards, ${(streamBytes / 1048576).toFixed(1)} MB raw; ${places.length} places, ${(placesBody.length / 1024).toFixed(0)} KB raw`);
