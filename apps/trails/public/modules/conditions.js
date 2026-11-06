// Live conditions from public services a phone can reach directly. Each one can fail on its own, and
// nothing here judges whether a trail or river is safe.
import { distanceMiles } from './geo.js';

const INCHES_PER_METER = 39.3701;
const GAUGE_MAX_AGE_HOURS = 6; // Some gauges keep listing a reading from years ago.
const USGS = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items';
const WEATHER = 'https://api.weather.gov';
const SNOW = 'https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer/identify';
const REGION_BOX = '-80.05,38.75,-78.3,40.35'; // Always the whole region, so this request says nothing about the person.
export const NEARBY_GAUGE_MILES = 30;
export const SAVED_FOR_MS = 15 * 60 * 1000;

// About two-thirds of a mile, enough for weather without sending someone's exact position.
export const roughly = ({ lat, lon }) => ({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });

export const gaugeUrl = () => `${USGS}?${new URLSearchParams({ f: 'json', bbox: REGION_BOX, parameter_code: '00060,00065', limit: '500', properties: 'monitoring_location_id,parameter_code,time,value' })}`;

export function snowUrl({ lat, lon }) {
  return `${SNOW}?${new URLSearchParams({ f: 'json', geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326', layers: 'visible:3', tolerance: '1', mapExtent: `${lon - 0.5},${lat - 0.5},${lon + 0.5},${lat + 0.5}`, imageDisplay: '400,400,96', returnGeometry: 'false' })}`;
}

export function parseAlerts(body) {
  return (body?.features || []).map(({ properties }) => ({ event: properties.event, headline: properties.headline || properties.event, ends: properties.ends || properties.expires || null }));
}

export function parseForecast(body, count = 4) {
  return (body?.properties?.periods || []).slice(0, count).map(({ name, temperature, temperatureUnit, shortForecast, windSpeed, windDirection }) => ({
    name,
    temperature: `${temperature}°${temperatureUnit}`,
    summary: shortForecast,
    wind: windSpeed ? `${windDirection || ''} ${windSpeed}`.trim() : '',
  }));
}

// The service reports meters, which its own legend shows as inches. A missing value stays unknown.
export function parseSnowInches(body) {
  const value = Number(body?.results?.[0]?.attributes?.['Service Pixel Value']);
  if (!body?.results?.length || !Number.isFinite(value) || value < 0) return null;
  return value * INCHES_PER_METER;
}

export function snowText(inches) {
  if (inches === null || inches === undefined) return '';
  if (inches < 0.5) return 'No snow estimated';
  if (inches < 1) return 'Under 1 inch estimated';
  return `About ${Math.round(inches)} inches estimated`;
}

export function parseGauges(body, gauges, now = Date.now(), maxAgeHours = GAUGE_MAX_AGE_HOURS) {
  const known = new Map(gauges.map(gauge => [gauge.id, gauge]));
  const readings = new Map();
  for (const { properties } of body?.features || []) {
    const id = properties.monitoring_location_id?.replace(/^USGS-/, '');
    const time = Date.parse(properties.time);
    const value = Number(properties.value);
    if (!known.has(id) || !Number.isFinite(time) || !Number.isFinite(value) || now - time > maxAgeHours * 3600000) continue;
    const reading = readings.get(id) || { ...known.get(id), time };
    if (properties.parameter_code === '00060') reading.cfs = value;
    if (properties.parameter_code === '00065') reading.feet = value;
    reading.time = Math.max(reading.time, time);
    readings.set(id, reading);
  }
  return [...readings.values()].filter(reading => reading.cfs !== undefined || reading.feet !== undefined);
}

export function nearbyGauges(readings, place, limit = 4, withinMiles = NEARBY_GAUGE_MILES) {
  return readings
    .map(reading => ({ ...reading, miles: distanceMiles(place, reading) }))
    .filter(({ miles }) => miles <= withinMiles)
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
}

export function gaugeText({ cfs, feet }) {
  const parts = [];
  if (cfs !== undefined) parts.push(`${Math.round(cfs).toLocaleString('en-US')} cubic feet per second`);
  if (feet !== undefined) parts.push(`${feet.toFixed(2)} ft stage`);
  return parts.join(', ');
}

async function json(fetcher, url, timeoutMs) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json, application/geo+json' } });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

// Sections are null when they couldn't be reached, so old readings can stand in for just those.
export async function fetchConditions(exactPlace, gauges, { fetcher = fetch, now = Date.now(), timeoutMs = 10000 } = {}) {
  const place = roughly(exactPlace);
  const read = url => json(fetcher, url, timeoutMs);
  const [alerts, forecast, snow, rivers] = await Promise.allSettled([
    read(`${WEATHER}/alerts/active?point=${place.lat},${place.lon}`).then(parseAlerts),
    read(`${WEATHER}/points/${place.lat},${place.lon}`).then(point => read(point.properties.forecast)).then(body => parseForecast(body)),
    read(snowUrl(place)).then(parseSnowInches),
    read(gaugeUrl()).then(body => nearbyGauges(parseGauges(body, gauges, now), exactPlace)),
  ]);
  const value = result => (result.status === 'fulfilled' ? result.value : null);
  return { fetchedAt: now, alerts: value(alerts), forecast: value(forecast), snowInches: value(snow), rivers: value(rivers) };
}

// Fresh readings win. A section that failed falls back to the saved one, marked so the page can say so.
export function withSaved(fresh, saved) {
  if (!saved) return { ...fresh, savedSections: [] };
  const merged = { ...fresh, savedSections: [] };
  for (const section of ['alerts', 'forecast', 'snowInches', 'rivers']) {
    if (fresh[section] === null && saved[section] !== null && saved[section] !== undefined) {
      merged[section] = saved[section];
      merged.savedSections.push(section);
      merged.savedAt = saved.fetchedAt;
    }
  }
  return merged;
}

export const isFresh = (saved, now = Date.now()) => Boolean(saved) && now - saved.fetchedAt < SAVED_FOR_MS;
