import type mapboxgl from "mapbox-gl";
import { loadMapboxToken } from "./map-config";
import type { FeatureCollection } from "geojson";
import {
  places, activityOptions, filterPlaces, estimateMinutes, formatDistance, formatDuration,
  type Place, type Analysis, type SavedOuting, type TrailPoint,
} from "./domain";
import { readOutings, writeOuting, removeOuting, readDiscovery, writeDiscovery } from "./storage";
import { discoverHikes, hikeGpx, makeGpx, mergeDiscovery, parseSnapshot, OVERPASS_SERVERS, type Hike, type HikeDiscovery, type HikeSource } from "./hikes";
import { REGION_BOUNDS, regionMinZoom } from "./region";
import { applyTerrainView, applyCameraPitch, setTerrainElevation, terrainMinZoom,
  TERRAIN_SOURCE, TERRAIN_PITCH, MAX_PITCH, TERRAIN_EXAGGERATION } from "./terrain";
import type { AnalysisResponse } from "./analysis.worker";
import "mapbox-gl/dist/mapbox-gl.css";
import "./app.css";

function get<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing interface element: ${id}`);
  return element;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K, text = "", className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

function button(text: string, action: () => void, className = "button"): HTMLButtonElement {
  const element = node("button", text, className);
  element.type = "button";
  element.onclick = action;
  return element;
}

get("app", HTMLElement).innerHTML = `
  <header class="topbar">
    <a class="brand" href="./">
      <span>Garrett County Adventures<span class="brand-subtitle">MARYLAND’S HIDDEN GEM</span></span>
    </a>
    <span class="header-caption">Less scrolling. More exploring.</span>
    <a class="header-link" href="./#trip-guides">Trip guides</a>
    <span id="connection" class="connection"></span>
  </header>
  <div class="workspace" id="adventure-map" tabindex="-1">
    <section class="map-region" aria-label="Adventure map">
      <div id="map" aria-busy="true"></div>
      <div class="map-loading" role="status" aria-live="polite">
        <span class="map-loading-spinner" aria-hidden="true"></span>
        <span>Loading map…</span>
      </div>
      <div class="map-caption"><strong>Your next adventure starts here.</strong><span id="map-summary">Garrett County and its immediate surroundings.</span></div>
      <button id="reset-map" type="button" class="map-reset">Show all places</button>
      <button id="terrain-toggle" type="button" class="terrain-toggle" aria-pressed="true" disabled>Return to 2D</button>
      <p id="map-notice" class="map-notice" hidden></p>
    </section>
    <aside class="sidebar" aria-label="Adventure explorer">
      <nav class="tabs" aria-label="Explorer views">
        <button type="button" data-tab="explore" aria-pressed="true">Discover</button>
        <button type="button" data-tab="hikes" aria-pressed="false">Hikes</button>
        <button type="button" data-tab="analyze" aria-pressed="false">Trail lab</button>
        <button type="button" data-tab="saved" aria-pressed="false">Saved <span id="saved-count">0</span></button>
      </nav>
      <div class="panel-scroll">
        <details class="map-settings">
          <summary>Map view settings</summary>
          <label for="map-pitch">Camera pitch <output id="pitch-reading" for="map-pitch">0 degrees</output></label>
          <input id="map-pitch" type="range" min="0" max="${MAX_PITCH}" step="1" value="0" disabled>
          <label for="terrain-steepness">Terrain steepness <output id="steepness-reading" for="terrain-steepness">${TERRAIN_EXAGGERATION}x</output></label>
          <input id="terrain-steepness" type="range" min="1" max="10" step="0.5" value="${TERRAIN_EXAGGERATION}" disabled>
          <p>Steepness applies in 3D terrain mode only. Heights are visually exaggerated, not measured slopes.</p>
        </details>
        <section id="explore-panel">
          <p class="eyebrow">THE GREAT OUTDOORS, CLOSE TO HOME</p>
          <h2>Find your kind<br>of adventure.</h2>
          <p class="intro">Waterfalls, quiet lakes, and mountain views. Pick a place and make a day of it.</p>
          <label class="field-label" for="search">Search places and activities</label>
          <input id="search" type="search" placeholder="Try waterfalls or camping" autocomplete="off">
          <label class="field-label" for="activity">What do you feel like doing?</label>
          <select id="activity"><option value="">All activities</option></select>
          <div class="results-heading"><p id="result-count" role="status"></p><button id="clear-filters" class="text-button" type="button">Reset filters</button></div>
          <section id="place-details" aria-label="Selected place" hidden></section>
          <ul id="place-list" class="place-list"></ul>
          <p id="empty-results" class="empty" hidden>No places match. Try a different activity or clear your search.</p>
          <p class="data-note">Curated project data, not live conditions. Verify access, opening hours, and trail suitability before heading out. Accessibility has not been verified.</p>
        </section>
        <section id="hikes-panel" hidden>
          <p class="eyebrow">OPENSTREETMAP / GARRETT COUNTY REGION</p>
          <h1>Find a trail.</h1>
          <p class="intro">Local hiking routes and named paths are included with the app. Browse them immediately, or check for updated mapping. Community data, not verified hiking recommendations.</p>
          <label for="hike-server" class="field-label">Public trail service</label>
          <select id="hike-server"></select>
          <div class="card-actions">
            <button id="find-hikes" type="button" class="button primary" disabled>Refresh regional hikes</button>
            <button id="cancel-hikes" type="button" class="text-button" hidden>Cancel search</button>
          </div>
          <p id="hikes-state" role="status">Search when you are ready. No location permission or API key needed.</p>
          <label for="hike-search" class="field-label">Filter downloaded hikes</label>
          <input id="hike-search" type="search" placeholder="Search trail names" autocomplete="off">
          <label for="hike-kind" class="field-label">Map feature type</label>
          <select id="hike-kind"><option value="">Routes and paths</option><option>Hiking route</option><option>Mapped path</option></select>
          <p id="hike-count" role="status" class="data-note"></p>
          <ul id="hike-list" class="place-list"></ul>
          <p class="data-note">Relations may contain branches, gaps, and alternate sections. Each mapped way is kept as its own GPX segment; analysis sums those segments, not a verified end-to-end hike. No elevation is supplied. Check permissions and current conditions before walking.</p>
          <p class="data-note">Geometry is clipped to the regional map boundary. Longer trails may be partial; distances and exports cover only the included portion.</p>
          <p class="data-note">Data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>, ODbL. Regional searches use the public Overpass service; cached results may be outdated.</p>
        </section>
        <section id="analyze-panel" hidden>
          <p class="eyebrow">POWERED BY RUST + WEBASSEMBLY</p>
          <h1>Know your trail.</h1>
          <p class="intro">Bring a GPX track. See the distance, climbs, and elevation profile before you go. Your file stays on this device.</p>
          <label class="upload" for="gpx-file"><strong>Import a GPX file</strong><span>Tracks or routes / up to 8 MiB and 100,000 points</span></label>
          <input id="gpx-file" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml">
          <div class="analysis-controls"><p id="analysis-state" role="status">Ready when you are.</p><button id="cancel-analysis" class="text-button" type="button" hidden>Cancel</button></div>
          <div id="trail-results" hidden>
            <h2 id="trail-name"></h2>
            <div id="trail-source" class="data-note" hidden></div>
            <div id="trail-stats" class="stats"></div>
            <p id="elevation-note" class="data-note"></p>
            <div id="profile-container">
              <h3>Elevation profile</h3>
              <svg id="profile" viewBox="0 0 600 180" role="img" aria-label="Elevation in meters over route distance"></svg>
              <label class="field-label" for="profile-position">Explore a point on the trail</label>
              <input id="profile-position" type="range" min="0" max="1" value="0">
              <p id="profile-reading" class="profile-reading"></p>
            </div>
            <label class="field-label" for="pace">Walking pace on flat ground</label>
            <select id="pace"><option value="3">Relaxed / 3 km/h</option><option value="4" selected>Steady / 4 km/h</option><option value="5">Brisk / 5 km/h</option></select>
            <p id="duration" class="duration"></p>
            <p class="data-note">Planning estimate, not navigation or a safety assessment. Excludes breaks, driving, surface conditions, and weather. Climb uses raw GPX elevations; GPS noise can inflate totals. Segment gaps are never connected.</p>
            <button id="save-trail" type="button" class="button primary">Save trail offline</button>
            <button id="export-trail" type="button" class="button">Export GPX</button>
            <p id="engine-timing" class="engine-timing"></p>
          </div>
        </section>
        <section id="saved-panel" hidden>
          <p class="eyebrow">YOUR NEXT DAYS OUT</p>
          <h1>Ready for<br>the road.</h1>
          <p class="intro">Place details and analyzed trails are saved on this device. No account needed.</p>
          <ul id="saved-list" class="place-list"></ul>
          <p id="saved-empty" class="empty">No saved outings yet. Save a place or import a trail to get started.</p>
          <p class="data-note">Offline includes saved details and trail analysis, not the Mapbox basemap. Downloads finish after the first successful app load. Browser data clearing removes saved outings.</p>
          <p id="offline-readiness" class="data-note" role="status">Checking offline app availability...</p>
        </section>
      </div>
      <footer class="panel-footer">Built for the mountains. Computed on your device.</footer>
    </aside>
  </div>
  <div id="notification" class="notification" role="status" hidden></div>
