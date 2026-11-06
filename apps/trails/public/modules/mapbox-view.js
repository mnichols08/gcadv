// The online 3D view: Mapbox's outdoors map on its terrain, the same look as the site's adventure
// map. It needs signal, so the app falls back to its own saved terrain without it. The map is kept
// when the hiker leaves 3D, because every new one counts as a billed map load.
import { collection, fromMapboxZoom, toMapboxZoom } from './mapbox-data.js';
import { EXAGGERATION, MAX_PITCH, START_PITCH } from './mapbox-settings.js';

const STYLE = 'mapbox://styles/mapbox/outdoors-v12';
const DEM_SOURCE = 'live-terrain';
const LOAD_TIMEOUT_MS = 15000;
const SETTLE_MS = 15000;
const FONT = ['DIN Pro Medium', 'Arial Unicode MS Regular'];

let library = null;

// Loaded only when someone first opens 3D: the file is larger than the rest of the app together.
export function loadMapboxGl() {
  library ||= new Promise((resolve, reject) => {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = 'vendor/mapbox-gl.css';
    document.head.append(style);
    const script = document.createElement('script');
    script.src = 'vendor/mapbox-gl.js';
    script.onload = () => resolve(window.mapboxgl);
    script.onerror = () => {
      library = null;
      reject(new Error('Mapbox failed to load'));
    };
    document.head.append(script);
  });
  return library;
}

const TRAIL_COLOR = ['match', ['get', 'kind'], 'foot', '#a8320a', 'shared', '#7a2fb5', 'ski', '#00798c', '#505050'];
const TRAIL_DASH = ['match', ['get', 'kind'], 'foot', ['literal', [1, 0]], 'shared', ['literal', [3, 2]], 'ski', ['literal', [3, 2]], ['literal', [2, 2]]];

const toFeet = field => ['to-string', ['round', ['*', ['to-number', field], 3.28084]]];

// The style's contour and peak labels are in meters.
export function useFeet(map) {
  if (map.getLayer('contour-label')) map.setLayoutProperty('contour-label', 'text-field', ['concat', toFeet(['get', 'ele']), ' ft']);
  for (const layer of map.getStyle().layers || []) {
    if (layer.type !== 'symbol' || !JSON.stringify(layer.layout?.['text-field'] || '').includes('elevation_m')) continue;
    map.setLayoutProperty(layer.id, 'text-field', ['format', ['coalesce', ['get', 'name_en'], ['get', 'name']], {},
      ['case', ['has', 'elevation_m'], ['concat', '\n', toFeet(['get', 'elevation_m']), ' ft'], ''], { 'font-scale': 0.8 }]);
  }
}

