// Offline is the normal case on a trail. The build fills in the name from a hash of the app's files,
// so every release installs as a new, complete copy.
const SHELL_CACHE = 'hike-shell-__BUILD__';
const SAVED_CACHE = 'hike-saved-v1'; // Areas the hiker chose to keep; only they can clear it.
const AUTO_CACHE = 'hike-auto-v1'; // Tiles and shards already seen; trimmed automatically.
const TILE_HOST = 'https://basemap.nationalmap.gov';
const AUTO_LIMIT = 1500;

const SHELL = [
  './',
  'app.css',
  'manifest.webmanifest',
  'icon.png',
  'modules/activities.js',
  'modules/app.js',
  'modules/backup.js',
  'modules/checkpoints.js',
  'modules/conditions.js',
  'modules/device.js',
  'modules/geo.js',
  'modules/geocaches.js',
  'modules/gpx.js',
  'modules/hikes.js',
  'modules/hunting.js',
  'modules/landscape.js',
  'modules/map.js',
  'modules/mapbox-data.js',
  'modules/mapbox-settings.js',
  'modules/mapbox-view.js',
  'modules/offline.js',
  'modules/photos.js',
  'modules/planner.js',
  'modules/store.js',
  'modules/terrain.js',
  'modules/terrain-view.js',
  'modules/trail-details.js',
  'modules/tracker.js',
  'modules/trails.js',
  'data/index.json',
  'data/places.json',
  'data/hikes.json',
  'data/routes.json',
  'data/official.json',
  'data/outfitters.json',
  'data/stays.json',
  'data/hunting.json',
  'data/gauges.json',
  'data/checkpoints.json',
];

const SHELL_PATHS = new Set(SHELL.map(path => new URL(path, self.location).pathname));
const APP_PAGE = new URL('./', self.location).pathname;

self.addEventListener('install', event => {
  // Past any browser copy, so a release can't be stored with some of the last one's files.
  const fresh = SHELL.map(path => new Request(path, { cache: 'reload' }));
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, SAVED_CACHE, AUTO_CACHE]);
    await Promise.all((await caches.keys()).filter(name => name.startsWith('hike-') && !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

let autoWrites = 0;
async function trimAuto(cache) {
  autoWrites += 1;
  if (autoWrites % 50) return;
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - AUTO_LIMIT)).map(key => cache.delete(key)));
}

// Tiles and stream shards never change meaningfully during a hike, so a stored copy wins.
async function kept(request) {
  const url = request.url;
  const saved = await (await caches.open(SAVED_CACHE)).match(url, { ignoreVary: true });
  if (saved) return saved;
  const auto = await caches.open(AUTO_CACHE);
  const seen = await auto.match(url, { ignoreVary: true });
  if (seen) return seen;
  const response = await fetch(request);
  if (response.ok) {
    await auto.put(url, response.clone());
    trimAuto(auto);
  }
  return response;
}

// One release's files only work together: one newer file can stop the whole app with an import error.
// So the app always comes from the stored release, which installs complete or not at all. That also
// means a weak signal can't hold it hostage.
async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const stored = await cache.match(request.mode === 'navigate' ? './' : request);
  return stored || fetch(request);
}

// Everything else here, like the map library or the license text, prefers fresh and keeps a copy.
async function freshFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const stored = await cache.match(request);
    if (stored) return stored;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === TILE_HOST) {
    event.respondWith(kept(request));
  } else if (url.origin === self.location.origin && /\/data\/(streams|trails|terrain)\//.test(url.pathname)) {
    event.respondWith(kept(request));
  } else if (url.origin === self.location.origin && url.pathname.startsWith(new URL('./', self.location).pathname)) {
    const isApp = url.pathname === APP_PAGE || SHELL_PATHS.has(url.pathname);
    event.respondWith(isApp ? shell(request) : freshFirst(request));
  }
});
