// Wires the sensors, recorder, map and panels together. Decisions live in the other modules.
import { bearingDegrees, compassPoint, distanceMiles, feetPerPixel, formatCoordinates, formatDistance, formatDuration, formatFeet, formatPace, project } from './geo.js';
import { compassNeedsPermission, createScreenLock, startCompass, watchGps } from './device.js';
import { gpxFileName, toGpx } from './gpx.js';
import * as backup from './backup.js';
import { arrivedAt, groupCheckpoints, progress, progressText } from './checkpoints.js';
import { cacheFacts, MAX_FILE_BYTES, mergeCaches, nearestFirst, parseGpx } from './geocaches.js';
import { ACTIVITIES, activityById, activityNames, filterRoutes, matchesActivity, routeLines } from './activities.js';
import { fetchConditions, gaugeText, isFresh, roughly, snowText, withSaved } from './conditions.js';
import { detailFacts, profilePath } from './trail-details.js';
import { nearbyDirectory, NEARBY_MILES, planTrip, seasonalActivities } from './planner.js';
import { accessFact, boundsCenter, decodeHike, directionsUrl, groupHikes, hikeFacts, nearestAccess, routeProgress, withMargin } from './hikes.js';
import { buildPlaceIndex, decodeLine, nearestOnLines, nearestPlace, nearestWater, shardKey, shardsForBounds, SHARD_DEGREES } from './landscape.js';
import { scaleBar, TopoMap } from './map.js';
import { clearSaved, planArea, saveArea, tileUrl, TILE_MAX_ZOOM } from './offline.js';
import * as store from './store.js';
import { nearestMarker, PLACE_LABELS, placePhoto, readExif, scaledSize } from './photos.js';
import { EXAGGERATION } from './mapbox-settings.js';
import { point as pointFeature, readToken, routeFeatures, streamFeatures, trailFeatures } from './mapbox-data.js';
import { hasTerrainAt, needsNewWindow, stitchWindow, viewWindow, windowBlocks, blockKey } from './terrain.js';
import { averagePosition, createRecorder, elapsedSeconds, routeLine, RULES } from './tracker.js';
import { decodeTrail, KIND_LABELS } from './trails.js';

const $ = id => document.getElementById(id);
const LOST_SIGNAL_MS = 30000;
const WATER_MIN_ZOOM = 11;
const TRAIL_MIN_ZOOM = 11;
const TRACK_MIN_ZOOM = 13;
const NEAREST_TRAIL_MILES = 1;
const PARKING_GUIDE_MILES = 0.5; // Closer than this to the trail, just head for the trail.
const MARKER_MIN_ZOOM = 11;
const PHOTO_LONGEST_SIDE = 1600;
const THUMB_LONGEST_SIDE = 160;
const LISTED_CACHES = 100;
const CHECKPOINT_MIN_ZOOM = 9; // Visible from further out than other markers, to invite a visit.
const STREAM_REFERENCE_ZOOM = 16;
const ARRIVED_MILES = 100 / 5280;

const state = {
  fix: null,
  fixAt: 0,
  gpsError: null,
  stopGps: null,
  follow: false,
  heading: null,
  compassOn: false,
  hike: null,
  recorder: null,
  spots: [],
  areas: [],
  viewing: null, // A finished hike drawn on the map: { hike, points }.
  target: null,
  showWater: true,
  showTrails: true,
  shardIndex: [],
  trailIndex: [],
  terrainIndex: [],
  threeD: false,
  shards: new Map(), // key -> { lines, paths, originX, originY } | 'loading'
  trailShards: new Map(),
  hikes: null,
  route: null, // The hike being followed, with its lines decoded.
  progress: null,
  reachedRoute: false,
  places: null,
  notedGaps: 0,
  saving: null,
  markFixes: [],
  fixSeconds: null,
  photos: [],
  photoImages: new Map(), // id -> a loaded thumbnail, ready to draw on the map.
  viewingPhoto: null,
  geocaches: [],
  viewingCache: null,
  backupEmail: null,
  backupAvailable: true,
  backupTimer: null,
  backupRunning: false,
  backupLast: null,
  checkpoints: [],
  checkins: [],
  viewingCheckpoint: null,
  arrival: null,
  saveBounds: null, // A chosen hike's area; otherwise saving takes what's on screen.
  markFix: null,
};

let view = null; // The map currently being drawn on: the screen's, or the 3D ground texture.

const dataUrl = path => new URL(`../data/${path}`, import.meta.url).href;
const screenLock = createScreenLock(held => { $('screen').hidden = !held; });

const map = new TopoMap($('map'), {
  tileUrl,
  tileMaxZoom: TILE_MAX_ZOOM,
  onDraw: drawOverlays,
  onUserMove: () => setFollow(false),
  onTap: handleMapTap,
  onViewChange: viewChanged,
  onTileStatus: ok => {
    if (ok) hideNotice('map');
    else if (!navigator.onLine) showNotice('map', 'This part of the map isn\'t saved. GPS and your route still work.');
  },
});

viewChanged();

/* Notices: one at a time, most recent wins. */
let noticeKey = null;
function showNotice(key, text) {
  noticeKey = key;
  $('notice').textContent = text;
  $('notice').hidden = false;
}
function hideNotice(key) {
  if (noticeKey === key) {
    noticeKey = null;
    $('notice').hidden = true;
  }
}

/* Map overlays */
function strokePoints(ctx, points) {
  let segment = null;
  ctx.beginPath();
  for (const point of points) {
    const { x, y } = view.toScreen(point.lat, point.lon);
    if (point.seg !== segment) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    segment = point.seg;
  }
  ctx.stroke();
}

function drawRoute(ctx, points, color) {
  if (!points.length) return;
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 8;
  strokePoints(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4.5;
  strokePoints(ctx, points);
}

function drawStreams(ctx) {
  if (!state.showWater || view.zoom < WATER_MIN_ZOOM) return;
  const factor = 2 ** (view.zoom - STREAM_REFERENCE_ZOOM);
  const middle = project(view.center.lat, view.center.lon, view.zoom);
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 102, 214, 0.75)';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const key of shardsForBounds(view.bounds())) {
    const shard = state.shards.get(key);
    if (!shard?.paths) continue;
    ctx.save();
    ctx.translate(view.width / 2 - middle.x + shard.originX * factor, view.height / 2 - middle.y + shard.originY * factor);
    ctx.scale(factor, factor);
    shard.paths.forEach((path, tier) => {
      ctx.lineWidth = [1.4, 2.2, 3.4][tier] / factor;
      ctx.stroke(path);
    });
    ctx.restore();
  }
  ctx.restore();
}

const TRAIL_STYLES = [
  { kind: 'track', color: 'rgba(80, 80, 80, 0.8)', width: 1.6, dash: [5, 5], minZoom: TRACK_MIN_ZOOM },
  { kind: 'ski', color: 'rgba(0, 121, 140, 0.85)', width: 1.8, dash: [6, 4], minZoom: TRAIL_MIN_ZOOM },
  { kind: 'shared', color: 'rgba(122, 47, 181, 0.9)', width: 2.4, dash: [8, 5], minZoom: TRAIL_MIN_ZOOM },
  { kind: 'foot', color: '#a8320a', width: 2.6, dash: [], minZoom: TRAIL_MIN_ZOOM },
];

function drawTrails(ctx) {
  if (!state.showTrails || view.zoom < TRAIL_MIN_ZOOM) return;
  const factor = 2 ** (view.zoom - STREAM_REFERENCE_ZOOM);
  const middle = project(view.center.lat, view.center.lon, view.zoom);
  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const key of shardsForBounds(view.bounds())) {
    const shard = state.trailShards.get(key);
    if (!shard?.paths) continue;
    ctx.save();
    ctx.translate(view.width / 2 - middle.x + shard.originX * factor, view.height / 2 - middle.y + shard.originY * factor);
    ctx.scale(factor, factor);
    for (const { kind, color, width, dash, minZoom } of TRAIL_STYLES) {
      if (view.zoom < minZoom) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = width / factor;
      ctx.setLineDash(dash.map(length => length / factor));
      ctx.stroke(shard.paths[kind]);
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawChosenHike(ctx) {
  const { route } = state;
  if (!route) return;
  if (route.kind === 'destination') {
    drawPin(ctx, { ...route.point, name: route.name }, '#00803c');
    return;
  }
  drawRoute(ctx, route.decoded.flatMap((line, seg) => line.points.map(point => ({ ...point, seg }))), '#00803c');
}

function drawPin(ctx, spot, fill) {
  const { x, y } = view.toScreen(spot.lat, spot.lon);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - 14, y - 16, x - 9, y - 30, x, y - 30);
  ctx.bezierCurveTo(x + 9, y - 30, x + 14, y - 16, x, y);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeText(spot.name, x + 13, y - 20);
  ctx.fillStyle = '#101820';
  ctx.fillText(spot.name, x + 13, y - 20);
}

function drawMe(ctx) {
  if (!state.fix || view !== map) return; // The 3D view draws its own marker.
  const { x, y } = view.toScreen(state.fix.lat, state.fix.lon);
  const radius = state.fix.accFeet / feetPerPixel(state.fix.lat, view.zoom);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(10, 108, 255, 0.16)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(10, 108, 255, 0.5)';
  ctx.stroke();
  const heading = currentHeading();
  if (heading !== null) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.lineTo(9, -7);
    ctx.lineTo(-9, -7);
    ctx.closePath();
    ctx.fillStyle = '#0a6cff';
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, 2 * Math.PI);
  ctx.fillStyle = '#0a6cff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function drawOverlays(ctx, target) {
  view = target;
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(16, 24, 32, 0.55)';
  for (const { bounds } of state.areas) {
    const a = view.toScreen(bounds.north, bounds.west);
    const b = view.toScreen(bounds.south, bounds.east);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  ctx.restore();
  drawStreams(ctx);
  drawTrails(ctx);
  drawChosenHike(ctx);
  if (state.viewing) {
    drawRoute(ctx, state.viewing.line ||= routeLine(state.viewing.points), '#6a2bd9');
    for (const spot of state.spots) if (spot.hikeId === state.viewing.hike.id) drawPin(ctx, spot, '#6a2bd9');
  }
  if (state.recorder) drawRoute(ctx, state.recorder.line, '#d6006e');
  for (const spot of visibleSpots()) drawPin(ctx, spot, '#d6006e');
  if (state.target && !state.target.spotId && !state.target.followsRoute) drawPin(ctx, state.target, '#0a6cff');
  // Thumbnails are the larger marker, so caches go on top or a nearby one would vanish.
  drawPhotos(ctx);
  drawGeocaches(ctx);
  drawCheckpoints(ctx);
  drawMe(ctx);
}

function drawCheckpoints(ctx) {
  if (view.zoom < CHECKPOINT_MIN_ZOOM) return;
  const reached = new Set(state.checkins.map(checkin => checkin.id));
  ctx.save();
  ctx.font = '700 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const checkpoint of state.checkpoints) {
    const { x, y } = view.toScreen(checkpoint.lat, checkpoint.lon);
    if (x < -20 || y < -20 || x > view.width + 20 || y > view.height + 20) continue;
    const done = reached.has(checkpoint.id);
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, 2 * Math.PI);
    ctx.fillStyle = done ? '#00803c' : '#f2a900';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = done ? '#fff' : '#101820';
    ctx.fillText(done ? '✓' : '★', x, y + 1);
  }
  ctx.restore();
}

function drawGeocaches(ctx) {
  if (view.zoom < MARKER_MIN_ZOOM) return;
  for (const cache of state.geocaches) {
    const { x, y } = view.toScreen(cache.lat, cache.lon);
    if (x < -20 || y < -20 || x > view.width + 20 || y > view.height + 20) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = cache.found ? '#6b7280' : '#00803c';
    ctx.fillRect(-9, -9, 18, 18);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(-9, -9, 18, 18);
    ctx.restore();
  }
}

function drawPhotos(ctx) {
  if (view.zoom < MARKER_MIN_ZOOM) return;
  for (const photo of state.photos) {
    if (photo.lat === null) continue;
    const { x, y } = view.toScreen(photo.lat, photo.lon);
    if (x < -30 || y < -30 || x > view.width + 30 || y > view.height + 30) continue;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 21, y - 21, 42, 42);
    const image = state.photoImages.get(photo.id);
    if (image) {
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, x - 19, y - 19, 38, 38);
    } else {
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(x - 19, y - 19, 38, 38);
    }
  }
}

const visibleSpots = () => state.spots.filter(spot => !spot.hikeId || spot.hikeId === state.hike?.id);

/* Trail and stream shards */
function buildTrailPaths(lines, originX, originY) {
  const paths = Object.fromEntries(TRAIL_STYLES.map(({ kind }) => [kind, new Path2D()]));
  for (const line of lines) {
    if (!matchesActivity(line.activities, state.activity)) continue;
    line.points.forEach((point, index) => {
      const { x, y } = project(point.lat, point.lon, STREAM_REFERENCE_ZOOM);
      if (index) paths[line.kind].lineTo(x - originX, y - originY);
      else paths[line.kind].moveTo(x - originX, y - originY);
    });
  }
  return paths;
}

