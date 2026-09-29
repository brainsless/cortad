import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proofsOf } from "./proof.mjs";

// An app that streams its model's words to its client and stops the model call when that client
// goes away, as a framework ties the call to the request. The provider sends its first words, and
// the rest a moment later.
const PROVIDER = `
const event = (text) => "data: " + JSON.stringify({ model: "cut-model", choices: [{ delta: { content: text } }] }) + "\\n\\n";
require("node:http").createServer((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(event("The first words"));
  const rest = setTimeout(() => { res.write(event(" and the rest.")); res.end("data: [DONE]\\n\\n"); }, 700);
  res.on("close", () => clearTimeout(rest));
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
const APP = `
const http = require("node:http");
http.createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    const stop = new AbortController();
    res.on("close", () => { if (!res.writableFinished) stop.abort(); });
    res.writeHead(200, { "content-type": "text/event-stream" });
    try {
      const r = await fetch("http://127.0.0.1:" + process.env.PROVIDER_PORT + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "cut-model", stream: true, messages: [{ role: "user", content: "hello" }] }), signal: stop.signal });
      for await (const chunk of r.body) res.write(chunk);
    } catch { /* the client went away */ }
    res.end();
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
const portOf = (child) => new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

// A client that reads the first bytes and hangs up, the way `| head` ends a curl.
const firstBytes = (port) => new Promise((resolve, reject) => {
  const req = request({ port, host: "127.0.0.1", method: "POST", path: "/api/stream", headers: { "content-type": "application/json" } }, (res) => res.once("data", (d) => { req.destroy(); resolve(String(d)); }));
  req.on("error", reject);
  req.end(JSON.stringify({ message: "hello" }));
});

test("a reply its client stopped reading is written as cut short, the model's words up to then stand, and the proof's sample is the latest whole reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cut-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), APP);
  const provider = spawn(process.execPath, ["-e", PROVIDER], { stdio: ["ignore", "pipe", "inherit"] });
  let app;
  try {
    app = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file, PROVIDER_PORT: String(await portOf(provider)) }, stdio: ["ignore", "pipe", "inherit"] });
    const port = await portOf(app);
    assert.match(await firstBytes(port), /The first words/);
    await new Promise((r) => setTimeout(r, 1000));
    const whole = await fetch(`http://127.0.0.1:${port}/api/stream`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hello again" }) }).then((r) => r.text());
    assert.match(whole, /and the rest/);
    await new Promise((r) => setTimeout(r, 400));
  } finally { app?.kill(); provider.kill(); }

  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const [cut, full] = rows.filter((r) => r.method === "POST");
  assert.equal(cut.cut, true, "the app began its reply and never finished it");
  assert.match(cut.reply, /The first words/);
  assert.doesNotMatch(cut.reply, /and the rest/);
  assert.equal(full.cut, undefined);
  const call = rows.find((r) => r.call && r.call.ex === cut.ex).call;
  assert.deepEqual([call.status, call.reply], [200, "The first words"], "the words the model had said when the call was stopped");

  const sample = (kept) => proofsOf(kept).get("POST /api/stream").sample;
  assert.deepEqual(sample(rows), { ask: "hello again", reply: "The first words and the rest." }, "the whole reply, not the latest one cut short");
  const alone = rows.filter((r) => r.ex !== full.ex && r.call?.ex !== full.ex);
  assert.equal(sample(alone).cut, true, "with only a reply cut short, the sample says so");
});
