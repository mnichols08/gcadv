import assert from "node:assert/strict";
import test from "node:test";
import { parseDiscovery, parseSnapshot, mergeDiscovery, hikeGpx, makeGpx, discoverHikes, HIKE_QUERY } from "../src/hikes";
import { REGION_BOUNDS, REGION_BBOX, clipSegments, inRegion, regionMinZoom } from "../src/region";
import snapshot from "../src/model/hikes.json";

const geometry = [{ lon: -79.4, lat: 39.5 }, { lon: -79.41, lat: 39.51 }];
const response = {
  elements: [
    { type: "relation", id: 1, tags: { type: "route", route: "hiking", name: "A & <trail>", access: "private" }, members: [
      { type: "way", ref: 2, geometry }, { type: "way", ref: 2, geometry },
      { type: "way", ref: 3, geometry: [{ lon: -79.2, lat: 39.6 }, { lon: -79.21, lat: 39.61 }] },
    ] },
    { type: "way", id: 2, tags: { name: "Named path", highway: "path" }, geometry },
    { type: "node", id: 3 },
    { type: "relation", id: 4, tags: { type: "route", route: "hiking" }, members: [] },
  ],
};

test("classifies routes and paths, preserves separate ways, source and unknown elevations", () => {
  const result = parseDiscovery(response, "2026-10-06T00:00:00.000Z");
  assert.equal(result.hikes.length, 2);
  assert.equal(result.skipped, 2);
  const route = result.hikes.find((hike) => hike.source.kind === "Hiking route")!;
  assert.equal(route.segments.length, 2);
  assert.equal(route.source.tags.access, "private");
  assert.equal(route.source.url, "https://www.openstreetmap.org/relation/1");
  const xml = hikeGpx(route);
  assert.ok(xml.includes("A &amp; &lt;trail&gt;"));
  assert.equal((xml.match(/<trkseg>/g) || []).length, 2);
  assert.ok(!xml.includes("<ele>"));
  assert.ok(xml.includes("OpenStreetMap contributors (ODbL)"));
});

test("invalid coordinates split geometry rather than bridging gaps", () => {
  const result = parseDiscovery({ elements: [{ type: "way", id: 7, tags: { highway: "footway", name: "Gaps" },
    geometry: [...geometry, null, { lon: 500, lat: 0 }, ...geometry],
  }] });
  assert.equal(result.hikes[0].segments.length, 2);
});

test("rejects partial service responses and excessive points", () => {
  assert.throws(() => parseDiscovery({ elements: [], remark: "runtime timeout" }), /complete/);
  assert.throws(() => parseDiscovery({}), /invalid/);
  assert.throws(() => parseDiscovery({ elements: [{ type: "way", id: 1, tags: { highway: "path" },
    geometry: Array.from({ length: 100001 }, () => geometry[0]),
  }] }), /supported size/);
});

test("GPX export preserves known elevations, removes invalid XML controls, and does not join segments", () => {
  const xml = makeGpx("bad\u0000name", [
    [{ longitude: 1, latitude: 2, elevation: 0 }, { longitude: 2, latitude: 3, elevation: null }],
    [{ longitude: 10, latitude: 20 }, { longitude: 11, latitude: 21 }],
  ]);
  assert.ok(xml.includes("<name>badname</name>"));
  assert.ok(xml.includes("<ele>0</ele>"));
  assert.equal((xml.match(/<trkseg>/g) || []).length, 2);
});

test("discovery explicitly submits a fixed regional query and surfaces HTTP errors", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(String(url)).searchParams.get("data"), HIKE_QUERY);
      assert.ok(options?.signal);
      return new Response("limited", { status: 429 });
    };
    await assert.rejects(discoverHikes(new AbortController().signal), /rate limit/);
    globalThis.fetch = async () => new Response(JSON.stringify(response));
    assert.equal((await discoverHikes(new AbortController().signal)).hikes.length, 2);
    globalThis.fetch = async () => new Response("not json");
    await assert.rejects(discoverHikes(new AbortController().signal), /invalid JSON/);
  } finally { globalThis.fetch = original; }
});

test("uses the original regional bounds for API discovery and clips crossing edges", () => {
  assert.deepEqual(REGION_BOUNDS, [
    [-79.48696767001076, 39.202068911240104],
    [-79.08637004392415, 39.722221540464716],
  ]);
  assert.ok(HIKE_QUERY.includes(`[bbox:${REGION_BBOX}]`));
  const segments = clipSegments([[[-80, 39.5], [-78, 39.5]]]);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0], [[REGION_BOUNDS[0][0], 39.5], [REGION_BOUNDS[1][0], 39.5]]);
  assert.deepEqual(clipSegments([[[-80, 38], [-78, 38]]]), []);
});

test("excursions outside the region do not connect distant inside portions", () => {
  const segments = clipSegments([[[-79.4, 39.5], [-80, 39.5], [-80, 39.6], [-79.4, 39.6]]]);
  assert.equal(segments.length, 2);
  assert.ok(segments.flat().every(inRegion));
  assert.equal(segments[0][0][1], 39.5);
  assert.equal(segments[1][0][1], 39.6);
});

test("minimum zoom keeps large and small viewports inside the regional rectangle", () => {
  for (const [width, height] of [[390, 220], [870, 818], [2000, 1000]]) {
    const zoom = regionMinZoom(width, height);
    const longitudeSpan = width / (512 * 2 ** zoom) * 360;
    assert.ok(longitudeSpan <= REGION_BOUNDS[1][0] - REGION_BOUNDS[0][0] + 1e-10);
    assert.ok(Number.isFinite(zoom));
  }
  assert.ok(regionMinZoom(2000, 1000) > regionMinZoom(390, 220));
});
test("actual bundled dataset is nonempty, attributed and wholly regional", () => {
  const bundled = parseSnapshot(snapshot);
  assert.equal(bundled.hikes.length, 243);
  assert.equal(bundled.hikes.filter((hike) => hike.source.kind === "Hiking route").length, 62);
  assert.equal(bundled.hikes.filter((hike) => hike.source.kind === "Mapped path").length, 181);
  for (const hike of bundled.hikes) {
    assert.ok(hike.segments.length);
    assert.ok(hike.segments.flat().every(inRegion), hike.name);
    assert.ok(hike.source.attribution.includes("ODbL"));
    assert.ok(hike.source.regionalOnly);
  }
  assert.throws(() => parseSnapshot({}), /Invalid/);
});

test("refresh or cache cannot remove bundled trails and older records cannot replace newer data", () => {
  const bundled = parseDiscovery(response, "2026-10-06T00:00:00.000Z");
  assert.equal(mergeDiscovery(bundled, { hikes: [], retrievedAt: "2026-10-07T00:00:00.000Z", skipped: 0 }).hikes.length, 2);
  const old = parseDiscovery(response, "2026-10-05T00:00:00.000Z");
  old.hikes[0].name = "Old name";
  assert.notEqual(mergeDiscovery(bundled, old).hikes[0].name, "Old name");
  const updated = parseDiscovery(response, "2026-10-07T00:00:00.000Z");
  updated.hikes[0].name = "Updated name";
  assert.ok(mergeDiscovery(bundled, updated).hikes.some((hike) => hike.name === "Updated name"));
});
