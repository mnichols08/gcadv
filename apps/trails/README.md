# Trail app

The phone-first trail app for Garrett County Adventures, served at `/trails/`. Find a trail for
hiking, biking, cross-country skiing, snowshoeing, snowmobiling, ATV/UTV riding or horseback riding;
record a high-detail route on a USGS topo map; pin photos to the map; reach virtual checkpoints; find
geocaches; and mark spots. It keeps working with no signal.

It covers Garrett and Allegany counties in Maryland; Tucker, Grant, Preston and Mineral in West
Virginia; and Somerset, Fayette and Bedford in Pennsylvania.

`public/` is a static site with relative URLs. The site's Vite build copies it to `dist/trails/`,
along with Mapbox GL from `node_modules`, and leaves it out of the site's own service worker
because the app caches itself.

## Run it

```sh
npm run build && npm run serve:trails   # http://127.0.0.1:4174/trails/
```

Browsers only allow GPS on `https` or `localhost`, so a phone on your Wi-Fi can't use the plain
preview address. To test outdoors, use a Netlify branch deploy, or a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:4174`.

## Layout

| Path | Job |
| --- | --- |
| `public/modules/tracker.js` | Decides which GPS fixes join the route. Computes distance, time and climb. Pure. |
| `public/modules/geo.js` | Distance, bearing, Web Mercator and formatting. Pure. |
| `public/modules/landscape.js` | Nearest town and water, plus the stream encoding. Pure. |
| `public/modules/trails.js` | Classifies trails and merges USGS with OpenStreetMap. Pure. |
| `public/modules/hikes.js` | Hike list facts and off-route rules. Pure. |
| `public/modules/photos.js` | Reads photo EXIF and decides where a photo belongs. Pure. |
| `public/modules/geocaches.js` | Reads geocaches from a GPX file. Pure. |
| `public/modules/checkpoints.js` | Arrival rules and progress for virtual checkpoints. Pure. |
| `public/modules/terrain.js` | Terrain blocks, mesh and camera math for 3D. Pure. |
| `public/modules/terrain-view.js` | The offline WebGL 3D view, on saved terrain. Loaded only when needed. |
| `public/modules/mapbox-view.js` | The online 3D view, on Mapbox outdoors and terrain. Loaded only when needed. |
| `public/modules/mapbox-data.js` | Turns trails, routes and markers into GeoJSON for that view. Pure. |
| `public/modules/conditions.js` | Reads live weather, snow and river services. Pure parsing. |
| `public/modules/trail-details.js` | Climb, effort, elevation profile and mapped trail facts. Pure. |
| `public/modules/activities.js` | What a trail is marked for, and the finder's filters. Pure. |
| `public/modules/gpx.js` | GPX 1.1 export. Pure. |
| `public/modules/map.js` | Canvas tile map and gestures. |
| `public/modules/device.js` | Geolocation, screen wake lock and compass. |
| `public/modules/store.js` | IndexedDB. Every recorded point is saved as it arrives. |
| `public/modules/offline.js`, `public/sw.js` | Saved map areas and offline caching. |
| `public/modules/app.js` | Wires it all to the page. |
| `scripts/bake-data.mjs` | Builds streams and places in `public/data/` from the repo's USGS captures. |
| `scripts/capture-trails.mjs` | Snapshots USGS and OpenStreetMap trails into `data-sources/`. |
| `scripts/capture-counties.mjs` | Snapshots the outlines of the covered counties from the US Census. |
| `scripts/capture-access.mjs` | Snapshots OpenStreetMap trailheads and parking. |
| `scripts/capture-terrain.mjs` | Captures USGS 3DEP elevation blocks for the 3D view and hike ground ranges. |
| `scripts/bake-trails.mjs` | Builds trail shards, `hikes.json` and `routes.json`. Fails if a listed hike matches nothing. |
| `data-sources/hikes.source.json` | The hand-picked hike list. Edit this to add a hike. |
| `data-sources/checkpoints.source.json` | The hand-picked checkpoints. The bake fails if one isn't near its trail. |

Tests live in `tests/trails/`: `npm run test:trails`, then `npm run build && npm run test:trails:e2e`.

## Data

| Layer | Source | Coverage |
| --- | --- | --- |
| Topo map | USGS Topo tiles, loaded directly from `basemap.nationalmap.gov` | National |
| Streams | USGS 3DHP flowlines, 161,174 reaches, simplified to about 30 ft | Potomac basin, plus neighbors within about 80 miles of it |
| Trails | USGS National Digital Trails and OpenStreetMap, merged | The covered counties and nearby, lat 38.75 to 40.35, lon -80.05 to -78.3 |
| Activities | Tags on those same records | Same. Only explicit markings count; see below |
| Counties | US Census TIGERweb | The nine covered counties |
| Elevation | USGS 3DEP, about 145 ft between samples | Same region as trails. The offline 3D view thins this to about 290 ft. Hike lists show low and high ground only, not climb |
| Towns | USGS GNIS populated places, 16,719 (extinct "historical" names removed) | WV, MD, VA, PA, DC around the basin |

To rebuild, run `node apps/trails/scripts/bake-data.mjs --samples <folder>`. The folder must hold the
2026-11-05 GNIS and neighbor-flowline captures, which aren't committed yet.

## Trail data and the license

OpenStreetMap data is under the Open Database License. The merged files, `public/data/trails/` and
`public/data/hikes.json`, count as a derived database, so they must stay available under that
license and credit OpenStreetMap. The app shows the credit and ships `TRAILS-LICENSE.txt` beside
the data. The app's own code and recorded hikes aren't affected. Have counsel confirm this
before selling the app or keeping its data private.

Lengths come from the mapped lines and include every branch, so they won't always match a
sign. Being mapped doesn't mean a trail is open or legal to use. Neither source reliably marks ATV
or snowmobile permissions around Gormania, so roads there show as "access unknown".

## Activities

A trail appears under an activity only if USGS or OpenStreetMap explicitly marks it for that, and the
app says "marked for", never "allowed". The one exception is walking on an ordinary footpath, which is
assumed unless a source says no. Blank USGS flags mean the source didn't say. An ATV marking says
nothing about wider UTVs, so they stay separate in the data. Most local motorized and groomed-snow
trails are poorly mapped in open data, so the land managers' own maps should replace these lists where
they can be used.

## Conditions

Phones reach these directly, since the site has no server. A section that fails falls back to its last
saved reading and says when it's from.

| Section | Source | Sent to it |
| --- | --- | --- |
| Alerts and forecast | National Weather Service | Location rounded to about two-thirds of a mile |
| Snow | NOAA NOHRSC modeled depth, in meters | Same rounded location |
| Rivers | USGS `latest-continuous`, replacing WaterServices, which shuts down February 22, 2027 | Nothing about the person: always the whole region |

It never judges safety, and it can't see closures or grooming, so it links to land managers for those.
Pennsylvania's park road data has snowmobile status and grooming fields, which could help once DCNR
gives permission.

## Trail details

Climb is an estimate from elevation samples about 145 ft apart. Mapped lines have no real direction, so
each counts its harder way, which can overstate a trail that goes up and back down. Estimated effort uses the National Park Service's Shenandoah
formula, the square root of gain times 2 times miles, which the park itself calls approximate because it
misses short steep trails. Difficulty, dogs, wheelchair access and visibility appear only where
OpenStreetMap tags cover enough of the trail, and always read "mapped as".

## Official sources

Land managers outrank community data. Checked 2026-11-05:

| Source | Terms found | How it's used |
| --- | --- | --- |
| US Forest Service trails | No access limits, no warranty | Bundled. Where a line runs along a mapped trail, it opens and closes uses there |
| Maryland DNR Trail Atlas | Marked MDDNR, no license stated | Not bundled. Used once to check our Maryland motor listings |
| West Virginia statewide trails | No trail-specific terms found | Not bundled |
| Pennsylvania DCNR park trails | Demonstration, education, planning and monitoring only, with a hold-harmless clause | Not bundled |

Anything not bundled can be added once the agency gives permission. Until then the app links to their
pages through `data-sources/official.source.json`, and `data-sources/corrections.source.json` records
trail-by-trail changes backed by a published land manager statement. A correction matching no trail stops
the bake.

## Trip planner and outfitters

Plan a trip (`/trails/#plan`) takes a town from `data-sources/stays.source.json` and a set of activities,
then lists the nearest trails, land manager pages, outfitters and the site's guides. Distances are
straight lines. `data-sources/outfitters.source.json` holds businesses whose own page, or a park or
tourism page, states the service, placed by town and cross-checked against the county the source names.
Re-check it before each season. It has no paid placements.