`;

const search = get("search", HTMLInputElement);
const activity = get("activity", HTMLSelectElement);
const fileInput = get("gpx-file", HTMLInputElement);
const pace = get("pace", HTMLSelectElement);
const position = get("profile-position", HTMLInputElement);
let selectedPlace: Place | undefined;
let filtered = places;
let saved: SavedOuting[] = [];
let analysis: Analysis | undefined;
let analysisSource: HikeSource | undefined;
let bundledDiscovery: HikeDiscovery | undefined;
let cachedDiscovery: HikeDiscovery | undefined;
let discovery: HikeDiscovery = { hikes: [], retrievedAt: "", skipped: 0 };
let discoveryReady = false;
let discoveryRequest: AbortController | undefined;
let hikesRendered = false;
let previewHike: Hike | undefined;
let trailPoints: TrailPoint[] = [];
let savedTrailId: string | undefined;
let map: mapboxgl.Map | undefined;
let mapboxglRuntime: typeof import("mapbox-gl").default | undefined;
let mapReady = false;
let terrainEnabled = true;
let popup: mapboxgl.Popup | undefined;
let pointMarker: mapboxgl.Marker | undefined;
let worker: Worker | undefined;
let requestId = 0;
let importing = false;
let savingTrail = false;
let activeTab = "explore";
let notificationTimer: ReturnType<typeof setTimeout> | undefined;

function notify(message: string, error = false): void {
  const element = get("notification", HTMLDivElement);
  clearTimeout(notificationTimer);
  element.textContent = message;
  element.classList.toggle("error", error);
  element.setAttribute("role", error ? "alert" : "status");
  element.hidden = false;
  if (!error) notificationTimer = setTimeout(() => { element.hidden = true; }, 6000);
}

function report(error: unknown): void {
  console.error(error);
  notify(error instanceof Error ? error.message : String(error), true);
}

function perform(action: () => Promise<void>): void {
  void action().catch(report);
}

function switchTab(tab: string): void {
  activeTab = tab;
  if (tab === "hikes" && !hikesRendered) renderHikes();
  for (const name of ["explore", "hikes", "analyze", "saved"]) {
    get(`${name}-panel`, HTMLElement).hidden = name !== tab;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((element) => {
    element.setAttribute("aria-pressed", String(element.dataset.tab === tab));
  });
  if (tab !== "analyze") pointMarker?.remove();
  else if (analysis) updateProfilePoint();
  updateMap();
}

document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((element) => {
  element.onclick = () => switchTab(element.dataset.tab || "explore");
});

activityOptions.forEach((label) => activity.append(new Option(label, label)));

function placeData(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: filtered.map((place) => ({
      type: "Feature", id: place.id, properties: { placeId: place.id, selected: selectedPlace?.id === place.id },
      geometry: { type: "Point", coordinates: place.coordinates },
    })),
  };
}

function routeData(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (activeTab === "hikes" && previewHike
      ? previewHike.segments.map((segment) => segment.map(([longitude, latitude]) => ({ longitude, latitude })))
      : analysis?.segments || []).filter((segment) => segment.length > 1).map((segment) => ({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: segment.map((p) => [p.longitude, p.latitude]) },
    })),
  };
}

function updateMap(): void {
  if (!mapReady || !map) return;
  const parks = map.getSource("parks");
  const trail = map.getSource("trail");
  if (parks?.type === "geojson") parks.setData(placeData());
  if (trail?.type === "geojson") trail.setData(routeData());
  const hikes = map.getSource("regional-hikes");
  if (hikes?.type === "geojson") hikes.setData(regionalHikeData());
}

function regionalHikeData(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: discovery.hikes.flatMap((hike) => hike.segments.map((segment) => ({
      type: "Feature" as const,
      properties: { hikeId: hike.source.id, name: hike.name },
      geometry: { type: "LineString" as const, coordinates: segment },
    }))),
  };
}
function focusTrail(): void {
  if (!mapReady || !map || !analysis) return;
  const bounds = new mapboxglRuntime!.LngLatBounds();
  for (const segment of analysis.segments) {
    for (const point of segment) bounds.extend([point.longitude, point.latitude]);
  }
  map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: reducedMotion() ? 0 : 900 });
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function selectPlace(place: Place, move = true): void {
  selectedPlace = place;
  switchTab("explore");
  renderPlaces();
  renderDetails();
  const heading = get("place-details", HTMLElement).querySelector("h2");
  if (move && heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
  updateMap();
  const url = new URL(location.href);
  url.searchParams.set("place", place.id);
  history.replaceState(null, "", url);
  if (mapReady && map) {
    popup?.remove();
    popup = new mapboxglRuntime!.Popup({ offset: 14 })
      .setLngLat(place.coordinates)
      .setDOMContent(node("strong", place.name))
      .addTo(map);
    if (move) map.flyTo({ center: place.coordinates, zoom: 13, duration: reducedMotion() ? 0 : 800 });
  }
}

function renderDetails(): void {
  const detail = get("place-details", HTMLElement);
  detail.replaceChildren();
  detail.hidden = !selectedPlace;
  if (!selectedPlace) return;
  const place = selectedPlace;
  detail.className = "selected-detail";
  detail.append(node("p", "YOUR SELECTED PLACE", "eyebrow"), node("h2", place.name), node("p", place.description));
  detail.append(node("p", place.activities.join(" / ") || "Activities not documented", "activity-text"));
  const controls = node("div", "", "card-actions");
  const isSaved = saved.some((outing) => outing.id === `place:${place.id}`);
  controls.append(button(isSaved ? "Saved on this device" : "Save outing offline", () => {
    perform(async () => {
      await writeOuting({
        id: `place:${place.id}`, kind: "place", name: place.name,
        savedAt: new Date().toISOString(), place,
      });
      await refreshSaved();
      notify("Place details saved on this device. The basemap still needs a connection.");
    });
  }, "button primary"));
  controls.append(button("Close", () => {
    selectedPlace = undefined;
    popup?.remove();
    const url = new URL(location.href);
    url.searchParams.delete("place");
    history.replaceState(null, "", url);
    renderDetails(); renderPlaces(); updateMap();
  }, "text-button"));
  detail.append(controls);
}

function renderPlaces(): void {
  const list = get("place-list", HTMLUListElement);
  list.replaceChildren();
  get("result-count", HTMLParagraphElement).textContent = `${filtered.length} ${filtered.length === 1 ? "place" : "places"} to explore`;
  get("empty-results", HTMLParagraphElement).hidden = filtered.length !== 0;
  filtered.forEach((place) => {
    const item = node("li", "", "place-card");
    const select = button("", () => selectPlace(place), "place-select");
    select.setAttribute("aria-pressed", String(selectedPlace?.id === place.id));
    select.append(node("span", place.name, "place-name"));
    select.append(node("span", place.description, "place-description"));
    select.append(node("span", place.activities.slice(0, 3).join(" / ") || "Discover this place", "activity-text"));
    item.append(select);
    list.append(item);
  });
}

function applyFilters(): void {
  filtered = filterPlaces(places, search.value, activity.value);
  if (selectedPlace && !filtered.some((place) => place.id === selectedPlace?.id)) {
    selectedPlace = undefined;
    popup?.remove();
    renderDetails();
  }
  const url = new URL(location.href);
  for (const [key, value] of [["q", search.value], ["activity", activity.value], ["place", selectedPlace?.id || ""]]) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
  renderPlaces();
  updateMap();
}

search.oninput = applyFilters;
activity.onchange = applyFilters;
get("clear-filters", HTMLButtonElement).onclick = () => {
  search.value = ""; activity.value = ""; applyFilters();
};

async function refreshSaved(): Promise<void> {
  saved = (await readOutings()).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  get("saved-count", HTMLSpanElement).textContent = String(saved.length);
  const list = get("saved-list", HTMLUListElement);
  list.replaceChildren();
  get("saved-empty", HTMLParagraphElement).hidden = saved.length > 0;
  saved.forEach((outing) => {
    const card = node("li", "", "saved-card");
    card.append(node("p", outing.kind === "place" ? "SAVED PLACE" : "SAVED TRAIL", "eyebrow"), node("h2", outing.name));
    card.append(node("p", outing.kind === "place" ? outing.place.description : `${formatDistance(outing.analysis.distanceM)} / ${outing.analysis.pointCount.toLocaleString()} points`));
    card.append(node("p", `Saved ${new Date(outing.savedAt).toLocaleDateString()}`, "data-note"));
    const actions = node("div", "", "card-actions");
    actions.append(button("Open outing", () => {
      if (outing.kind === "place") {
        search.value = ""; activity.value = ""; applyFilters();
        selectPlace(outing.place);
      } else {
        cancelAnalysis();
        savedTrailId = outing.id;
        showAnalysis(outing.analysis, outing.source);
        switchTab("analyze");
        get("analysis-state", HTMLParagraphElement).textContent = "Loaded from this device. No network needed.";
        get("engine-timing", HTMLParagraphElement).textContent = "Saved Rust analysis";
      }
    }));
    actions.append(button("Remove", () => {
      perform(async () => {
        await removeOuting(outing.id);
        if (savedTrailId === outing.id) savedTrailId = undefined;
        await refreshSaved();
        notify("Saved outing removed.");
      });
    }, "text-button"));
    card.append(actions);
    if (outing.kind === "trail" && outing.source) card.append(sourceDetails(outing.source));
    list.append(card);
  });
  renderDetails();
  updateSaveTrailButton();
}

function setBusy(busy: boolean): void {
  importing = busy;
  get("cancel-analysis", HTMLButtonElement).hidden = !busy;
  get("save-trail", HTMLButtonElement).disabled = busy || savingTrail;
}

function cancelAnalysis(): void {
  requestId++;
  worker?.terminate();
  worker = undefined;
  setBusy(false);
}

get("cancel-analysis", HTMLButtonElement).onclick = () => {
  cancelAnalysis();
  get("analysis-state", HTMLParagraphElement).textContent = "Import cancelled. Your previous trail is unchanged.";
};

function analyzeInput(read: () => Promise<string>, source?: HikeSource): void {
  cancelAnalysis();
  switchTab("analyze");
  const id = requestId;
  void (async () => {
    setBusy(true);
    get("analysis-state", HTMLParagraphElement).textContent = "Loading local Rust engine and analyzing...";
    const xml = await read();
    if (id !== requestId) return;
    worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<AnalysisResponse>) => {
      if (data.id !== requestId) return;
      worker?.terminate();
      worker = undefined;
      setBusy(false);
      if ("error" in data) {
        get("analysis-state", HTMLParagraphElement).textContent = "Import failed. Your previous trail is unchanged.";
        report(new Error(data.error));
        return;
      }
      savedTrailId = undefined;
      showAnalysis(data.analysis, source);
      get("analysis-state", HTMLParagraphElement).textContent = source ? "OSM geometry analyzed locally. No elevations were inferred." : "Analyzed locally. Nothing was uploaded.";
      get("engine-timing", HTMLParagraphElement).textContent =
        `Rust/WASM analysis: ${data.elapsedMs.toFixed(1)} ms (excludes engine loading and transfer)`;
      notify("Trail imported and analyzed.");
    };
    worker.onerror = () => {
      if (id !== requestId) return;
      cancelAnalysis();
      get("analysis-state", HTMLParagraphElement).textContent = "Engine failed to load or run.";
      report(new Error("The local analysis engine failed. Reload the app while online and retry."));
    };
    worker.postMessage({ id, xml });
  })().catch((error: unknown) => {
    if (id !== requestId) return;
    cancelAnalysis();
    get("analysis-state", HTMLParagraphElement).textContent = "Import failed. Your previous trail is unchanged.";
    report(error);
  });
}

fileInput.onchange = () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  analyzeInput(async () => {
    if (file.size > 8 * 1024 * 1024) throw new Error("Choose a GPX file no larger than 8 MiB.");
    return file.text();
  });
};

function showAnalysis(result: Analysis, source?: HikeSource): void {
  analysis = result;
  analysisSource = source;
  const sourcePanel = get("trail-source", HTMLDivElement);
  sourcePanel.replaceChildren();
  sourcePanel.hidden = !source;
  if (source) sourcePanel.append(sourceDetails(source));
  trailPoints = result.segments.flat();
  get("trail-results", HTMLDivElement).hidden = false;
  get("trail-name", HTMLHeadingElement).textContent = result.name;
  const stats = get("trail-stats", HTMLDivElement);
  stats.replaceChildren();
  const complete = result.elevationPairs === result.totalPairs;
  for (const [label, value] of [
    ["DISTANCE", formatDistance(result.distanceM)],
    [complete ? "ASCENT" : "KNOWN ASCENT", result.elevationPairs ? `${Math.round(result.ascentM)} m` : "Unknown"],
    [complete ? "DESCENT" : "KNOWN DESCENT", result.elevationPairs ? `${Math.round(result.descentM)} m` : "Unknown"],
    ["SEGMENTS", String(result.segments.length)],
  ]) {
    const stat = node("div", "", "stat");
    stat.append(node("span", label), node("strong", value));
    stats.append(stat);
  }
  get("elevation-note", HTMLParagraphElement).textContent = complete
    ? "Elevation is present for every point. Gain and loss are raw GPX sums, not smoothed terrain measurements."
    : `Incomplete elevation: ${result.elevationPoints} of ${result.pointCount} points have heights. Climb totals cover only ${result.elevationPairs} of ${result.totalPairs} connected point pairs; no heights are inferred.`;
  get("profile-container", HTMLDivElement).hidden = result.elevationPoints === 0;
  position.max = String(trailPoints.length - 1);
  position.value = "0";
  renderProfile();
  updateDuration();
  updateSaveTrailButton();
  updateMap();
  focusTrail();
  updateProfilePoint();
}

function updateSaveTrailButton(): void {
  get("save-trail", HTMLButtonElement).textContent =
    savedTrailId && saved.some((item) => item.id === savedTrailId) ? "Trail saved on this device" : "Save trail offline";
}

get("save-trail", HTMLButtonElement).onclick = () => {
  if (!analysis || savingTrail) return;
  const snapshot = analysis;
  const source = analysisSource;
  const id = savedTrailId || (source ? `osm:${source.id}` : `trail:${crypto.randomUUID()}`);
  savingTrail = true;
  get("save-trail", HTMLButtonElement).disabled = true;
  perform(async () => {
    try {
      await writeOuting({ id, kind: "trail", name: snapshot.name, savedAt: new Date().toISOString(), analysis: snapshot, source });
      if (analysis === snapshot) savedTrailId = id;
      await refreshSaved();
      notify("Trail geometry and analysis saved for offline use.");
    } finally {
      savingTrail = false;
      get("save-trail", HTMLButtonElement).disabled = importing;
    }
  });
};

function sourceDetails(source: HikeSource): HTMLElement {
  const details = node("div", "", "source-details");
  details.append(node("p", `${source.kind} / ${source.attribution}. Retrieved ${new Date(source.retrievedAt).toLocaleString()}.`));
  details.append(node("p", `Access: ${source.tags.access || "unknown"} / Foot access: ${source.tags.foot || "unknown"} / Surface: ${source.tags.surface || "unknown"} / Difficulty tag: ${source.tags.sac_scale || "unknown"}. Tags are unverified, not current conditions.`));
  if (source.regionalOnly) details.append(node("p", "Geometry is limited to this region and may show only part of a longer route. Distance totals cover this regional portion."));
  const link = node("a", "View OpenStreetMap source");
  link.href = source.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  details.append(link);
  return details;
}

function downloadGpx(name: string, xml: string): void {
  const url = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml;charset=utf-8" }));
  const link = node("a");
  link.href = url;
  link.download = `${name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "trail"}.gpx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

