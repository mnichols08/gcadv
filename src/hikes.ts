export interface HikeSource {
  id: string;
  url: string;
  retrievedAt: string;
  attribution: string;
  kind: "Hiking route" | "Mapped path";
  tags: Record<string, string>;
  regionalOnly?: boolean;
}

export interface Hike {
  name: string;
  segments: [number, number][][];
  source: HikeSource;
}

export interface HikeDiscovery {
  hikes: Hike[];
  retrievedAt: string;
  skipped: number;
}

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OVERPASS_SERVERS = [
  { label: "Overpass Germany", url: OVERPASS_URL },
  { label: "Overpass Kumi (alternate)", url: "https://overpass.kumi.systems/api/interpreter" },
];
// Fixed regional bounds avoid sending a visitor's position or unbounded map queries.
export const HIKE_QUERY = `[out:json][timeout:25][bbox:${REGION_BBOX}];
(
  relation["type"="route"]["route"~"^(hiking|foot)$"];
  way["highway"~"^(path|footway)$"]["name"]["foot"!="no"]["access"!="private"]["access"!="no"];
);
out geom;`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coordinates(value: unknown): [number, number][][] {
  if (!Array.isArray(value)) return [];
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const point of value) {
    if (record(point) && typeof point.lon === "number" && typeof point.lat === "number" &&
        Number.isFinite(point.lon) && Number.isFinite(point.lat) &&
        Math.abs(point.lon) <= 180 && Math.abs(point.lat) <= 90) {
      current.push([point.lon, point.lat]);
    } else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export function parseDiscovery(value: unknown, retrievedAt = new Date().toISOString()): HikeDiscovery {
  if (!record(value) || !Array.isArray(value.elements)) throw new Error("The trail service returned an invalid response.");
  if (typeof value.remark === "string") throw new Error("The trail service could not complete the query. Try again later.");
  const hikes: Hike[] = [];
  let skipped = 0;
  let points = 0;
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (!record(element) || (element.type !== "way" && element.type !== "relation") ||
        typeof element.id !== "number" || !Number.isSafeInteger(element.id) || element.id <= 0 ||
        !record(element.tags)) { skipped++; continue; }
    const tags: Record<string, string> = {};
    for (const [key, tag] of Object.entries(element.tags)) if (typeof tag === "string") tags[key] = tag.slice(0, 500);
    const relation = element.type === "relation";
    if (relation ? tags.type !== "route" || !["hiking", "foot"].includes(tags.route) :
      !["path", "footway"].includes(tags.highway)) { skipped++; continue; }
    const id = `${element.type}/${element.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const segments: [number, number][][] = [];
    if (relation && Array.isArray(element.members)) {
      const members = new Set<number>();
      for (const member of element.members) {
        if (!record(member) || member.type !== "way" || typeof member.ref !== "number" || members.has(member.ref)) continue;
        members.add(member.ref);
        segments.push(...coordinates(member.geometry));
      }
    } else if (!relation) segments.push(...coordinates(element.geometry));
    const regionalSegments = clipSegments(segments);
    const count = regionalSegments.reduce((sum, segment) => sum + segment.length, 0);
    if (!count) { skipped++; continue; }
    points += count;
    if (points > 300_000 || count > 100_000 || hikes.length >= 500) {
      throw new Error("Regional trail results exceed the supported size. No partial results were accepted.");
    }
    hikes.push({
      name: tags.name || tags.ref || `Unnamed hiking route ${element.id}`,
      segments: regionalSegments,
      source: {
        id, url: `https://www.openstreetmap.org/${id}`, retrievedAt,
        attribution: "OpenStreetMap contributors (ODbL)", kind: relation ? "Hiking route" : "Mapped path", tags,
        regionalOnly: true,
      },
    });
  }
  hikes.sort((a, b) => a.source.kind.localeCompare(b.source.kind) || a.name.localeCompare(b.name));
  return { hikes, retrievedAt, skipped };
}

export function mergeDiscovery(bundled: HikeDiscovery, cached?: HikeDiscovery): HikeDiscovery {
  const hikes = new Map(bundled.hikes.map((hike) => [hike.source.id, hike]));
  for (const hike of cached?.hikes || []) {
    const previous = hikes.get(hike.source.id);
    if (previous && previous.source.retrievedAt >= hike.source.retrievedAt) continue;
    const segments = clipSegments(hike.segments);
    if (segments.length) hikes.set(hike.source.id, {
      ...hike, segments, source: { ...hike.source, regionalOnly: true },
    });
  }
  return {
    hikes: [...hikes.values()].sort((a, b) => a.source.kind.localeCompare(b.source.kind) || a.name.localeCompare(b.name)),
    retrievedAt: cached && cached.retrievedAt > bundled.retrievedAt ? cached.retrievedAt : bundled.retrievedAt,
    skipped: cached?.skipped || bundled.skipped,
  };
}

