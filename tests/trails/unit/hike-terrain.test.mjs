import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { project, TILE_SIZE } from '../../../apps/trails/public/modules/geo.js';
import { planArea } from '../../../apps/trails/public/modules/offline.js';
import { BLOCK_SAMPLES, blockKey, blocksForBounds, buildMesh, cameraEye, CAMERA_LIMITS, clampCamera, defaultCamera, groundFeet, hasTerrainAt, HEIGHT_SCALE, lookAt, multiply, needsNewWindow, perspective, stitchWindow, TERRAIN_ZOOM, TILES_PER_BLOCK, toWorld, viewWindow, VIEW_SAMPLES, windowBlocks } from '../../../apps/trails/public/modules/terrain.js';

const app = path => new URL(`../../../apps/trails/public/${path}`, import.meta.url);
const flatBlock = feet => new Int16Array(BLOCK_SAMPLES * BLOCK_SAMPLES).fill(feet);
const HERE = { lat: 39.2809, lon: -79.3409 }; // Gormania.
const gridOf = fill => stitchWindow(viewWindow(HERE.lat, HERE.lon), fill);

function transform(matrix, [x, y, z]) {
  const out = [0, 1, 2, 3].map(row => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
  return out.map(value => value / out[3]);
}

test('the view window keeps the point well inside it', () => {
  for (const [lat, lon] of [[39.2809, -79.3409], [39.5, -79.42], [39.07, -79.57], [38.98, -79.65]]) {
    const grid = stitchWindow(viewWindow(lat, lon), () => flatBlock(1000));
    assert.equal(needsNewWindow(grid, lat, lon, 0.2), false, `${lat},${lon}`);
  }
});

test('a window is four neighboring blocks', () => {
  assert.deepEqual(windowBlocks({ col: 5, row: 9 }).map(blockKey), ['5_9', '6_9', '5_10', '6_10']);
});

test('stitching keeps each block in its place and joins them without a seam', () => {
  const grid = gridOf(({ col, row }) => flatBlock((col % 2) * 1000 + (row % 2) * 100 + 500));
  const { col, row } = grid.window;
  const value = (x, y) => grid.heights[y * VIEW_SAMPLES + x];
  assert.equal(value(0, 0), (col % 2) * 1000 + (row % 2) * 100 + 500);
  assert.equal(value(VIEW_SAMPLES - 1, 0), ((col + 1) % 2) * 1000 + (row % 2) * 100 + 500);
  assert.equal(value(0, VIEW_SAMPLES - 1), (col % 2) * 1000 + ((row + 1) % 2) * 100 + 500);
});

test('a block outside the capture drops to the lowest ground, and none at all gives nothing', () => {
  const window3d = viewWindow(HERE.lat, HERE.lon);
  const grid = stitchWindow(window3d, block => (block.col === window3d.col && block.row === window3d.row ? flatBlock(2000) : null));
  assert.equal(grid.heights[0], 2000);
  assert.equal(grid.heights[VIEW_SAMPLES * VIEW_SAMPLES - 1], 2000);
  assert.equal(stitchWindow(window3d, () => null), null);
});

test('ground lookups line up with where a place falls on the grid', () => {
  // A surface rising steadily east, so a wrong position gives a wrong height.
  const grid = gridOf(() => flatBlock(0));
  for (let y = 0; y < VIEW_SAMPLES; y += 1) for (let x = 0; x < VIEW_SAMPLES; x += 1) grid.heights[y * VIEW_SAMPLES + x] = x * 10;
  const { x, z } = toWorld(grid, grid.center.lat, grid.center.lon);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6);
  assert.equal(groundFeet(grid, 0, 0), ((VIEW_SAMPLES - 1) / 2) * 10);
  const extent = grid.span * grid.feetPerTile;
  assert.equal(groundFeet(grid, -extent / 2, 0), 0);
  assert.equal(groundFeet(grid, extent, 0), null);
  // Six z13 tiles at this latitude is about 14 miles.
  assert.ok(Math.abs(extent / 5280 - 14) < 1);
});

test('map texture coordinates agree with world positions', () => {
  const grid = gridOf(() => flatBlock(1000));
  const { vertices } = buildMesh({ ...grid });
  const extent = grid.span * grid.feetPerTile;
  // The vertex at the far southeast corner should sit at texture (1, 1).
  const last = vertices.length - 6;
  assert.ok(Math.abs(vertices[last] - extent / 2) < 1);
  assert.ok(Math.abs(vertices[last + 2] - extent / 2) < 1);
  assert.equal(vertices[last + 3], 1);
  assert.equal(vertices[last + 4], 1);
  assert.equal(vertices[1], 1000 * HEIGHT_SCALE);
});

test('relief shading lights slopes facing the northwest sun', () => {
  const grid = gridOf(() => flatBlock(0));
  // A ridge running north-south down the middle.
  for (let y = 0; y < VIEW_SAMPLES; y += 1) {
    for (let x = 0; x < VIEW_SAMPLES; x += 1) grid.heights[y * VIEW_SAMPLES + x] = 3000 - Math.abs(x - 128) * 30;
  }
  const { vertices } = buildMesh(grid);
  const shadeAt = x => vertices[(128 * VIEW_SAMPLES + x) * 6 + 5];
  assert.ok(shadeAt(60) > shadeAt(200), 'the west slope should be brighter than the east');
});