function addLayers(map) {
  for (const id of ['streams', 'trails', 'routes', 'points']) map.addSource(id, { type: 'geojson', data: collection([]) });
  map.addLayer({ id: 'streams', type: 'line', source: 'streams', minzoom: 10,
    paint: { 'line-color': '#0066d6', 'line-opacity': 0.7, 'line-width': ['match', ['get', 'tier'], 2, 3.4, 1, 2.2, 1.4] } });
  map.addLayer({ id: 'trails', type: 'line', source: 'trails', minzoom: 10, layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_COLOR, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 3], 'line-dasharray': TRAIL_DASH } });
  map.addLayer({ id: 'trail-names', type: 'symbol', source: 'trails', minzoom: 12,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12 },
    paint: { 'text-color': ['case', ['==', ['get', 'kind'], 'foot'], '#7c2507', '#333333'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.85, 'line-width': 8 } });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 } });
  map.addLayer({ id: 'points', type: 'circle', source: 'points',
    paint: { 'circle-radius': ['coalesce', ['get', 'radius'], 8], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-pitch-alignment': 'viewport' } });
  map.addLayer({ id: 'point-names', type: 'symbol', source: 'points',
    layout: { 'text-field': ['coalesce', ['get', 'label'], ''], 'text-font': FONT, 'text-size': 13, 'text-anchor': 'left', 'text-offset': [1, 0], 'text-optional': true },
    paint: { 'text-color': '#101820', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
}

export class MapboxView {
  constructor(mapboxgl, container, { token, center, zoom, onTap, onUserMove, onBearing, onViewChange, onFail }) {
    this.mapboxgl = mapboxgl;
    this.onUserMove = onUserMove;
    this.target = null;
    this.photos = new Map();
    this.pending = null;
    this.loaded = false;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container,
      style: STYLE,
      center: [center.lon, center.lat],
      zoom: toMapboxZoom(zoom),
      pitch: START_PITCH,
      bearing: 0,
      maxPitch: MAX_PITCH,
      dragRotate: true,
      pitchWithRotate: true,
      touchPitch: true,
    });
    this.map = map;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mapbox took too long')), LOAD_TIMEOUT_MS);
      map.on('style.load', () => {
        clearTimeout(timer);
        map.addSource(DEM_SOURCE, { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 });
        map.setTerrain({ source: DEM_SOURCE, exaggeration: EXAGGERATION });
        map.setFog({});
        useFeet(map);
        addLayers(map);
        this.loaded = true;
        if (this.pending) this.setData(this.pending);
        resolve(this);
      });
      map.on('error', ({ error, sourceId }) => {
        // A dropped tile on weak signal is normal. A refused token or a missing style is not.
        const refused = [401, 403].includes(error?.status);
        if (!this.loaded) {
          if (refused || !sourceId) {
            clearTimeout(timer);
            reject(error || new Error('Mapbox failed'));
          }
        } else if (refused) {
          onFail?.();
        }
      });
    });
    // The guide card takes room from the map without the window changing size.
    new ResizeObserver(() => map.resize()).observe(container);
    map.on('rotate', () => onBearing?.(map.getBearing()));
    map.on('moveend', () => onViewChange?.());
    map.on('idle', () => this.settle());
    map.on('click', ({ point }) => onTap?.(point.x, point.y));
    for (const event of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
      map.on(event, ({ originalEvent }) => {
        if (!originalEvent) return;
        this.target = null;
        this.onUserMove?.();
      });
    }
  }

  get zoom() {
    return fromMapboxZoom(this.map.getZoom());
  }

  get center() {
    const { lat, lng } = this.map.getCenter();
    return { lat, lon: lng };
  }

  bounds() {
    const box = this.map.getBounds();
    return { south: box.getSouth(), north: box.getNorth(), west: box.getWest(), east: box.getEast() };
  }

  toScreen(lat, lon) {
    return this.map.project([lon, lat]);
  }

  show(center, zoom) {
    this.map.resize();
    const next = { center: [center.lon, center.lat], zoom: toMapboxZoom(zoom) };
    this.map.jumpTo(next);
    this.holdView(next);
  }

  // When elevation arrives after the camera is placed, Mapbox lifts the camera clear of the ground,
  // which zooms out and slides the view. That could leave the trail off the screen, so the view is
  // put back once the map goes quiet, unless the person has moved it themselves.
  holdView(view) {
    this.target = { ...view, until: Date.now() + SETTLE_MS };
  }

  settle() {
    const { target, map } = this;
    if (!target) return;
    if (Date.now() > target.until) {
      this.target = null;
      return;
    }
    const { lng, lat } = map.getCenter();
    const drift = Math.max(Math.abs(lng - target.center[0]), Math.abs(lat - target.center[1]));
    if (drift > 0.0002 || Math.abs(map.getZoom() - target.zoom) > 0.05) map.jumpTo({ center: target.center, zoom: target.zoom });
  }

  resize() {
    this.map.resize();
  }

  fit({ south, west, north, east }) {
    this.target = null;
    this.map.fitBounds([[west, south], [east, north]], { padding: 56, maxZoom: 15, pitch: this.map.getPitch(), bearing: this.map.getBearing(), duration: 700 });
    this.map.once('moveend', () => {
      const { lng, lat } = this.map.getCenter();
      this.holdView({ center: [lng, lat], zoom: this.map.getZoom() });
    });
  }

  follow({ lat, lon }, minimumZoom = 15) {
    this.target = null;
    this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), toMapboxZoom(minimumZoom)), duration: 500 });
  }

  zoomBy(steps) {
    this.target = null;
    this.map.easeTo({ zoom: this.map.getZoom() + steps, duration: 250 });
  }

  faceNorth() {
    this.map.easeTo({ bearing: 0, duration: 400 });
  }

  setData(data) {
    if (!this.loaded) {
      this.pending = data;
      return;
    }
    for (const [id, features] of Object.entries(data)) this.map.getSource(id)?.setData(collection(features));
  }

  setMe(position, heading) {
    if (!this.me) {
      const element = document.createElement('div');
      element.className = 'live-me';
      element.innerHTML = '<span class="live-me-arrow"></span>';
      this.me = new this.mapboxgl.Marker({ element, rotationAlignment: 'map', pitchAlignment: 'viewport' }).setLngLat([position.lon, position.lat]).addTo(this.map);
    }
    this.me.setLngLat([position.lon, position.lat]);
    this.me.setRotation(heading ?? 0);
    this.me.getElement().dataset.heading = heading === null ? 'none' : 'known';
  }

  // Photos stay real thumbnails here, as they are on the flat map.
  setPhotos(photos, open) {
    const keep = new Set(photos.map(photo => photo.id));
    for (const [id, marker] of this.photos) {
      if (!keep.has(id)) {
        marker.remove();
        this.photos.delete(id);
      }
    }
    for (const photo of photos) {
      if (this.photos.has(photo.id)) continue;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'live-photo';
      element.setAttribute('aria-label', 'Open photo');
      if (photo.src) element.style.backgroundImage = `url("${photo.src}")`;
      element.addEventListener('click', event => {
        event.stopPropagation();
        open(photo.id);
      });
      this.photos.set(photo.id, new this.mapboxgl.Marker({ element }).setLngLat([photo.lon, photo.lat]).addTo(this.map));
    }
  }
}
