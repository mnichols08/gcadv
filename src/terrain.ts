import type { Map } from "mapbox-gl";
import { regionMinZoom } from "./region";

export const TERRAIN_SOURCE = "adventure-terrain";
export const TERRAIN_PITCH = 45;
export const MAX_PITCH = 85;
export const TERRAIN_EXAGGERATION = 1.8;

export function setTerrainElevation(map: Map, enabled: boolean, exaggeration = TERRAIN_EXAGGERATION): void {
  if (!Number.isFinite(exaggeration) || exaggeration < 1 || exaggeration > 10) {
    throw new RangeError("Terrain steepness must be between 1 and 10.");
  }
  if (enabled && !map.getSource(TERRAIN_SOURCE)) {
    map.addSource(TERRAIN_SOURCE, {
      type: "raster-dem",
      url: "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: 512,
      maxzoom: 14,
    });
  }
  map.setTerrain(enabled ? { source: TERRAIN_SOURCE, exaggeration } : null);
}

export function terrainMinZoom(width: number, height: number, pitch: number): number {
  return regionMinZoom(width, height / Math.cos(pitch * Math.PI / 180));
}

export function applyCameraPitch(map: Map, pitch: number): void {
  if (!Number.isFinite(pitch) || pitch < 0 || pitch > MAX_PITCH) {
    throw new RangeError(`Camera pitch must be between 0 and ${MAX_PITCH} degrees.`);
  }
  const container = map.getContainer();
  map.stop();
  map.setMinZoom(terrainMinZoom(container.clientWidth, container.clientHeight, pitch));
  map.jumpTo({ pitch });
}

export function applyTerrainView(map: Map, enabled: boolean, reducedMotion: boolean,
  exaggeration = TERRAIN_EXAGGERATION, pitch = TERRAIN_PITCH): void {
  if (!Number.isFinite(pitch) || pitch < 0 || pitch > MAX_PITCH) {
    throw new RangeError(`Camera pitch must be between 0 and ${MAX_PITCH} degrees.`);
  }
  setTerrainElevation(map, enabled, exaggeration);
  map.setMinPitch(enabled ? TERRAIN_PITCH : 0);
  const targetPitch = enabled ? Math.max(TERRAIN_PITCH, pitch) : 0;
  const container = map.getContainer();
  // A tilted viewport sees farther toward the horizon; retain a tighter regional zoom floor.
  map.setMinZoom(terrainMinZoom(container.clientWidth, container.clientHeight,
    Math.max(map.getPitch(), targetPitch)));
  map.easeTo({ pitch: targetPitch, bearing: enabled ? map.getBearing() : 0, duration: reducedMotion ? 0 : 800 });
  if (!enabled && reducedMotion) {
    map.setMinZoom(terrainMinZoom(container.clientWidth, container.clientHeight, 0));
  }
}
