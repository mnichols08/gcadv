import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverHikes, parseDiscovery, OVERPASS_URL } from "../src/hikes";

async function main(): Promise<void> {
  const endpoint = process.argv[2] || OVERPASS_URL;
  const snapshot = endpoint === "--input"
    ? parseDiscovery(JSON.parse(await readFile(process.argv[3], "utf8")))
    : await discoverHikes(AbortSignal.timeout(35_000), endpoint);
  if (!snapshot.hikes.length) throw new Error("No regional hikes returned; refusing to overwrite the bundled snapshot.");
  await writeFile(resolve(__dirname, "..", "src", "model", "hikes.json"), `${JSON.stringify(snapshot)}\n`);
  console.log(`Saved ${snapshot.hikes.length} regional mapped features, retrieved ${snapshot.retrievedAt}.`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
