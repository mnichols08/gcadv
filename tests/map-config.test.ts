import assert from "node:assert/strict";
import test from "node:test";
import { validateMapConfig } from "../src/map-config";

test("accepts public token shape without a hard-coded credential", () => {
  const token = ["pk", "test_payload", "test_signature"].join(".");
  assert.equal(validateMapConfig({ mapboxToken: token }), token);
});

test("rejects secret tokens, missing config, and malformed values", () => {
  for (const config of [
    null, {}, { mapboxToken: 123 }, { mapboxToken: "" },
    { mapboxToken: ["sk", "test_payload", "test_signature"].join(".") },
    { mapboxToken: "pk.invalid" },
  ]) {
    assert.throws(() => validateMapConfig(config), /public Mapbox token/);
  }
});