async function loadTrailShard(key) {
  if (state.trailShards.has(key) || !state.trailIndex.includes(key)) return state.trailShards.get(key);
  state.trailShards.set(key, 'loading');
  try {
    const response = await fetch(dataUrl(`trails/${key}.json`));
    if (!response.ok) throw new Error(String(response.status));
    const lines = (await response.json()).lines.map(decodeTrail);
    const [row, column] = key.split('_').map(Number);
    const origin = project(row * SHARD_DEGREES, column * SHARD_DEGREES, STREAM_REFERENCE_ZOOM);
    const shard = { lines, paths: buildTrailPaths(lines, origin.x, origin.y), originX: origin.x, originY: origin.y };
    state.trailShards.set(key, shard);
    map.requestDraw();
    three.drape?.requestDraw();
    syncLive();
    return shard;
  } catch {
    state.trailShards.delete(key);
    return null;
  }
}

function buildPaths(lines, originX, originY) {
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  for (const line of lines) {
    const path = paths[line.order >= 5 ? 2 : line.order >= 3 ? 1 : 0];
    line.points.forEach((point, index) => {
      const { x, y } = project(point.lat, point.lon, STREAM_REFERENCE_ZOOM);
      if (index) path.lineTo(x - originX, y - originY);
      else path.moveTo(x - originX, y - originY);
    });
  }
  return paths;
}

async function loadShard(key) {
  if (state.shards.has(key) || !state.shardIndex.includes(key)) return state.shards.get(key);
  state.shards.set(key, 'loading');
  try {
    const response = await fetch(dataUrl(`streams/${key}.json`));
    if (!response.ok) throw new Error(String(response.status));
    const { lines: raw } = await response.json();
    const lines = raw.map(decodeLine);
    const [row, column] = key.split('_').map(Number);
    const origin = project(row * SHARD_DEGREES, column * SHARD_DEGREES, STREAM_REFERENCE_ZOOM);
    const shard = { lines, paths: buildPaths(lines, origin.x, origin.y), originX: origin.x, originY: origin.y };
    state.shards.set(key, shard);
    map.requestDraw();
    three.drape?.requestDraw();
    syncLive();
    return shard;
  } catch {
    state.shards.delete(key);
    return null;
  }
}

function viewChanged() {
  const pixels = feetPerPixel(map.center.lat, map.zoom);
  const { pixels: width, label } = scaleBar(pixels);
  $('scaleBar').style.width = `${width}px`;
  $('scaleLabel').textContent = label;
  if (state.showWater && map.zoom >= WATER_MIN_ZOOM && state.shardIndex.length) {
    shardsForBounds(map.bounds()).forEach(loadShard);
  }
  if (state.showTrails && map.zoom >= TRAIL_MIN_ZOOM && state.trailIndex.length) {
    shardsForBounds(map.bounds()).forEach(loadTrailShard);
  }
}

/* GPS */
function currentHeading() {
  if (state.heading !== null) return state.heading;
  if (state.fix?.courseDegrees !== null && state.fix?.courseDegrees !== undefined && state.fix.mph > 0.5) return state.fix.courseDegrees;
  return null;
}

function setFollow(follow) {
  state.follow = follow;
  $('locate').setAttribute('aria-pressed', String(follow));
}

function renderGps() {
  const chip = $('gps');
  if (state.gpsError) {
    chip.dataset.state = 'lost';
    chip.textContent = state.gpsError;
  } else if (!state.stopGps) {
    chip.dataset.state = 'off';
    chip.textContent = 'GPS off';
  } else if (!state.fix) {
    chip.dataset.state = 'poor';
    chip.textContent = 'Finding GPS…';
  } else if (Date.now() - state.fixAt > LOST_SIGNAL_MS) {
    chip.dataset.state = 'lost';
    chip.textContent = `No GPS for ${formatDuration((Date.now() - state.fixAt) / 1000)}`;
  } else {
    const usable = state.fix.accFeet <= RULES.worstAccuracyFeet;
    chip.dataset.state = usable ? 'good' : 'poor';
    chip.textContent = usable ? `GPS ±${Math.round(state.fix.accFeet)} ft` : `Weak GPS ±${Math.round(state.fix.accFeet)} ft`;
  }
}

function onFix(fix) {
  const first = !state.fix;
  if (state.fix && fix.t > state.fix.t) {
    const seconds = (fix.t - state.fix.t) / 1000;
    if (seconds < 60) state.fixSeconds = state.fixSeconds === null ? seconds : state.fixSeconds * 0.8 + seconds * 0.2;
  }
  if ($('markDialog').open) {
    state.markFixes.push(fix);
    renderMarkStatus();
  }
  state.fix = fix;
  state.fixAt = Date.now();
  state.gpsError = null;
  if (state.recorder && state.hike?.status === 'recording') {
    const result = state.recorder.offer(fix);
    if (result.status === 'recorded') {
      store.addPoint(state.hike.id, result.point).catch(() => showNotice('save', 'Couldn\'t save your last GPS point. This phone may be out of storage.'));
      if (state.recorder.stats.gaps > state.notedGaps) {
        state.notedGaps = state.recorder.stats.gaps;
        showNotice('gap', `No GPS for ${formatDuration(result.point.gapSeconds || 0)}, likely because the phone slept. That stretch isn't in your route.`);
      }
    }
    renderStats();
  }
  // Someone who just picked a trail is looking at it, and GPS arriving late mustn't pull them away.
  if ((first && !state.route) || state.follow) {
    map.setView(fix.lat, fix.lon, first ? Math.max(map.zoom, 15) : map.zoom);
  } else {
    redraw();
  }
  update3dPosition();
  renderGps();
  updateArrival();
  updateRouteProgress();
  renderGuide();
}

function onGpsError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    state.gpsError = 'Location blocked';
    stopGps();
    showNotice('gps', 'Location is blocked for this site. Allow it in your browser\'s site settings, then try again.');
  }
  // Timeouts and "position unavailable" are normal under tree cover, so the watch keeps running.
  renderGps();
}

function startGps() {
  if (state.stopGps) return true;
  if (!window.isSecureContext || !('geolocation' in navigator)) {
    state.gpsError = 'GPS unavailable';
    showNotice('gps', 'This browser can only use GPS on a secure (https) page.');
    renderGps();
    return false;
  }
  state.gpsError = null;
  hideNotice('gps');
  state.stopGps = watchGps(onFix, onGpsError);
  renderGps();
  return true;
}

function stopGps() {
  state.stopGps?.();
  state.stopGps = null;
}

async function ensureCompass() {
  if (state.compassOn) return;
  state.compassOn = await startCompass(heading => {
    state.heading = heading;
    redraw();
    renderGuide();
  });
}

/* Stats */
function renderStats() {
  const stats = state.recorder?.stats;
  $('statMiles').textContent = stats ? `${stats.miles.toFixed(2)} mi` : '0.00 mi';
  $('statGain').textContent = stats ? formatFeet(stats.gainFeet) : '0 ft';
  $('statPace').textContent = stats ? formatPace(stats.movingSeconds, stats.miles) : '--';
  $('statTime').textContent = state.hike ? formatDuration(elapsedSeconds(state.hike, Date.now())) : '0:00';
}

function renderButtons() {
  const { hike } = state;
  $('start').hidden = Boolean(hike);
  $('pause').hidden = !hike;
  $('finish').hidden = !hike;
  $('pause').textContent = hike?.status === 'paused' ? 'Resume' : 'Pause';
  $('pause').classList.toggle('primary', hike?.status === 'paused');
  const sheet = document.querySelector('.sheet');
  document.documentElement.style.setProperty('--sheet-height', `${sheet.offsetHeight}px`);
}

