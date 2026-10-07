# Garrett County Adventures

Garrett County Adventures is a responsive trip-planning website for exploring
parks, trails, towns, and local guides in Garrett County, Maryland. It combines
a Mapbox map with curated places, OpenStreetMap trail data, and tools for
reviewing GPX tracks. Trail analysis runs locally in the browser; the app does
not upload GPX files.

## What you can do

- Browse trip guides and local destination articles from the homepage.
- Search and filter 16 curated places, then select a place to locate it on the
  map or save its details in this browser.
- Explore the map, which starts in **3D terrain mode**. Use the mouse wheel to
  zoom, **Return to 2D** to disable terrain, and the map settings to adjust
  pitch and terrain exaggeration.
- Browse the bundled OpenStreetMap snapshot of regional hiking routes and
  mapped paths. Refresh it on demand from the Hikes tab; refreshes require an
  internet connection.
- Import GPX tracks or routes in Trail Lab to review distance, elevation,
  ascent, and estimated walking time. Export GPX or save the analysis for
  offline access.
- Install the site as a PWA. Saved details and the app shell can work offline;
  Mapbox styles, tiles, and live trail refreshes require a connection.

The bundled trail snapshot is community mapping, not verified trail guidance.
Routes may be incomplete or clipped to the Garrett County map region; access,
conditions, and accessibility are not verified. See the [detailed guide](docs/README.md)
for data limits, analysis details, and attribution.

## Languages and tools

| Technology | Use |
| --- | --- |
| TypeScript | Map explorer, place search, saved outings, trail workflows, and browser storage |
| Rust compiled to WebAssembly | Local GPX distance and elevation calculations |
| JavaScript | Node build scripts and site behavior |
| HTML and CSS | Accessible page structure, responsive layouts, and styling |
| Markdown with YAML front matter | Trip guide content and metadata |
| Mapbox GL JS, Vite, Sass, and Node.js | Interactive maps, development server, asset bundling, and CSS processing |

The front end uses browser APIs including IndexedDB, Web Workers, and service
workers. It does not use a client-side UI framework.

## Run locally

Requirements: Node.js LTS with npm, Rust and Cargo, the
`wasm32-unknown-unknown` target, and `wasm-pack`.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
npm ci
```

Create a local Mapbox configuration from the example and add a **public**
Mapbox token (`pk.` prefix):

```sh
cp map-config.example.json map-config.local.json
```

Start the Vite development server (it builds the Rust/WASM module first):

```sh
npm run dev
```

Open `http://localhost:3000`. For a production build, run `npm run build` and
then `npm start` to serve it on port 3000. The token is public to browser
visitors, so restrict it to the domains you use and grant only the required scopes. Never
put a secret `sk.` token in this app. On deployment, provide `map-config.json`
beside `index.html` as a separate runtime file; it is intentionally excluded
from source control and the offline cache. The rest of the site still builds
without it, but the basemap will show a setup message.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build Rust/WASM, type-check TypeScript, and create production files in `dist` |
| `npm run build:content` | Rebuild guide pages, homepage cards, sitemap, and robots file without rebuilding Rust/WASM |
| `npm run dev` | Build the WASM engine and start Vite with hot module replacement on port 3000 |
| `npm run preview` | Preview the production build with Vite on port 4173 |
| `npm run typecheck` | Type-check the TypeScript app |
| `npm test` | Run TypeScript tests |
| `npm run test:rust` | Run Rust tests |
| `npm run refresh:hikes` | Refresh the checked-in regional OpenStreetMap snapshot |

For feature behavior, data sources, GPX calculations, offline limits, and
deployment details, see [docs/README.md](docs/README.md).
