import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Next's edge sandbox (next/dist/server/web/sandbox/context.js) builds its own fetch from the
// primitives it bundles, so a route with `runtime = 'edge'` calls its model where the hook's
// patched fetch never looks. This pins that: the day it is seen, the edge door stops being excluded.
// NEXT_DIR names a project with Next installed; this repository does not carry Next.
const RUNTIME = process.env.NEXT_DIR && join(process.env.NEXT_DIR, "node_modules/next/dist/compiled/edge-runtime/index.js");
test("a model call made from inside Next's edge sandbox is not seen by the hook", { skip: !(RUNTIME && existsSync(RUNTIME)) && "NEXT_DIR is not set to a project with Next installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
const { EdgeRuntime } = require(${JSON.stringify(RUNTIME)});
const provider = http.createServer((q, s) => { q.resume(); q.on("end", () => s.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: "hi" } }] }))); }).listen(0, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + provider.address().port + "/v1/chat/completions";
  const rt = new EdgeRuntime();
  await rt.evaluate("fetch(" + JSON.stringify(url) + ", { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }) }).then((r) => r.text())");
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "node", messages: [{ role: "user", content: "hello" }] }) }).then((r) => r.text());
  setTimeout(() => { console.log("DONE"); process.exit(0); }, 300);
});
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.on("exit", resolve));
  const calls = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.call).map((r) => r.call.model);
  assert.deepEqual(calls, ["node"], "the same call from Node's own fetch is seen; the edge sandbox's is not");
});
