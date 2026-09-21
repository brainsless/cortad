import assert from "node:assert/strict";
import { test } from "node:test";
import { listingUrl } from "./listing.mjs";

test("a key is asked where their app sends it, not at the provider its name suggests", () => {
  const canonical = "https://api.openai.com/v1/models";
  assert.equal(listingUrl("OPENAI_API_KEY", canonical, { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.fireworks.ai/inference/v1/" }), "https://api.fireworks.ai/inference/v1/models");
  assert.equal(listingUrl("OPENAI_API_KEY", canonical, { OPENAI_API_KEY: "k", OPENAI_API_BASE: "http://localhost:4000/v1" }), "http://localhost:4000/v1/models");
  assert.equal(listingUrl("OPENAI_API_KEY", canonical, { OPENAI_API_KEY: "k" }), canonical);
  assert.equal(listingUrl("OPENAI_API_KEY", canonical, { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "not a url" }), canonical);
});