get("export-trail", HTMLButtonElement).onclick = () => {
  if (analysis) downloadGpx(analysis.name, makeGpx(analysis.name, analysis.segments, analysisSource));
};

function updateMapSummary(): void {
  get("map-summary", HTMLSpanElement).textContent = discoveryReady
    ? `${places.length} local places / ${discovery.hikes.length} mapped regional routes and paths.`
    : `${places.length} local places / Loading regional routes and paths…`;
}

function renderHikes(): void {
  updateMapSummary();
  const list = get("hike-list", HTMLUListElement);
  list.replaceChildren();
  const term = get("hike-search", HTMLInputElement).value.trim().toLowerCase();
  const kind = get("hike-kind", HTMLSelectElement).value;
  if (!discoveryReady) {
    get("hike-count", HTMLParagraphElement).textContent = "Loading bundled trail data…";
    list.append(node("li", "Bundled trail data is loading. The trails will appear here shortly.", "empty"));
    return;
  }
  const matches = (discovery?.hikes || []).filter((hike) =>
    hike.name.toLowerCase().includes(term) && (!kind || hike.source.kind === kind),
  );
  get("hike-count", HTMLParagraphElement).textContent = discovery
    ? `${matches.length} of ${discovery.hikes.length} mapped features. ${discovery.skipped} unsupported or geometry-free records excluded.`
    : "No downloaded results yet.";
  for (const hike of matches) {
    const card = node("li", "", "saved-card");
    card.append(node("p", hike.source.kind.toUpperCase(), "eyebrow"), node("h2", hike.name));
    card.append(node("p", `${hike.segments.length} regional segments / ${hike.segments.reduce((sum, segment) => sum + segment.length, 0).toLocaleString()} points. Elevation unknown.`, "data-note"));
    if (["no", "private"].includes(hike.source.tags.access) || hike.source.tags.foot === "no") {
      card.append(node("p", "Restricted access is tagged. This is not a recommendation to enter.", "access-warning"));
    }
    card.append(sourceDetails(hike.source));
    const actions = node("div", "", "card-actions");
    actions.append(button("Preview on map", () => {
      previewHike = hike;
      updateMap();
      if (mapReady && map) {
        const bounds = new mapboxglRuntime!.LngLatBounds();
        hike.segments.forEach((segment) => segment.forEach((point) => bounds.extend(point)));
        map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: reducedMotion() ? 0 : 800 });
      } else notify("Map unavailable. You can still analyze or export this geometry.");
    }));
    actions.append(button("Analyze hike", () => analyzeInput(async () => hikeGpx(hike), hike.source), "button primary"));
    actions.append(button("Export GPX", () => downloadGpx(hike.name, hikeGpx(hike))));
    card.append(actions);
    list.append(card);
  }
  if (discovery && !matches.length) list.append(node("li", "No mapped hikes match. Clear filters or retry discovery later.", "empty"));
  hikesRendered = true;
}

