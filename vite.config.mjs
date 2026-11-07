import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig, loadEnv } from "vite";

const require = createRequire(import.meta.url);
const sass = require("sass");
const { buildSite } = require("./scripts/content-site");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
// The trail app is a static PWA with its own service worker, so it is copied in rather than bundled.
const TRAILS = path.join(ROOT, "apps", "trails", "public");
const MAPBOX_DIST = path.join(ROOT, "node_modules", "mapbox-gl", "dist");
const TRAIL_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };

function trailFile(pathname) {
  const relative = pathname.replace(/^\/trails\//, "") || "index.html";
  const vendor = relative.match(/^vendor\/(mapbox-gl\.(?:js|css))$/);
  const file = vendor ? path.join(MAPBOX_DIST, vendor[1]) : path.resolve(TRAILS, relative);
  if (!vendor && file !== TRAILS && !file.startsWith(TRAILS + path.sep)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function walkFiles(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolute, relative) : [relative];
  });
}

function getMapboxToken(environment) {
  const configPath = path.join(ROOT, "map-config.local.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    return config.mapboxToken;
  }
  return environment.MAPBOX_TOKEN || environment.MAPBOX_PUBLIC_TOKEN;
}

function validateMapboxToken(token) {
  if (typeof token !== "string" || !/^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Map configuration requires a public Mapbox token beginning with pk. Secret tokens are not allowed.");
  }
  return token;
}

function sitePlugin(command, environment) {
  let site;
  return {
    name: "garrett-county-site",
    transformIndexHtml(html, context) {
      site ||= buildSite();
      if (context.path === "/" || context.path.endsWith("index.html")) {
        return html.replace("__PLANNING_GUIDES__", site.planningCards)
          .replace("__LOCAL_GUIDES__", site.localCards);
      }
      return html;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        if (pathname === "/trails") {
          response.statusCode = 301;
          response.setHeader("Location", "/trails/");
          response.end();
          return;
        }
        if (pathname.startsWith("/trails/")) {
          const file = trailFile(pathname);
          if (!file) return next();
          response.setHeader("Content-Type", TRAIL_TYPES[path.extname(file)] || "application/octet-stream");
          if (pathname === "/trails/sw.js") {
            response.end(fs.readFileSync(file, "utf8").replace("__BUILD__", String(Date.now())));
            return;
          }
          fs.createReadStream(file).pipe(response);
          return;
        }
        if (pathname === "/service-worker.js") {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(`self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  await self.registration.unregister();
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith("chingu-adventures-") || name.startsWith("chingu-mapbox-"))
    .map(name => caches.delete(name)));
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  await Promise.all(clients.map(client => client.navigate(client.url)));
})()));`);
          return;
        }
        if (pathname === "/map-config.json") {
          try {
            const token = getMapboxToken(environment);
            if (!token) return next();
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ mapboxToken: validateMapboxToken(token) }));
            return;
          } catch (error) {
            response.statusCode = 500;
            response.end(error.message);
            return;
          }
        }
        site ||= buildSite();
        const page = site.pages.find((entry) => `/${entry.name}` === pathname);
        if (!page) return next();
        response.setHeader("Content-Type", page.name.endsWith(".xml") ? "application/xml" :
          page.name.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/html; charset=utf-8");
        response.end(page.source.replaceAll("./site.css", "./src/site.scss").replaceAll('"/site.css"', '"/src/site.scss"'));
      });
    },
    closeBundle() {
      if (command !== "build") return;
      site ||= buildSite();
      for (const page of site.pages) {
        fs.mkdirSync(path.dirname(path.join(DIST, page.name)), { recursive: true });
        fs.writeFileSync(path.join(DIST, page.name), page.source);
      }
      fs.cpSync(TRAILS, path.join(DIST, "trails"), { recursive: true });
      fs.mkdirSync(path.join(DIST, "trails", "vendor"), { recursive: true });
      for (const name of ["mapbox-gl.js", "mapbox-gl.css"]) {
        fs.copyFileSync(path.join(MAPBOX_DIST, name), path.join(DIST, "trails", "vendor", name));
      }
      // Each release of the app is stored whole, under a name its own files decide.
      const trailsDir = path.join(DIST, "trails");
      const release = crypto.createHash("sha256");
      for (const name of walkFiles(trailsDir).filter((file) => file !== "sw.js").sort()) {
        release.update(name);
        release.update(fs.readFileSync(path.join(trailsDir, name)));
      }
      const trailWorker = path.join(trailsDir, "sw.js");
      fs.writeFileSync(trailWorker, fs.readFileSync(trailWorker, "utf8").replace("__BUILD__", release.digest("hex").slice(0, 16)));
      fs.writeFileSync(path.join(DIST, "site.css"),
        sass.compile(path.join(ROOT, "src", "site.scss"), { style: "compressed" }).css);

      const outputConfig = path.join(DIST, "map-config.json");
      const token = getMapboxToken(environment);
      if (token) {
        fs.writeFileSync(outputConfig, JSON.stringify({ mapboxToken: validateMapboxToken(token) }));
      } else {
        fs.rmSync(outputConfig, { force: true });
        console.warn("No map token configured. Set map-config.local.json, MAPBOX_PUBLIC_TOKEN, or deploy map-config.json separately to enable the basemap.");
      }

      // The trail app caches itself, and its map data is far too large to download on every first visit.
      // Nor should a first visit download hundreds of trail pages, or the long land rules page.
      const assets = walkFiles(DIST).filter((name) => name !== "service-worker.js" &&
        name !== "map-config.json" && !name.endsWith(".map") && !name.startsWith("trails/") && !name.startsWith("trail/") && !name.startsWith("trails-in/") && name !== "land-rules.html").sort();
      const hash = crypto.createHash("sha256");
      for (const name of assets) {
        hash.update(name);
        hash.update(fs.readFileSync(path.join(DIST, name)));
      }
      const worker = fs.readFileSync(path.join(ROOT, "src", "service-worker.js"), "utf8")
        .replace("__CACHE_VERSION__", hash.digest("hex").slice(0, 16))
        .replace("__PRECACHE_ASSETS__", JSON.stringify(assets.map((name) => `./${name}`)));
      fs.writeFileSync(path.join(DIST, "service-worker.js"), worker);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const environment = { ...loadEnv(mode, ROOT, ""), ...process.env };
  return ({
  publicDir: "public",
  plugins: [sitePlugin(command, environment)],
  cacheDir: process.env.CHINGU_VITE_CACHE_DIR || undefined,
  server: { host: "localhost", port: 3000, strictPort: true },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { home: path.join(ROOT, "index.html"), explore: path.join(ROOT, "explore.html") } },
  },
  });
});
