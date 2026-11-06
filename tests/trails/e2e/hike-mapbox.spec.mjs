import { test, expect } from '@playwright/test';

const URL_PATH = '/trails/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN88+bNfwAJYwPh9vMCxwAAAABJRU5ErkJggg==', 'base64');

// A stand-in for Mapbox that records what the app asks of it, so these tests need no token or network.
const FAKE_MAPBOX = `
window.__mapbox = { maps: [], markers: [] };
class FakeMap {
  constructor(options) {
    this.options = options; this.handlers = {}; this.sources = {}; this.layers = []; this.center = options.center; this.zoomLevel = options.zoom; this.terrain = null; this.moves = [];
    window.__mapbox.maps.push(this);
    if (window.__mapboxFail) setTimeout(() => this.fire('error', { error: { status: 401 } }));
    else setTimeout(() => this.fire('style.load', {}));
  }
  on(name, handler) { (this.handlers[name] ||= []).push(handler); }
  once(name, handler) { this.on(name, handler); }
  fire(name, event) { for (const handler of this.handlers[name] || []) handler(event); }
  addControl() {} resize() {} setFog() {} remove() { this.removed = true; }
  getLayer() { return null; } getStyle() { return { layers: [] }; } setLayoutProperty() {}
  addSource(id, source) { const entry = { ...source, setData: data => { entry.data = data; } }; this.sources[id] = entry; }
  getSource(id) { return this.sources[id]; }
  addLayer(layer) { this.layers.push(layer); }
  setTerrain(terrain) { this.terrain = terrain; }
  getZoom() { return this.zoomLevel; } getPitch() { return this.options.pitch; } getBearing() { return 0; }
  getCenter() { return { lng: this.center[0], lat: this.center[1] }; }
  getBounds() { const [x, y] = this.center; return { getSouth: () => y - 0.05, getNorth: () => y + 0.05, getWest: () => x - 0.05, getEast: () => x + 0.05 }; }
  project() { return { x: 0, y: 0 }; }
  jumpTo({ center, zoom }) { this.center = center; this.zoomLevel = zoom; this.moves.push('jump'); }
  easeTo({ center, zoom }) { if (center) this.center = center; if (zoom !== undefined) this.zoomLevel = zoom; this.moves.push('ease'); }
  fitBounds(bounds) { this.fitted = bounds; }
}
class FakeMarker {
  constructor({ element } = {}) { this.element = element || document.createElement('div'); window.__mapbox.markers.push(this); }
  setLngLat(place) { this.place = place; return this; }
  setRotation() { return this; }
  addTo() { return this; }
  remove() {}
  getElement() { return this.element; }
}
window.mapboxgl = { Map: FakeMap, Marker: FakeMarker, NavigationControl: class {} };
`;

test.use({ serviceWorkers: 'block' });

async function open(page, { token = 'pk.test_token.signature', fail = false } = {}) {
  await page.route('https://basemap.nationalmap.gov/**', route => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } }));
  await page.route('**/trails/vendor/mapbox-gl.js', route => route.fulfill({ body: FAKE_MAPBOX, contentType: 'text/javascript' }));
  await page.route('**/map-config.json', route => (token ? route.fulfill({ json: { mapboxToken: token } }) : route.fulfill({ status: 404, body: '' })));
  await page.addInitScript(fail => {
    window.__mapboxFail = fail;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { watchPosition(success) { window.__gps = success; return 1; }, clearWatch() {}, getCurrentPosition() {} },
    });
    window.__emit = (lat, lon, t = Date.now()) => window.__gps({
      coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: t,
    });
  }, fail);
  await page.goto(URL_PATH);
}

const toggle = page => page.getByRole('button', { name: '3D terrain view' });
const fake = (page, read) => page.evaluate(read);

test('with signal and a token, 3D is the Mapbox outdoors map on terrain', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#live3d')).toBeVisible();
  await expect(page.locator('#terrain')).toBeHidden();
  await expect(page.locator('#heightNote')).toHaveText('Height shown ×1.8');
  const facts = await fake(page, () => {
    const map = window.__mapbox.maps[0];
    return { style: map.options.style, pitch: map.options.pitch, terrain: map.terrain, dem: Object.values(map.sources).find(source => source.type === 'raster-dem')?.url, token: window.mapboxgl.accessToken, layers: map.layers.map(layer => layer.id) };
  });
  expect(facts.style).toBe('mapbox://styles/mapbox/outdoors-v12');
  expect(facts.pitch).toBeGreaterThanOrEqual(45);
  expect(facts.terrain.exaggeration).toBe(1.8);
  expect(facts.dem).toBe('mapbox://mapbox.mapbox-terrain-dem-v1');
  expect(facts.token).toBe('pk.test_token.signature');
  expect(facts.layers).toEqual(expect.arrayContaining(['trails', 'routes', 'points']));
});