get("hike-search", HTMLInputElement).oninput = renderHikes;
get("hike-kind", HTMLSelectElement).onchange = renderHikes;
OVERPASS_SERVERS.forEach((server) => get("hike-server", HTMLSelectElement).append(new Option(server.label, server.url)));

get("cancel-hikes", HTMLButtonElement).onclick = () => {
  discoveryRequest?.abort();
};

get("find-hikes", HTMLButtonElement).onclick = () => {
  if (discoveryRequest || !bundledDiscovery) return;
  const controller = new AbortController();
  const endpoint = get("hike-server", HTMLSelectElement).value;
  discoveryRequest = controller;
  get("find-hikes", HTMLButtonElement).disabled = true;
  get("hike-server", HTMLSelectElement).disabled = true;
  get("cancel-hikes", HTMLButtonElement).hidden = false;
  get("hikes-state", HTMLParagraphElement).textContent = "Searching the Garrett County region. This may take up to 35 seconds...";
  const timeout = setTimeout(() => controller.abort(new Error("Trail search timed out. Try again later.")), 35_000);
  void (async () => {
    try {
      const refreshed = await discoverHikes(controller.signal, endpoint);
      discovery = mergeDiscovery(bundledDiscovery, refreshed);
      renderHikes();
      updateMap();
      get("hikes-state", HTMLParagraphElement).textContent = `Fetched ${new Date(discovery.retrievedAt).toLocaleString()}. Saving a local copy...`;
      await writeDiscovery(refreshed);
      get("hikes-state", HTMLParagraphElement).textContent = `Cached on this device / retrieved ${new Date(discovery.retrievedAt).toLocaleString()}. Not live conditions.`;
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === "AbortError") {
        get("hikes-state", HTMLParagraphElement).textContent = "Search cancelled. Previous results are unchanged.";
      } else {
        get("hikes-state", HTMLParagraphElement).textContent = "Search or caching failed. Any previous results remain available.";
        report(controller.signal.aborted ? controller.signal.reason : error);
      }
    } finally {
      clearTimeout(timeout);
      discoveryRequest = undefined;
      get("find-hikes", HTMLButtonElement).disabled = false;
      get("hike-server", HTMLSelectElement).disabled = false;
      get("cancel-hikes", HTMLButtonElement).hidden = true;
    }
  })();
};

