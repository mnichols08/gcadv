const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sass = require("sass");
const { buildSite } = require("./content-site");
const { PUBLIC_ASSETS } = require("./site-assets");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

fs.mkdirSync(DIST, { recursive: true });
const site = buildSite();
let homepage = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
homepage = homepage.replace("__PLANNING_GUIDES__", site.planningCards);
homepage = homepage.replace("__LOCAL_GUIDES__", site.localCards);
homepage = homepage.replace("./src/site.scss", "./site.css");
fs.writeFileSync(path.join(DIST, "index.html"), homepage);
const explorer = fs.readFileSync(path.join(ROOT, "explore.html"), "utf8")
  .replace("./src/site.scss", "./site.css");
fs.writeFileSync(path.join(DIST, "explore.html"), explorer);
for (const name of PUBLIC_ASSETS) {
  const destination = path.join(DIST, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(PUBLIC, name), destination);
}
fs.writeFileSync(path.join(DIST, "site.css"), sass.compile(path.join(ROOT, "src", "site.scss"), { style: "compressed" }).css);
for (const page of site.pages) fs.writeFileSync(path.join(DIST, page.name), page.source);

const assets = [...new Set([
  ...fs.readdirSync(DIST, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "service-worker.js" &&
      entry.name !== "map-config.json" && !entry.name.endsWith(".map"))
    .map((entry) => entry.name),
  ...PUBLIC_ASSETS.filter((name) => name !== "index.html"),
])].sort();
const hash = crypto.createHash("sha256");
for (const name of assets) {
  hash.update(name);
  hash.update(fs.readFileSync(path.join(DIST, name)));
}
const worker = fs.readFileSync(path.join(ROOT, "src", "service-worker.js"), "utf8")
  .replace("__CACHE_VERSION__", hash.digest("hex").slice(0, 16))
  .replace("__PRECACHE_ASSETS__", JSON.stringify(assets.map((name) => `./${name}`)));
fs.writeFileSync(path.join(DIST, "service-worker.js"), worker);
console.log(`Generated ${site.articles.length} guide pages, homepage directory, sitemap, robots.txt, and offline cache.`);