test('leaving 3D and coming back reuses the same map, so it is one billed load', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeHidden();
  await expect(page.locator('#map')).toBeVisible();
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  expect(await fake(page, () => window.__mapbox.maps.length)).toBe(1);
});

test('GPS moves the marker, and following moves the camera', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await page.getByRole('button', { name: 'Find me and follow' }).click();
  await page.evaluate(() => window.__emit(39.1002, -79.5316));
  await expect.poll(() => fake(page, () => window.__mapbox.markers[0]?.place)).toEqual([-79.5316, 39.1002]);
  await expect.poll(() => fake(page, () => window.__mapbox.maps[0].center)).toEqual([-79.5316, 39.1002]);
});

test('a chosen hike and its trails reach the 3D map', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await page.getByRole('button', { name: /Find a/ }).click();
  await page.getByRole('button', { name: 'Follow this hike' }).first().click();
  await expect.poll(() => fake(page, () => window.__mapbox.maps[0].sources.routes.data?.features.length || 0)).toBeGreaterThan(0);
  expect(await fake(page, () => Boolean(window.__mapbox.maps[0].fitted))).toBe(true);
});

test('no token: 3D uses the saved terrain', async ({ page }) => {
  await open(page, { token: null });
  await toggle(page).click();
  await expect(page.locator('#terrain')).toBeVisible();
  await expect(page.locator('#live3d')).toBeHidden();
  await expect(page.locator('#heightNote')).toHaveText('Height shown ×1.5');
  expect(await fake(page, () => window.__mapbox?.maps.length ?? 0)).toBe(0);
});

test('a refused token: 3D uses the saved terrain', async ({ page }) => {
  await open(page, { fail: true });
  await toggle(page).click();
  await expect(page.locator('#terrain')).toBeVisible();
  await expect(page.locator('#live3d')).toBeHidden();
});

test('losing signal in 3D switches to the saved terrain and says so', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('#terrain')).toBeVisible();
  await expect(page.locator('#live3d')).toBeHidden();
  await expect(page.locator('#notice')).toHaveText('No signal. This is the saved terrain now.');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
});

test('losing signal with no terrain saved goes to the flat map and says so', async ({ page }) => {
  await open(page);
  await page.route('**/data/terrain/**', route => route.abort());
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#terrain')).toBeHidden();
  await expect(page.locator('#live3d')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('flat map');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('GPS arriving just after picking a trail leaves the trail in view', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Find a trail' }).click();
  await page.locator('#finderList li', { hasText: 'Lostland Run' }).getByRole('button', { name: 'Follow this hike' }).click();
  await page.evaluate(() => window.__emit(39.6, -79.1));
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  const [lon, lat] = await fake(page, () => window.__mapbox.maps[0].center);
  expect(Math.abs(lat - 39.385)).toBeLessThan(0.1);
  expect(Math.abs(lon + 79.26)).toBeLessThan(0.1);
});

// Mapbox lifts the camera when elevation arrives late, which zooms out and slides the view.
const lift = page => page.evaluate(() => {
  const map = window.__mapbox.maps[0];
  map.zoomLevel = 13.59;
  map.center = [map.center[0], map.center[1] + 0.02];
  map.fire('idle', {});
  return { zoom: map.zoomLevel, center: map.center };
});

test('the view goes back on target if late terrain moves it', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  const before = await fake(page, () => ({ zoom: window.__mapbox.maps[0].zoomLevel, center: window.__mapbox.maps[0].center }));
  expect(await lift(page)).toEqual(before);
});

test('a view the person moved themselves is left alone', async ({ page }) => {
  await open(page);
  await toggle(page).click();
  await expect(page.locator('#live3d')).toBeVisible();
  await page.evaluate(() => window.__mapbox.maps[0].fire('dragstart', { originalEvent: {} }));
  expect((await lift(page)).zoom).toBe(13.59);
});