updateMapSummary();
get("hikes-state", HTMLParagraphElement).textContent = "Loading the bundled regional trail snapshot…";
void import("./model/hikes.json").then(({ default: snapshot }) => {
  bundledDiscovery = parseSnapshot(snapshot);
  discovery = mergeDiscovery(bundledDiscovery, cachedDiscovery);
  discoveryReady = true;
  updateMapSummary();
  get("find-hikes", HTMLButtonElement).disabled = false;
  if (hikesRendered) renderHikes();
  const cacheNote = cachedDiscovery ? ` / cached refresh ${new Date(cachedDiscovery.retrievedAt).toLocaleString()}` : "";
  get("hikes-state", HTMLParagraphElement).textContent = `${discovery.hikes.length} bundled mapped features / snapshot ${new Date(bundledDiscovery.retrievedAt).toLocaleString()}${cacheNote}. Available offline; not live conditions.`;
  updateMap();
}).catch(report);
perform(async () => {
  const cached = await readDiscovery();
  cachedDiscovery = cached;
  // An explicit search may finish before IndexedDB opens; do not overwrite fresh results.
  if (cached && bundledDiscovery && !discoveryRequest) {
    discovery = mergeDiscovery(bundledDiscovery, cached);
    updateMapSummary();
    if (hikesRendered) renderHikes();
    updateMap();
    get("hikes-state", HTMLParagraphElement).textContent = `Bundled regional hikes plus cached mapping / latest retrieval ${new Date(discovery.retrievedAt).toLocaleString()}. May be outdated; refresh to check for updates.`;
  }
});

