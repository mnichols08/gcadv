import geojson from "./model/geo.json";
import type { HikeSource } from "./hikes";

export interface Place {
  id: string;
  name: string;
  description: string;
  activities: string[];
  coordinates: [number, number];
}

export interface TrailPoint {
  longitude: number;
  latitude: number;
  elevation: number | null;
  distanceM: number;
}

export interface Analysis {
  name: string;
  segments: TrailPoint[][];
  pointCount: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  elevationPoints: number;
  elevationPairs: number;
  totalPairs: number;
  minElevation: number | null;
  maxElevation: number | null;
}

export type SavedOuting =
  | { id: string; kind: "place"; name: string; savedAt: string; place: Place }
  | { id: string; kind: "trail"; name: string; savedAt: string; analysis: Analysis; source?: HikeSource };

const categories: [string, RegExp][] = [
  ["Hiking", /hik/i],
  ["Camping", /camp/i],
  ["Paddling", /kayak|boat/i],
  ["Fishing", /fish/i],
  ["Biking", /bik/i],
  ["Picnicking", /picni/i],
  ["Winter sports", /ski|snow/i],
  ["Sightseeing", /view|museum|shopping/i],
];

export const places: Place[] = geojson.features.map((feature) => ({
  id: feature.id,
  name: feature.properties["Park Name"],
  description: feature.properties.Description,
  activities: categories
    .filter(([, expression]) => expression.test(feature.properties.Activities || ""))
    .map(([label]) => label),
  coordinates: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]],
}));

export const activityOptions = categories.map(([label]) => label);

export function filterPlaces(data: Place[], query: string, activity: string): Place[] {
  const term = query.trim().toLocaleLowerCase();
  return data.filter((place) =>
    (!activity || place.activities.includes(activity)) &&
    `${place.name} ${place.description} ${place.activities.join(" ")}`.toLocaleLowerCase().includes(term),
  );
}

export function estimateMinutes(analysis: Analysis, paceKmh: number): number {
  if (!Number.isFinite(paceKmh) || paceKmh <= 0) throw new Error("Walking pace must be positive.");
  const climb = analysis.elevationPairs === analysis.totalPairs ? analysis.ascentM / 600 : 0;
  return Math.round((analysis.distanceM / 1000 / paceKmh + climb) * 60);
}

export const formatDistance = (meters: number): string => `${(meters / 1000).toFixed(2)} km`;
export const formatDuration = (minutes: number): string =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
