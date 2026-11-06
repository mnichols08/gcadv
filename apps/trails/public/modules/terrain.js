// Terrain and camera math for the 3D view. No WebGL here, so all of it can be tested directly.
// World space is in feet around the terrain's center: x east, y up, z south.
import { feetPerPixel, project, TILE_SIZE, unproject } from './geo.js';

export const TERRAIN_ZOOM = 13;
export const TILES_PER_BLOCK = 3;
export const BLOCK_SAMPLES = 257;
export const VIEW_SAMPLES = 257; // 2 by 2 blocks thinned to this, about 290 ft apart.
export const HEIGHT_SCALE = 1.5; // Mountains read flat on a phone, and the page says it's exaggerated.
const BLOCKS_ACROSS = 2;
const SPAN_TILES = BLOCKS_ACROSS * TILES_PER_BLOCK;

export const blockKey = ({ col, row }) => `${col}_${row}`;

function blockPosition(lat, lon) {
  const { x, y } = project(lat, lon, TERRAIN_ZOOM);
  return { col: x / TILE_SIZE / TILES_PER_BLOCK, row: y / TILE_SIZE / TILES_PER_BLOCK };
}

export function blocksForBounds({ south, west, north, east }) {
  const a = blockPosition(north, west);
  const b = blockPosition(south, east);
  const blocks = [];
  for (let row = Math.floor(a.row); row <= Math.floor(b.row); row += 1) {
    for (let col = Math.floor(a.col); col <= Math.floor(b.col); col += 1) blocks.push({ col, row });
  }
  return blocks;
}

// The block holding a point and the sample closest to it.
export function blockAt(lat, lon) {
  const position = blockPosition(lat, lon);
  const col = Math.floor(position.col);
  const row = Math.floor(position.row);
  return {
    key: blockKey({ col, row }),
    column: Math.round((position.col - col) * (BLOCK_SAMPLES - 1)),
    row: Math.round((position.row - row) * (BLOCK_SAMPLES - 1)),
  };
}

// The four blocks whose shared corner is closest, so the center stays well inside the view.
export function viewWindow(lat, lon) {
  const { col, row } = blockPosition(lat, lon);
  return { col: Math.round(col) - 1, row: Math.round(row) - 1 };
}

export const windowBlocks = ({ col, row }) => [
  { col, row }, { col: col + 1, row }, { col, row: row + 1 }, { col: col + 1, row: row + 1 },
];

export function hasTerrainAt(lat, lon, index) {
  const { col, row } = blockPosition(lat, lon);
  return index.includes(blockKey({ col: Math.floor(col), row: Math.floor(row) }));
}

// Joins four blocks and thins them. A block outside the captured region drops to the lowest
// known ground, which reads as the edge of the data rather than as a false landscape.
export function stitchWindow(window, blockFor) {
  const parts = windowBlocks(window).map(blockFor);
  let lowest = Infinity;
  for (const part of parts) {
    if (!part) continue;
    for (const value of part) lowest = Math.min(lowest, value);
  }
  if (!Number.isFinite(lowest)) return null;
  const step = (BLOCK_SAMPLES - 1) * BLOCKS_ACROSS / (VIEW_SAMPLES - 1);
  const heights = new Float32Array(VIEW_SAMPLES * VIEW_SAMPLES);
  for (let y = 0; y < VIEW_SAMPLES; y += 1) {
    for (let x = 0; x < VIEW_SAMPLES; x += 1) {
      const sourceX = x * step;
      const sourceY = y * step;
      const blockX = Math.min(BLOCKS_ACROSS - 1, Math.floor(sourceX / (BLOCK_SAMPLES - 1)));
      const blockY = Math.min(BLOCKS_ACROSS - 1, Math.floor(sourceY / (BLOCK_SAMPLES - 1)));
      const part = parts[blockY * BLOCKS_ACROSS + blockX];
      const inX = sourceX - blockX * (BLOCK_SAMPLES - 1);
      const inY = sourceY - blockY * (BLOCK_SAMPLES - 1);
      heights[y * VIEW_SAMPLES + x] = part ? part[inY * BLOCK_SAMPLES + inX] : lowest;
    }
  }
  const leftTile = window.col * TILES_PER_BLOCK;
  const topTile = window.row * TILES_PER_BLOCK;
  const middle = unproject((leftTile + SPAN_TILES / 2) * TILE_SIZE, (topTile + SPAN_TILES / 2) * TILE_SIZE, TERRAIN_ZOOM);
  return { heights, size: VIEW_SAMPLES, leftTile, topTile, span: SPAN_TILES, center: middle, feetPerTile: feetPerPixel(middle.lat, TERRAIN_ZOOM) * TILE_SIZE, window };
}

