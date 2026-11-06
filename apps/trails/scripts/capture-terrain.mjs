// Captures USGS 3DEP ground elevation for the 3D view, one block at a time.
//
//   node apps/trails/scripts/capture-terrain.mjs
//
// Each block is three z13 map tiles square, about 7 miles: 257 by 257 little-endian int16 whole
// feet, north to south, aligned to the Web Mercator tiles so the topo map lines up with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BLOCK_SAMPLES, blocksForBounds, blockKey, TILES_PER_BLOCK, TERRAIN_ZOOM } from '../public/modules/terrain.js';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const data = resolve(here, '../public/data');
const out = join(data, 'terrain');
const REGION = { south: 38.75, west: -80.05, north: 40.35, east: -78.3 }; // Matches capture-trails.
const EXPORT = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const MERCATOR_EDGE = 20037508.342789244;
const WORKERS = 3;

function blockBox({ col, row }) {
  const span = 2 ** TERRAIN_ZOOM;
  const x = tile => (tile / span) * 2 * MERCATOR_EDGE - MERCATOR_EDGE;
  const y = tile => MERCATOR_EDGE - (tile / span) * 2 * MERCATOR_EDGE;
  return [x(col * TILES_PER_BLOCK), y((row + 1) * TILES_PER_BLOCK), x((col + 1) * TILES_PER_BLOCK), y(row * TILES_PER_BLOCK)];
}

// An uncompressed little-endian 32-bit float TIFF, the form this service sends.
function readFloatTiff(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42) throw new Error('Not a little-endian TIFF');
  const start = view.getUint32(4, true);
  const entries = new Map();
  for (let index = 0; index < view.getUint16(start, true); index += 1) {
    const at = start + 2 + index * 12;
    const type = view.getUint16(at + 2, true);
    const count = view.getUint32(at + 4, true);
    const size = type === 3 ? 2 : 4;
    const from = count * size <= 4 ? at + 8 : view.getUint32(at + 8, true);
    entries.set(view.getUint16(at, true), Array.from({ length: count }, (_, item) => (type === 3 ? view.getUint16(from + item * 2, true) : view.getUint32(from + item * 4, true))));
  }
  const tag = id => entries.get(id)?.[0];
  if (tag(259) !== 1 || tag(258) !== 32 || tag(339) !== 3 || tag(277) !== 1) throw new Error('Unexpected TIFF layout');
  const width = tag(256);
  const height = tag(257);
  const tiled = entries.has(324);
  const pieceWidth = tiled ? tag(322) : width;
  const pieceHeight = tiled ? tag(323) : (tag(278) || height);
  const across = Math.ceil(width / pieceWidth);
  const values = new Float32Array(width * height);
  entries.get(tiled ? 324 : 273).forEach((offset, piece) => {
    const left = (piece % across) * pieceWidth;
    const top = Math.floor(piece / across) * pieceHeight;
    for (let row = 0; row < pieceHeight && top + row < height; row += 1) {
      for (let column = 0; column < pieceWidth && left + column < width; column += 1) {
        values[(top + row) * width + left + column] = view.getFloat32(offset + (row * pieceWidth + column) * 4, true);
      }
    }
  });
  return { width, height, values };
}

async function capture(block, attempt = 0) {
  const query = new URLSearchParams({ bbox: blockBox(block).join(','), bboxSR: '3857', imageSR: '3857', size: `${BLOCK_SAMPLES},${BLOCK_SAMPLES}`, format: 'tiff', pixelType: 'F32', compression: 'None', interpolation: 'RSP_BilinearInterpolation', f: 'image' });
  try {
    const response = await fetch(`${EXPORT}?${query}`);
    if (!response.ok) throw new Error(String(response.status));
    const { width, height, values } = readFloatTiff(await response.arrayBuffer());
    if (width !== BLOCK_SAMPLES || height !== BLOCK_SAMPLES) throw new Error(`size ${width}x${height}`);
    return Int16Array.from(values, meters => {
      if (!Number.isFinite(meters) || meters < -100 || meters > 3000) throw new Error(`bad sample ${meters}`);
      return Math.round(meters * 3.28084);
    });
  } catch (error) {
    if (attempt >= 4) throw error;
    await new Promise(wake => setTimeout(wake, 2000 * 2 ** attempt));
    return capture(block, attempt + 1);
  }
}

mkdirSync(out, { recursive: true });
const blocks = blocksForBounds(REGION);
let next = 0;
let low = Infinity;
let high = -Infinity;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < blocks.length) {
    const block = blocks[next];
    next += 1;
    const path = join(out, `${blockKey(block)}.bin`);
    if (existsSync(path)) continue;
    const feet = await capture(block);
    for (const value of feet) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    writeFileSync(path, Buffer.from(feet.buffer));
  }
}));

// Other bakes rewrite this file too, so read it as late as possible.
const indexPath = join(data, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
index.terrainBlocks = blocks.map(blockKey).sort();
index.sources.terrain = 'USGS 3DEP elevation, captured 2026-11-05';
writeFileSync(indexPath, JSON.stringify(index));
console.log(`${blocks.length} blocks; elevations ${low} to ${high} ft`);
