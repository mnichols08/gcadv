export function validateMapConfig(value: unknown): string {
  if (typeof value !== "object" || value === null || !("mapboxToken" in value) ||
      typeof value.mapboxToken !== "string" || !/^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.mapboxToken)) {
    throw new Error("Map configuration requires a public Mapbox token beginning with pk. Secret tokens are not allowed in the browser.");
  }
  return value.mapboxToken;
}

export async function loadMapboxToken(): Promise<string> {
  const response = await fetch("./map-config.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Map configuration is unavailable. Set up map-config.local.json and rebuild, or deploy map-config.json.");
  }
  return validateMapConfig(await response.json());
}
