// Public, searchable trail pages, built from the same data as the trail app. They use no scripts and
// no outside map, so a page costs a visitor nothing and tells no one but the host that they read it.
import fs from 'node:fs';
import { ACTIVITIES, activityNames, ATV, DIRT_BIKE, routeLines, SNOWMOBILE, UTV } from '../apps/trails/public/modules/activities.js';
import { distanceMiles, formatFeet } from '../apps/trails/public/modules/geo.js';
import { areaWarning, directionsUrl } from '../apps/trails/public/modules/hikes.js';
import { shardsForBounds } from '../apps/trails/public/modules/landscape.js';
import { climbIsReliable, detailFacts, profilePath } from '../apps/trails/public/modules/trail-details.js';
import { decodeTrail } from '../apps/trails/public/modules/trails.js';

const DATA = new URL('../apps/trails/public/data/', import.meta.url);
const readData = name => JSON.parse(fs.readFileSync(new URL(name, DATA), 'utf8'));

const MIN_MILES = 0.5;
const SHORT_WITHOUT_ACCESS_MILES = 1.5;
const MOTORIZED = SNOWMOBILE | ATV | UTV | DIRT_BIKE;
const GENERIC_NAME = /^((blue|green|red|yellow|orange|white|black|purple|pink) )?(trail|route)$|^(access road|connector( trail| old)?|designated route|forest road|bushwhack|crosscut|service road|old road|snowmobile route|trail no \d+|fire trail #?\d+|fr \d+|sgl \d+ designated route|(mtb|bike|loop|interpretive) trail|redesign|prologue|pipeline( trail)?)$/i;
const NOT_A_DESTINATION = /\b(connector|connection|spur|bypass|access|parking|shortcut|unofficial|closed|abandoned|private|hunter|disabled|segment|section|tunnel|viaduct|via|archery)\b/i;
// Notes left by mappers, or things that aren't a trail to visit.
const MAPPING_NOTE = /not correct|under construction|gpsed|right of way|railroad$|sled run|disc golf|walkway|\bto$/i;
const ROAD_NAME = /\b(road|rd|street|lane|ln|drive|dr|avenue|ave|highway|hwy|pike)\b/i;

const confirmedByManager = route => Boolean(route.official) || route.sources.includes('usfs');

// Why a route doesn't get a public page, or null if it does. A search result reaches far more people
// than the app's list, so this is stricter than what the app shows, and a motorized listing needs the
// land manager behind it: a wrong one can cost someone a fine.
export function holdReason(route) {
  if (route.miles < MIN_MILES) return 'short';
  if (!route.activities) return 'no marked use';
  if (GENERIC_NAME.test(route.name.trim())) return 'generic name';
  if (MAPPING_NOTE.test(route.name.trim())) return 'mapping note';
  const confirmed = confirmedByManager(route);
  if (NOT_A_DESTINATION.test(route.name) && !confirmed) return 'not a destination';
  if (ROAD_NAME.test(route.name) && !confirmed) return 'road';
  if (route.activities & MOTORIZED && !confirmed) return 'motorized, not confirmed';
  if (!route.access && !confirmed && route.miles < SHORT_WITHOUT_ACCESS_MILES) return 'thin';
  return null;
}

// Two pages can't share a title, so the longest stands in for a repeated name within a county.
export function publishableRoutes(routes) {
  const longest = new Map();
  for (const route of routes.filter(item => !holdReason(item))) {
    const key = `${route.name.toLowerCase()}|${route.county}`;
    if (!longest.has(key) || longest.get(key).miles < route.miles) longest.set(key, route);
  }
  return [...longest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const countySlug = county => county.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
export const trailPath = route => `/trail/${route.id}.html`;
export const countyPath = county => `/trails-in/${countySlug(county)}.html`;
export const DIRECTORY_PATH = '/trail-directory.html';
export const HUNTING_PATH = '/hunting.html';

const milesText = miles => `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const countiesOf = route => route.counties || [route.county];
const showsClimb = route => climbIsReliable(route) && Number.isFinite(route.climbFeet);

function loadLines(route, shards) {
  const loaded = shardsForBounds(route.bounds).map(key => {
    if (!shards.has(key)) {
      const file = new URL(`trails/${key}.json`, DATA);
      shards.set(key, fs.existsSync(file) ? { lines: JSON.parse(fs.readFileSync(file, 'utf8')).lines.map(decodeTrail) } : null);
    }
    return shards.get(key);
  });
  return routeLines(loaded, route);
}

// Drawn north-up, with distances true to scale at the trail's own latitude.
export function outlineSvg(route, lines, escapeHtml) {
  const WIDTH = 640;
  const PAD = 24;
  const { south, north, west, east } = route.bounds;
  const squeeze = Math.cos(((south + north) / 2) * (Math.PI / 180));
  const wide = Math.max((east - west) * squeeze, 1e-4);
  const tall = Math.max(north - south, 1e-4);
  const height = Math.min(Math.round(WIDTH * (tall / wide)), 420) + PAD * 2;
  const scale = Math.min((WIDTH - PAD * 2) / wide, (height - PAD * 2) / tall);
  const left = (WIDTH - wide * scale) / 2;
  const top = (height - tall * scale) / 2;
  const x = lon => left + (lon - west) * squeeze * scale;
  const y = lat => top + (north - lat) * scale;
  const paths = lines.map(({ points }) => {
    let last = null;
    const kept = points.filter((point, index) => {
      const place = [x(point.lon), y(point.lat)];
      if (last && index < points.length - 1 && Math.hypot(place[0] - last[0], place[1] - last[1]) < 1.5) return false;
      last = place;
      return true;
    });
    return kept.map((point, index) => `${index ? 'L' : 'M'}${x(point.lon).toFixed(1)} ${y(point.lat).toFixed(1)}`).join('');
  }).join('');
  const milesAcross = distanceMiles({ lat: north, lon: west }, { lat: north, lon: west + (WIDTH - PAD * 2) / scale / squeeze });
  const barMiles = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50].filter(value => value <= milesAcross / 3).at(-1) || 0.1;
  const barWidth = (barMiles / milesAcross) * (WIDTH - PAD * 2);
  const spots = (route.access || []).map(spot => `<circle class="trail-outline-spot" cx="${x(spot.lon).toFixed(1)}" cy="${y(spot.lat).toFixed(1)}" r="5"/>`).join('');
  return `<figure class="trail-figure"><svg class="trail-outline" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeHtml(`Outline of ${route.name}, north at the top`)}"><path class="trail-outline-line" d="${paths}"/>${spots}<path class="trail-outline-scale" d="M${PAD} ${height - 12}h${barWidth.toFixed(1)}"/><text class="trail-outline-text" x="${PAD}" y="${height - 18}">${barMiles} mi</text><text class="trail-outline-text" x="${WIDTH - PAD}" y="${PAD}" text-anchor="end">N ↑</text></svg><figcaption>Mapped trail lines${route.access ? ', with parking and trailheads as dots' : ''}. Not for navigation.</figcaption></figure>`;
}

function profileSvg(route, escapeHtml) {
  if (!route.profile?.length) return '';
  const low = Math.min(...route.profile);
  const high = Math.max(...route.profile);
  const WIDTH = 640;
  const HEIGHT = 110;
  return `<figure class="trail-figure"><svg class="trail-profile" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeHtml(`Elevation from ${formatFeet(low)} to ${formatFeet(high)}`)}" preserveAspectRatio="none"><path d="${profilePath(route.profile, WIDTH, HEIGHT - 4)}"/></svg><figcaption>Elevation from ${formatFeet(low)} to ${formatFeet(high)}, along ${milesText(route.profileMiles)} of the longest mapped section.</figcaption></figure>`;
}

const SOURCE_CREDITS = {
  osm: '<a href="https://www.openstreetmap.org/copyright" rel="noopener">© OpenStreetMap contributors</a>',
  usgs: 'USGS National Digital Trails',
  usfs: 'USDA Forest Service',
};

const shell = ({ siteUrl, escapeHtml, path, title, description, jsonLd, crumbs, heading, dek, body }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#203a31">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${siteUrl}${path}">
  <link rel="stylesheet" href="/site.css">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/images/gcadv-logo.png" type="image/png">
  <title>${escapeHtml(title)}</title>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Garrett County Adventures">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${siteUrl}${path}">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body class="editorial-page">
  <header class="editorial-header"><a class="editorial-brand" href="/" aria-label="Garrett County Adventures home">Garrett County Adventures</a><nav aria-label="Main navigation"><a href="${DIRECTORY_PATH}">Trails</a><a href="/trails/">Trail app</a></nav></header>
  <main class="article-main">
    <div class="article-layout no-contents"><article class="guide-article">
      <nav class="breadcrumbs" aria-label="Breadcrumb">${crumbs.map(([label, href]) => (href ? `<a href="${href}">${escapeHtml(label)}</a><span aria-hidden="true">/</span>` : `<span aria-current="page">${escapeHtml(label)}</span>`)).join('')}</nav>
      <h1>${escapeHtml(heading)}</h1>
      <p class="article-dek">${escapeHtml(dek)}</p>
      <div class="article-body">${body}</div>
    </article></div>
    <footer class="editorial-footer"><a href="${DIRECTORY_PATH}">Browse trails by county</a><a href="/#trip-guides">Browse trip guides</a><a href="/trails/">Open the trail app</a><a href="${HUNTING_PATH}">Hunting and trapping</a><a href="/privacy.html">Privacy</a></footer>
  </main>
</body>
</html>`;

const breadcrumbData = (siteUrl, crumbs) => ({
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map(([name, href], index) => ({ '@type': 'ListItem', position: index + 1, name, ...(href ? { item: `${siteUrl}${href}` } : {}) })),
});

export function trailPage(route, lines, nearby, { siteUrl, escapeHtml, hikes = [] }) {
  const marked = activityNames(route.activities);
  const counties = countiesOf(route);
  const others = counties.filter(county => county !== route.county);
  // Climb and effort already have a card of their own.
  const facts = detailFacts({ ...route, climbFeet: undefined, effort: undefined });
  const description = `${route.name} in ${route.county}: ${milesText(route.miles)} of mapped trail, marked for ${listText(marked)}${showsClimb(route) && route.climbFeet >= 50 ? `, with about ${formatFeet(route.climbFeet)} of climbing` : ''}. See the outline, elevation and parking.`;
  const crumbs = [['Trails', DIRECTORY_PATH], [route.county, countyPath(route.county)], [route.name, null]];
  const closed = route.noUse ? `<li>Forest Service: no ${escapeHtml(activityNames(route.noUse).join(', no '))}</li>` : '';
  const seasons = Object.entries(route.seasons || {}).map(([bit, text]) => `<li>Forest Service season for ${escapeHtml(activityNames(Number(bit))[0])}: ${escapeHtml(text)}</li>`).join('');
  const official = route.official ? `<p class="trail-official">${escapeHtml(route.official.note)} <a href="${escapeHtml(route.official.url)}" rel="noopener">${escapeHtml(route.official.label)}</a>.</p>` : '';
  const warning = areaWarning(route, hikes);
  const way = route.access?.[0] || route.center;
  const access = (route.access || []).map(spot => {
    const label = `${spot.type === 'trailhead' ? 'Trailhead' : 'Parking'}${spot.name ? `: ${spot.name}` : ''}`;
    return `<li>${escapeHtml(label)}, about ${escapeHtml(formatFeet(spot.feet))} from the mapped trail. <a href="${escapeHtml(directionsUrl(spot))}" rel="noopener">Driving directions</a></li>`;
  }).join('');
  const body = `
    ${warning ? `<p class="trail-warning"><strong>Safety warning.</strong> ${escapeHtml(warning)}</p>` : ''}
    ${official}
    <ul class="trail-facts">
      <li><strong>${milesText(route.miles)}</strong><span>mapped trail</span></li>
      ${showsClimb(route) ? `<li><strong>${route.climbFeet < 50 ? 'Nearly flat' : formatFeet(route.climbFeet)}</strong><span>${route.climbFeet < 50 ? 'little climbing' : 'climbing, going the harder way'}</span></li>` : ''}
      ${route.effort && climbIsReliable(route) ? `<li><strong>${escapeHtml(route.effort)}</strong><span>estimated effort, from length and climb</span></li>` : ''}
      ${route.surface && route.miles < 10 ? `<li><strong>${escapeHtml(route.surface[0].toUpperCase() + route.surface.slice(1))}</strong><span>mapped surface</span></li>` : ''}
    </ul>
    <p class="trail-actions"><a class="button button-primary" href="/trails/#trail=${escapeHtml(route.id)}">Open in the trail app</a><a class="button" href="${escapeHtml(directionsUrl(way))}" rel="noopener">Driving directions</a></p>
    ${outlineSvg(route, lines, escapeHtml)}
    ${profileSvg(route, escapeHtml)}
    <h2>Marked for</h2>
    <p>${escapeHtml(listText(marked.map((name, index) => (index ? name : name[0].toUpperCase() + name.slice(1)))))}.</p>
    <p class="trail-caution">That comes from map data and can be wrong or out of date. Confirm the rules, closures and any permit with the land manager before you go.</p>
    <p class="trail-caution"><strong>Hunting season:</strong> this trail may be on or near land open to hunting. In season, wear blaze orange or other high-visibility colors, and put some on your dog. <a href="${HUNTING_PATH}">See season dates and safety</a>.</p>
    ${facts.length || closed || seasons ? `<h2>What the map data says</h2><ul>${facts.map(fact => `<li>${escapeHtml(fact)}</li>`).join('')}${closed}${seasons}</ul>` : ''}
    ${access ? `<h2>Getting there</h2><ul>${access}</ul>` : ''}
    ${others.length ? `<p>This trail also reaches ${escapeHtml(listText(others))}. The length covers only what's mapped in this region, and it includes every mapped branch, so it may not match a sign or the loop you plan.</p>` : '<p>The length includes every mapped branch, so it may not match a sign or the loop you plan.</p>'}
    ${nearby.length ? `<h2>Trails nearby</h2><ul>${nearby.map(({ route: other, miles }) => `<li><a href="${trailPath(other)}">${escapeHtml(other.name)}</a>, about ${Math.max(1, Math.round(miles))} mi away</li>`).join('')}</ul>` : ''}
    <p class="trail-credit">Trail data: ${route.sources.map(source => SOURCE_CREDITS[source]).filter(Boolean).join(', ')}. <a href="/trails/data/TRAILS-LICENSE.txt">Data license</a>.</p>`;
  return {
    name: trailPath(route).slice(1),
    source: shell({
      siteUrl, escapeHtml, path: trailPath(route), crumbs, body, description,
      title: `${route.name}, ${route.county}: Trail Map and Details`,
      heading: route.name,
      dek: `${route.county}. Marked for ${listText(marked)}.`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'TouristAttraction', name: route.name, description, url: `${siteUrl}${trailPath(route)}`, geo: { '@type': 'GeoCoordinates', latitude: route.center.lat, longitude: route.center.lon } },
          breadcrumbData(siteUrl, crumbs),
        ],
      },
    }),
  };
}

const trailRow = (route, escapeHtml) => `<li><a href="${trailPath(route)}">${escapeHtml(route.name)}</a> <small>${milesText(route.miles)}${showsClimb(route) && route.climbFeet >= 50 ? `, ${formatFeet(route.climbFeet)} of climbing` : ''}</small></li>`;

function countyPage(county, routes, { siteUrl, escapeHtml }) {
  const crumbs = [['Trails', DIRECTORY_PATH], [county, null]];
  const sections = ACTIVITIES.map(activity => {
    const listed = routes.filter(route => route.activities & activity.mask);
    return listed.length ? `<h2 id="${activity.id}">${escapeHtml(activity.label)} (${listed.length})</h2><ul class="trail-list">${listed.map(route => trailRow(route, escapeHtml)).join('')}</ul>` : '';
  }).join('');
  const description = `${routes.length} trails in ${county}, with length, climb and what each is marked for: ${ACTIVITIES.filter(activity => routes.some(route => route.activities & activity.mask)).map(activity => activity.label.toLowerCase()).join(', ')}.`;
  return {
    name: countyPath(county).slice(1),
    source: shell({
      siteUrl, escapeHtml, path: countyPath(county), crumbs, description,
      title: `Trails in ${county}: Hiking, Biking and More`,
      heading: `Trails in ${county}`,
      dek: `${routes.length} trails with a page of their own. The trail app lists more.`,
      jsonLd: { '@context': 'https://schema.org', ...breadcrumbData(siteUrl, crumbs) },
      body: `<p class="trail-caution">"Marked" means a map source says so. Confirm the rules, closures and any permit with the land manager before you go.</p>${sections}`,
    }),
  };
}

function directoryPage(counties, official, { siteUrl, escapeHtml }) {
  const crumbs = [['Trails', null]];
  const places = official.map(place => `<li><a href="${escapeHtml(place.url)}" rel="noopener">${escapeHtml(place.name)}</a>, ${escapeHtml(place.place)}<br><small>${escapeHtml(place.about)}</small></li>`).join('');
  return {
    name: DIRECTORY_PATH.slice(1),
    source: shell({
      siteUrl, escapeHtml, path: DIRECTORY_PATH, crumbs,
      title: 'Trails Around Garrett County: Maryland, West Virginia and Pennsylvania',
      description: 'Hiking, biking, skiing, horse and off-road trails around Garrett County, MD, including Allegany County and nearby West Virginia and Pennsylvania counties.',
      heading: 'Trails around Garrett County',
      dek: 'Hiking, biking, skiing and riding in the mountains of Maryland, West Virginia and Pennsylvania.',
      jsonLd: { '@context': 'https://schema.org', ...breadcrumbData(siteUrl, crumbs) },
      body: `<h2>Browse by county</h2><ul class="trail-list">${counties.map(([county, routes]) => `<li><a href="${countyPath(county)}">${escapeHtml(county)}</a> <small>${routes.length} trails</small></li>`).join('')}</ul>
      <p><a href="/trails/#plan">Plan a trip in the trail app</a> to see what's closest to where you're staying.</p>
      <h2>Snowmobile, ATV and UTV riding</h2>
      <p>Riding rules change by the season and the land manager, so we only give a motorized trail its own page when a land manager confirms it. Start with the managers below, and see the <a href="/trails/">trail app</a> for trails a map source marks for riding.</p>
      <h2>Hunting and trapping</h2>
      <p>Many of these trails are on or near land open to hunting. In season, wear blaze orange or other high-visibility colors. <a href="${HUNTING_PATH}">See season dates, safety and each state's rules</a>.</p>
      <h2>Parks and forests</h2><ul class="trail-places">${places}</ul>`,
    }),
  };
}

const longDate = day => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function huntingPage({ season, checkedAt, firearms, states }, { siteUrl, escapeHtml }) {
  const crumbs = [['Trails', DIRECTORY_PATH], ['Hunting and trapping', null]];
  const dateRows = firearms.map(({ name, from, to, label, area }) => `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(longDate(from))} to ${escapeHtml(longDate(to))}</td><td>${escapeHtml(label)}. ${escapeHtml(area)}.</td></tr>`).join('');
  const stateSections = states.map(({ name, sundays, links }) => `<h3>${escapeHtml(name)}</h3><p>${escapeHtml(sundays)}</p><ul>${links.map(({ label, url }) => `<li><a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(label)}</a></li>`).join('')}</ul>`).join('');
  return {
    name: HUNTING_PATH.slice(1),
    source: shell({
      siteUrl, escapeHtml, path: HUNTING_PATH, crumbs,
      title: 'Hunting and Trapping Around Garrett County: Seasons and Rules',
      description: `${season} firearms deer season dates and official hunting and trapping links for Maryland, West Virginia and Pennsylvania, plus safety for anyone on the trails.`,
      heading: 'Hunting and trapping around Garrett County',
      dek: 'Season dates and official rules for hunters and trappers, and what everyone else on the trails should know.',
      jsonLd: { '@context': 'https://schema.org', ...breadcrumbData(siteUrl, crumbs) },
      body: `
      <p class="trail-caution">This is a starting point, not the law. Each state's own regulations decide, and rules differ by county, land and season. Dates were checked ${escapeHtml(longDate(checkedAt))}.</p>
      <h2>If you're hiking or riding where people hunt</h2>
      <p>Many trails here cross land open to hunting, including state forests, game lands and national forest. Even if you aren't hunting:</p>
      <ul>
        <li><strong>Wear high-visibility colors.</strong> Blaze orange is best, on your head and upper body so you can be seen from every side.</li>
        <li><strong>Put high-visibility colors on your dog,</strong> like an orange vest or collar, and keep it close.</li>
        <li><strong>Avoid white, tan, brown and black.</strong> These can look like game through the trees.</li>
        <li><strong>Take extra care at dawn and dusk,</strong> when many hunters are out and it's harder to see you.</li>
        <li><strong>Stay on the trail and be easy to hear.</strong> Talking as you go lets hunters know you're there.</li>
        <li><strong>Don't count on Sundays being quiet.</strong> All three states have Sunday hunting here.</li>
        <li><strong>Check with the land manager if you're unsure.</strong> Some areas close to other uses during firearms season.</li>
      </ul>
      <h2>Firearms deer season, ${escapeHtml(season)}</h2>
      <table><thead><tr><th scope="col">State</th><th scope="col">Dates</th><th scope="col">Season</th></tr></thead><tbody>${dateRows}</tbody></table>
      <p>Other seasons, including archery, muzzleloader, bear and turkey, run at other times. Each state's calendar below has them all.</p>
      <h2>Rules, licenses and trapping seasons</h2>
      ${stateSections}
      <h2>Public land</h2>
      <p>Public land isn't automatically open to hunting or trapping. Parks and other areas have their own limits, and the land manager or state rules decide. Know whose land you're on, since this site doesn't show private property lines.</p>
      <h2>Using the trail app in the field</h2>
      <p>The <a href="/trails/">trail app</a> shows your GPS position on a topographic map and works with no signal once you've saved an area. You can mark spots, like your truck or a stand, and they stay on your phone. We never receive them.</p>`,
    }),
  };
}

export function buildTrailPages({ siteUrl, escapeHtml }) {
  const { routes, counties } = readData('routes.json');
  const { official } = readData('official.json');
  const { hikes } = readData('hikes.json');
  const context = { siteUrl, escapeHtml, hikes };
  const shards = new Map();
  const withLines = publishableRoutes(routes).map(route => ({ route, lines: loadLines(route, shards) })).filter(({ lines }) => lines.length);
  const published = withLines.map(({ route }) => route);
  const pages = withLines.map(({ route, lines }) => {
    const nearby = published.filter(other => other !== route)
      .map(other => ({ route: other, miles: distanceMiles(route.center, other.center) }))
      .sort((a, b) => a.miles - b.miles).slice(0, 5);
    return trailPage(route, lines, nearby, context);
  });
  const byCounty = counties.map(county => [county, published.filter(route => countiesOf(route).includes(county))]).filter(([, listed]) => listed.length);
  pages.push(...byCounty.map(([county, listed]) => countyPage(county, listed, context)));
  pages.push(directoryPage(byCounty, official, context));
  pages.push(huntingPage(readData('hunting.json'), context));
  return pages;
}
