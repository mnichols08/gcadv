# Garrett County Adventures — Project Guide

For the project overview, quick start, language and tool list, and command
reference, start with the [main README](../README.md).

## Purpose and technology

This project helps people plan visits to Garrett County, Maryland. The
homepage provides local trip guides; the interactive explorer brings together
curated places, mapped regional routes and paths, and local GPX analysis.
It is a planning aid, not a navigation service or a source of verified access,
conditions, or accessibility information.

The browser app is written in **TypeScript** and uses Mapbox GL JS. **Rust** is
compiled to WebAssembly for GPX calculations, which run in a Web Worker.
Build scripts and some site behavior use **JavaScript**; page content is
**HTML/CSS**, with guide articles authored in **Markdown** and YAML front
matter. Vite, Sass, Node.js, IndexedDB, and service workers support the
build, styling, local storage, and offline app shell.

The explorer now includes a responsive, keyboard-accessible place browser,
activity filters, synchronized map selection, shareable place/search URLs,
local saved outings, and a GPX trail lab powered by Rust and WebAssembly.
The original 16 curated places remain the discovery dataset. No new trail,
accessibility, opening-hours, or live-condition information is assumed.

The homepage leads with local trip guides and Garrett County's scenery. The
interactive map lives at `/explore.html` and is linked from the site footer.
Article source files live in `content/articles/` as Markdown with YAML front
matter. The Vite production build emits each article's root-level `.html`
permalink, plus `sitemap.xml` and `robots.txt`, into `dist`. Keep article
permalinks stable so search results and existing internal links do not break.
Guide metadata such as descriptions, related articles, source lists, and
last-checked dates is rendered from each article's front matter. The
`npm run build:content` command refreshes these pages without rebuilding the
map's Rust/WebAssembly engine. The site follows the device color preference by
default, lets visitors choose a theme, and offers platform-appropriate PWA
installation guidance. Its service worker caches the guide pages and app shell;
Mapbox basemap tiles still need an internet connection.
Article Markdown is rendered at build time. Raw HTML is restricted to a small
allowlist, and Markdown text and link labels are HTML-escaped.

## Using the app

Open the homepage to browse trip guides, then choose **Explore the map** to
open `/explore.html`. Search or filter the curated places and select a result
to sync it with the map. The map starts in 3D terrain mode; scroll the mouse
wheel to zoom. **Return to 2D** disables terrain. Use **Hikes** to browse the
bundled map data or request an update, **Trail lab** to import and analyze a
GPX file, and **Saved** to reopen details stored in this browser.

### Build and run

Requirements: a current Node.js LTS release with npm, Rust with Cargo, the
`wasm32-unknown-unknown` target, and `wasm-pack`.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
npm ci
npm run dev
```

Open `http://localhost:3000`. For a production preview, run `npm run build`
and then `npm start` to serve `dist` on port 3000.

Before building, copy `map-config.example.json` to `map-config.local.json`
and fill `mapboxToken` with a **public** Mapbox token (prefix `pk.`).
The local file is ignored by Git. The build copies it into the ignored runtime
file `dist/map-config.json`, separately from JavaScript bundles and source maps.
Never use a secret (`sk.`) token in any browser application; the build and
runtime reject it. Public tokens are visible to visitors, so apply domain
restrictions and minimum required scopes in your Mapbox account.

On deployment, provision `map-config.json` beside `index.html`, or set the
build environment variable `MAPBOX_TOKEN` (also accepts
`MAPBOX_PUBLIC_TOKEN`) to the public token. Values in `.env` files are loaded
by Vite during local builds. The build then writes `dist/map-config.json` for
deployment. The runtime file is
intentionally not committed or precached. Builds without a token still work
for place discovery and trail analysis, with a visible map setup message.
Ignoring a file does not remove it from previously created commits.

The production build compiles the Rust crate, type-checks TypeScript, and uses
Vite to emit the web app into `dist`. VS Code also provides build and preview
tasks; the preview task listens on port 4173. `npm run dev` builds WASM once
and starts Vite with hot module replacement on both localhost address families
at port 3000. Development unregisters any older app service worker and clears
this app's local offline caches so they cannot serve stale production files.
Use the production preview to check offline behavior. After changing Rust, run
`npm run build:wasm` again.