/* Hike lifecycle */
const defaultHikeName = time => `Hike on ${new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

async function startHike() {
  if (!startGps()) return;
  ensureCompass();
  const now = Date.now();
  state.hike = { id: store.newId(), name: defaultHikeName(now), status: 'recording', startedAt: now, pausedSeconds: 0, pausedAt: null, endedAt: null };
  state.recorder = createRecorder();
  state.notedGaps = 0;
  state.viewing = null;
  await store.putHike(state.hike);
  await screenLock.hold();
  setFollow(true);
  if (state.fix && Date.now() - state.fixAt < LOST_SIGNAL_MS) onFix({ ...state.fix, t: Date.now() });
  showNotice('sleep', screenLock.supported
    ? 'Keep this app open. Phones stop sharing GPS with web apps when the app is closed or the phone is locked.'
    : 'Keep this screen on. This browser can\'t hold it awake, and GPS stops when the phone locks.');
  setTimeout(() => hideNotice('sleep'), 9000);
  renderButtons();
  renderStats();
}

async function togglePause() {
  const { hike, recorder } = state;
  if (!hike) return;
  const now = Date.now();
  if (hike.status === 'paused') {
    hike.pausedSeconds += (now - hike.pausedAt) / 1000;
    hike.pausedAt = null;
    hike.status = 'recording';
    recorder.resume();
    await screenLock.hold();
  } else {
    hike.pausedAt = now;
    hike.status = 'paused';
    recorder.pause();
    screenLock.release();
  }
  await store.putHike(hike);
  renderButtons();
  renderStats();
}

async function endHike(name) {
  const { hike, recorder } = state;
  const now = Date.now();
  if (hike.pausedAt) hike.pausedSeconds += (now - hike.pausedAt) / 1000;
  Object.assign(hike, {
    name,
    status: 'done',
    pausedAt: null,
    endedAt: now,
    miles: recorder.stats.miles,
    gainFeet: recorder.stats.gainFeet,
    movingSeconds: recorder.stats.movingSeconds,
    pointCount: recorder.points.length,
    untrackedSeconds: recorder.stats.untrackedSeconds,
  });
  await store.putHike(hike);
  scheduleBackup();
  const finished = { hike, points: recorder.points };
  clearActive();
  state.viewing = finished;
  redraw();
}

function clearActive() {
  state.hike = null;
  state.recorder = null;
  state.notedGaps = 0;
  state.target = null;
  screenLock.release();
  renderButtons();
  renderStats();
  renderGuide();
}

async function restoreActive() {
  const hikes = await store.listHikes();
  const active = hikes.find(hike => hike.status === 'recording' || hike.status === 'paused');
  state.spots = await store.listSpots();
  state.areas = await store.listAreas();
  state.geocaches = await store.listGeocaches();
  state.checkins = await store.listCheckins();
  state.photos = await store.listPhotos();
  state.photos.forEach(loadPhotoImage);
  if (active) {
    state.hike = active;
    state.recorder = createRecorder(await store.listPoints(active.id));
    state.notedGaps = state.recorder.stats.gaps;
    if (active.status === 'recording') {
      startGps();
      screenLock.hold();
      setFollow(true);
    }
    showNotice('restored', `${active.name} restored. ${state.recorder.stats.miles.toFixed(2)} mi so far.`);
    setTimeout(() => hideNotice('restored'), 7000);
    const last = state.recorder.points.at(-1);
    if (last) map.setView(last.lat, last.lon, 15);
  } else if ((await navigator.permissions?.query({ name: 'geolocation' }).catch(() => null))?.state === 'granted') {
    startGps();
  }
  renderButtons();
  renderStats();
  redraw();
}

/* 3D view */
const DRAPE_FULL_SIZE = 3072; // Twelve z14 tiles across, the detail of the topo map at that zoom.
const DRAPE_REFRESH_MS = 8000;
const DRAPE_UPLOAD_DELAY_MS = 600;
const three = { view: null, drape: null, grid: null, blocks: new Map(), uploadTimer: null, dirty: false, lastRefresh: 0, loading: 0, live: null, liveOn: false, liveTimer: null, token: undefined };
const LIVE_SYNC_MS = 500;
const HEIGHT_NOTE_SAVED = 'Height shown ×1.5';
const mapConfigUrl = new URL('../../map-config.json', import.meta.url).href;

async function loadBlock(block) {
  const key = blockKey(block);
  if (!state.terrainIndex.includes(key)) return null;
  if (three.blocks.has(key)) return three.blocks.get(key);
  const response = await fetch(dataUrl(`terrain/${key}.bin`));
  if (!response.ok) throw new Error(String(response.status));
  const heights = new Int16Array(await response.arrayBuffer());
  three.blocks.set(key, heights);
  return heights;
}

function scheduleDrapeUpload() {
  clearTimeout(three.uploadTimer);
  three.uploadTimer = setTimeout(() => {
    if (!state.threeD) return;
    three.view.setDrape(three.drape.canvas);
    hideNotice('3d');
  }, DRAPE_UPLOAD_DELAY_MS);
}

function refreshDrape() {
  three.dirty = false;
  three.lastRefresh = Date.now();
  three.drape?.requestDraw();
}

// A redraw for both views. The ground texture is expensive to send to the graphics chip, so
// everyday changes reach it on a slow timer. The position marker is separate and stays live.
function redraw() {
  map.requestDraw();
  if (state.threeD) three.dirty = true;
  syncLive();
}

/* Online 3D, on Mapbox */
function liveData() {
  const inView = shards => [...shards.values()].filter(shard => shard?.lines);
  const reached = new Set(state.checkins.map(checkin => checkin.id));
  const routes = [];
  if (state.route?.decoded) routes.push(...routeFeatures(state.route.decoded.flatMap((line, seg) => line.points.map(point => ({ ...point, seg }))), '#00803c'));
  if (state.viewing) routes.push(...routeFeatures(state.viewing.line ||= routeLine(state.viewing.points), '#6a2bd9'));
  if (state.recorder) routes.push(...routeFeatures(state.recorder.line, '#d6006e'));
  const points = [
    ...(state.route?.kind === 'destination' ? [pointFeature(state.route.point, { color: '#00803c', label: state.route.name })] : []),
    ...visibleSpots().map(spot => pointFeature(spot, { color: '#d6006e', label: spot.name })),
    ...(state.viewing ? state.spots.filter(spot => spot.hikeId === state.viewing.hike.id).map(spot => pointFeature(spot, { color: '#6a2bd9', label: spot.name })) : []),
    ...(state.target && !state.target.spotId && !state.target.followsRoute ? [pointFeature(state.target, { color: '#0a6cff', label: state.target.name })] : []),
    ...state.geocaches.map(cache => pointFeature(cache, { color: cache.found ? '#6b7280' : '#00803c' })),
    ...state.checkpoints.map(checkpoint => pointFeature(checkpoint, { color: reached.has(checkpoint.id) ? '#00803c' : '#f2a900', radius: 11 })),
  ];
  return {
    streams: state.showWater ? streamFeatures(inView(state.shards)) : [],
    trails: state.showTrails ? trailFeatures(inView(state.trailShards), line => matchesActivity(line.activities, state.activity)) : [],
    routes,
    points,
  };
}

function syncLive() {
  if (!three.liveOn || three.liveTimer) return;
  three.liveTimer = setTimeout(() => {
    three.liveTimer = null;
    if (!three.liveOn) return;
    three.live.setData(liveData());
    three.live.setPhotos(state.photos.filter(photo => photo.lat !== null).map(photo => ({ ...photo, src: state.photoImages.get(photo.id)?.src })), id => {
      const photo = state.photos.find(item => item.id === id);
      if (photo) openPhoto(photo);
    });
  }, LIVE_SYNC_MS);
}

function loadLiveShards() {
  if (!three.liveOn) return;
  const covered = shardsForBounds(three.live.bounds());
  if (state.showTrails && three.live.zoom >= TRAIL_MIN_ZOOM) covered.forEach(loadTrailShard);
  if (state.showWater && three.live.zoom >= WATER_MIN_ZOOM) covered.forEach(loadShard);
}

async function mapboxToken() {
  if (three.token !== undefined) return three.token;
  const response = await fetch(mapConfigUrl, { cache: 'no-store' });
  three.token = response.ok ? readToken(await response.json()) : null;
  return three.token;
}

// False when this phone can't have the online view, so the saved terrain can take over.
async function openLive(center, zoom) {
  if (!navigator.onLine) return false;
  showNotice('3d', 'Loading 3D terrain…');
  try {
    const token = await mapboxToken();
    if (!token) return false;
    const { loadMapboxGl, MapboxView } = await import('./mapbox-view.js');
    if (!three.live) {
      const mapboxgl = await loadMapboxGl();
      $('live3d').hidden = false;
      three.live = new MapboxView(mapboxgl, $('live3d'), {
        token,
        center,
        zoom,
        onTap: (x, y) => handleMapTap(x, y, three.live),
        onUserMove: () => setFollow(false),
        onBearing: bearing => { $('northArrow').style.transform = `rotate(${-bearing}deg)`; },
        onViewChange: loadLiveShards,
        // A refused token won't fix itself, so don't try again until the app reloads.
        onFail: () => {
          three.token = null;
          leaveLive('The online 3D map stopped loading.');
        },
      });
    }
    $('live3d').hidden = false;
    await three.live.ready;
    three.live.show(center, zoom);
    hideNotice('3d');
    return true;
  } catch {
    $('live3d').hidden = true;
    // This map never finished, so a later try has to start fresh.
    three.live?.map.remove();
    three.live = null;
    hideNotice('3d');
    return false;
  }
}

// Only a promise about the saved terrain if it actually loaded.
function leaveLive(reason) {
  const { center, zoom } = three.live;
  closeLive();
  map.paused = false;
  map.setView(center.lat, center.lon, zoom);
  state.threeD = false;
  set3dControls(false);
  enter3d({ savedOnly: true }).then(() => {
    showNotice('3d', `${reason} ${state.threeD ? 'This is the saved terrain now.' : 'This area\'s terrain isn\'t saved, so here\'s the flat map.'}`);
    setTimeout(() => hideNotice('3d'), 6000);
  });
}

function fitViews(bounds, padding) {
  map.fit(bounds, padding);
  if (three.liveOn) three.live.fit(bounds);
}

function closeLive() {
  three.liveOn = false;
  clearTimeout(three.liveTimer);
  three.liveTimer = null;
  $('live3d').hidden = true;
}

async function showWindow({ lat, lon }) {
  const window3d = viewWindow(lat, lon);
  const ticket = (three.loading += 1);
  showNotice('3d', 'Loading 3D terrain…');
  const blocks = await Promise.all(windowBlocks(window3d).map(block => loadBlock(block).catch(() => null)));
  // The hiker may have walked on, or left 3D, while this was loading.
  if (ticket !== three.loading || !state.threeD) return;
  const lookup = new Map(windowBlocks(window3d).map((block, index) => [blockKey(block), blocks[index]]));
  const grid = stitchWindow(window3d, block => lookup.get(blockKey(block)));
  if (!grid) {
    showNotice('3d', 'The 3D terrain isn\'t available here. Open the app with signal, or save this area first.');
    exit3d();
    return;
  }
  three.grid = grid;
  three.view.setGrid(grid);
  three.view.setFocus(lat, lon);
  const size = Math.min(DRAPE_FULL_SIZE, three.view.maxTexture);
  if (!three.drape) {
    three.drape = new TopoMap(document.createElement('canvas'), {
      tileUrl,
      tileMaxZoom: TILE_MAX_ZOOM,
      fixedSize: size,
      onDraw: (ctx, target) => {
        drawOverlays(ctx, target);
        scheduleDrapeUpload();
      },
    });
  }
  three.drape.setView(grid.center.lat, grid.center.lon, 14 + Math.log2(size / DRAPE_FULL_SIZE));
  const covered = shardsForBounds(three.drape.bounds());
  if (state.showTrails) covered.forEach(loadTrailShard);
  if (state.showWater) covered.forEach(loadShard);
  update3dPosition();
}

function update3dPosition() {
  if (three.liveOn && state.fix) {
    three.live.setMe(state.fix, currentHeading());
    if (state.follow) three.live.follow(state.fix);
    return;
  }
  if (!state.threeD || !three.grid || !state.fix) return;
  if (state.follow && needsNewWindow(three.grid, state.fix.lat, state.fix.lon)) {
    if (hasTerrainAt(state.fix.lat, state.fix.lon, state.terrainIndex)) showWindow(state.fix);
    return;
  }
  three.view.setMarker(state.fix.lat, state.fix.lon);
  if (state.follow) three.view.setFocus(state.fix.lat, state.fix.lon);
}

async function enter3d({ savedOnly = false } = {}) {
  const center = state.follow && state.fix ? state.fix : map.center;
  if (!savedOnly && await openLive(center, map.zoom)) {
    state.threeD = true;
    three.liveOn = true;
    map.paused = true;
    $('terrain').hidden = true;
    set3dControls(true);
    $('heightNote').textContent = `Height shown ×${EXAGGERATION}`;
    if (!three.liveHinted) {
      three.liveHinted = true;
      showNotice('3d', 'Use two fingers to tilt and turn. Pinch to zoom.');
      setTimeout(() => hideNotice('3d'), 5000);
    }
    syncLive();
    loadLiveShards();
    update3dPosition();
    return;
  }
  $('heightNote').textContent = HEIGHT_NOTE_SAVED;
  if (!hasTerrainAt(center.lat, center.lon, state.terrainIndex)) {
    showNotice('3d', 'This 3D view needs saved terrain, which covers only the counties this app maps. Move the map there first.');
    setTimeout(() => hideNotice('3d'), 6000);
    return;
  }
  if (!three.view) {
    try {
      const { TerrainView } = await import('./terrain-view.js');
      three.view = new TerrainView($('terrain'), {
        onCameraChange: ({ heading }) => { $('northArrow').style.transform = `rotate(${-heading}deg)`; },
        onContextLost: () => {
          exit3d();
          showNotice('3d', 'The phone reclaimed 3D memory, so the app went back to the map. Your hike is still recording.');
        },
      });
    } catch {
      showNotice('3d', 'This browser can\'t draw 3D. The map and your hike still work.');
      setTimeout(() => hideNotice('3d'), 6000);
      return;
    }
  }
  state.threeD = true;
  map.paused = true;
  $('terrain').hidden = false;
  set3dControls(true);
  await showWindow(center);
}

function exit3d() {
  if (three.liveOn) {
    map.setView(three.live.center.lat, three.live.center.lon, three.live.zoom);
    closeLive();
  }
  state.threeD = false;
  three.loading += 1;
  clearTimeout(three.uploadTimer);
  map.paused = false;
  $('terrain').hidden = true;
  set3dControls(false);
  hideNotice('3d');
  viewChanged();
  redraw();
}

function set3dControls(on) {
  $('toggle3d').setAttribute('aria-pressed', String(on));
  $('north').hidden = !on;
  $('heightNote').hidden = !on;
  $('scale').hidden = on;
}

/* Following a chosen hike */
function chooseHike(hike) {
  state.route = hike.decoded ? hike : decodeHike(hike);
  state.progress = null;
  state.reachedRoute = false;
  // Holds the guide open until the first fix can point it at the nearest part of the route.
  state.target = { name: hike.name, ...(hike.point || boundsCenter(hike.bounds)), followsRoute: true };
  state.viewing = null;
  setFollow(false);
  // The guide card takes room from the map, so measure after it's showing.
  renderGuide();
  map.resize();
  map.fit(hike.bounds);
  if (three.liveOn) {
    three.live.fit(hike.bounds);
  } else if (state.threeD) {
    const middle = hike.point || boundsCenter(hike.bounds);
    if (hasTerrainAt(middle.lat, middle.lon, state.terrainIndex)) showWindow(middle);
  }
  startGps();
  ensureCompass();
  updateRouteProgress();
  renderGuide();
  redraw();
}

function updateRouteProgress() {
  const { route, fix } = state;
  if (!route || !fix) return;
  const wasOff = state.progress?.off;
  state.progress = routeProgress(route, fix, wasOff);
  // Only warn after being on the route, or every walk to the trailhead would buzz.
  if (state.progress.onRoute) state.reachedRoute = true;
  if (state.progress.off && wasOff === false && state.reachedRoute) {
    navigator.vibrate?.([200, 100, 200]);
    showNotice('route', `You've left ${route.name}. The mapped trail is ${formatDistance(state.progress.miles)} ${compassPoint(state.progress.bearing)}.`);
  } else if (!state.progress.off) {
    hideNotice('route');
  }
  const parking = route.kind === 'route' && !state.reachedRoute && state.progress.miles > PARKING_GUIDE_MILES ? nearestAccess(route, fix) : null;
  state.target = parking
    ? { name: route.name, lat: parking.lat, lon: parking.lon, followsRoute: true, toAccess: parking.type }
    : { name: route.name, ...state.progress.point, followsRoute: true };
}

function endRoute() {
  state.route = null;
  state.progress = null;
  state.reachedRoute = false;
  state.target = null;
  hideNotice('route');
  renderGuide();
  redraw();
}

async function loadHikes() {
  if (state.hikes) return state.hikes;
  const { hikes } = await (await fetch(dataUrl('hikes.json'))).json();
  state.hikes = hikes;
  return hikes;
}

/* Activities */
const ACTIVITY_KEY = 'trail-activity';
const ROUTE_PAGE = 30;

function rememberActivity(id) {
  try {
    if (id) localStorage.setItem(ACTIVITY_KEY, id);
    else localStorage.removeItem(ACTIVITY_KEY);
  } catch { /* A remembered choice is only a convenience. */ }
}

function setActivity(id) {
  const activity = activityById(id);
  state.activity = activity;
  rememberActivity(activity?.id);
  $('activityChip').hidden = !activity;
  $('activityChip').textContent = activity ? `${activity.label} only ✕` : '';
  $('activityChip').setAttribute('aria-label', activity ? `Showing ${activity.label} trails only. Show all trails.` : '');
  // The flat map keeps prepared paths, so they're rebuilt for the new choice.
  for (const shard of state.trailShards.values()) {
    if (shard?.lines) shard.paths = buildTrailPaths(shard.lines, shard.originX, shard.originY);
  }
  redraw();
  if (state.threeD && !three.liveOn) refreshDrape();
}

async function loadRoutes() {
  if (state.routes) return state.routes;
  state.routes = await (await fetch(dataUrl('routes.json'))).json();
  return state.routes;
}

