// Saves a map area ahead of time. Keep these cache names in step with ../sw.js.
import { countTiles, tilesForBounds } from './geo.js';
import { shardsForBounds } from './landscape.js';
import { blockKey, blocksForBounds, BLOCK_SAMPLES } from './terrain.js';

export const SAVED_CACHE = 'hike-saved-v1';
export const TILE_HOST = 'https://basemap.nationalmap.gov';
export const TILE_MAX_ZOOM = 16;
export const MAX_SAVE_TILES = 4000;
const SAVE_MIN_ZOOM = 10;
const AVERAGE_TILE_KB = 25; // Sampled from USGS Topo tiles in western Maryland.

export const tileUrl = ({ z, x, y }) => `${TILE_HOST}/arcgis/rest/services/USGSTopo/MapServer/tile/${z}/${y}/${x}`;

// Everything from a regional overview down to the most detailed tile USGS Topo draws.
export function planArea(bounds, shardIndex = [], trailIndex = [], terrainIndex = []) {
  // Count before listing: a zoomed-out view would be millions of tiles.
  let tileCount = 0;
  for (let zoom = SAVE_MIN_ZOOM; zoom <= TILE_MAX_ZOOM; zoom += 1) tileCount += countTiles(bounds, zoom);
  const tooLarge = tileCount > MAX_SAVE_TILES;
  const tiles = [];
  if (!tooLarge) {
    for (let zoom = SAVE_MIN_ZOOM; zoom <= TILE_MAX_ZOOM; zoom += 1) tiles.push(...tilesForBounds(bounds, zoom));
  }
  const covered = shardsForBounds(bounds);
  const known = new Set(shardIndex);
  const shards = covered.filter(key => known.has(key));
  const knownTrails = new Set(trailIndex);
  const trailShards = covered.filter(key => knownTrails.has(key));
  const knownBlocks = new Set(terrainIndex);
  // Skipped for a huge view, which is refused anyway and could span thousands of blocks.
  const terrainBlocks = tooLarge ? [] : blocksForBounds(bounds).map(blockKey).filter(key => knownBlocks.has(key));
  return {
    bounds,
    tiles,
    shards,
    trailShards,
    terrainBlocks,
    tileCount,
    megabytes: (tileCount * AVERAGE_TILE_KB) / 1024 + (terrainBlocks.length * BLOCK_SAMPLES * BLOCK_SAMPLES * 2) / 1048576,
    tooLarge,
  };
}

export async function saveArea(plan, onProgress, signal) {
  const cache = await caches.open(SAVED_CACHE);
  const dataFile = (folder, key, type = 'json') => new URL(`../data/${folder}/${key}.${type}`, import.meta.url).href;
  const urls = [
    ...plan.shards.map(key => dataFile('streams', key)),
    ...plan.trailShards.map(key => dataFile('trails', key)),
    ...plan.terrainBlocks.map(key => dataFile('terrain', key, 'bin')),
    ...plan.tiles.map(tileUrl),
  ];
  let finished = 0;
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < urls.length && !signal?.aborted) {
      const url = urls[next];
      next += 1;
      try {
        if (!(await cache.match(url, { ignoreVary: true }))) {
          const response = await fetch(url, { mode: 'cors', signal });
          if (!response.ok) throw new Error(String(response.status));
          await cache.put(url, response);
        }
      } catch {
        failed += 1;
      }
      finished += 1;
      onProgress?.({ finished, failed, total: urls.length });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return { finished, failed, total: urls.length };
}

export const clearSaved = () => caches.delete(SAVED_CACHE);
