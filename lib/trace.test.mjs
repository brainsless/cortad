import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A small app under the hook: one route calls a model (a host that does not resolve; the hook notes
// the call as it is made, not when it answers), one route does not.
const APP = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    if (req.url === "/api/talk") await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: JSON.parse(body).text }] }) }).catch(() => {});
    res.end(JSON.stringify({ ok: true, got: body.length }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;

test("the request during which the app called a model is written down, with its body and sign-in; others are not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), APP);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer their-session" }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post("/api/save", { title: "not a chat" })).ok, true);
  const answered = await post("/api/talk", { text: "hello from me", thread: 7 });
  assert.equal(answered.got, JSON.stringify({ text: "hello from me", thread: 7 }).length, "the app still read its own body whole");
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].hello, "node", "the hook says it is there");
  const rows = lines.filter((l) => !l.hello && !l.call);
  assert.equal(rows.length, 1);
  assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /api/talk");
  assert.deepEqual(JSON.parse(rows[0].body), { text: "hello from me", thread: 7 });
  assert.equal(rows[0].headers.authorization, "Bearer their-session");
  assert.match(rows[0].sent, /hello from me/);
});

// A provider on this machine answering the three ways real ones do: JSON with its counts, a stream
// with none, and gzip over plain http.request.
const METERED = `
const http = require("node:http");
const zlib = require("node:zlib");
const provider = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const { model, stream } = JSON.parse(body);
    if (stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"model":"' + model + '","choices":[{"delta":{"content":"hi"}}]}\\n\\ndata: [DONE]\\n\\n'); return; }
    const out = JSON.stringify({ model, choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } });
    if (req.headers["accept-encoding"] === "gzip") { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(zlib.gzipSync(out)); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(out);
  });
}).listen(0, "127.0.0.1", async function () {
  const url = "http://127.0.0.1:" + this.address().port + "/v1/chat/completions";
  const post = (body) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());
  await post({ model: "their-json-model" });
  await post({ model: "their-stream-model", stream: true });
  await new Promise((done) => {
    const req = http.request(url, { method: "POST", headers: { "accept-encoding": "gzip" } }, (res) => { res.on("data", () => {}); res.on("end", done); });
    req.end(JSON.stringify({ model: "their-gzip-model" }));
  });
  setTimeout(() => { provider.close(); console.log("DONE"); }, 200);
});
`;

test("every model call the app makes is metered: its model, status and the provider's own counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meter-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), METERED);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.on("data", (d) => { if (/DONE/.test(String(d))) resolve(); }));
  child.kill();
  const calls = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.call).map((l) => l.call);
  const by = Object.fromEntries(calls.map((c) => [c.model, c]));
  assert.equal(calls.length, 3);
  assert.deepEqual([by["their-json-model"].promptTokens, by["their-json-model"].cachedTokens, by["their-json-model"].completionTokens, by["their-json-model"].usage], [11, 4, 3, true]);
  assert.equal(by["their-stream-model"].usage, false, "a stream with no counts is still a call, marked as unread");
  assert.equal(by["their-stream-model"].status, 200);
  assert.deepEqual([by["their-gzip-model"].promptTokens, by["their-gzip-model"].usage], [11, true], "gzip over http.request is read");
  assert.ok(calls.every((c) => /^127\.0\.0\.1:\d+$/.test(c.host)));
  assert.ok(!readFileSync(file, "utf8").includes('"content":"hi"'), "no reply text is written down");
});
