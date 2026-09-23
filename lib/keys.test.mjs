import assert from "node:assert/strict";
import { test } from "node:test";
import { holdsKeys, secretEnvValues } from "./keys.mjs";

test("a file carrying a key is kept, code that reads one from the environment is not", () => {
  assert.ok(holdsKeys('[{"guid":"a1","playlist":"https://x/p.m3u8","aesKey":"9f86d081884c7d659a2feaa0c55ad015"}]'));
  assert.ok(holdsKeys("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MfszSEX8"));
  assert.ok(holdsKeys('const client = new OpenAI({ apiKey: "sk-proj-4eC39HqLyjWDarjtT1zdp7dc" })'));
  assert.ok(holdsKeys("DB=postgres://u:hunter2hunter2@db/x", ["hunter2hunter2"]));
  assert.ok(!holdsKeys("const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })"));
  assert.ok(!holdsKeys('{"name":"app","version":"1.0.0","scripts":{"dev":"next dev"}}'));
  assert.ok(!holdsKeys('const tokenLimit = 4096; const keyName = "OPENAI_API_KEY";'));
});

test("only secret-named values from real env files are looked for", () => {
  const files = { ".env": "OPENAI_API_KEY=sk-live-value-123456\nBUCKET=documents-bucket-01\n", ".env.example": "STRIPE_SECRET=your-secret-here-please\n" };
  assert.deepEqual(secretEnvValues(Object.keys(files), (f) => files[f]), ["sk-live-value-123456"]);
});

test("code that names or looks for a key is not a key", () => {
  assert.ok(!holdsKeys('if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;'));
  assert.ok(!holdsKeys('const fake = "sk-live-should-never-leak-anywhere";'));
  assert.ok(holdsKeys('"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"'));
});
