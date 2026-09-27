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
  const rows = lines.filter((l) => !l.hello && !l.call && !l.listen && !l.routes);
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
    const rows = readRows(file).filter((l) => !l.hello && !l.call && !l.listen && !l.routes);
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

// An agent loop that writes its observations into the next prompt as text: the second call's new
// user text, and only that, is the material.
test("within one turn, prompt text a later call adds is read as the tools' material", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", async () => {
    const system = { role: "system", content: "You are a shop assistant." };
    const user = { role: "user", content: "Where is order YQ1?" };
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [system, user] }) }).catch(() => {});
    await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-x", messages: [system, user, { role: "assistant", content: "Thought: look it up" }, { role: "user", content: "Observation: {\\"order\\":\\"YQ1\\",\\"status\\":\\"shipped\\"}" }] }) }).catch(() => {});
    res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`);
  const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(dir, "app.cjs")], { env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "x-cortad-turn": "case_1:1" }, body: "{}" });
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  const calls = readRows(file).filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools, undefined, "the first call holds only the customer's message and the prompt");
  assert.deepEqual(calls[1].tools, [{ name: "", text: 'Observation: {"order":"YQ1","status":"shipped"}' }]);
});

// One turn through three SDK styles and a vector store: the tools the model asked for, streamed or
// whole, with values clipped and secrets left out; this turn's tool answers and not an earlier
// turn's; the passages the prompt labels as retrieved; and what the store answered.
const FIXTURE = new URL("./hook-fixture.json", import.meta.url).pathname;
// Tool use written in the reply text: CrewAI and LangChain ReAct, a tool tag, JSON, and prose that
// only says Action.
const WRITTEN = ["reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse"];
test("a model call carries the tools it asked for and the passages its prompt was handed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "app.cjs"), `
const http = require("node:http");
const fx = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const styles = [fx.chat, fx.chatJson, fx.responses, fx.responsesStream, fx.anthropic, fx.store, fx.reactCrew, fx.reactLangchain, fx.xmlTag, fx.jsonText, fx.reactProse];
const provider = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => { const s = styles.find((x) => x.path === req.url); res.writeHead(200, { "content-type": s.type }); res.end(s.reply); });
}).listen(0, "127.0.0.1", () => {
  const base = "http://127.0.0.1:" + provider.address().port;
  http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      for (const s of styles) {
        const r = await fetch(base + s.path, { method: "POST", body: JSON.stringify(s.sent || {}) });
        const reader = r.body.getReader(); while (!(await reader.read()).done);
      }
      res.end("{}");
    });
  }).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
});
`);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onDoor: () => {} });
  const child = spawn(process.execPath, [join(dir, "app.cjs")], { env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
    await fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { "x-cortad-turn": fx.turn }, body: "{}" });
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill(); }
  const rows = readRows(file);
  const calls = Object.fromEntries(rows.filter((l) => l.call).map((l) => [l.call.model, l.call]));
  for (const style of ["chat", "chatJson", "responses", "responsesStream", "anthropic", ...WRITTEN]) {
    const call = calls[fx[style].sent.model];
    assert.equal(call?.turn, fx.turn, style);
    assert.deepEqual(call.called, fx[style].called, `${style}: the tools it asked for`);
    assert.deepEqual(call.passages, fx[style].passages, `${style}: the passages it was handed`);
  }
  assert.deepEqual(calls["chat-stream"].tools, fx.chat.tools, "this turn's tool answer, and not an earlier turn's");
  assert.deepEqual(calls["responses-json"].tools, fx.responses.tools);
  for (const style of ["reactCrew", "reactLangchain", "xmlTag"]) assert.deepEqual(calls[fx[style].sent.model].tools, fx[style].tools, `${style}: what the tool answered, named`);
  assert.ok(!/abc123|sk-livekey|hunter2/.test(readFileSync(file, "utf8")), "a secret argument is never written");
  const store = rows.find((l) => l.dep && l.dep.passages)?.dep;
  assert.deepEqual([store?.turn, store?.passages], [fx.turn, fx.store.passages], "what the store answered, pinned to the turn");
  // The command hands both on to the run exactly as the hook wrote them.
  const report = capture.usage();
  assert.deepEqual(report.rows.find((r) => r.model === "chat-stream")?.called, fx.chat.called);
  assert.deepEqual(report.rows.find((r) => r.model === "anthropic-stream")?.passages, fx.anthropic.passages);
  assert.deepEqual(report.deps.find((d) => d.passages)?.passages, fx.store.passages);
});

// The route table read off the app itself: Express 4 and 5 through a router mounted under a prefix
// and a mounted sub-app, handed to the runner and answered by port.
const NODE_APP = new URL("../.scratch/py-app/node-app/", import.meta.url).pathname;
const hasNodeApps = (() => { try { readFileSync(join(NODE_APP, "node_modules/express4/package.json")); return true; } catch { return false; } })();
for (const version of ["express", "express4"]) {
  test(`${version}: every route is written with its mount prefix, and the runner answers it`, { skip: !hasNodeApps }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "routes-"));
    const capture = makeCapture({ work: dir, keepSecret: () => {}, onDoor: () => {} });
    const child = spawn(process.execPath, [join(NODE_APP, "express-app.cjs")], { cwd: NODE_APP, env: { ...process.env, ...capture.env({}), EXPRESS: version }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
      await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 300));
      const table = capture.registry(port);
      const said = table.routes.map((r) => `${r.method} ${r.path}`);
      assert.equal(table.framework, "express");
      assert.equal(table.port, port);
      for (const want of ["POST /api/chat", "GET /api/threads/{id}", "DELETE /api/threads/{id}", "PUT /admin/users/{userId}", "GET /health"]) assert.ok(said.includes(want), `${want} in ${said}`);
      assert.ok(said.includes("POST /late"), "a route added after listening is there by the first request");
      assert.deepEqual(table.routes.find((r) => r.path === "/api/chat"), { method: "POST", path: "/api/chat", file: "express-app.cjs", handler: "chat" });
    } finally { child.kill(); }
  });
}

test("the runner keeps the newest table per port, answers the app's port first and drops what is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "routes-"));
  const rows = [
    { routes: { framework: "express", port: 4000, routes: [{ method: "post", path: "/api/chat", file: "a.js", handler: "chat" }], openapi: null } },
    { routes: { framework: "fastapi", port: 5000, routes: [{ method: "POST", path: "/old" }], openapi: null } },
    { routes: { framework: "made-up", port: 5000, routes: [{ method: "GET", path: "/new" }, { method: "POST", path: "no-slash" }, { method: 7, path: "/x" }, { method: "PATCH", path: "/y".repeat(900) }], openapi: [] } },
  ];
  writeFileSync(join(dir, "trace.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const capture = makeCapture({ work: dir, keepSecret: () => {}, onDoor: () => {} });
  assert.deepEqual(capture.registry(4000).routes, [{ method: "POST", path: "/api/chat", file: "a.js", handler: "chat" }]);
  const other = capture.registry(5000);
  assert.deepEqual([other.framework, other.openapi, other.routes.map((r) => r.path.length)], ["unknown", null, [4, 1024]]);
  assert.equal(capture.registry(9999).port, 5000, "an unknown port gets the newest table");
  assert.deepEqual(makeCapture({ work: mkdtempSync(join(tmpdir(), "routes-")), keepSecret: () => {}, onDoor: () => {} }).registry(1), {});
});

// Fastify through its diagnostics channel, Koa and Hono through the apps held as they are made.
for (const framework of ["fastify", "koa", "hono"]) {
  test(`${framework}: a prefixed route with a path parameter is written as {name}`, { skip: !hasNodeApps }, async () => {
    const file = join(mkdtempSync(join(tmpdir(), "routes-")), "trace.jsonl");
    const child = spawn(process.execPath, ["--require", new URL("./trace.cjs", import.meta.url).pathname, join(NODE_APP, "others.cjs"), framework], { cwd: NODE_APP, env: { ...process.env, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
    try {
      let table;
      for (let i = 0; i < 50 && !table; i++) { await new Promise((r) => setTimeout(r, 100)); table = readRows(file).find((l) => l.routes)?.routes; }
      assert.equal(table?.framework, framework);
      assert.deepEqual(table.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), ["POST /api/chat/{id} chat"]);
    } finally { child.kill(); }
  });
}