## 3D

With signal and a Mapbox token, 3D uses Mapbox's outdoors map on its terrain, the same as the site's
adventure map. The token comes from `/map-config.json`, which the site's build writes. Without signal
or a token, or if Mapbox refuses the token, the app uses its own saved terrain, or the flat map if that
area's terrain isn't on the phone. The Mapbox map is kept when leaving 3D, since each new one counts as
a billed map load.

## High-detail tracking

Every fix that passes the accuracy and spike checks is saved and exported in GPX, up to whatever
rate the phone reports. Distance and the drawn line use a filtered path through those fixes, which
only moves on past about 10 ft, so GPS wobble can't inflate the miles. Marked spots average the
readings taken while the mark dialog is open. A phone's GPS is usually good to several yards at
best, and more points add detail without making any single point more accurate.

## Photos

A photo's location comes from its own GPS tag, then from the recorded route by time, then from the
current position if it was taken in the last 10 minutes. Otherwise it waits to be placed by hand.
Photos are stored only on the phone, at up to 1,600 px, and re-encoding removes their metadata.
There is no backup, so they are lost if browser data is cleared.

## Checkpoints

Ten real places to reach on foot, with nothing placed on the ground. Within a checkpoint's radius
plus up to 50 ft for GPS error, a Check in button appears, with no signal needed. Readings coarser
than about 165 ft or older than 30 seconds don't count. Check-ins stay on the phone, so there's no
leaderboard, and they can't be proven: anyone faking GPS could check in. Anything competitive needs
a server and some thought about cheating. Places whose approach crosses private land, like
Hoye-Crest, are left out on purpose.

