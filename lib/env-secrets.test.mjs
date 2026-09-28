import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { secretValues } from "./env-secrets.mjs";

test("a model's name is shown and priced; keys, and a key under a model's name, stay masked", () => {
  const file = join(mkdtempSync(join(tmpdir(), "env-secrets-")), ".env");
  writeFileSync(file, [
    "OPENAI_MODEL=accounts/fireworks/models/glm-5p3-flash",
    "MODEL_PROVIDER=openai",
    "OPENAI_API_KEY=sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
    "EMBED_MODEL=abcdefghijklmnopqrstuvwxyz0123456789",
    "DATABASE_URL=postgres://app:hunter2hunter2@db:5432/app",
  ].join("\n"));
  const masked = secretValues([file]);
  assert.ok(!masked.includes("accounts/fireworks/models/glm-5p3-flash"));
  assert.ok(!masked.includes("openai"));
  assert.ok(masked.includes("sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"));
  assert.ok(masked.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.ok(masked.includes("postgres://app:hunter2hunter2@db:5432/app"));
});