// Geometry lives in the trail shards, so a saved area can still follow a trail with no signal.
async function followRoute(route) {
  const shards = await Promise.all(shardsForBounds(route.bounds).map(loadTrailShard));
  const decoded = routeLines(shards, route);
  if (!decoded.length) {
    showNotice('route', 'That trail\'s map data isn\'t on this phone yet. Open it once with signal, or save the area first.');
    setTimeout(() => hideNotice('route'), 6000);
    return false;
  }
  chooseHike({ ...route, kind: 'route', decoded, area: route.county });
  return true;
}

function externalLink(text, url) {
  const link = document.createElement('a');
  link.className = 'text-button link-button';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = text;
  return link;
}

async function loadDirectory() {
  if (state.directory) return state.directory;
  const read = async name => (await fetch(dataUrl(name))).json();
  const [{ official }, { outfitters }, { stays, guides }] = await Promise.all(['official.json', 'outfitters.json', 'stays.json'].map(read));
  state.directory = { official, outfitters, stays, guides };
  return state.directory;
}

const miles = value => `about ${Math.round(value)} mi away`;

function officialRow({ entry, miles: away }) {
  const row = document.createElement('li');
  const title = document.createElement('span');
  title.className = 'item-title';
  const name = document.createElement('strong');
  name.textContent = entry.name;
  const place = document.createElement('small');
  place.textContent = `${entry.place} · ${miles(away)}`;
  title.append(name, place);
  const about = document.createElement('p');
  about.className = 'hike-note';
  about.textContent = entry.about;
  row.append(title, about, externalLink(entry.label, entry.url));
  return row;
}

function outfitterRow({ entry, miles: away }) {
  const row = document.createElement('li');
  const title = document.createElement('span');
  title.className = 'item-title';
  const name = document.createElement('strong');
  name.textContent = entry.name;
  const place = document.createElement('small');
  place.textContent = `${entry.place} · ${miles(away)}`;
  title.append(name, place);
  if (entry.season) {
    const season = document.createElement('small');
    season.textContent = entry.season;
    title.append(season);
  }
  const about = document.createElement('p');
  about.className = 'hike-note';
  about.textContent = entry.services;
  row.append(title, about, externalLink('Website', entry.url));
  if (entry.phone) row.append(externalLink(`Call ${entry.phone}`, `tel:${entry.phone.replace(/[^\d+]/g, '')}`));
  return row;
}

// Facts and the elevation sparkline, for both hand-picked hikes and listed trails.
function detailNodes(item) {
  const nodes = detailFacts(item).map(fact => {
    const line = document.createElement('small');
    line.textContent = fact;
    return line;
  });
  if (item.profile?.length > 1) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'profile');
    svg.setAttribute('viewBox', '0 0 240 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    const low = Math.min(...item.profile);
    const high = Math.max(...item.profile);
    svg.setAttribute('aria-label', `Elevation over ${item.profileMiles} miles of the longest mapped section, from ${formatFeet(low)} to ${formatFeet(high)}`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', profilePath(item.profile, 240, 40));
    svg.append(path);
    nodes.push(svg);
  }
  return nodes;
}

function directorySection(heading, rows, build) {
  if (!rows.length) return null;
  const section = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = heading;
  const list = document.createElement('ul');
  list.className = 'list';
  list.append(...rows.map(build));
  section.append(title, list);
  return section;
}

const OUTFITTER_NOTE = 'Listed from each business\'s own website, or a park or tourism page. Not paid placements or endorsements, so call ahead to confirm.';

function outfitterNote() {
  const note = document.createElement('p');
  note.className = 'fine';
  note.textContent = OUTFITTER_NOTE;
  return note;
}

async function renderFinderHelp(position) {
  const holder = $('finderHelp');
  holder.replaceChildren();
  if (!state.activity) return;
  let directory;
  try {
    directory = await loadDirectory();
  } catch {
    return;
  }
  const official = directorySection('From the land managers', nearbyDirectory(directory.official, position, state.activity.id), officialRow);
  const outfitters = directorySection('Rentals and guides nearby', nearbyDirectory(directory.outfitters, position, state.activity.id), outfitterRow);
  holder.replaceChildren(...[official, outfitters, outfitters && outfitterNote()].filter(Boolean));
}

/* Trip planner */
const PLAN_KEY = 'trail-plan';

function readPlan() {
  try {
    return JSON.parse(localStorage.getItem(PLAN_KEY)) || {};
  } catch {
    return {};
  }
}

function rememberPlan(plan) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch { /* A remembered plan is only a convenience. */ }
}

function planStay(plan, stays) {
  if (plan.here && state.fix) return { label: 'where you are now', lat: state.fix.lat, lon: state.fix.lon, county: '' };
  return stays.find(stay => stay.id === plan.stay) || null;
}

async function renderPlan() {
  const results = $('planResults');
  results.replaceChildren();
  let directory;
  let routeData;
  try {
    [directory, routeData] = await Promise.all([loadDirectory(), loadRoutes()]);
  } catch {
    results.textContent = 'The planner\'s lists aren\'t available. Reopen the app with signal once to store them.';
    return;
  }
  const plan = readPlan();
  const select = $('planStay');
  if (select.options.length === 1) {
    select.append(...directory.stays.map(stay => new Option(stay.label, stay.id)));
    select.addEventListener('change', () => {
      rememberPlan({ ...readPlan(), stay: select.value, here: false });
      renderPlan();
    });
  }
  select.value = plan.here ? '' : plan.stay || '';
  $('planHere').hidden = !state.fix;

  const month = new Date().getMonth();
  const chosen = new Set(plan.activities || []);
  $('planActivities').replaceChildren(...seasonalActivities(month).map(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(chosen.has(id)));
    button.addEventListener('click', () => {
      if (chosen.has(id)) chosen.delete(id);
      else chosen.add(id);
      rememberPlan({ ...readPlan(), activities: [...chosen] });
      renderPlan();
    });
    return button;
  }));

  const stay = planStay(plan, directory.stays);
  if (!stay || !chosen.size) {
    const hint = document.createElement('p');
    hint.className = 'fine';
    hint.textContent = !stay ? 'Pick where you\'re staying to see what\'s close.' : 'Pick one or more activities.';
    results.append(hint);
    return;
  }
  const trip = planTrip({ stay, activityIds: seasonalActivities(month).map(({ id }) => id).filter(id => chosen.has(id)), routes: routeData.routes, outfitters: directory.outfitters, official: directory.official, guides: directory.guides });
  results.append(textButton(`Conditions near ${stay.label}`, () => openConditions(stay, stay.label)));
  for (const { activity, trails, outfitters, official } of trip.sections) {
    const section = document.createElement('section');
    section.className = 'plan-section';
    const heading = document.createElement('h3');
    heading.textContent = activity.label;
    section.append(heading);
    if (activity.note) {
      const note = document.createElement('p');
      note.className = 'fine';
      note.textContent = activity.note;
      section.append(note);
    }
    if (trails.length) {
      const list = document.createElement('ul');
      list.className = 'list route-list';
      list.append(...trails.map(({ entry, miles: away }) => routeRow(entry, away, () => $('planDialog').close())));
      section.append(list);
    } else {
      const none = document.createElement('p');
      none.className = 'fine';
      none.textContent = `No trails within ${NEARBY_MILES} miles are marked for this in the data. That may only mean no one has mapped them.`;
      section.append(none);
    }
    const parts = [
      directorySection('From the land managers', official, officialRow),
      directorySection('Rentals and guides', outfitters, outfitterRow),
    ].filter(Boolean);
    section.append(...parts);
    results.append(section);
  }
  if (trip.sections.some(({ outfitters }) => outfitters.length)) results.append(outfitterNote());
  if (trip.guides.length) {
    const section = document.createElement('section');
    section.className = 'plan-section';
    const heading = document.createElement('h3');
    heading.textContent = 'Local guides';
    const list = document.createElement('ul');
    list.className = 'list';
    list.append(...trip.guides.map(guide => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'text-button link-button';
      link.href = `../${guide.url}`;
      link.textContent = guide.title;
      row.append(link);
      return row;
    }));
    section.append(heading, list);
    results.append(section);
  }
}

/* Conditions */
const clock = time => new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayAndClock = time => new Date(time).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const conditionsKey = place => {
  const { lat, lon } = roughly(place);
  return `trail-conditions:${lat},${lon}`;
};

function savedConditions(place) {
  try {
    return JSON.parse(localStorage.getItem(conditionsKey(place)));
  } catch {
    return null;
  }
}

function saveConditions(place, conditions) {
  try {
    localStorage.setItem(conditionsKey(place), JSON.stringify(conditions));
  } catch { /* Saved readings are only a convenience. */ }
}

async function loadGauges() {
  state.gauges ||= (await (await fetch(dataUrl('gauges.json'))).json()).gauges;
  return state.gauges;
}

function conditionsSection(heading, ...children) {
  const section = document.createElement('section');
  section.className = 'plan-section';
  const title = document.createElement('h3');
  title.textContent = heading;
  section.append(title, ...children);
  return section;
}

const textLine = (text, tag = 'p', className = 'fine') => {
  const line = document.createElement(tag);
  line.className = className;
  line.textContent = text;
  return line;
};

function renderConditions(conditions, directory, place) {
  const holder = $('conditionsList');
  holder.replaceChildren();
  const unavailable = 'Not available right now.';
  const savedNote = section => (conditions.savedSections?.includes(section) ? [textLine(`No connection, so this is from ${dayAndClock(conditions.savedAt)}.`)] : []);

  const alerts = (conditions.alerts || []).map(alert => {
    const row = document.createElement('li');
    row.className = 'alert';
    const strong = document.createElement('strong');
    strong.textContent = alert.headline;
    row.append(strong);
    return row;
  });
  if (alerts.length) {
    const list = document.createElement('ul');
    list.className = 'list';
    list.append(...alerts);
    holder.append(conditionsSection('Weather alerts', list, ...savedNote('alerts')));
  } else {
    holder.append(conditionsSection('Weather alerts', textLine(conditions.alerts === null ? unavailable : 'None active from the National Weather Service.'), ...savedNote('alerts')));
  }

  const forecastList = document.createElement('ul');
  forecastList.className = 'list';
  forecastList.append(...(conditions.forecast || []).map(period => {
    const row = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = `${period.name}: ${period.temperature}`;
    const summary = document.createElement('small');
    summary.textContent = [period.summary, period.wind && `wind ${period.wind}`].filter(Boolean).join(', ');
    const title = document.createElement('span');
    title.className = 'item-title';
    title.append(name, summary);
    row.append(title);
    return row;
  }));
  holder.append(conditionsSection('Forecast', conditions.forecast ? forecastList : textLine(unavailable), ...savedNote('forecast')));

  holder.append(conditionsSection('Snow on the ground',
    textLine(conditions.snowInches === null ? unavailable : snowText(conditions.snowInches), 'p', 'hike-note'),
    textLine('NOAA\'s modeled estimate for this area, not a trail report. It doesn\'t show grooming.'),
    ...savedNote('snowInches')));

  const riverList = document.createElement('ul');
  riverList.className = 'list';
  riverList.append(...(conditions.rivers || []).map(river => {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'item-title';
    const name = document.createElement('strong');
    name.textContent = river.name;
    const level = document.createElement('small');
    level.textContent = gaugeText(river);
    const when = document.createElement('small');
    when.textContent = `${clock(river.time)} · about ${Math.round(river.miles)} mi away`;
    title.append(name, level, when);
    row.append(title);
    return row;
  }));
  const hasRivers = conditions.rivers?.length;
  holder.append(conditionsSection('Rivers nearby',
    hasRivers ? riverList : textLine(conditions.rivers === null ? unavailable : 'No gauge reporting nearby.'),
    textLine('USGS readings, which are provisional. They don\'t say whether a river is safe, so check with an outfitter or land manager before paddling.'),
    ...savedNote('rivers')));

  const managers = nearbyDirectory(directory.official, place, null, 3);
  const closures = managers.map(({ entry }) => externalLink(entry.name, entry.url));
  holder.append(conditionsSection('Closures and trail status', textLine('This app can\'t see closures, so check the land manager.'), ...closures));
  holder.append(textLine(`Updated ${clock(conditions.fetchedAt)}. Looking this up sends a rough location, to about two-thirds of a mile, to NOAA and the National Weather Service.`));
}

async function openConditions(place, label) {
  $('conditionsTitle').textContent = `Conditions near ${label}`;
  const holder = $('conditionsList');
  holder.replaceChildren(textLine('Checking…'));
  $('conditionsDialog').showModal();
  const ticket = (state.conditionsTicket = (state.conditionsTicket || 0) + 1);
  try {
    const [gauges, directory] = await Promise.all([loadGauges(), loadDirectory()]);
    const saved = savedConditions(place);
    let conditions = isFresh(saved) ? saved : null;
    if (!conditions) {
      const fresh = await fetchConditions(place, gauges);
      conditions = withSaved(fresh, saved);
      // A section that failed keeps its older reading, so only new answers overwrite.
      const nothingNew = ['alerts', 'forecast', 'snowInches', 'rivers'].every(section => fresh[section] === null);
      if (!nothingNew) saveConditions(place, { ...conditions, savedSections: [] });
    }
    if (ticket === state.conditionsTicket) renderConditions(conditions, directory, place);
  } catch {
    if (ticket === state.conditionsTicket) holder.replaceChildren(textLine('Conditions aren\'t available. Reopen the app with signal once to store what they need.'));
  }
}

