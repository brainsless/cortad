import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture, placeBuilt } from "./replay.mjs";

// A Next.js route as Turbopack builds it: one chunk under .next holding the AI SDK it bundled (lines 1
// and 2) and the app's route (line 3), with an index map beside it, the shape Turbopack writes.
const CHUNK = [
  `const sdkPost = (url, text) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: text }] }) }).catch(() => null);`,
  `const sdkPush = (controller, text) => controller.enqueue(new TextEncoder().encode(text));`,
  `module.exports = async function route(text) { await sdkPost("https://api.openai.com/v1/chat/completions", text); return new ReadableStream({ start(c) { sdkPush(c, "About " + text); c.close(); } }); };`,
  `//# sourceMappingURL=route.js.map`,
].join("\n");
// Line 1 to the SDK's line 1, line 2 to its line 11, line 3 to route.ts line 7.
const MAP = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, names: [], mappings: "AAAA;AAUA;ACJA",
  sources: ["[project]/node_modules/ai/dist/index.mjs", "[project]/src/app/api/chat/route.ts"] } }] };
const SERVER = `
const http = require("node:http");
const { Readable } = require("node:stream");
const route = require("./.next/server/chunks/route.js");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => { const stream = await route(JSON.parse(body).text); res.writeHead(200, { "content-type": "text/plain" }); Readable.fromWeb(stream).pipe(res); });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

function nextApp() {
  const dir = mkdtempSync(join(tmpdir(), "built-"));
  mkdirSync(join(dir, ".next/server/chunks"), { recursive: true });
  mkdirSync(join(dir, "src/app/api/chat"), { recursive: true });
  writeFileSync(join(dir, "src/app/api/chat/route.ts"), "export async function POST() {}\n");
  writeFileSync(join(dir, ".next/server/chunks/route.js"), CHUNK);
  writeFileSync(join(dir, ".next/server/chunks/route.js.map"), JSON.stringify(MAP));
  writeFileSync(join(dir, "server.cjs"), SERVER);
  return dir;
}

test("a frame in a Turbopack chunk is placed at the app's own route through the chunk's map, past the SDK bundled beside it", () => {
  const dir = nextApp();
  const chunk = join(dir, ".next/server/chunks/route.js");
  assert.equal(placeBuilt(`${chunk}:3:40`), "src/app/api/chat/route.ts:7");
  assert.equal(placeBuilt(`${chunk}:1:5`), null, "a line the map puts in node_modules is not the app's");
  assert.equal(placeBuilt(`${join(dir, ".next/server/chunks/none.js")}:1:1`), null, "a chunk with no map is not placed");
  assert.equal(placeBuilt("app.cjs:4"), "app.cjs:4", "a frame already in the app's source passes as it came");
});

test("under the hook, the model call and the stream write of a built route name route.ts, never the chunk or the SDK", async () => {
  const dir = nextApp();
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const child = spawn(process.execPath, [join(dir, "server.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    const reply = await (await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "x-cortad-turn": "case_2:1" }, body: JSON.stringify({ text: "Madeira" }) })).text();
    assert.equal(reply, "About Madeira");
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  const [row] = capture.usage("case_2:1").rows;
  assert.equal(row.caller[0], "src/app/api/chat/route.ts:7");
  assert.ok(row.caller.every((at) => !at.includes(".next") && !at.includes("node_modules")));
  assert.deepEqual(row.sites?.map((s) => s.at), ["src/app/api/chat/route.ts:7"]);
});
