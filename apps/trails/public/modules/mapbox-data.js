// What the online 3D view shows, as GeoJSON. Pure, so it can be checked without a map.

// Mapbox measures zoom on a 512-pixel world and the topo map on a 256-pixel one.
export const toMapboxZoom = zoom => zoom - 1;
export const fromMapboxZoom = zoom => zoom + 1;

// The browser-safe kind of token only. A secret token must never reach a page.
export function readToken(config) {
  const token = config?.mapboxToken;
  return typeof token === 'string' && /^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

const coordinates = points => points.map(({ lat, lon }) => [lon, lat]);

export function line(points, properties = {}) {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coordinates(points) } };
}

export function point({ lat, lon }, properties = {}) {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

export const collection = features => ({ type: 'FeatureCollection', features });

// A trail crossing a shard edge is stored in both shards, and a line drawn twice looks heavier.
export function uniqueLines(shards) {
  const seen = new Set();
  const lines = [];
  for (const shard of shards) {
    for (const entry of shard?.lines || []) {
      const first = entry.points[0];
      const last = entry.points[entry.points.length - 1];
      const key = first && `${entry.name}|${first.lat},${first.lon}|${last.lat},${last.lon}|${entry.points.length}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(entry);
    }
  }
  return lines;
}

export const trailFeatures = (shards, accepts = () => true) => uniqueLines(shards)
  .filter(entry => entry.points.length > 1 && accepts(entry))
  .map(entry => line(entry.points, { kind: entry.kind, name: entry.name }));

export const streamFeatures = shards => shards
  .flatMap(shard => shard?.lines || [])
  .filter(entry => entry.points.length > 1)
  .map(entry => line(entry.points, { tier: entry.order >= 5 ? 2 : entry.order >= 3 ? 1 : 0 }));

// A recorded route is one list of points with a segment number, because pausing breaks the line.
export function routeSegments(points) {
  const segments = [];
  let current = null;
  let segment;
  for (const entry of points) {
    if (!current || entry.seg !== segment) {
      current = [];
      segments.push(current);
      segment = entry.seg;
    }
    current.push(entry);
  }
  return segments.filter(part => part.length > 1);
}

export const routeFeatures = (points, color) => routeSegments(points).map(part => line(part, { color }));