function openPlan() {
  $('planDialog').showModal();
  renderPlan();
}

function routeRow(route, away = null, closeDialog = () => $('finderDialog').close()) {
  const row = document.createElement('li');
  const title = document.createElement('span');
  title.className = 'item-title';
  const name = document.createElement('strong');
  name.textContent = route.name;
  const area = document.createElement('small');
  const distance = away !== null ? ` · ${miles(away)}` : state.fix ? ` · ${formatDistance(distanceMiles(state.fix, route.center))} away` : '';
  const others = (route.counties?.length || 1) - 1;
  area.textContent = `${route.county}${others ? ` and ${others} more` : ''}${distance}`;
  const facts = document.createElement('small');
  facts.textContent = [`${route.miles.toFixed(route.miles < 10 ? 2 : 1)} mi of mapped trail`, route.surface && `surface: ${route.surface.toLowerCase()}`].filter(Boolean).join(' · ');
  const marked = document.createElement('small');
  marked.textContent = `Marked for ${activityNames(route.activities).join(', ')}`;
  title.append(name, area, facts, marked, ...detailNodes(route));
  if (route.noUse) {
    const closed = document.createElement('small');
    closed.className = 'official-note';
    closed.textContent = `Forest Service: no ${activityNames(route.noUse).join(', no ')}`;
    title.append(closed);
  }
  const seasons = Object.entries(route.seasons || {}).map(([bit, text]) => `${activityNames(Number(bit))[0]} ${text}`);
  if (seasons.length) {
    const season = document.createElement('small');
    season.className = 'official-note';
    season.textContent = `Forest Service season: ${seasons.join(', ')}`;
    title.append(season);
  }
  if (route.official) {
    const note = document.createElement('small');
    note.className = 'official-note';
    note.textContent = route.official.note;
    title.append(note);
  }
  if (route.access) {
    const access = document.createElement('small');
    access.textContent = accessFact(route);
    title.append(access);
  }
  row.append(title);
  row.append(
    textButton('Follow this trail', async () => {
      if (await followRoute(route)) closeDialog();
    }),
    textButton('Save offline', async () => {
      if (await followRoute(route)) {
        closeDialog();
        openMaps(withMargin(route.bounds));
      }
    }),
  );
  row.append(textButton('Conditions', () => openConditions(route.center, route.name)));
  if (route.official) row.append(externalLink(route.official.label, route.official.url));
  const way = route.access?.[0] || route.center;
  const link = document.createElement('a');
  link.className = 'text-button link-button';
  link.href = directionsUrl(way);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Driving directions';
  row.append(link);
  return row;
}

function renderRoutePage(holder, routes, shown = ROUTE_PAGE) {
  holder.querySelector('.route-list')?.remove();
  holder.querySelector('.route-more')?.remove();
  const list = document.createElement('ul');
  list.className = 'list route-list';
  list.append(...routes.slice(0, shown).map(route => routeRow(route)));
  holder.append(list);
  if (routes.length > shown) {
    const more = textButton(`Show more (${routes.length - shown} left)`, () => renderRoutePage(holder, routes, shown + ROUTE_PAGE));
    more.classList.add('route-more');
    holder.append(more);
  }
}

function renderFinderChoices() {
  const holder = $('finderActivities');
  const choices = [{ id: '', label: 'Everything' }, ...ACTIVITIES];
  holder.replaceChildren(...choices.map(({ id, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.textContent = label;
    button.setAttribute('aria-pressed', String((state.activity?.id || '') === id));
    button.addEventListener('click', () => {
      setActivity(id);
      renderFinder();
    });
    return button;
  }));
  const note = state.activity?.note || '';
  $('finderNote').hidden = !note;
  $('finderNote').textContent = note;
}

async function renderFinder() {
  const holder = $('finderList');
  holder.replaceChildren();
  renderFinderChoices();
  let hikes;
  let routeData;
  try {
    [hikes, routeData] = await Promise.all([loadHikes(), loadRoutes()]);
  } catch {
    holder.textContent = 'The trail list isn\'t available. Reopen the app with signal once to store it.';
    return;
  }
  const counties = $('finderCounty');
  if (counties.options.length === 1) {
    counties.append(...routeData.counties.map(county => new Option(county, county)));
    counties.addEventListener('change', renderFinder);
  }
  const county = counties.value;
  const position = state.fix || map.center;
  renderFinderHelp(position);
  // The hand-picked list is hikes, so other activities go straight to what's marked for them.
  const picks = !state.activity || state.activity.id === 'hike' ? hikes.filter(hike => !county || hike.county === county) : [];
  const routes = filterRoutes(routeData.routes, { activity: state.activity, county, position, distance: distanceMiles });
  const routeHolder = document.createElement('div');
  if (routes.length) {
    const heading = document.createElement('h3');
    heading.textContent = `${state.fix ? 'Closest to you' : 'Closest to the map'} (${routes.length})`;
    routeHolder.append(heading);
    renderRoutePage(routeHolder, routes);
  } else {
    const empty = document.createElement('p');
    empty.className = 'fine';
    empty.textContent = `No trails here are marked for ${state.activity?.label.toLowerCase() || 'that'}. That may only mean no one has mapped them yet.`;
    routeHolder.append(empty);
  }
  for (const group of groupHikes(picks, state.fix)) {
    const heading = document.createElement('h3');
    heading.textContent = group.name;
    const list = document.createElement('ul');
    list.className = 'list';
    for (const hike of group.hikes) {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'item-title';
      const name = document.createElement('strong');
      name.textContent = hike.name;
      const area = document.createElement('small');
      area.textContent = hike.area;
      const facts = document.createElement('small');
      facts.textContent = hikeFacts(hike);
      title.append(name, area, facts, ...detailNodes(hike));
      row.append(title);
      const access = document.createElement('small');
      access.textContent = accessFact(hike);
      title.append(access);
      if (hike.note) {
        const note = document.createElement('p');
        note.className = 'hike-note';
        note.textContent = hike.note;
        row.append(note);
      }
      row.append(
        textButton(hike.kind === 'route' ? 'Follow this hike' : 'Guide me here', () => {
          chooseHike(hike);
          $('finderDialog').close();
        }),
        textButton('Save offline', () => {
          chooseHike(hike);
          $('finderDialog').close();
          openMaps(withMargin(hike.bounds));
        }),
        textButton('Conditions', () => openConditions(hike.point || boundsCenter(hike.bounds), hike.name)),
      );
      const way = hike.access?.[0] || hike.point;
      if (way) {
        const link = document.createElement('a');
        link.className = 'text-button link-button';
        link.href = directionsUrl(way);
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Driving directions';
        row.append(link);
      }
      list.append(row);
    }
    holder.append(heading, list);
  }
  holder.append(routeHolder);
}

/* Guiding toward a spot */
function setTarget(target) {
  if (state.route) endRoute();
  state.target = target;
  ensureCompass();
  if (target) startGps();
  renderGuide();
  redraw();
}

function renderGuide() {
  const { target, fix } = state;
  $('guide').hidden = !target;
  if (target) {
    $('guideName').textContent = target.name;
    if (!fix) {
      $('guideDistance').textContent = 'Finding GPS…';
      $('guideNote').textContent = '';
      $('guideArrow').style.transform = '';
    } else {
      const miles = distanceMiles(fix, target);
      const bearing = bearingDegrees(fix, target);
      const heading = currentHeading();
      if (target.toAccess) $('guideDistance').textContent = `${formatDistance(miles)} ${compassPoint(bearing)} to ${target.toAccess}`;
      else if (target.followsRoute && state.progress?.onRoute) $('guideDistance').textContent = 'On the trail';
      else if (target.followsRoute && state.route.kind === 'route') $('guideDistance').textContent = `${formatDistance(miles)} ${compassPoint(bearing)} to the trail`;
      else $('guideDistance').textContent = miles < ARRIVED_MILES ? "You're here" : `${formatDistance(miles)} ${compassPoint(bearing)}`;
      $('guideArrow').style.transform = `rotate(${bearing - (heading ?? 0)}deg)`;
      let note = compassNeedsPermission() && !state.compassOn ? 'Arrow assumes north is up. Tap here to use the compass.' : 'Arrow assumes north is up. Start walking to set your direction.';
      if (state.heading !== null) note = 'Straight line, by compass. Approximate near metal.';
      else if (heading !== null) note = 'Straight line, by direction you are walking.';
      if (target.followsRoute && state.progress?.onRoute) note = 'Staying within about 300 ft of the mapped line.';
      $('guideNote').textContent = note;
    }
  }
  document.documentElement.style.setProperty('--sheet-height', `${document.querySelector('.sheet').offsetHeight}px`);
}

/* Where am I */
async function landscapeAt(position) {
  if (!state.places) {
    try {
      const { places } = await (await fetch(dataUrl('places.json'))).json();
      state.places = buildPlaceIndex(places);
    } catch {
      state.places = null;
    }
  }
  const town = state.places ? nearestPlace(state.places, position) : null;
  const delta = SHARD_DEGREES / 2;
  const keys = shardsForBounds({ south: position.lat - delta, north: position.lat + delta, west: position.lon - delta, east: position.lon + delta });
  const shards = await Promise.all(keys.map(loadShard));
  const lines = shards.flatMap(shard => shard?.lines || []);
  const trailShards = await Promise.all(keys.map(loadTrailShard));
  const trailLines = trailShards.flatMap(shard => shard?.lines || []);
  return {
    town,
    water: nearestWater(lines, position),
    trail: nearestOnLines(trailLines, position, NEAREST_TRAIL_MILES),
    hasWaterData: state.shardIndex.includes(shardKey(position.lat, position.lon)),
    hasTrailData: state.trailIndex.includes(shardKey(position.lat, position.lon)),
  };
}

const describeTrail = ({ line, miles, bearing }) => {
  const label = KIND_LABELS[line.kind];
  const name = line.name ? `${line.name} (${label})` : `An unnamed ${label}`;
  return `${name}, ${formatDistance(miles)} ${compassPoint(bearing)}.`;
};

const describeWater = water => {
  const name = water.name || (water.into ? `An unnamed stream draining to ${water.into}` : 'An unnamed stream');
  const flow = `flows ${compassPoint(water.flowBearing)}${water.name && water.into ? ` into ${water.into}` : ''}`;
  return `${name}, ${formatDistance(water.miles)} ${compassPoint(water.bearing)}. It ${flow}.`;
};

async function renderWhere() {
  const { fix } = state;
  $('whereEmpty').hidden = Boolean(fix);
  $('whereBody').hidden = !fix;
  renderSpotList();
  if (!fix) return;
  $('whereCoords').textContent = formatCoordinates(fix);
  $('whereAccuracy').textContent = `Within about ${Math.round(fix.accFeet)} ft${state.fixSeconds ? ` · new reading every ${state.fixSeconds.toFixed(1)} s` : ''}${Number.isFinite(fix.altFeet) ? ` · GPS elevation ${formatFeet(fix.altFeet)}` : ''}`;
  $('wherePlace').textContent = 'Looking up nearby places…';
  $('whereWater').textContent = '';
  $('whereTrail').textContent = '';
  $('goWater').hidden = true;
  const { town, water, trail, hasWaterData, hasTrailData } = await landscapeAt(fix);
  state.lastLandscape = { town, water };
  $('wherePlace').textContent = town
    ? `${formatDistance(town.miles)} ${compassPoint(town.bearingFromPlace)} of ${town.name}, ${town.state}.`
    : 'No town in the bundled data within 40 miles.';
  if (trail) $('whereTrail').textContent = describeTrail(trail);
  else $('whereTrail').textContent = hasTrailData ? 'No mapped trail within a mile.' : 'Trail data doesn\'t cover this area yet.';
  if (water) {
    $('whereWater').textContent = describeWater(water);
    $('goWater').hidden = false;
  } else {
    $('whereWater').textContent = hasWaterData ? 'No mapped water within 3 miles.' : 'Water data doesn\'t cover this area yet.';
  }
}

function renderSpotList() {
  const list = $('spotList');
  list.replaceChildren();
  const startPoint = state.recorder?.points[0];
  const entries = [];
  if (startPoint) entries.push({ name: 'Start of this hike', lat: startPoint.lat, lon: startPoint.lon });
  entries.push(...visibleSpots().map(spot => ({ ...spot, spotId: spot.id })));
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Nothing marked yet. Mark your car before you leave it.';
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'item-title';
    const name = document.createElement('strong');
    name.textContent = entry.name;
    title.append(name);
    if (state.fix) {
      const away = document.createElement('small');
      away.textContent = `${formatDistance(distanceMiles(state.fix, entry))} ${compassPoint(bearingDegrees(state.fix, entry))}`;
      title.append(away);
    }
    const go = textButton(`Guide me`, () => {
      setTarget(entry);
      $('whereDialog').close();
    });
    row.append(title, go);
    if (entry.spotId) {
      row.append(textButton('Delete', async () => {
        await store.deleteSpot(entry.spotId);
        state.spots = await store.listSpots();
        if (state.target?.spotId === entry.spotId) setTarget(null);
        renderSpotList();
        redraw();
      }));
    }
    list.append(row);
  }
}

function textButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

async function shareLocation() {
  const { fix } = state;
  if (!fix) return;
  const { town } = state.lastLandscape || {};
  const near = town ? ` (${formatDistance(town.miles)} ${compassPoint(town.bearingFromPlace)} of ${town.name}, ${town.state})` : '';
  const text = `I'm at ${formatCoordinates(fix)}${near}, within about ${Math.round(fix.accFeet)} ft. https://www.google.com/maps?q=${fix.lat.toFixed(5)},${fix.lon.toFixed(5)}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      $('shareSpot').textContent = 'Copied';
    }
  } catch { /* Dismissing the share sheet is fine. */ }
}

/* Photos */
const jpegUrl = bytes => URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));

function loadPhotoImage(photo) {
  const image = new Image();
  const url = jpegUrl(photo.thumb);
  image.onload = () => {
    state.photoImages.set(photo.id, image);
    URL.revokeObjectURL(url);
    redraw();
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}

// Redrawing onto a canvas drops the original file's metadata, including its location and camera.
async function shrink(bitmap, longest, quality) {
  const { width, height } = scaledSize(bitmap.width, bitmap.height, longest);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  return new Promise(resolve => { canvas.toBlob(resolve, 'image/jpeg', quality); });
}

async function addPhotos(files) {
  navigator.storage?.persist?.().catch(() => {});
  let added = 0;
  let unplaced = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const exif = readExif(await file.slice(0, 512 * 1024).arrayBuffer());
      const bitmap = await createImageBitmap(file);
      const [full, thumb] = await Promise.all([shrink(bitmap, PHOTO_LONGEST_SIDE, 0.82), shrink(bitmap, THUMB_LONGEST_SIDE, 0.7)]);
      bitmap.close();
      const place = placePhoto({ exif, fileTime: file.lastModified || null, points: state.recorder?.points || [], fix: state.fix, now: Date.now() });
      const photo = { id: store.newId(), hikeId: state.hike?.id || null, ...place, thumb: await thumb.arrayBuffer(), addedAt: Date.now() };
      await store.putPhotoFile(photo.id, await full.arrayBuffer());
      await store.putPhoto(photo);
      state.photos.push(photo);
      loadPhotoImage(photo);
      added += 1;
      if (photo.lat === null) unplaced += 1;
    } catch {
      failed += 1;
    }
  }
  const parts = [];
  if (added) parts.push(`${added === 1 ? 'Photo' : `${added} photos`} added.`);
  if (unplaced) parts.push(`${unplaced} had no location. Place ${unplaced === 1 ? 'it' : 'them'} from More, My photos.`);
  if (failed) parts.push(`${failed} couldn't be read or saved.`);
  scheduleBackup();
  showNotice('photo', parts.join(' '));
  setTimeout(() => hideNotice('photo'), 7000);
  redraw();
}

async function openPhoto(photo) {
  state.viewingPhoto = photo;
  const bytes = await store.getPhotoFile(photo.id);
  if (bytes) $('photoFull').src = jpegUrl(bytes);
  const when = new Date(photo.t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  $('photoFacts').textContent = photo.lat === null ? `${when}. No location yet. Move the map to the spot, then place it.` : `${when}. ${PLACE_LABELS[photo.source]}.`;
  $('photoGuide').hidden = photo.lat === null;
  $('photoDialog').showModal();
}

function renderPhotos() {
  const list = $('photoList');
  list.replaceChildren();
  if (!state.photos.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Photos you add appear here and on the map.';
    list.append(empty);
    return;
  }
  for (const photo of [...state.photos].sort((a, b) => b.t - a.t)) {
    const row = document.createElement('li');
    const image = document.createElement('img');
    image.className = 'thumb';
    image.alt = '';
    const url = jpegUrl(photo.thumb);
    image.onload = () => URL.revokeObjectURL(url);
    image.src = url;
    const label = document.createElement('small');
    label.textContent = `${new Date(photo.t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}${photo.lat === null ? ' · needs a location' : ''}`;
    row.append(image, label, textButton('Open', () => {
      $('photosDialog').close();
      openPhoto(photo);
    }));
    list.append(row);
  }
}

/* Backup */
const BACKUP_FLAG = 'waymark-backup';
const BACKUP_LAST_ACCOUNT = 'waymark-backup-last'; // Outlives sign-out, to catch a different account.
const BACKUP_DELAY_MS = 5000;

function rememberBackup(email) {
  try {
    if (email) localStorage.setItem(BACKUP_FLAG, email);
    else localStorage.removeItem(BACKUP_FLAG);
  } catch { /* Private browsing may refuse. Backup still runs while the app is open. */ }
}

function lastAccount() {
  try {
    return localStorage.getItem(BACKUP_LAST_ACCOUNT);
  } catch {
    return null;
  }
}

function rememberLastAccount(email) {
  try {
    if (email) localStorage.setItem(BACKUP_LAST_ACCOUNT, email);
    else localStorage.removeItem(BACKUP_LAST_ACCOUNT);
  } catch { /* See rememberBackup. */ }
}

function rememberedBackup() {
  try {
    return localStorage.getItem(BACKUP_FLAG);
  } catch {
    return null;
  }
}

// Called after anything worth keeping changes. A failure here must never interrupt a hike.
function scheduleBackup(delay = BACKUP_DELAY_MS) {
  if (!state.backupEmail) return;
  clearTimeout(state.backupTimer);
  state.backupTimer = setTimeout(() => runBackup().catch(() => {}), delay);
}

async function reloadSynced() {
  state.spots = await store.listSpots();
  state.checkins = await store.listCheckins();
  state.photos = await store.listPhotos();
  for (const photo of state.photos) if (!state.photoImages.has(photo.id)) loadPhotoImage(photo);
  updateArrival();
  redraw();
}

const BACKUP_ERRORS = {
  offline: 'No signal right now. Backup will try again when you have some.',
  over_quota: 'Your backup is full, so some items are waiting. Delete some hikes or photos to make room.',
  too_large: 'One item is too large to back up.',
  too_many: 'Backup is pausing for a while. It will try again later.',
};

function renderBackupResult(result) {
  if (!result) return;
  const parts = [];
  if (result.uploaded) parts.push(`${result.uploaded} saved`);
  if (result.downloaded) parts.push(`${result.downloaded} brought to this phone`);
  if (result.removedHere) parts.push(`${result.removedHere} removed here`);
  $('backupKeepRemoving').hidden = !result.heldRemovals;
  if (result.heldRemovals) parts.push(`${result.heldRemovals} items were removed from your backup elsewhere. They're still on this phone, in case that wasn't you`);
  const summary = parts.length ? `${parts.join('. ')}.` : 'Everything is backed up.';
  const trouble = result.failed ? ` ${result.failed} couldn't finish. ${BACKUP_ERRORS[result.firstError] || 'They\'ll try again next time.'}` : '';
  $('backupStatus').textContent = `${summary}${trouble}`;
}

async function runBackup(options = {}) {
  if (!state.backupEmail || state.backupRunning) return;
  state.backupRunning = true;
  $('backupNow').disabled = true;
  $('backupStatus').textContent = 'Backing up…';
  $('backupProgress').hidden = false;
  try {
    const result = await backup.runSync(store, (done, total) => { $('backupProgress').value = total ? (done / total) * 100 : 100; }, options);
    state.backupLast = result;
    renderBackupResult(result);
    if (result.downloaded || result.removedHere) await reloadSynced();
  } catch (error) {
    if (error.status === 401) {
      state.backupEmail = null;
      rememberBackup(null);
      resetSignIn();
      renderBackup('Your sign-in ended. Sign in again to keep backing up. Everything is still on this phone.');
    } else {
      $('backupStatus').textContent = BACKUP_ERRORS[error.code] || 'Backup couldn\'t finish. It will try again later.';
    }
  } finally {
    state.backupRunning = false;
    $('backupNow').disabled = false;
    $('backupProgress').hidden = true;
  }
}

// Back to the first step, so nobody is left looking at a code box for a finished sign-in.
function resetSignIn() {
  $('backupEmailForm').hidden = false;
  $('backupCodeForm').hidden = true;
  $('backupCode').value = '';
}

function renderBackup(message = '') {
  const signedIn = Boolean(state.backupEmail);
  $('backupMessage').textContent = message;
  $('backupOut').hidden = signedIn || !state.backupAvailable;
  $('backupIn').hidden = !signedIn;
  if (signedIn) $('backupAccount').textContent = `Backing up to ${state.backupEmail}.`;
}

async function openBackup() {
  resetSignIn();
  $('backupDialog').showModal();
  renderBackup();
  try {
    const { email } = await backup.whoAmI();
    state.backupEmail = email;
    state.backupAvailable = true;
    rememberBackup(email);
    renderBackup();
    renderBackupResult(state.backupLast);
  } catch (error) {
    if (error.status === 503 || error.code === 'backup_unavailable') {
      state.backupAvailable = false;
      renderBackup('Backup isn\'t set up on this site yet. Everything is safe on this phone.');
    } else if (error.status === 401) {
      state.backupEmail = null;
      state.backupAvailable = true;
      rememberBackup(null);
      renderBackup();
    } else if (!state.backupEmail) {
      renderBackup('Signing in needs signal. Everything still works on this phone.');
    }
  }
}

const SIGN_IN_ERRORS = {
  bad_email: 'That email address doesn\'t look right.',
  bad_code: 'That code didn\'t work. Check it, or ask for a new one. Codes last 10 minutes.',
  too_many: 'Too many tries. Please wait an hour and try again.',
  mail_failed: 'The email couldn\'t be sent. Please try again in a little while.',
  offline: 'Signing in needs signal.',
  backup_unavailable: 'Backup isn\'t set up on this site yet.',
};
const signInError = error => SIGN_IN_ERRORS[error.code] || 'Something went wrong. Please try again.';

/* Checkpoints */
function updateArrival() {
  const age = state.fix ? (Date.now() - state.fixAt) / 1000 : 0;
  const next = arrivedAt(state.checkpoints, state.checkins, state.fix, age);
  if (next?.id !== state.arrival?.id && next) navigator.vibrate?.(200);
  state.arrival = next;
  $('arrival').hidden = !next;
  if (next) $('arrival').textContent = `You've reached ${next.name}. Check in`;
  document.documentElement.style.setProperty('--sheet-height', `${document.querySelector('.sheet').offsetHeight}px`);
}

async function checkIn() {
  const checkpoint = state.arrival;
  const { fix } = state;
  if (!checkpoint || !fix) return;
  scheduleBackup();
  await store.putCheckin({ id: checkpoint.id, t: Date.now(), lat: fix.lat, lon: fix.lon, accFeet: Math.round(fix.accFeet), hikeId: state.hike?.id || null });
  state.checkins = await store.listCheckins();
  updateArrival();
  showNotice('checkin', `Checked in at ${checkpoint.name}. ${progressText(progress(state.checkpoints, state.checkins))}`);
  setTimeout(() => hideNotice('checkin'), 7000);
  redraw();
}

function openCheckpoint(checkpoint) {
  state.viewingCheckpoint = checkpoint;
  const checkin = state.checkins.find(item => item.id === checkpoint.id);
  const away = state.fix ? `${formatDistance(distanceMiles(state.fix, checkpoint))} ${compassPoint(bearingDegrees(state.fix, checkpoint))} · ` : '';
  const when = checkin ? ` · reached ${new Date(checkin.t).toLocaleDateString('en-US', { dateStyle: 'medium' })}` : '';
  $('checkpointTitle').textContent = checkpoint.name;
  $('checkpointFacts').textContent = `${away}${checkpoint.area}${when}`;
  $('checkpointAbout').textContent = checkpoint.about;
  $('checkpointNote').textContent = checkpoint.note;
  $('checkpointNote').hidden = !checkpoint.note;
  $('checkpointDialog').showModal();
}

function renderCheckpoints() {
  const holder = $('checkpointList');
  holder.replaceChildren();
  const reached = new Map(state.checkins.map(checkin => [checkin.id, checkin]));
  $('checkpointProgress').textContent = progressText(progress(state.checkpoints, state.checkins));
  $('checkpointsReset').hidden = !state.checkins.length;
  for (const group of groupCheckpoints(state.checkpoints)) {
    const heading = document.createElement('h3');
    heading.textContent = group.name;
    const list = document.createElement('ul');
    list.className = 'list';
    for (const checkpoint of group.checkpoints) {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'item-title';
      const name = document.createElement('strong');
      name.textContent = `${reached.has(checkpoint.id) ? '✓ ' : ''}${checkpoint.name}`;
      const facts = document.createElement('small');
      const away = state.fix ? `${formatDistance(distanceMiles(state.fix, checkpoint))} ${compassPoint(bearingDegrees(state.fix, checkpoint))} · ` : '';
      facts.textContent = `${away}${checkpoint.area}`;
      title.append(name, facts);
      row.append(title, textButton('Details', () => {
        $('checkpointsDialog').close();
        openCheckpoint(checkpoint);
      }));
      list.append(row);
    }
    holder.append(heading, list);
  }
}

/* Geocaches */
function handleMapTap(x, y, target = map) {
  if (target.zoom >= CHECKPOINT_MIN_ZOOM) {
    const hit = nearestMarker(state.checkpoints.map(checkpoint => ({ ...target.toScreen(checkpoint.lat, checkpoint.lon), checkpoint })), x, y, 22);
    if (hit) {
      openCheckpoint(hit.checkpoint);
      return;
    }
  }
  const markers = [
    ...state.photos.filter(photo => photo.lat !== null).map(photo => ({ ...target.toScreen(photo.lat, photo.lon), open: () => openPhoto(photo) })),
    ...state.geocaches.map(cache => ({ ...target.toScreen(cache.lat, cache.lon), open: () => openCache(cache) })),
  ];
  if (target.zoom >= MARKER_MIN_ZOOM) nearestMarker(markers, x, y)?.open();
}

function openCache(cache) {
  state.viewingCache = cache;
  $('cacheTitle').textContent = cache.code ? `${cache.name} (${cache.code})` : cache.name;
  const distance = state.fix ? `${formatDistance(distanceMiles(state.fix, cache))} ${compassPoint(bearingDegrees(state.fix, cache))} · ` : '';
  $('cacheFacts').textContent = `${distance}${cacheFacts(cache)}${cache.found ? ` · found ${new Date(cache.found).toLocaleDateString('en-US', { dateStyle: 'medium' })}` : ''}`;
  $('cacheDescription').textContent = cache.description;
  $('cacheHint').hidden = true;
  $('cacheHint').textContent = cache.hint;
  $('cacheHintShow').hidden = !cache.hint;
  $('cacheFound').textContent = cache.found ? 'Not found after all' : 'Mark found';
  $('cacheDialog').showModal();
}

function renderCaches() {
  const list = $('cacheList');
  list.replaceChildren();
  $('cachesClear').hidden = !state.geocaches.length;
  if (!state.geocaches.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No geocaches loaded yet.';
    list.append(empty);
    return;
  }
  const from = state.fix || map.center;
  const sorted = nearestFirst(state.geocaches, from);
  for (const cache of sorted.slice(0, LISTED_CACHES)) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'item-title';
    const name = document.createElement('strong');
    name.textContent = cache.name;
    const facts = document.createElement('small');
    facts.textContent = `${formatDistance(distanceMiles(from, cache))} ${compassPoint(bearingDegrees(from, cache))}${cache.found ? ' · found' : ''}${cacheFacts(cache) ? ` · ${cacheFacts(cache)}` : ''}`;
    title.append(name, facts);
    row.append(title, textButton('Details', () => {
      $('cachesDialog').close();
      openCache(cache);
    }));
    list.append(row);
  }
  if (sorted.length > LISTED_CACHES) {
    const more = document.createElement('li');
    more.textContent = `Showing the nearest ${LISTED_CACHES} of ${sorted.length.toLocaleString('en-US')}. All of them are on the map.`;
    list.append(more);
  }
}