export function parseSnapshot(value: unknown): HikeDiscovery {
  if (!record(value) || typeof value.retrievedAt !== "string" || !Number.isFinite(Date.parse(value.retrievedAt)) ||
      !Array.isArray(value.hikes) || typeof value.skipped !== "number") throw new Error("Invalid bundled hike snapshot.");
  const hikes: Hike[] = value.hikes.map((hike: unknown) => {
    if (!record(hike) || typeof hike.name !== "string" || !Array.isArray(hike.segments) || !record(hike.source)) {
      throw new Error("Invalid hike in bundled snapshot.");
    }
    const source = hike.source;
    if (typeof source.id !== "string" || !/^(way|relation)\/[1-9]\d*$/.test(source.id) ||
        source.url !== `https://www.openstreetmap.org/${source.id}` ||
        typeof source.retrievedAt !== "string" || !Number.isFinite(Date.parse(source.retrievedAt)) ||
        typeof source.attribution !== "string" || !record(source.tags) ||
        (source.kind !== "Hiking route" && source.kind !== "Mapped path")) throw new Error("Invalid snapshot provenance.");
    const tags: Record<string, string> = {};
    for (const [key, tag] of Object.entries(source.tags)) {
      if (typeof tag !== "string") throw new Error("Invalid snapshot tag.");
      tags[key] = tag;
    }
    const segments = hike.segments.map((segment: unknown): [number, number][] => {
      if (!Array.isArray(segment) || segment.length < 2) throw new Error("Invalid snapshot geometry.");
      return segment.map((point: unknown): [number, number] => {
        if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number" ||
            !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error("Invalid snapshot coordinate.");
        return [point[0], point[1]];
      });
    });
    return {
      name: hike.name, segments: clipSegments(segments),
      source: { id: source.id, url: source.url, retrievedAt: source.retrievedAt,
        attribution: source.attribution, kind: source.kind, tags, regionalOnly: true },
    };
  });
  return { hikes, retrievedAt: value.retrievedAt, skipped: value.skipped };
}

export async function discoverHikes(signal: AbortSignal, endpoint = OVERPASS_URL): Promise<HikeDiscovery> {
  if (!OVERPASS_SERVERS.some((server) => server.url === endpoint)) throw new Error("Unsupported trail service endpoint.");
  const url = new URL(endpoint);
  url.searchParams.set("data", HIKE_QUERY);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(
    response.status === 429 ? "Trail service rate limit reached. Wait before trying again." :
      `Trail discovery failed (HTTP ${response.status}). Try again later.`,
  );
  if (!response.body) throw new Error("The trail service returned no data.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 12 * 1024 * 1024) throw new Error("Trail response exceeds the 12 MiB limit.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("The trail service returned invalid JSON."); }
  return parseDiscovery(data);
}

function escapeXml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function makeGpx(name: string, segments: { longitude: number; latitude: number; elevation?: number | null }[][], source?: HikeSource): string {
  const metadata = source ? `<metadata><desc>${escapeXml(`${source.attribution}; ${source.kind}; retrieved ${source.retrievedAt}. ${source.regionalOnly ? "Geometry limited to the Garrett County region; may be only part of the full route. " : ""}Mapped geometry only, not verified navigation.`)}</desc><link href="${escapeXml(source.url)}"><text>OpenStreetMap source</text></link></metadata>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garrett County Adventures" xmlns="http://www.topografix.com/GPX/1/1">${metadata}<trk><name>${escapeXml(name)}</name>${segments.map((segment) =>
    `<trkseg>${segment.map((point) => `<trkpt lat="${point.latitude}" lon="${point.longitude}">${point.elevation == null ? "" : `<ele>${point.elevation}</ele>`}</trkpt>`).join("")}</trkseg>`,
  ).join("")}</trk></gpx>`;
}

export function hikeGpx(hike: Hike): string {
  return makeGpx(hike.name, hike.segments.map((segment) => segment.map(([longitude, latitude]) => ({ longitude, latitude }))), hike.source);
}
import { REGION_BBOX, clipSegments } from "./region";
