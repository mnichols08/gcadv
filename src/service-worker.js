const CACHE_NAME = "chingu-adventures-__CACHE_VERSION__";
const ASSETS = __PRECACHE_ASSETS__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

// Do not replace a running page's worker/WASM assets until its next navigation.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) =>
        (name.startsWith("chingu-adventures-") || name.startsWith("chingu-mapbox-")) && name !== CACHE_NAME,
      ).map((name) => caches.delete(name)),
    )),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const scope = self.registration.scope;
  const knownAsset = ASSETS.some((asset) => new URL(asset, scope).href === url.href);
  const shell = event.request.mode === "navigate" &&
    (url.pathname === new URL(scope).pathname || url.pathname === new URL("./index.html", scope).pathname);
  if (!knownAsset && !shell) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const response = await cache.match(shell ? new URL("./index.html", scope).href : event.request);
    return response || fetch(event.request);
  }));
});