async function importCaches(file) {
  const result = $('cachesResult');
  if (file.size > MAX_FILE_BYTES) {
    result.textContent = 'That file is too large. Try a smaller area.';
    return;
  }
  try {
    const incoming = parseGpx(await file.text());
    if (!incoming.length) {
      result.textContent = 'No waypoints found in that file. It needs to be a GPX file.';
      return;
    }
    const { caches, added, updated } = mergeCaches(state.geocaches, incoming);
    await store.putGeocaches(caches);
    state.geocaches = caches;
    result.textContent = `Loaded ${added.toLocaleString('en-US')} new${updated ? ` and updated ${updated.toLocaleString('en-US')}` : ''}.`;
    renderCaches();
    redraw();
  } catch {
    result.textContent = 'That file couldn\'t be read.';
  }
}

/* Hikes list */
async function renderHikes() {
  const list = $('hikeList');
  list.replaceChildren();
  const hikes = (await store.listHikes()).filter(hike => hike.status === 'done');
  if (!hikes.length) {
    const empty = document.createElement('li');
    empty.textContent = 'Finished hikes appear here.';
    list.append(empty);
    return;
  }
  for (const hike of hikes) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'item-title';
    const name = document.createElement('strong');
    name.textContent = hike.name;
    const detail = document.createElement('small');
    const missing = hike.untrackedSeconds ? ` · ${formatDuration(hike.untrackedSeconds)} not tracked` : '';
    detail.textContent = `${new Date(hike.startedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })} · ${hike.miles.toFixed(2)} mi · ${formatDuration(elapsedSeconds(hike))} · ${formatFeet(hike.gainFeet)} climbed${hike.pointCount ? ` · ${hike.pointCount.toLocaleString('en-US')} GPS points` : ''}${missing}`;
    title.append(name, detail);
    row.append(
      title,
      textButton('Show on map', async () => {
        const points = await store.listPoints(hike.id);
        state.viewing = { hike, points };
        setFollow(false);
        fitPoints(points);
        $('hikesDialog').close();
      }),
      textButton('Export GPX', () => exportGpx(hike)),
      textButton('Delete', async () => {
        if (!window.confirm(`Delete ${hike.name}? This can't be undone.`)) return;
        await store.deleteHike(hike.id);
        scheduleBackup();
        if (state.viewing?.hike.id === hike.id) state.viewing = null;
        state.spots = await store.listSpots();
        renderHikes();
        redraw();
      }),
    );
    list.append(row);
  }
}

function fitPoints(points) {
  if (!points.length) return;
  const lats = points.map(point => point.lat);
  const lons = points.map(point => point.lon);
  fitViews({ south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) });
}

async function exportGpx(hike) {
  const points = await store.listPoints(hike.id);
  const photoStops = state.photos.filter(photo => photo.hikeId === hike.id && photo.lat !== null).map(photo => ({ name: `Photo: ${new Date(photo.t).toLocaleTimeString('en-US', { timeStyle: 'short' })}`, lat: photo.lat, lon: photo.lon, t: photo.t, altFeet: null }));
  const spots = [...state.spots.filter(spot => spot.hikeId === hike.id), ...photoStops, ...state.checkins.filter(checkin => checkin.hikeId === hike.id).map(checkin => ({ name: `Checkpoint: ${state.checkpoints.find(item => item.id === checkin.id)?.name || checkin.id}`, lat: checkin.lat, lon: checkin.lon, t: checkin.t, altFeet: null }))];
  const file = new File([toGpx(hike, points, spots)], gpxFileName(hike), { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: hike.name });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

/* Saving a map area */
function renderMapPlan() {
  const plan = planArea(state.saveBounds || map.bounds(), state.shardIndex, state.trailIndex, state.terrainIndex);
  const covered = plan.shards.length || plan.trailShards.length ? ' Trail and water data for this area come with it.' : '';
  $('mapsPlan').textContent = plan.tooLarge
    ? `This view is too large (${plan.tileCount.toLocaleString('en-US')} map pieces). Zoom in to about the area you'll hike.`
    : `About ${Math.max(1, Math.round(plan.megabytes))} MB, ${plan.tileCount.toLocaleString('en-US')} map pieces.${covered}`;
  $('mapsSave').disabled = plan.tooLarge || Boolean(state.saving);
  return plan;
}

async function renderAreas() {
  const list = $('areaList');
  list.replaceChildren();
  $('mapsClear').hidden = !state.areas.length;
  if (!state.areas.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No saved areas yet. Saved areas show on the map as dashed boxes.';
    list.append(empty);
    return;
  }
  for (const area of state.areas) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'item-title';
    const name = document.createElement('strong');
    name.textContent = area.name;
    const detail = document.createElement('small');
    detail.textContent = `${area.tiles.toLocaleString('en-US')} map pieces · saved ${new Date(area.savedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}`;
    title.append(name, detail);
    row.append(title, textButton('Show', () => {
      setFollow(false);
      fitViews(area.bounds, 24);
      $('mapsDialog').close();
    }));
    list.append(row);
  }
}

async function saveCurrentArea() {
  const plan = renderMapPlan();
  if (plan.tooLarge) return;
  const controller = new AbortController();
  state.saving = controller;
  navigator.storage?.persist?.().catch(() => {});
  $('mapsSave').disabled = true;
  $('mapsCancel').hidden = false;
  $('mapsProgress').hidden = false;
  $('mapsResult').textContent = '';
  const { failed, total } = await saveArea(plan, progress => {
    $('mapsProgress').value = (progress.finished / progress.total) * 100;
  }, controller.signal);
  state.saving = null;
  $('mapsCancel').hidden = true;
  $('mapsProgress').hidden = true;
  const center = { lat: (plan.bounds.north + plan.bounds.south) / 2, lon: (plan.bounds.east + plan.bounds.west) / 2 };
  const town = state.places ? nearestPlace(state.places, center) : (await landscapeAt(center)).town;
  if (controller.signal.aborted) {
    $('mapsResult').textContent = 'Stopped. What finished is kept, but this area isn\'t complete.';
  } else if (failed) {
    $('mapsResult').textContent = `${failed} of ${total} pieces didn't download. Try again with better signal to fill them in.`;
  } else {
    await store.putArea({ id: store.newId(), name: town ? `Near ${town.name}, ${town.state}` : 'Saved area', bounds: plan.bounds, tiles: plan.tileCount, savedAt: Date.now() });
    state.areas = await store.listAreas();
    $('mapsResult').textContent = `Saved ${plan.tileCount.toLocaleString('en-US')} map pieces. This area now works without signal.`;
    renderAreas();
    redraw();
  }
  renderMapPlan();
}