function updateDuration(): void {
  if (!analysis) return;
  const complete = analysis.elevationPairs === analysis.totalPairs;
  get("duration", HTMLParagraphElement).textContent =
    `Estimated walking time: ${formatDuration(estimateMinutes(analysis, Number(pace.value)))}. ` +
    (complete ? "Flat-ground pace + 1 hour per 600 m of ascent." : "Distance-only estimate: missing elevations prevent a complete climbing estimate.");
}

pace.onchange = updateDuration;

function profileXY(point: TrailPoint): [number, number] {
  if (!analysis) return [0, 0];
  const min = analysis.minElevation ?? 0;
  const span = Math.max(1, (analysis.maxElevation ?? min) - min);
  return [20 + point.distanceM / Math.max(analysis.distanceM, 1) * 560, 150 - ((point.elevation ?? min) - min) / span * 125];
}

function svgNode(tag: string): SVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function renderProfile(): void {
  const svg = document.getElementById("profile");
  if (!(svg instanceof SVGSVGElement) || !analysis) return;
  svg.replaceChildren();
  const step = Math.max(1, Math.ceil(analysis.pointCount / 1000));
  for (const segment of analysis.segments) {
    let path = "";
    let connected = false;
    segment.forEach((point, i) => {
      if (point.elevation === null) { connected = false; return; }
      if (connected && i % step && i !== segment.length - 1) return;
      const [x, y] = profileXY(point);
      path += `${connected ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
      connected = true;
    });
    const line = svgNode("path");
    line.setAttribute("d", path);
    line.setAttribute("class", "profile-line");
    svg.append(line);
  }
  const label = svgNode("text");
  label.setAttribute("x", "20"); label.setAttribute("y", "175");
  label.textContent = `${Math.round(analysis.minElevation ?? 0)} - ${Math.round(analysis.maxElevation ?? 0)} m / ${formatDistance(analysis.distanceM)}`;
  svg.append(label);
  const dot = svgNode("circle");
  dot.id = "profile-dot";
  dot.setAttribute("r", "5");
  svg.append(dot);
}

function updateProfilePoint(): void {
  const point = trailPoints[Number(position.value)];
  if (!point) return;
  const description = `${formatDistance(point.distanceM)} along trail / ${point.elevation === null ? "elevation unknown" : `${Math.round(point.elevation)} m elevation`}`;
  get("profile-reading", HTMLParagraphElement).textContent = description;
  position.setAttribute("aria-valuetext", description);
  const dot = document.getElementById("profile-dot");
  if (dot) {
    dot.setAttribute("visibility", point.elevation === null ? "hidden" : "visible");
    const [x, y] = profileXY(point);
    dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(y));
  }
  if (mapReady && map && activeTab === "analyze") {
    pointMarker ||= new mapboxglRuntime!.Marker({ color: "#e9a23b" });
    pointMarker.setLngLat([point.longitude, point.latitude]).addTo(map);
  }
}

position.oninput = updateProfilePoint;
document.getElementById("profile")?.addEventListener("click", (event) => {
  if (!analysis) return;
  const target = event.currentTarget;
  if (!(target instanceof SVGSVGElement)) return;
  const bounds = target.getBoundingClientRect();
  const distance = Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * 600 - 20) / 560)) * analysis.distanceM;
  let closest = 0;
  for (let i = 1; i < trailPoints.length; i++) {
    if (Math.abs(trailPoints[i].distanceM - distance) < Math.abs(trailPoints[closest].distanceM - distance)) closest = i;
  }
  position.value = String(closest);
  updateProfilePoint();
});

function mapNotice(message: string): void {
  const element = get("map-notice", HTMLParagraphElement);
  element.textContent = message;
  element.hidden = !message;
}

function updateConnection(): void {
  get("connection", HTMLSpanElement).textContent = navigator.onLine ? "LOCAL-FIRST EXPLORER" : "OFFLINE MODE";
  if (!navigator.onLine) mapNotice("Offline: saved details and trail analysis work. Basemap tiles need a connection.");
  else mapNotice("");
}

window.addEventListener("online", updateConnection);
window.addEventListener("offline", updateConnection);
updateConnection();

function updateTerrainButton(): void {
  const toggle = get("terrain-toggle", HTMLButtonElement);
  toggle.setAttribute("aria-pressed", String(terrainEnabled));
  toggle.textContent = terrainEnabled ? "Return to 2D" : "3D terrain";
  get("map-pitch", HTMLInputElement).min = String(terrainEnabled ? TERRAIN_PITCH : 0);
  syncPitchControl();
}

const pitchControl = get("map-pitch", HTMLInputElement);
const steepnessControl = get("terrain-steepness", HTMLInputElement);
let terrainExaggeration = TERRAIN_EXAGGERATION;

function syncPitchControl(): void {
  if (!map) return;
  const pitch = Math.round(map.getPitch());
  pitchControl.value = String(pitch);
  get("pitch-reading", HTMLOutputElement).value = `${pitch} degrees`;
  pitchControl.setAttribute("aria-valuetext", `${pitch} degrees`);
}

pitchControl.oninput = () => {
  if (!mapReady || !map) return;
  try {
    applyCameraPitch(map, pitchControl.valueAsNumber);
    syncPitchControl();
  } catch (error) {
    report(error);
    syncPitchControl();
  }
};

steepnessControl.oninput = () => {
  if (!mapReady || !map) return;
  try {
    const exaggeration = steepnessControl.valueAsNumber;
    if (terrainEnabled) setTerrainElevation(map, true, exaggeration);
    terrainExaggeration = exaggeration;
    get("steepness-reading", HTMLOutputElement).value = `${exaggeration}x`;
    steepnessControl.setAttribute("aria-valuetext", `${exaggeration} times actual elevation`);
  } catch (error) {
    report(error);
    steepnessControl.value = String(terrainExaggeration);
  }
};

get("terrain-toggle", HTMLButtonElement).onclick = () => {
  if (!mapReady || !map) return;
  try {
    const enabled = !terrainEnabled;
    applyTerrainView(map, enabled, reducedMotion(), terrainExaggeration,
      map.getPitch() > 0 ? map.getPitch() : TERRAIN_PITCH);
    terrainEnabled = enabled;
    updateTerrainButton();
    if (enabled && !navigator.onLine) mapNotice("3D elevation tiles need a connection. Previously loaded terrain may be incomplete offline.");
  } catch (error) {
    report(error);
    mapNotice("Could not change terrain mode. Try again while online.");
  }
};

async function initializeMap(): Promise<void> {
try {
  const mapboxModule = await import("mapbox-gl");
  mapboxglRuntime = mapboxModule.default;
  mapboxglRuntime.accessToken = await loadMapboxToken();
  map = new mapboxglRuntime.Map({
    container: "map", style: "mapbox://styles/mapbox/outdoors-v12",
    center: [-79.312, 39.505], zoom: 12,
    maxBounds: REGION_BOUNDS,
    pitch: TERRAIN_PITCH, bearing: 0, maxPitch: MAX_PITCH, scrollZoom: true,
    dragRotate: true, pitchWithRotate: true, touchPitch: true,
    minZoom: regionMinZoom(get("map", HTMLDivElement).clientWidth, get("map", HTMLDivElement).clientHeight),
  });
  map.once("load", () => get("map", HTMLDivElement).setAttribute("aria-busy", "false"));
  const updateZoomFloor = () => {
    if (map) map.setMinZoom(terrainMinZoom(map.getContainer().clientWidth,
      map.getContainer().clientHeight, map.getPitch()));
  };
  map.on("resize", updateZoomFloor);
  map.on("pitch", updateZoomFloor);
  map.on("pitch", syncPitchControl);
  map.on("pitchend", updateZoomFloor);
  map.addControl(new mapboxglRuntime.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
  map.on("error", (event) => {
    console.error("Map resource error:", event.error);
    if (map && !map.isStyleLoaded()) get("map", HTMLDivElement).setAttribute("aria-busy", "false");
    if ("sourceId" in event && event.sourceId === TERRAIN_SOURCE && terrainEnabled && map) {
      applyTerrainView(map, false, true);
      terrainEnabled = false;
      updateTerrainButton();
      mapNotice("Elevation terrain could not load. Returned to 2D; try 3D again while online.");
      return;
    }
    mapNotice("Some map resources are unavailable. You can still browse places and analyze or open saved trails.");
  });
  map.on("style.load", () => {
    if (!map) return;
    map.addSource("parks", { type: "geojson", promoteId: "placeId", data: placeData() });
    map.addLayer({
      id: "parks", type: "circle", source: "parks",
      paint: {
        "circle-radius": ["case", ["get", "selected"], 11, 7],
        "circle-color": ["case", ["get", "selected"], "#e9a23b", "#41694e"],
        "circle-stroke-color": "#fff", "circle-stroke-width": 3,
      },
    });
    map.addSource("trail", { type: "geojson", data: routeData() });
    map.addSource("regional-hikes", { type: "geojson", data: regionalHikeData() });
    map.addLayer({ id: "regional-hikes", type: "line", source: "regional-hikes",
      paint: { "line-color": "#41694e", "line-width": 2, "line-opacity": 0.7 } });
    map.on("click", "regional-hikes", (event) => {
      const hike = discovery.hikes.find((item) => item.source.id === event.features?.[0]?.properties?.hikeId);
      if (!hike) return;
      switchTab("hikes");
      get("hike-search", HTMLInputElement).value = hike.name;
      get("hike-kind", HTMLSelectElement).value = "";
      previewHike = hike;
      renderHikes();
      updateMap();
    });
    map.on("mouseenter", "regional-hikes", () => { if (map) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "regional-hikes", () => { if (map) map.getCanvas().style.cursor = ""; });
    map.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": "#d47522", "line-width": 5 } });
    map.on("click", "parks", (event) => {
      const place = places.find((item) => item.id === event.features?.[0]?.properties?.placeId);
      if (place) selectPlace(place);
    });
    map.on("mouseenter", "parks", () => { if (map) map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "parks", () => { if (map) map.getCanvas().style.cursor = ""; });
    mapReady = true;
    if (terrainEnabled) applyTerrainView(map, true, true, terrainExaggeration, map.getPitch());
    updateTerrainButton();
    get("terrain-toggle", HTMLButtonElement).disabled = false;
    pitchControl.disabled = false;
    steepnessControl.disabled = false;
    syncPitchControl();
    if (selectedPlace && activeTab === "explore") selectPlace(selectedPlace, false);
    if (analysis) { focusTrail(); updateProfilePoint(); }
  });
} catch (error) {
  get("map", HTMLDivElement).setAttribute("aria-busy", "false");
  console.error("Map initialization failed:", error);
  mapNotice(`${error instanceof Error ? error.message : "The map could not start."} Place discovery, saved details, and trail analysis remain available.`);
}
}
void initializeMap();

get("reset-map", HTMLButtonElement).onclick = () => {
  if (!mapReady || !map) return;
  const bounds = new mapboxglRuntime!.LngLatBounds();
  places.forEach((place) => bounds.extend(place.coordinates));
  map.fitBounds(bounds, { padding: 50, duration: reducedMotion() ? 0 : 800 });
};

const params = new URL(location.href).searchParams;
search.value = params.get("q") || "";
activity.value = activityOptions.includes(params.get("activity") || "") ? params.get("activity") || "" : "";
filtered = filterPlaces(places, search.value, activity.value);
selectedPlace = filtered.find((place) => place.id === params.get("place"));
renderPlaces();
renderDetails();
perform(refreshSaved);
