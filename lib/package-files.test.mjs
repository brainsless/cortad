import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 0.1.8 shipped without lib/listing.mjs, which local.mjs imports: every `npx cortad` crashed on start
// for the minutes it was latest. Every relative import in a shipped file must be shipped too.
test("every module a shipped file imports is in the package", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const shipped = new Set(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files);
  const missing = [];
  for (const file of shipped) {
    const text = readFileSync(join(root, file), "utf8");
    if (/\.(?:mjs|cjs|js)$/.test(file)) {
      for (const [, spec] of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g)) {
        const target = normalize(join(dirname(file), spec));
        if (!shipped.has(target)) missing.push(`${file} imports ${target}`);
      }
    }
    // The Python hook imports its siblings by name, inside a try that keeps the app starting without them.
    if (file.endsWith(".py")) {
      for (const [, name] of text.matchAll(/^\s*(?:from|import)\s+(\w+)/gm)) {
        const target = join(dirname(file), `${name}.py`);
        if (existsSync(join(root, target)) && !shipped.has(target)) missing.push(`${file} imports ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
