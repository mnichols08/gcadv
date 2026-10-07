import assert from "node:assert/strict";
import test from "node:test";
import type { Map } from "mapbox-gl";
import { applyTerrainView, applyCameraPitch, setTerrainElevation, terrainMinZoom, TERRAIN_SOURCE, TERRAIN_PITCH } from "../src/terrain";
import { regionMinZoom } from "../src/region";

test("3D loads one DEM source, enables terrain and tilt; 2D resets both", () => {
  let source: unknown;
  let additions = 0;
  let terrain: unknown;
  let camera: { pitch: number; bearing: number; duration: number } | undefined;
  let zoom = 0;
  let minPitch = 0;
  const mock = {
    getSource: () => source,
    addSource: (id: string, value: unknown) => { assert.equal(id, TERRAIN_SOURCE); source = value; additions++; },
    setTerrain: (value: unknown) => { terrain = value; },
    getContainer: () => ({ clientWidth: 900, clientHeight: 800 }),
    getPitch: () => camera?.pitch ?? 0,
    getBearing: () => 0,
    setMinPitch: (value: number) => { minPitch = value; },
    stop: () => {},
    jumpTo: (value: { pitch: number }) => { camera = { ...value, bearing: 0, duration: 0 }; },
    setMinZoom: (value: number) => { zoom = value; },
    easeTo: (value: typeof camera) => { camera = value; },
  };
  applyTerrainView(mock as Map, true, false);
  assert.deepEqual(terrain, { source: TERRAIN_SOURCE, exaggeration: 5 });
  assert.equal(camera?.pitch, TERRAIN_PITCH);
  assert.equal(minPitch, 50);
  assert.equal(camera?.duration, 800);
  assert.ok(zoom > 10);
  applyTerrainView(mock as Map, true, true);
  assert.equal(additions, 1);
  assert.equal(camera?.duration, 0);
  applyTerrainView(mock as Map, true, true, 5, 10);
  assert.equal(camera?.pitch, 50, "3D cannot start below its enforced minimum");
  applyTerrainView(mock as Map, true, true, 5, 80);
  assert.equal(camera?.pitch, 80, "higher user pitch is preserved");
  applyTerrainView(mock as Map, false, true);
  assert.equal(minPitch, 0);
  assert.equal(terrain, null);
  assert.equal(camera?.pitch, 0);
  assert.equal(camera?.bearing, 0);
  assert.equal(zoom, regionMinZoom(900, 800));
  applyCameraPitch(mock as Map, 85);
  assert.equal(camera?.pitch, 85);
  setTerrainElevation(mock as Map, true, 10);
  assert.deepEqual(terrain, { source: TERRAIN_SOURCE, exaggeration: 10 });
  assert.equal(camera?.pitch, 85, "changing steepness preserves camera pitch");
  assert.equal(additions, 1);
  applyCameraPitch(mock as Map, 0);
  assert.equal(camera?.pitch, 0);
  assert.equal(zoom, regionMinZoom(900, 800));
  assert.throws(() => applyCameraPitch(mock as Map, 86), RangeError);
  assert.throws(() => setTerrainElevation(mock as Map, true, 11), RangeError);
});

test("flat zoom floor remains unchanged and tilted view tightens it", () => {
  assert.equal(terrainMinZoom(900, 800, 0), regionMinZoom(900, 800));
  assert.ok(terrainMinZoom(400, 900, TERRAIN_PITCH) > terrainMinZoom(400, 900, 0));
});