Production CSS is minified, raster photography is served as WebP with a smaller
responsive homepage source, and the map and hike data load as separate chunks
when needed. Production builds omit source maps; development builds retain them.
Deploy the complete contents of `dist` together so the versioned service worker
and its precached assets stay in sync. Configure the static host to revalidate
HTML and `service-worker.js` on each visit, and cache content-hashed bundles
longer term. The hosting project is not tied to a specific provider, so its
cache headers must be set in that provider's deployment configuration.

```sh
npm test
npm run test:rust
npm run typecheck
```

### OpenStreetMap hike discovery

The map starts in **3D terrain** mode with a 45-degree camera pitch and 1.8x
visual elevation exaggeration. Use the mouse wheel to zoom in or out over the
map. Choose **Return to 2D** to remove terrain and reset pitch and bearing.
In 3D mode a 45-degree minimum pitch is enforced for sliders, gestures, and
camera movements. **Map view settings** is collapsed by default; open it to
access keyboard-accessible sliders for pitch (45-85 degrees in 3D, 0-85
without terrain) and steepness (1-10x).
Steepness changes only visual elevation, not measured slopes or GPX statistics,
and applies only while 3D terrain is enabled. Preferences last for the current
page session. Pitch stays synchronized with map gestures.
**3D terrain** can be disabled with **Return to 2D**, which removes terrain and
resets pitch/bearing. The toggle is independent of manual camera controls:
right-click-and-drag (or Ctrl-drag)
on desktop, or drag two fingers vertically on touch screens to adjust pitch
up to Mapbox's 85-degree maximum. The compass shows camera orientation and resets bearing when
clicked. Manual tilt also works without elevation terrain enabled.
The toggle is keyboard accessible, respects reduced-motion preferences, and remains disabled
until the map style loads. Terrain tiles require connectivity and ordinary
Mapbox usage applies. Terrain errors return the map to 2D with a visible notice.
Map bounds remain constrained in both modes; the zoom floor tightens for tilted
viewports. This visual terrain does not supply elevation data to GPX analysis.

The map is constrained to the original project bounds: southwest
`[-79.48696767001076, 39.202068911240104]`, northeast
`[-79.08637004392415, 39.722221540464716]`. This is a rectangular Garrett County
region with immediate surroundings, not an exact county administrative polygon.
Panning, zooming out, and route previews respect these bounds.

The app permanently includes `src/model/hikes.json`: a real OpenStreetMap
snapshot retrieved October 6, 2026, containing **243 mapped features (62 hiking
route relations and 181 named paths)**. These appear immediately in the **Hikes**
tab and as regional map lines without an API request or preexisting browser
cache. They are included in the built app and offline app cache. Selecting a
map line opens matching hike results. No elevation or live access information
is added. Per-feature source attribution and retrieval dates remain attached
to analysis, saved outings, and GPX exports.

All OSM geometry is clipped to the regional rectangle. Border-crossing edges
are clipped at the boundary, and gaps/out-of-region excursions remain separate
segments. Longer routes may therefore be partial: displayed distances and GPX
exports cover only their regional sections, not necessarily the complete hike.

The **Refresh regional hikes** button runs an explicit, bounded Overpass query
for hiking/foot route relations and named paths using these same bounds.
Refreshing requires internet access but no API key or location permission.
It does not run automatically when panning or typing. The public endpoint is
`https://overpass-api.de/api/interpreter`, with an explicitly selectable
`https://overpass.kumi.systems/api/interpreter` alternate; requests are never
silently retried against another provider. Service timeouts and rate limits are
reported visibly. Searches can be cancelled, time out after 35 seconds, and
reject oversized or incomplete responses rather than presenting partial success.

Results are cached in IndexedDB with a retrieval timestamp for offline browsing.
Refresh results are merged with the permanent snapshot by OSM identity, preferring
the newer retrieved record. An empty refresh or old browser cache cannot erase
the bundled dataset. Bundled mapping is historical and could include features
removed from OSM since retrieval; check the source before relying on it.
Use the refresh button to check for updated results. Cache failures are reported;
the fetched results remain available in the current tab. Existing saved outings
are preserved during the database upgrade.

