// A small slippy map on canvas: tiles, gestures, and a hook for drawing on top.
import { project, TILE_SIZE, unproject } from './geo.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const RETRY_MS = 20000;
const MAX_CACHED_TILES = 320;

export class TopoMap {
  constructor(canvas, { tileUrl, tileMaxZoom, minZoom = 6, maxZoom = 19, fixedSize = 0, onDraw, onUserMove, onViewChange, onTileStatus, onTap }) {
    Object.assign(this, { canvas, tileUrl, tileMaxZoom, minZoom, maxZoom, onDraw, onUserMove, onTileStatus, onTap });
    this.ctx = canvas.getContext('2d');
    this.center = { lat: 39.5, lon: -79.3 };
    this.zoom = 10;
    this.tiles = new Map();
    this.pointers = new Map();
    this.gesture = null;
    this.drawQueued = false;
    this.paused = false;
    if (fixedSize) {
      // An offscreen map: the 3D view's ground texture, with no gestures of its own.
      this.width = this.height = canvas.width = canvas.height = fixedSize;
      this.ratio = 1;
    } else {
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
      this.listen();
    }
    // Assigned last: the callback may use the finished map, which doesn't exist until now.
    this.onViewChange = onViewChange;
    window.addEventListener('online', () => {
      for (const [key, tile] of this.tiles) if (tile.failedAt) this.tiles.delete(key);
      this.requestDraw();
    });
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    this.width = box.width;
    this.height = box.height;
    this.ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(box.width * this.ratio);
    this.canvas.height = Math.round(box.height * this.ratio);
    this.changed();
  }

  setView(lat, lon, zoom = this.zoom) {
    this.center = { lat, lon };
    this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.changed();
  }

  zoomAround(nextZoom, anchorX = this.width / 2, anchorY = this.height / 2) {
    const zoom = clamp(nextZoom, this.minZoom, this.maxZoom);
    const before = this.unprojectScreen(anchorX, anchorY);
    this.zoom = zoom;
    const world = project(before.lat, before.lon, zoom);
    this.center = unproject(world.x - anchorX + this.width / 2, world.y - anchorY + this.height / 2, zoom);
    this.changed();
  }

  fit({ south, west, north, east }, paddingPixels = 56) {
    const usableWidth = Math.max(1, this.width - paddingPixels * 2);
    const usableHeight = Math.max(1, this.height - paddingPixels * 2);
    const span = (a, b) => ({ x: Math.abs(a.x - b.x) || 1, y: Math.abs(a.y - b.y) || 1 });
    const size = span(project(north, west, 0), project(south, east, 0));
    const zoom = Math.floor(Math.log2(Math.min(usableWidth / size.x, usableHeight / size.y)));
    this.setView((north + south) / 2, (west + east) / 2, Math.min(zoom, 16));
  }

  bounds() {
    const a = this.unprojectScreen(0, 0);
    const b = this.unprojectScreen(this.width, this.height);
    return { north: a.lat, west: a.lon, south: b.lat, east: b.lon };
  }

  toScreen(lat, lon) {
    const world = project(lat, lon, this.zoom);
    const middle = project(this.center.lat, this.center.lon, this.zoom);
    return { x: world.x - middle.x + this.width / 2, y: world.y - middle.y + this.height / 2 };
  }

  unprojectScreen(x, y) {
    const middle = project(this.center.lat, this.center.lon, this.zoom);
    return unproject(middle.x + x - this.width / 2, middle.y + y - this.height / 2, this.zoom);
  }

  changed() {
    this.requestDraw();
    this.onViewChange?.();
  }

  requestDraw() {
    if (this.drawQueued || this.paused) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let tile = this.tiles.get(key);
    if (tile?.failedAt && Date.now() - tile.failedAt > RETRY_MS) {
      this.tiles.delete(key);
      tile = null;
    }
    if (tile) {
      // Re-insert so the Map's order doubles as least-recently-used.
      this.tiles.delete(key);
      this.tiles.set(key, tile);
      return tile;
    }
    const entry = { image: new Image(), ready: false, failedAt: 0 };
    entry.image.crossOrigin = 'anonymous';
    entry.image.onload = () => {
      entry.ready = true;
      this.onTileStatus?.(true);
      this.requestDraw();
    };
    entry.image.onerror = () => {
      entry.failedAt = Date.now();
      this.onTileStatus?.(false);
    };
    entry.image.src = this.tileUrl({ z, x, y });
    this.tiles.set(key, entry);
    while (this.tiles.size > MAX_CACHED_TILES) this.tiles.delete(this.tiles.keys().next().value);
    return entry;
  }

