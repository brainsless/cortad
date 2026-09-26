import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture } from "./replay.mjs";

const readRows = (file) => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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
  const rows = lines.filter((l) => !l.hello && !l.call && !l.listen);
  assert.equal(rows.length, 1);
  assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /api/talk");
  assert.deepEqual(JSON.parse(rows[0].body), { text: "hello from me", thread: 7 });
  assert.equal(rows[0].headers.authorization, "Bearer their-session");
  assert.match(rows[0].sent, /hello from me/);
  assert.ok(lines.some((l) => l.listen === port), "the port it serves is said, so watching means this app");
});

// databuddy's API is Elysia on Bun: Bun.serve, never node:http, and its models behind Vercel's gateway.
// Under the command the hook arrives through BUN_OPTIONS, which must also leave `bun run` working.
const BUN = spawnSync("bun", ["--version"]).status === 0 ? "bun" : null;
const BUN_APP = `
export default {
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (new URL(req.url).pathname === "/v1/agent/chat") await fetch("https://ai-gateway.vercel.sh/v1/ai/language-model", { method: "POST", body: JSON.stringify({ prompt: JSON.parse(body).messages }) }).catch(() => {});
    return Response.json({ got: body.length });
  },
};
`;
test("Bun: the request that called a model through a gateway is written down, and the port it serves", { skip: !BUN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-bun-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.ts"), BUN_APP);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: { dev: "bun app.ts" } }));
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onDoor: () => {} });
  // Its own process group: `bun run` starts the app as a child, and killing only the runner leaves it serving.
  const child = spawn(BUN, ["run", "dev"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: "ignore", detached: true });
  try {
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("the app never listened")), 8000);
      const look = setInterval(() => {
        const listen = readRows(file).find((l) => l.listen);
        if (listen) { clearInterval(look); clearTimeout(deadline); resolve(listen.listen); }
      }, 100);
    });
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: "better-auth.session_token=theirs" }, body: JSON.stringify(body) }).then((r) => r.json());
    await post("/v1/flags", { key: "not a chat" });
    const chat = { messages: [{ role: "user", parts: [{ type: "text", text: "visitors this week?" }] }], websiteId: "w1" };
    assert.equal((await post("/v1/agent/chat", chat)).got, JSON.stringify(chat).length, "the app still read its own body whole");
    await new Promise((r) => setTimeout(r, 300));
    const rows = readRows(file).filter((l) => !l.hello && !l.call && !l.listen);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /v1/agent/chat");
    assert.deepEqual(JSON.parse(rows[0].body), chat);
    assert.equal(rows[0].headers.cookie, "better-auth.session_token=theirs");
    assert.equal(capture.watching(port), true);
    assert.equal(capture.watching(port + 1), false, "a hooked process on another port is not this app");
  } finally { process.kill(-child.pid, "SIGKILL"); }
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

// The run tags each message with a turn and writes the customer's rule sentences beside the trace;
// the hook pins every model call to its turn and says which of those sentences the prompt carried,
// through JSON escapes and non-ASCII text, and the tag never reaches the door row it replays from.
test("a model call carries its turn and the rule ids its prompt held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify([
    { id: "rule:aaaaaaaaaa", text: "Never invent an order number.\nAsk for the phone's last four digits." },
    { id: "rule:bbbbbbbbbb", text: "始终只使用手机号后四位定位用户" },
    { id: "rule:cccccccccc", text: "Answer in {language} and nothing else, ever." },
    { id: "rule:dddddddddd", text: "This sentence is not in any prompt." },
  ]));
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const system = "Rules:\\nNever invent an order number.\\n  Ask for the phone's last four digits.\\n始终只使用手机号后四位定位用户\\nAnswer in Arabic and nothing else, ever.";
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [{ role: "system", content: system }, { role: "user", content: JSON.parse(body).text }] }) }).catch(() => {});
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file, CORTAD_RULES_FILE: rulesFile }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": "case_9:2" }, body: JSON.stringify({ text: "hi" }) }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  const lines = readRows(file);
  const call = lines.find((l) => l.call)?.call;
  assert.equal(call?.turn, "case_9:2");
  assert.deepEqual(call?.rules, ["rule:aaaaaaaaaa", "rule:bbbbbbbbbb", "rule:cccccccccc"]);
  const door = lines.find((l) => l.path === "/api/talk");
  assert.equal(door?.headers["x-cortad-turn"], undefined, "the tag is ours, never replayed as theirs");
});

// A tool's answer rides on the next model call as a tool message; the hook hands it over as the
// material the reply's facts rest on, named by the call that produced it.
test("what the app's tools answered is read off the next prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", async () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_ticket", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "{\\"ticket\\":\\"TK5063AB3D63\\",\\"status\\":\\"open\\"}" },
    ];
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages }) }).catch(() => {});
    res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  const call = readRows(file).find((l) => l.call)?.call;
  assert.deepEqual(call?.tools, [{ name: "lookup_ticket", text: '{"ticket":"TK5063AB3D63","status":"open"}' }]);
});
