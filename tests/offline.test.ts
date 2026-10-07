import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface WorkerEvent {
  request: { url: string; method: string; mode: string };
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (response: Promise<unknown>) => void;
}

test("offline shell handles shared query URLs, includes WASM, and excludes basemap requests", async () => {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  let cachedAssets: string[] = [];
  let matched = "";
  const source = readFileSync("src/service-worker.js", "utf8")
    .replace("__CACHE_VERSION__", "test")
    .replace("__PRECACHE_ASSETS__", JSON.stringify(["./index.html", "./engine.wasm", "./worker.js"]));
  runInNewContext(source, {
    URL,
    self: {
      location: { origin: "https://example.test" },
      registration: { scope: "https://example.test/adventures/" },
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) => handlers.set(type, handler),
    },
    caches: {
      open: async () => ({
        addAll: async (assets: string[]) => { cachedAssets = assets; },
        match: async (request: string | { url: string }) => {
          matched = typeof request === "string" ? request : request.url;
          return new Response("cached content");
        },
      }),
    },
    fetch: () => { throw new Error("Offline test must not fetch a cached asset."); },
  });
  let pending: Promise<unknown> | undefined;
  const event = (url: string, mode = "navigate") => ({
    request: { url, method: "GET", mode },
    respondWith: (response: Promise<Response>) => { pending = response; },
    waitUntil: (response: Promise<unknown>) => { pending = response; },
  });
  handlers.get("install")!(event("https://example.test/adventures/"));
  await pending;
  assert.ok(cachedAssets.includes("./engine.wasm"));
  handlers.get("fetch")!(event("https://example.test/adventures/?place=123&q=waterfall"));
  assert.equal(await (await pending as Response).text(), "cached content");
  assert.equal(matched, "https://example.test/adventures/index.html");
  handlers.get("fetch")!(event("https://example.test/adventures/engine.wasm", "cors"));
  await pending;
  assert.equal(matched, "https://example.test/adventures/engine.wasm");
  pending = undefined;
  handlers.get("fetch")!(event("https://api.mapbox.com/tiles", "cors"));
  assert.equal(pending, undefined);
});