test('triangles face up so the terrain is not culled', () => {
  const grid = gridOf(() => flatBlock(1000));
  const { vertices, indices } = buildMesh(grid);
  const point = index => [vertices[index * 6], vertices[index * 6 + 1], vertices[index * 6 + 2]];
  const [a, b, c] = [point(indices[0]), point(indices[1]), point(indices[2])];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  assert.ok(u[2] * v[0] - u[0] * v[2] > 0);
});

test('camera: limits hold and headings wrap', () => {
  const camera = clampCamera({ heading: -10, tilt: 200, distance: 1 });
  assert.equal(camera.heading, 350);
  assert.equal(camera.tilt, CAMERA_LIMITS.maxTilt);
  assert.equal(camera.distance, CAMERA_LIMITS.minDistance);
});

test('camera: facing north puts the eye to the south, and never under the ground', () => {
  const target = { x: 0, y: 3000, z: 0 };
  const eye = cameraEye({ heading: 0, tilt: 30, distance: 10000 }, target, () => 0);
  assert.ok(Math.abs(eye.x) < 1e-6);
  assert.ok(eye.z > 8000);
  assert.ok(Math.abs(eye.y - 8000) < 1);
  const blocked = cameraEye({ heading: 0, tilt: 12, distance: 10000 }, target, () => 5000);
  assert.ok(blocked.y > 5000 * HEIGHT_SCALE);
});

test('camera: the focus lands at the screen center, with north ahead and up on top', () => {
  const target = { x: 500, y: 3000, z: -200 };
  const eye = cameraEye(defaultCamera(), target, () => null);
  const matrix = multiply(perspective(50, 0.6, 100, 100000), lookAt(eye, target));
  const middle = transform(matrix, [target.x, target.y, target.z]);
  assert.ok(Math.abs(middle[0]) < 1e-3 && Math.abs(middle[1]) < 1e-3);
  // Farther north sits higher on screen, and east sits to the right.
  assert.ok(transform(matrix, [target.x, target.y, target.z - 1000])[1] > 0);
  assert.ok(transform(matrix, [target.x + 1000, target.y, target.z])[0] > 0);
  assert.ok(transform(matrix, [target.x, target.y + 1000, target.z])[1] > 0);
});

test('saving an area keeps its terrain blocks', () => {
  const bounds = { south: 39.27, north: 39.29, west: -79.35, east: -79.33 };
  const keys = blocksForBounds(bounds).map(blockKey);
  const plan = planArea(bounds, [], [], keys);
  assert.deepEqual(plan.terrainBlocks, keys);
  assert.deepEqual(planArea(bounds).terrainBlocks, []);
  assert.deepEqual(planArea({ south: 20, north: 50, west: -125, east: -70 }, [], [], keys).terrainBlocks, []);
});

const gridIndex = JSON.parse(readFileSync(app('data/index.json'), 'utf8')).terrainBlocks;

test('baked terrain: covers the home hikes and every block is complete', () => {
  for (const [lat, lon] of [[39.2809, -79.3409], [39.5, -79.42], [39.1124, -79.4997], [39.0636, -79.3031], [38.98, -79.65]]) {
    assert.ok(hasTerrainAt(lat, lon, gridIndex), `${lat},${lon}`);
  }
  assert.equal(hasTerrainAt(38.2, -77, gridIndex), false);
  for (const key of gridIndex) {
    assert.ok(existsSync(app(`data/terrain/${key}.bin`)), key);
  }
  assert.equal(readFileSync(app(`data/terrain/${gridIndex[0]}.bin`)).length, BLOCK_SAMPLES * BLOCK_SAMPLES * 2);
});

test('baked terrain: a known place reads the right ground and lines up with its tile', () => {
  // Bear Rocks, on the Allegheny Front, is around 4,000 ft. Gormania's valley is far lower.
  const read = (lat, lon) => {
    const { x, y } = project(lat, lon, TERRAIN_ZOOM);
    const blockSpan = TILES_PER_BLOCK * TILE_SIZE;
    const key = `${Math.floor(x / blockSpan)}_${Math.floor(y / blockSpan)}`;
    const file = readFileSync(app(`data/terrain/${key}.bin`));
    const heights = new Int16Array(file.buffer, file.byteOffset, file.length / 2);
    const column = Math.round(((x % blockSpan) / blockSpan) * (BLOCK_SAMPLES - 1));
    const row = Math.round(((y % blockSpan) / blockSpan) * (BLOCK_SAMPLES - 1));
    return heights[row * BLOCK_SAMPLES + column];
  };
  const bearRocks = read(39.0636, -79.3031);
  const gormania = read(39.2809, -79.3409);
  assert.ok(bearRocks > 3700 && bearRocks < 4300, `Bear Rocks read ${bearRocks} ft`);
  assert.ok(gormania > 2000 && gormania < 2800, `Gormania read ${gormania} ft`);
});