**Hiking route** means an OSM route relation; **Mapped path** means an individual
mapped way, not necessarily a whole hike. Named paths may also appear within
route relations; they are shown separately. Relation member ways are preserved
as separate GPX segments and repeated members are counted once. Branches,
alternate sections, disconnected geometry, and incomplete mapping mean that
analysis totals are mapped segment lengths, not a guaranteed navigable route.
Results are not curated recommendations or proof of public access. Missing
access, surface, difficulty, and elevation information stays explicitly unknown.

Preview geometry, analyze it with the existing local Rust/WASM engine, export
GPX, or save the analyzed hike. Saved hikes retain source URL, available tags,
retrieval date, and **OpenStreetMap contributors (ODbL)** attribution. GPX exports
preserve segment boundaries and attribution, and omit unavailable elevations.
GPX export is also available for imported and saved trails. Respect the
[OpenStreetMap license and attribution requirements](https://www.openstreetmap.org/copyright)
when redistributing data. Custom routing and elevation enrichment are not part
of this integration.

To replace the repository snapshot intentionally, run `npm run refresh:hikes`
and then `npm run build`. The refresh script validates the response and refuses
to replace the dataset with empty results. Public servers may throttle requests.
For an already downloaded Overpass JSON response, run
`npx tsx scripts/refresh-hikes.ts --input path-to-response.json`.
Review and commit the generated snapshot to keep the new data permanently.
This redistributed dataset is derived from OpenStreetMap under the ODbL;
retain attribution and comply with its license when redistributing it.

### GPX analysis

Import a GPX file containing track segments (`trkseg`/`trkpt`) or routes
(`rte`/`rtept`). If tracks exist, they take precedence over routes to avoid
counting the same journey twice. Waypoints alone are not a trail. Files are
limited to 8 MiB and 100,000 points; elevations must be between -12,000 and
10,000 meters. Invalid XML, coordinates, or elevations
produce visible errors. `tests/fixtures/segmented.gpx` is a **synthetic** example
for testing, not a real navigable trail.

The lazily loaded WASM engine runs in a dedicated worker. Cancelling or
replacing an import terminates that worker; previous successful analysis is
retained on failure. GPX contents are never uploaded by the analyzer. Mapbox
still receives ordinary basemap requests, and the displayed map viewport
may reflect your imported trail's location.

Distances are horizontal great-circle sums, not terrain-adjusted distances.
Segments and routes are never bridged. Ascent/descent are raw elevation
differences between adjacent points with known elevations; missing heights
are not interpolated. Incomplete coverage is explicitly labeled.
GPS noise can inflate climb totals. The chart samples long tracks for display;
statistics use every point.

Walking estimates use the selected flat-ground pace, plus one hour per 600 m
of ascent only when elevation pairs are complete. Otherwise estimates use
distance alone and say so. These are planning aids, not navigation, verified
accessibility, or safety assessments. They exclude breaks, surface conditions,
weather, and driving.

### Saved outings and offline use

Place snapshots and analyzed trail geometry are stored in this browser's
IndexedDB, without an account. Save/remove failures are reported visibly.
Saved data is not synchronized across devices and is lost if browser site data
is cleared or evicted. No durable-storage guarantee is made.

On HTTPS or localhost, a versioned service worker precaches the app shell,
worker chunks, and WASM binary after a successful initial online load. Saved
details, elevation profiles, and new local GPX analysis can then work offline.
**Mapbox styles, tiles, external fonts, and APIs are not downloaded for offline
use.** An unavailable basemap does not prevent using the explorer's panels.

Updates wait until existing app tabs close, avoiding mixed old/new WASM
assets. Reopen the app to activate a downloaded update. Generated service
worker files must be deployed together with all emitted build assets. Edit
the shell/manifest/icons in `public` and service-worker logic in `src`, not
their generated copies in `dist`.

The runtime public Mapbox token is used for browser requests. Configure
appropriate domain restrictions and usage limits in Mapbox before deploying
to a new domain. Advanced routing, terrain downloads, and trip optimization
remain future work requiring licensed, validated geographic data.