/* Controls */
$('zoomIn').addEventListener('click', () => (three.liveOn ? three.live.zoomBy(1) : state.threeD ? three.view.zoomBy(0.7) : map.zoomAround(Math.round(map.zoom) + 1)));
$('zoomOut').addEventListener('click', () => (three.liveOn ? three.live.zoomBy(-1) : state.threeD ? three.view.zoomBy(1.4) : map.zoomAround(Math.round(map.zoom) - 1)));
$('toggle3d').addEventListener('click', () => (state.threeD ? exit3d() : enter3d()));
$('north').addEventListener('click', () => (three.liveOn ? three.live.faceNorth() : three.view.setCamera({ heading: 0 })));
// Losing signal is the normal case out there, so 3D carries on from the saved terrain.
window.addEventListener('offline', () => {
  if (three.liveOn) leaveLive('No signal.');
});
$('locate').addEventListener('click', () => {
  if (!startGps()) return;
  ensureCompass();
  setFollow(true);
  if (state.fix) map.setView(state.fix.lat, state.fix.lon, Math.max(map.zoom, 15));
  update3dPosition();
});
$('trails').addEventListener('click', () => {
  state.showTrails = !state.showTrails;
  $('trails').setAttribute('aria-pressed', String(state.showTrails));
  viewChanged();
  redraw();
  if (three.liveOn) {
    loadLiveShards();
  } else if (state.threeD) {
    if (state.showTrails) shardsForBounds(three.drape.bounds()).forEach(loadTrailShard);
    refreshDrape();
  }
});
$('water').addEventListener('click', () => {
  state.showWater = !state.showWater;
  $('water').setAttribute('aria-pressed', String(state.showWater));
  viewChanged();
  redraw();
  if (three.liveOn) {
    loadLiveShards();
  } else if (state.threeD) {
    if (state.showWater) shardsForBounds(three.drape.bounds()).forEach(loadShard);
    refreshDrape();
  }
});
$('start').addEventListener('click', startHike);
$('pause').addEventListener('click', togglePause);
$('finish').addEventListener('click', () => {
  const { stats } = state.recorder;
  $('finishName').value = state.hike.name;
  const missing = stats.untrackedSeconds ? ` ${formatDuration(stats.untrackedSeconds)} wasn't tracked.` : '';
  $('finishSummary').textContent = `${stats.miles.toFixed(2)} mi in ${formatDuration(elapsedSeconds(state.hike, Date.now()))}.${missing}`;
  $('finishDialog').showModal();
});
$('finishDialog').addEventListener('close', async () => {
  const choice = $('finishDialog').returnValue;
  $('finishDialog').returnValue = '';
  if (choice === 'save') {
    await endHike($('finishName').value.trim() || state.hike.name);
    await renderHikes();
    $('hikesDialog').showModal();
  } else if (choice === 'discard') {
    if (!window.confirm('Discard this hike and its route?')) return;
    await store.deleteHike(state.hike.id);
    state.spots = await store.listSpots();
    clearActive();
    redraw();
  }
});
function renderMarkStatus() {
  const position = averagePosition(state.markFixes);
  $('markStatus').textContent = position
    ? `Averaging ${position.count} GPS ${position.count === 1 ? 'reading' : 'readings'}. Stand still a little longer for a sharper spot.`
    : 'Waiting for a GPS reading…';
}
$('mark').addEventListener('click', () => {
  startGps();
  // The spot is where you stood when you tapped, even if you walk on while typing its name.
  state.markFix = state.fix;
  state.markFixes = state.fix ? [state.fix] : [];
  renderMarkStatus();
  $('markName').value = '';
  $('markDialog').showModal();
});
$('addPhoto').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) await addPhotos(files);
});
$('openMore').addEventListener('click', async () => {
  $('storageNote').textContent = '';
  $('moreDialog').showModal();
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate?.usage) $('storageNote').textContent = `Using about ${Math.max(1, Math.round(estimate.usage / 1048576))} MB of this phone's storage.`;
});
$('openPhotos').addEventListener('click', () => {
  $('moreDialog').close();
  renderPhotos();
  $('photosDialog').showModal();
});
$('photoDialog').addEventListener('close', () => {
  if ($('photoFull').src) URL.revokeObjectURL($('photoFull').src);
  $('photoFull').removeAttribute('src');
});
$('photoGuide').addEventListener('click', () => {
  const { lat, lon } = state.viewingPhoto;
  setTarget({ name: 'Your photo', lat, lon });
  $('photoDialog').close();
});
$('photoPlace').addEventListener('click', async () => {
  const photo = state.viewingPhoto;
  Object.assign(photo, { lat: map.center.lat, lon: map.center.lon, source: 'manual', updatedAt: Date.now() });
  scheduleBackup();
  await store.putPhoto(photo);
  $('photoDialog').close();
  redraw();
});
$('photoDelete').addEventListener('click', async () => {
  if (!window.confirm('Delete this photo from your phone?')) return;
  const { id } = state.viewingPhoto;
  await store.deletePhoto(id);
  state.photos = state.photos.filter(photo => photo.id !== id);
  state.photoImages.delete(id);
  scheduleBackup();
  $('photoDialog').close();
  redraw();
});
$('openBackup').addEventListener('click', () => {
  $('moreDialog').close();
  openBackup();
});
$('backupEmailForm').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('backupEmail').value.trim();
  try {
    await backup.startSignIn(email);
    $('backupEmailForm').hidden = true;
    $('backupCodeForm').hidden = false;
    $('backupCode').value = '';
    $('backupCode').focus();
    renderBackup(`We sent a code to ${email}. Check spam if it doesn't arrive in a minute.`);
  } catch (error) {
    renderBackup(signInError(error));
  }
});
$('backupCodeForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const { email } = await backup.finishSignIn($('backupEmail').value.trim(), $('backupCode').value.trim());
    const previous = lastAccount();
    if (previous && previous !== email && !window.confirm(`This phone was backing up to ${previous}. Signing in as ${email} copies everything on this phone into that account, and brings that account's hikes and photos here. Continue?`)) {
      await backup.signOut().catch(() => {});
      resetSignIn();
      renderBackup('Not signed in. Nothing was copied.');
      return;
    }
    state.backupEmail = email;
    rememberBackup(email);
    rememberLastAccount(email);
    resetSignIn();
    renderBackup();
    await runBackup();
  } catch (error) {
    renderBackup(signInError(error));
  }
});
$('backupRestart').addEventListener('click', () => {
  resetSignIn();
  renderBackup();
});
$('backupNow').addEventListener('click', () => runBackup());
$('backupSignOut').addEventListener('click', async () => {
  try {
    await backup.signOut();
  } catch { /* Forgetting locally still stops this phone from backing up. */ }
  state.backupEmail = null;
  state.backupLast = null;
  rememberBackup(null);
  clearTimeout(state.backupTimer);
  resetSignIn();
  renderBackup('Signed out. Everything is still on this phone, and your backup is kept.');
});
$('backupKeepRemoving').addEventListener('click', () => {
  if (window.confirm('Remove those items from this phone too? They are already gone from your backup, so this deletes the last copy.')) runBackup({ allowRemovals: true });
});
$('backupOthers').addEventListener('click', async () => {
  try {
    await backup.signOutOthers();
    $('backupStatus').textContent = 'Every other phone is signed out. If this wasn\'t expected, check your email account too.';
  } catch (error) {
    $('backupStatus').textContent = error.code === 'offline' ? 'This needs signal.' : 'That didn\'t work. Please try again.';
  }
});
$('backupDelete').addEventListener('click', async () => {
  if (state.backupRunning) {
    $('backupStatus').textContent = 'Backup is running. Try again when it finishes.';
    return;
  }
  if (!window.confirm('Permanently delete your account and everything backed up, on every phone that uses it? What is stored on this phone stays here.')) return;
  try {
    await backup.startSignIn(state.backupEmail);
    clearTimeout(state.backupTimer);
    $('backupDeleteCode').value = '';
    $('backupDeleteForm').hidden = false;
    $('backupDeleteCode').focus();
    $('backupStatus').textContent = `We sent a code to ${state.backupEmail}. Enter it to confirm.`;
  } catch (error) {
    $('backupStatus').textContent = signInError(error);
  }
});
$('backupDeleteCancel').addEventListener('click', () => {
  $('backupDeleteForm').hidden = true;
  $('backupStatus').textContent = 'Your backup is unchanged.';
});
$('backupDeleteForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await backup.deleteAccount($('backupDeleteCode').value.trim());
    await store.clearDeletions();
    state.backupEmail = null;
    state.backupLast = null;
    rememberBackup(null);
    rememberLastAccount(null);
    clearTimeout(state.backupTimer);
    $('backupDeleteForm').hidden = true;
    resetSignIn();
    renderBackup('Your account and backup are deleted. Everything on this phone is still here.');
  } catch (error) {
    $('backupStatus').textContent = error.code === 'offline' ? 'Deleting your account needs signal.' : signInError(error);
  }
});
window.addEventListener('online', () => scheduleBackup(1000));
$('arrival').addEventListener('click', checkIn);
$('openCheckpoints').addEventListener('click', () => {
  renderCheckpoints();
  $('checkpointsDialog').showModal();
});
$('checkpointsReset').addEventListener('click', async () => {
  if (!window.confirm('Clear every check-in and start over?')) return;
  await store.clearCheckins();
  state.checkins = [];
  scheduleBackup();
  renderCheckpoints();
  updateArrival();
  redraw();
});
$('checkpointFollow').addEventListener('click', async () => {
  const hike = (await loadHikes()).find(item => item.id === state.viewingCheckpoint.hikeId);
  $('checkpointDialog').close();
  if (hike) chooseHike(hike);
});
$('checkpointGuide').addEventListener('click', () => {
  const { name, lat, lon } = state.viewingCheckpoint;
  setTarget({ name, lat, lon, spotId: `checkpoint-${state.viewingCheckpoint.id}` });
  $('checkpointDialog').close();
});
$('openCaches').addEventListener('click', () => {
  $('moreDialog').close();
  $('cachesResult').textContent = '';
  renderCaches();
  $('cachesDialog').showModal();
});
$('cachesImport').addEventListener('click', () => $('cachesInput').click());
$('cachesInput').addEventListener('change', async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) await importCaches(file);
});
$('cachesClear').addEventListener('click', async () => {
  if (!window.confirm('Remove every loaded geocache, including your found marks?')) return;
  await store.clearGeocaches();
  state.geocaches = [];
  renderCaches();
  redraw();
});
$('cacheHintShow').addEventListener('click', () => {
  $('cacheHint').hidden = false;
  $('cacheHintShow').hidden = true;
});
$('cacheGuide').addEventListener('click', () => {
  const { name, lat, lon } = state.viewingCache;
  setTarget({ name, lat, lon });
  $('cacheDialog').close();
});
$('cacheFound').addEventListener('click', async () => {
  const cache = state.viewingCache;
  cache.found = cache.found ? null : Date.now();
  await store.putGeocache(cache);
  $('cacheDialog').close();
  redraw();
});
$('markChips').addEventListener('click', event => {
  if (event.target.classList.contains('pill')) $('markName').value = event.target.textContent;
});
$('markDialog').addEventListener('close', async () => {
  const choice = $('markDialog').returnValue;
  $('markDialog').returnValue = '';
  if (choice !== 'save') return;
  const fix = averagePosition(state.markFixes) || state.markFix || state.fix;
  if (!fix) {
    showNotice('mark', 'No GPS fix yet, so that spot wasn\'t saved. Try again once the GPS chip shows a distance.');
    return;
  }
  const { lat, lon, altFeet } = fix;
  await store.putSpot({ id: store.newId(), hikeId: state.hike?.id || null, name: $('markName').value.trim(), lat, lon, altFeet: Number.isFinite(altFeet) ? altFeet : null, t: Date.now() });
  state.spots = await store.listSpots();
  redraw();
  scheduleBackup();
});
$('openWhere').addEventListener('click', () => {
  startGps();
  $('shareSpot').textContent = 'Share location';
  $('whereDialog').showModal();
  renderWhere();
});
$('shareSpot').addEventListener('click', shareLocation);
$('goWater').addEventListener('click', () => {
  const { water } = state.lastLandscape || {};
  if (!water) return;
  setTarget({ name: water.name || 'Nearest stream', ...water.point });
  $('whereDialog').close();
});
$('guideStop').addEventListener('click', () => (state.route ? endRoute() : setTarget(null)));
$('activityChip').addEventListener('click', () => setActivity(''));
$('openPlan').addEventListener('click', openPlan);
$('openConditions').addEventListener('click', () => {
  $('moreDialog').close();
  openConditions(state.fix || map.center, state.fix ? 'where you are' : 'the middle of the map');
});
$('planHere').addEventListener('click', () => {
  rememberPlan({ ...readPlan(), here: true });
  renderPlan();
});
// The site links straight to the planner, whether or not the app is already open.
const openPlanFromLink = () => {
  if (location.hash === '#plan' && !$('planDialog').open) openPlan();
};
window.addEventListener('hashchange', openPlanFromLink);
openPlanFromLink();
// Trail pages link here. This only shows the trail: following it turns on GPS, and that stays a choice.
async function openTrailFromLink() {
  const id = /^#trail=([\w-]+)$/.exec(location.hash)?.[1];
  if (!id || $('finderDialog').open) return;
  const route = (await loadRoutes()).routes.find(item => item.id === id);
  if (!route) return;
  const shards = await Promise.all(shardsForBounds(route.bounds).map(loadTrailShard));
  const decoded = routeLines(shards, route);
  state.viewing = { hike: { id: route.id }, line: decoded.flatMap((line, seg) => line.points.map(point => ({ ...point, seg }))) };
  setFollow(false);
  fitViews(route.bounds);
  renderFinderChoices();
  const list = document.createElement('ul');
  list.className = 'list route-list';
  list.append(routeRow(route));
  $('finderList').replaceChildren(list);
  $('finderHelp').replaceChildren();
  $('finderDialog').showModal();
  redraw();
}
window.addEventListener('hashchange', openTrailFromLink);
$('openFinder').addEventListener('click', () => {
  $('finderDialog').showModal();
  renderFinder();
});
$('openHikes').addEventListener('click', async () => {
  $('moreDialog').close();
  await renderHikes();
  $('hikesDialog').showModal();
});
function openMaps(bounds = null) {
  state.saveBounds = bounds;
  $('mapsResult').textContent = '';
  renderMapPlan();
  renderAreas();
  $('mapsDialog').showModal();
}
$('openMaps').addEventListener('click', () => {
  $('moreDialog').close();
  openMaps();
});
$('mapsSave').addEventListener('click', saveCurrentArea);
$('mapsCancel').addEventListener('click', () => state.saving?.abort());
$('mapsClear').addEventListener('click', async () => {
  if (!window.confirm('Delete every saved map area? Your hikes and marked spots stay.')) return;
  await clearSaved();
  await store.clearAreas();
  state.areas = [];
  renderAreas();
  redraw();
});
// iOS needs a tap to allow the compass, so offer it on the first interaction with the guide.
$('guide').addEventListener('click', () => {
  if (compassNeedsPermission()) ensureCompass();
});

setInterval(() => {
  renderGps();
  updateArrival();
  if (state.hike) renderStats();
  if (state.threeD && three.dirty && Date.now() - three.lastRefresh >= DRAPE_REFRESH_MS) refreshDrape();
}, 1000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

fetch(dataUrl('checkpoints.json')).then(response => response.json()).then(({ checkpoints }) => {
  state.checkpoints = checkpoints;
  updateArrival();
  redraw();
}).catch(() => {});

fetch(dataUrl('index.json')).then(response => response.json()).then(index => {
  state.shardIndex = index.shards;
  state.trailIndex = index.trailShards || [];
  state.terrainIndex = index.terrainBlocks || [];
  viewChanged();
  openTrailFromLink();
}).catch(() => {});

try {
  setActivity(localStorage.getItem(ACTIVITY_KEY) || '');
} catch { /* Private browsing: everything shows until a choice is made. */ }

state.backupEmail = rememberedBackup();
scheduleBackup(3000);

renderButtons();
restoreActive().catch(() => showNotice('save', 'This browser is blocking storage, so your route can\'t be saved. Check private-browsing settings.'));