  // Draws a coarser tile stretched over the gap, so a saved overview still shows offline.
  drawFallback(z, x, y, screenX, screenY, size) {
    const { ctx } = this;
    for (let up = 1; up <= 6 && z - up >= 0; up += 1) {
      const factor = 2 ** up;
      const parent = this.tiles.get(`${z - up}/${Math.floor(x / factor)}/${Math.floor(y / factor)}`);
      if (parent?.ready) {
        const part = TILE_SIZE / factor;
        ctx.drawImage(parent.image, (x % factor) * part, (y % factor) * part, part, part, screenX, screenY, size, size);
        return;
      }
    }
  }

  draw() {
    const { ctx, ratio, width, height } = this;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#e4e6dc';
    ctx.fillRect(0, 0, width, height);
    const z = clamp(Math.round(this.zoom), 0, this.tileMaxZoom);
    const scale = 2 ** (this.zoom - z);
    const size = TILE_SIZE * scale;
    const middle = project(this.center.lat, this.center.lon, z);
    const left = middle.x - width / 2 / scale;
    const top = middle.y - height / 2 / scale;
    const count = 2 ** z;
    // Ask for the coarser parent too, so a fast pan or a missing tile has something to show.
    for (let y = Math.floor(top / TILE_SIZE); y <= Math.floor((top + height / scale) / TILE_SIZE); y += 1) {
      if (y < 0 || y >= count) continue;
      for (let x = Math.floor(left / TILE_SIZE); x <= Math.floor((left + width / scale) / TILE_SIZE); x += 1) {
        if (x < 0 || x >= count) continue;
        const screenX = Math.round((x * TILE_SIZE - left) * scale);
        const screenY = Math.round((y * TILE_SIZE - top) * scale);
        const drawSize = Math.ceil(size) + 1;
        const tile = this.tile(z, x, y);
        if (tile.ready) ctx.drawImage(tile.image, screenX, screenY, drawSize, drawSize);
        else {
          if (z > 2) this.tile(z - 2, x >> 2, y >> 2);
          this.drawFallback(z, x, y, screenX, screenY, drawSize);
        }
      }
    }
    this.onDraw?.(ctx, this);
  }

  listen() {
    const { canvas } = this;
    const position = event => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const pair = () => {
      const [a, b] = [...this.pointers.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    canvas.addEventListener('pointerdown', event => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, position(event));
      // A tap is one finger that lifts quickly from about where it landed.
      this.press = this.pointers.size === 1 ? { ...position(event), at: Date.now() } : null;
      if (this.pointers.size === 2) this.gesture = { ...pair(), zoom: this.zoom };
    });
    canvas.addEventListener('pointermove', event => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const current = position(event);
      this.pointers.set(event.pointerId, current);
      if (this.pointers.size === 1) {
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        if (!dx && !dy) return;
        // A fingertip always wobbles a little during a tap, so it shouldn't drop follow mode.
        if (this.press && Math.hypot(current.x - this.press.x, current.y - this.press.y) < 10) return;
        const middle = project(this.center.lat, this.center.lon, this.zoom);
        this.center = unproject(middle.x - dx, middle.y - dy, this.zoom);
        this.onUserMove?.();
        this.changed();
      } else if (this.pointers.size === 2 && this.gesture) {
        const now = pair();
        this.zoomAround(this.gesture.zoom + Math.log2(now.distance / this.gesture.distance), now.x, now.y);
        this.onUserMove?.();
      }
    });
    const lift = event => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.gesture = null;
    };
    canvas.addEventListener('pointerup', event => {
      const at = position(event);
      const { press } = this;
      lift(event);
      this.press = null;
      if (press && Date.now() - press.at < 500 && Math.hypot(at.x - press.x, at.y - press.y) < 10) this.onTap?.(at.x, at.y);
    });
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const at = position(event);
      this.zoomAround(this.zoom - event.deltaY / 300, at.x, at.y);
    }, { passive: false });
    canvas.addEventListener('dblclick', event => {
      const at = position(event);
      this.zoomAround(Math.round(this.zoom) + 1, at.x, at.y);
    });
  }
}

const SCALE_STEPS = [
  [50, '50 ft'], [100, '100 ft'], [250, '250 ft'], [500, '500 ft'], [1000, '1,000 ft'], [2640, '½ mi'],
  [5280, '1 mi'], [10560, '2 mi'], [26400, '5 mi'], [52800, '10 mi'], [105600, '20 mi'], [264000, '50 mi'],
];

export function scaleBar(feetPerPixel, maxPixels = 110) {
  let chosen = SCALE_STEPS[0];
  for (const step of SCALE_STEPS) if (step[0] / feetPerPixel <= maxPixels) chosen = step;
  return { pixels: Math.round(chosen[0] / feetPerPixel), label: chosen[1] };
}