## Backup

Optional and off by default. Signing in uses an 8-digit code by email, because a link would open
Safari rather than an app installed on an iPhone's home screen. Finished hikes, marked spots,
check-ins and photos are copied to Cloudflare (an index in D1, the contents in R2), and the newest
change to each item wins across phones. Backup runs while the app is open and has signal.

Tracks are location history, so:

- Every item can only be reached with its owner's session cookie, and is served as an inert download.
- Only hashes of sign-in codes and session tokens are stored.
- Sign-in guesses are limited per code, per day per email address, and per network address. Every
  new sign-in sends an email. Sessions end after 30 idle days and at 90 days regardless.
- Sending, new accounts, writes and upload volume have caps, so one person can't run up the bill.
  The default of 90 emails a day suits a small free mail plan. Set `HIKE_MAIL_PER_DAY` to raise it.
- Deleting an account needs a fresh emailed code. "Sign out other phones" handles a lost phone.
- If more than 6 items disappear from a backup at once, a phone keeps its copies until told otherwise.
  Removing something from the backup itself is immediate and can't be undone.
- Data is encrypted at rest by Cloudflare but isn't end-to-end encrypted, and the app says so.
- People can delete their account and all of its data from the app.

### Turning it on

This site is on Netlify, which can't run `functions/api/hike` (a Cloudflare Pages Function). Until the backup API is hosted, or the site moves to Cloudflare Pages, `/api/hike/*` answers 404 and the app says backup isn't set up. On Cloudflare, without the steps below, it answers 503 and the app says the same.

1. Create the database and storage, under Workers & Pages in Cloudflare:
   `wrangler d1 create trail-backup` and `wrangler r2 bucket create trail-backup`.
2. Load the tables: `wrangler d1 execute trail-backup --remote --file apps/trails/server/schema.sql`.
3. In the Pages project, under Settings > Bindings, bind D1 as `HIKE_DB` and R2 as `HIKE_BUCKET`.
   Do this for Preview and Production separately, and use separate resources for each.
4. Under Variables and Secrets, add these as encrypted values:
   - `RESEND_API_KEY`, for a sending domain verified in Resend
   - `HIKE_MAIL_FROM`, such as `Garrett County Adventures <signin@garrettcountyadventures.com>`
   - `HIKE_CODE_PEPPER`, a long random value that must not change, from `openssl rand -hex 32`
5. Redeploy.

Before real users rely on it, publish a privacy policy covering location data and backup, and move
the app and API to their own subdomain. Today the session cookie shares an origin with the whole
marketing site, so a script-injection bug on any page could reach backups.

## Geocaching

Listings are never bundled or fetched. The Geocaching.com API is for approved partners, so hikers
load a GPX file they are entitled to use, and it stays on the phone. Found marks are local and don't
reach any listing site. Opencaching's OKAPI is a possible open source of listings, but its data
license still needs checking. Placing caches isn't offered, since land managers usually require
approval.

## 3D view

The 3D button drapes the same map drawing (topo, trails, streams, hike route and your track) over
USGS ground elevation, with height shown at 1.5 times real so hills read on a phone. Drag to turn
and tilt, pinch to zoom. It covers the same region as the trail data and draws only when something
changes. The ground texture refreshes about every 8 seconds, while your position marker updates with
each GPS fix. Saving a map area also saves its terrain.

## Known limits

- **3D battery use hasn't been measured on a phone.** It's meant for looking around, with 2D as the
  default for long recording. Tracking runs the same in either view.
- **Phone locked means no tracking.** Browsers stop reporting location to a web app that is
  locked or in the background. The app holds the screen awake, keeps recording in the open, and
  records any silence as an untracked gap instead of drawing a false straight line. Reliable
  screen-off tracking needs a native wrapper.
- **No routing.** Hikes are mapped lines with an off-route warning, not turn-by-turn directions.
  Trailheads and parking come from OpenStreetMap, weren't checked in person, and are missing for
  9 of the 29 hikes. Driving directions hand off to Google Maps and need signal.
- **Climb uses GPS altitude,** which is much noisier than horizontal position. Treat it as an estimate.
- **Compass correction is one fixed value** (`REGION_DECLINATION_DEGREES`) that is only roughly right
  for this region. A wider release needs the World Magnetic Model.
- **Not safety equipment.** Bearings are straight lines, not walkable routes.