export function toWorld(grid, lat, lon) {
  const { x, y } = project(lat, lon, TERRAIN_ZOOM);
  return {
    x: (x / TILE_SIZE - grid.leftTile - grid.span / 2) * grid.feetPerTile,
    z: (y / TILE_SIZE - grid.topTile - grid.span / 2) * grid.feetPerTile,
  };
}

// Ground feet at a world position, smoothly between samples; null off the edge.
export function groundFeet(grid, x, z) {
  const extent = grid.span * grid.feetPerTile;
  const u = (x / extent + 0.5) * (grid.size - 1);
  const v = (z / extent + 0.5) * (grid.size - 1);
  if (u < 0 || v < 0 || u > grid.size - 1 || v > grid.size - 1) return null;
  const left = Math.min(grid.size - 2, Math.floor(u));
  const top = Math.min(grid.size - 2, Math.floor(v));
  const fx = u - left;
  const fy = v - top;
  const at = (column, row) => grid.heights[row * grid.size + column];
  return at(left, top) * (1 - fx) * (1 - fy) + at(left + 1, top) * fx * (1 - fy) + at(left, top + 1) * (1 - fx) * fy + at(left + 1, top + 1) * fx * fy;
}

// True when the point has walked close enough to the edge that the view should move on.
export function needsNewWindow(grid, lat, lon, margin = 0.15) {
  const { x, y } = project(lat, lon, TERRAIN_ZOOM);
  const u = (x / TILE_SIZE - grid.leftTile) / grid.span;
  const v = (y / TILE_SIZE - grid.topTile) / grid.span;
  return u < margin || v < margin || u > 1 - margin || v > 1 - margin;
}

// x, y, z, u, v, shade for each sample, plus triangles. Shade comes from a low northwest sun,
// the convention on shaded relief maps, so ridges read correctly.
export function buildMesh(grid) {
  const { size, heights, span, feetPerTile } = grid;
  const extent = span * feetPerTile;
  const spacing = extent / (size - 1);
  const vertices = new Float32Array(size * size * 6);
  const sun = normalize([-0.5, 0.75, -0.5]);
  const sample = (column, row) => heights[Math.max(0, Math.min(size - 1, row)) * size + Math.max(0, Math.min(size - 1, column))] * HEIGHT_SCALE;
  let at = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const normal = normalize([sample(column - 1, row) - sample(column + 1, row), 2 * spacing, sample(column, row - 1) - sample(column, row + 1)]);
      vertices[at] = (column / (size - 1) - 0.5) * extent;
      vertices[at + 1] = sample(column, row);
      vertices[at + 2] = (row / (size - 1) - 0.5) * extent;
      vertices[at + 3] = column / (size - 1);
      vertices[at + 4] = row / (size - 1);
      vertices[at + 5] = Math.max(0, normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2]);
      at += 6;
    }
  }
  const indices = new Uint32Array((size - 1) * (size - 1) * 6);
  at = 0;
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const corner = row * size + column;
      indices.set([corner, corner + size, corner + 1, corner + 1, corner + size, corner + size + 1], at);
      at += 6;
    }
  }
  return { vertices, indices };
}

function normalize([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export const CAMERA_LIMITS = { minDistance: 1500, maxDistance: 60000, minTilt: 12, maxTilt: 85 };
const CLEARANCE_FEET = 250;

export const defaultCamera = () => ({ heading: 0, tilt: 35, distance: 9000 });

export function clampCamera({ heading, tilt, distance }) {
  return {
    heading: ((heading % 360) + 360) % 360,
    tilt: Math.max(CAMERA_LIMITS.minTilt, Math.min(CAMERA_LIMITS.maxTilt, tilt)),
    distance: Math.max(CAMERA_LIMITS.minDistance, Math.min(CAMERA_LIMITS.maxDistance, distance)),
  };
}

// Heading is the way the camera faces, 0 for north. The eye never goes below the ground.
export function cameraEye(camera, target, groundAt) {
  const heading = (camera.heading * Math.PI) / 180;
  const tilt = (camera.tilt * Math.PI) / 180;
  const across = camera.distance * Math.cos(tilt);
  const x = target.x - Math.sin(heading) * across;
  const z = target.z + Math.cos(heading) * across;
  let y = target.y + camera.distance * Math.sin(tilt);
  const ground = groundAt(x, z);
  if (ground !== null) y = Math.max(y, ground * HEIGHT_SCALE + CLEARANCE_FEET);
  return { x, y, z };
}

export function perspective(fovDegrees, aspect, near, far) {
  const f = 1 / Math.tan((fovDegrees * Math.PI) / 360);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
}

export function lookAt(eye, target) {
  const f = normalize([target.x - eye.x, target.y - eye.y, target.z - eye.z]);
  const s = normalize([-f[2], 0, f[0]]); // forward x up, with up fixed to +y.
  const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
  const dot = (a, b) => a[0] * b.x + a[1] * b.y + a[2] * b.z;
  return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}
