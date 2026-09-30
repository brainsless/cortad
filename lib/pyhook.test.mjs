import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const APP = new URL("../.scratch/py-app/", import.meta.url).pathname;
const PY = join(APP, ".venv/bin/python");
const HOOK = new URL("./pyhook/", import.meta.url).pathname;
const up = async (port) => { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/nothing`); return true; } catch { await new Promise((r) => setTimeout(r, 250)); } } return false; };
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Real FastAPI under uvicorn with the OpenAI SDK, and real Flask with requests: the two stacks most
// Python AI backends are one of. Skipped where the scratch virtualenv has not been made.
const skip = !existsSync(PY);

test("FastAPI: the request that called a model is written down, with body, sign-in and what the app answered", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(PY, ["-m", "uvicorn", "fast_app:app", "--port", "4321"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(4321), "the app starts with the hook loaded");
    const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:4321${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post("/v2/save", { prompt: "not a chat" })).status, 200);
    const mine = await post("/v2/assist", { prompt: "hello from python", thread: 3 }, { "x-session": "py-session-only-they-have" });
    assert.equal(mine.status, 200);
    assert.match((await mine.json()).answer, /hello from python/, "the app still read its own body");
    await new Promise((r) => setTimeout(r, 300));
    const lines = rowsOf(file);
    assert.equal(lines[0].hello, "python");
    const rows = lines.filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /v2/assist");
    assert.deepEqual(JSON.parse(rows[0].body), { prompt: "hello from python", thread: 3 });
    assert.equal(rows[0].headers["x-session"], "py-session-only-they-have");
    assert.match(rows[0].sent[0], /hello from python/);
    assert.equal(rows[0].status, 200);
    assert.match(JSON.parse(rows[0].reply).answer, /You asked: hello from python/, "what the app answered, as it answered it");
  } finally { child.kill("SIGKILL"); }
});

test("Flask: the same, through werkzeug and requests", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(PY, ["flask_app.py"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(4322));
    const mine = await fetch("http://127.0.0.1:4322/helper/reply", { method: "POST", headers: { "content-type": "application/json", cookie: "sid=flask-cookie" }, body: JSON.stringify({ text: "hello from flask" }) });
    assert.equal(mine.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const rows = rowsOf(file).filter((l) => !l.hello && !l.call && !l.listen && !l.routes && !l.conn);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /helper/reply");
    assert.equal(rows[0].headers.cookie, "sid=flask-cookie");
    assert.match(rows[0].sent[0], /hello from flask/);
    assert.equal(rows[0].status, 200);
  } finally { child.kill("SIGKILL"); }
});

test("every model call through the OpenAI SDK is metered, streamed or not", { skip }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const out = await new Promise((done) => {
    const child = spawn(PY, ["meter_app.py"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
    let said = ""; child.stdout.on("data", (d) => { said += d; }); child.on("close", () => done(said));
  });
  assert.match(out, /DONE/);
  const calls = Object.fromEntries(rowsOf(file).filter((l) => l.call).map((l) => [l.call.model, l.call]));
  assert.deepEqual([calls["py-json-model"]?.promptTokens, calls["py-json-model"]?.completionTokens, calls["py-json-model"]?.usage], [9, 2, true]);
  assert.deepEqual([calls["py-stream-model"]?.status, calls["py-stream-model"]?.usage], [200, false], "a stream with no counts is a call whose counts were not read");
  assert.deepEqual([calls["py-async-model"]?.promptTokens, calls["py-async-model"]?.usage], [9, true], "an async stream is read to its last chunk");
});

// The same two facts from the Python hook: the turn tag on the call row, and the rule ids the prompt
// carried, read through the SDK's ASCII-escaped JSON.
test("FastAPI: a model call carries its turn and the rule ids its prompt held", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const rulesFile = join(dir, "rules.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(rulesFile, JSON.stringify([
    { id: "rule:aaaaaaaaaa", text: "始终只使用手机号后四位定位用户" },
    { id: "rule:bbbbbbbbbb", text: "Answer in {language} and nothing else, ever." },
    { id: "rule:cccccccccc", text: "This sentence is not in any prompt." },
  ]));
  const child = spawn(PY, ["-m", "uvicorn", "fast_app:app", "--port", "4325"], { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_RULES_FILE: rulesFile }, stdio: "ignore" });
  try {
    assert.ok(await up(4325));
    const prompt = "Rules:\n始终只使用手机号后四位定位用户\nAnswer in Chinese and nothing else, ever.";
    const res = await fetch("http://127.0.0.1:4325/v2/assist", { method: "POST", headers: { "content-type": "application/json", "x-session": "py-session-only-they-have", "x-cortad-turn": "case_3:1" }, body: JSON.stringify({ prompt, thread: 1 }) });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
    const lines = rowsOf(file);
    const call = lines.find((l) => l.call)?.call;
    assert.equal(call?.turn, "case_3:1");
    assert.deepEqual(call?.rules, ["rule:aaaaaaaaaa", "rule:bbbbbbbbbb"]);
    const door = lines.find((l) => l.path === "/v2/assist");
    assert.equal(door?.headers["x-cortad-turn"], undefined);
  } finally { child.kill("SIGKILL"); }
});

// One turn through the OpenAI SDK (a chat stream and a responses call), a raw Anthropic stream over
// httpx and a vector store over requests, inside a FastAPI handler: the tools the model asked for,
// this turn's tool answers, the passages the prompt labels as retrieved, and what the store answered.
const FIXTURE = new URL("./hook-fixture.json", import.meta.url).pathname;
const TURN_APP = `
import asyncio, json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx, requests
from fastapi import FastAPI
from openai import AsyncOpenAI

fx = json.load(open(${JSON.stringify(FIXTURE)}))
written = ["reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse"]
styles = [fx["chat"], fx["chatJson"], fx["responses"], fx["responsesStream"], fx["anthropic"], fx["store"], fx["ragBlock"], fx["ragCode"], fx["records"]] + [fx[w] for w in written]

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
client = AsyncOpenAI(api_key="k", base_url=base + "/v1", max_retries=0)
app = FastAPI()

@app.post("/talk")
async def talk():
    chat = dict(fx["chat"]["sent"]); chat.pop("stream")
    async for _ in await client.chat.completions.create(stream=True, **chat):
        pass
    await client.responses.create(**fx["responses"]["sent"])
    async with httpx.AsyncClient() as h:
        # Steps run as tasks of their own, the way LangChain runs a chain's steps and a model's batch.
        await asyncio.create_task(h.post(base + fx["chatJson"]["path"], json=fx["chatJson"]["sent"]))
        for style in ["responsesStream", "anthropic", "ragCode"] + written:
            async with h.stream("POST", base + fx[style]["path"], json=fx[style]["sent"]) as r:
                async for _ in r.aiter_bytes():
                    pass
        await asyncio.gather(h.post(base + fx["ragBlock"]["path"], json=fx["ragBlock"]["sent"]))
        # A prompt past 64 KB, as an app's list of tools makes it, is still read whole.
        tools = [{"type": "function", "function": {"name": "tool_%d" % i, "description": "x" * 400, "parameters": {"type": "object"}}} for i in range(200)]
        await h.post(base + fx["records"]["path"], json=dict(fx["records"]["sent"], tools=tools))
    requests.post(base + fx["store"]["path"], json={"vector": [0.1]})
    return {"ok": True}
`;
test("FastAPI: a model call carries the tools it asked for, the passages its prompt was handed and the line of the app that made it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "turn_app.py"), TURN_APP);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const child = spawn(PY, ["-m", "uvicorn", "turn_app:app", "--port", "4331"], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(4331));
    const res = await fetch("http://127.0.0.1:4331/talk", { method: "POST", headers: { "x-cortad-turn": fx.turn } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const calls = Object.fromEntries(rows.filter((l) => l.call).map((l) => [l.call.model, l.call]));
  for (const style of ["chat", "chatJson", "responses", "responsesStream", "anthropic", "reactCrew", "reactLangchain", "xmlTag", "jsonText", "reactProse", "ragBlock", "ragCode", "records"]) {
    const call = calls[fx[style].sent.model];
    assert.equal(call?.turn, fx.turn, style);
    assert.deepEqual(call.called, fx[style].called, `${style}: the tools it asked for`);
    assert.deepEqual(call.passages, fx[style].passages, `${style}: the passages it was handed`);
  }
  for (const call of Object.values(calls)) assert.match(call.caller?.[0] ?? "", /^turn_app\.py:\d+$/, `${call.model}: the line of the app that made the call`);
  const lineOf = (text) => TURN_APP.split("\n").findIndex((l) => l.includes(text)) + 1;
  assert.deepEqual(calls["chat-json"].caller, [`turn_app.py:${lineOf("asyncio.create_task(h.post")}`], "a call made in a task of its own is placed at the line that awaits it");
  assert.deepEqual(calls["rag-block"].caller, [`turn_app.py:${lineOf("asyncio.gather(h.post")}`], "and one made in a gathered task");
  assert.deepEqual(calls["chat-stream"].tools, fx.chat.tools, "this turn's tool answer, and not an earlier turn's");
  assert.deepEqual(calls["responses-json"].tools, fx.responses.tools);
  for (const style of ["reactCrew", "reactLangchain", "xmlTag"]) assert.deepEqual(calls[fx[style].sent.model].tools, fx[style].tools, `${style}: what the tool answered, named`);
  assert.ok(!/abc123|sk-livekey|hunter2/.test(readFileSync(file, "utf8")), "a secret argument is never written");
  const store = rows.find((l) => l.dep && l.dep.passages)?.dep;
  assert.deepEqual([store?.turn, store?.passages], [fx.turn, fx.store.passages], "what the store answered, pinned to the turn");
});

// The same two styles the Node hook reads: a provider's tools and the error it met, off the recorded
// stream, and a call its schema refuses.
const PROVIDER_APP = `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI

fx = json.load(open(${JSON.stringify(FIXTURE)}))
styles = [fx["providerTools"], fx["refusedArgs"]]

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/talk")
async def talk():
    async with httpx.AsyncClient() as h:
        for s in styles:
            async with h.stream("POST", base + s["path"], json=s["sent"]) as r:
                async for _ in r.aiter_bytes():
                    pass
    return {"ok": True}
`;
test("FastAPI: the tools a provider ran and what they answered, and a call its schema refuses, ride on the model call", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "provider_app.py"), PROVIDER_APP);
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const child = spawn(PY, ["-m", "uvicorn", "provider_app:app", "--port", "4337"], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    assert.ok(await up(4337));
    const res = await fetch("http://127.0.0.1:4337/talk", { method: "POST", headers: { "x-cortad-turn": fx.turn } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const calls = Object.fromEntries(rowsOf(file).filter((l) => l.call).map((l) => [l.call.model, l.call]));
  assert.deepEqual(calls["responses-provider-tools"]?.called, fx.providerTools.called);
  assert.deepEqual(calls["responses-provider-tools"]?.tools, fx.providerTools.tools);
  assert.deepEqual(calls["refused-args"]?.called, fx.refusedArgs.called);
});

// An app whose own code picks the tool from a classifier's answer: the fixture's shop, in Python.
// The run writes the list after the app has loaded, as a real run does; the hook wraps the function
// in its module and wherever the app took it by name or put it in a table of its own.
const DISPATCH_APP = (fx) => `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI, Request
from ${fx.module} import query_order

styles = json.loads(${JSON.stringify(JSON.stringify([fx.classify, fx.answer]))})
HANDLERS = {"order": query_order}

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        s = next(x for x in styles if self.path == x["path"])
        raw = s["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", s["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    async with httpx.AsyncClient() as h:
        intent = json.loads((await h.post(base + styles[0]["path"], json=styles[0]["sent"])).json()["choices"][0]["message"]["content"])["intent"]
        if intent == "order":
            (HANDLERS[intent] if body.get("via") == "table" else query_order)(body["message"])
        await h.post(base + styles[1]["path"], json=styles[1]["sent"])
    return {"ok": True}
`;
const SHOP_TOOLS = (fx) => `
def query_order(message):
    return ${JSON.stringify(fx.returns)}

def search_faq(question):
    return "never asked"

REFUND_POLICY = "seven days"
`;
test("FastAPI: a tool the app's own code runs is recorded with its arguments and what it returned; a password never is", { skip }, async () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8")).dispatched;
  const dir = mkdtempSync(join(tmpdir(), "pyhook-"));
  const file = join(dir, "trace.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "dispatch_app.py"), DISPATCH_APP(fx));
  writeFileSync(join(dir, `${fx.module}.py`), SHOP_TOOLS(fx));
  const toolsFile = join(dir, "tools.json");
  const child = spawn(PY, ["-m", "uvicorn", "dispatch_app:app", "--port", "4336"], { cwd: dir, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_TOOLS_FILE: toolsFile }, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  child.stderr.on("data", (d) => { said += d; });
  try {
    assert.ok(await up(4336));
    writeFileSync(toolsFile, JSON.stringify(fx.tools.map((t) => ({ ...t, file: t.file === "app" ? "dispatch_app.py" : `${fx.module}.py` }))));
    for (const [turn, via] of [["case_4:1", "name"], ["case_4:2", "table"]]) {
      const res = await fetch("http://127.0.0.1:4336/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn }, body: JSON.stringify({ message: fx.message, via }) });
      assert.equal(res.status, 200);
    }
    await new Promise((r) => setTimeout(r, 400));
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const ran = rows.filter((l) => l.dep && l.dep.host === "in-app").map((l) => l.dep);
  assert.deepEqual(ran.map((d) => [d.turn, d.called, d.tools]), [["case_4:1", fx.called, fx.toolRows], ["case_4:2", fx.called, fx.toolRows]], "taken by name and from the app's own table; search_faq was never called");
  const calls = rows.filter((l) => l.call).map((l) => l.call);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.tools === undefined), "the second chain's prompt and the person's message are not a tool's answer");
  assert.ok(rows.every((l) => ![...(l.call?.tools ?? []), ...(l.dep?.tools ?? [])].some((t) => !t.name)), "nothing in tools has an empty name");
  assert.ok(!readFileSync(file, "utf8").includes("hunter2"), "the password the person typed is in no row");
  assert.equal(said.split(fx.unwatched.replace("%s", "py")).length - 1, 1, "a named tool that is not a function is said once in the app's log");
});

// The route table read off the app object the server was handed, in one path syntax.
const tableOf = async (args, port, extra = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const child = spawn(args[0], args.slice(1), { cwd: APP, env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, ...extra }, stdio: "ignore", detached: true });
  try {
    assert.ok(await up(port), "the app starts with the hook loaded");
    const rows = rowsOf(file).filter((l) => l.routes);
    assert.ok(rows.length, "a routes row is written");
    const table = rows[rows.length - 1].routes;
    return { ...table, said: table.routes.map((r) => `${r.method} ${r.path}`) };
  } finally { process.kill(-child.pid, "SIGKILL"); }
};

test("FastAPI: an APIRouter's prefixed route with an int path parameter, and the OpenAPI document", { skip }, async () => {
  const t = await tableOf([PY, "-m", "uvicorn", "fast_app:app", "--port", "4331"], 4331);
  assert.deepEqual([t.framework, t.port], ["fastapi", 4331]);
  assert.ok(t.said.includes("POST /api/things/{thing_id}"), t.said.join(", "));
  assert.deepEqual(t.routes.find((r) => r.path === "/api/things/{thing_id}"), { method: "POST", path: "/api/things/{thing_id}", file: "fast_app.py", handler: "update_thing" });
  assert.ok(t.openapi?.paths?.["/api/things/{thing_id}"]?.post, "the in-process OpenAPI document carries the route");
  assert.equal(t.routes.find((r) => r.path === "/docs").file, "", "the framework's own files are not theirs");
});

test("Flask: url_map rules with converters, static left out", { skip }, async () => {
  const t = await tableOf([PY, "flask_app.py"], 4322);
  assert.deepEqual([t.framework, t.port, t.openapi], ["flask", 4322, null]);
  assert.deepEqual(t.said, ["POST /helper/reply", "POST /helper/threads/{thread_id}"]);
});

const hasDjango = existsSync(join(APP, ".venv/bin/django-admin"));
test("Django: included patterns keep their prefix, converters and regex groups become {name}", { skip: skip || !hasDjango }, async () => {
  const t = await tableOf([PY, "django_app.py", "runserver", "4332", "--noreload"], 4332);
  assert.deepEqual([t.framework, t.port], ["django", 4332]);
  assert.deepEqual(t.said, ["POST /api/chat/{pk}/", "GET /api/chat/{pk}/", "POST /api/notes/{slug}/"], "a function view's methods are unknown; a class view's are its own");
});

const hasGunicorn = existsSync(join(APP, ".venv/bin/gunicorn"));
test("gunicorn with uvicorn's worker: the port is gunicorn's socket, not uvicorn's default", { skip: skip || !hasGunicorn }, async () => {
  const t = await tableOf([join(APP, ".venv/bin/gunicorn"), "-k", "uvicorn.workers.UvicornWorker", "-b", "127.0.0.1:4333", "fast_app:app"], 4333);
  assert.deepEqual([t.framework, t.port], ["fastapi", 4333]);
  assert.ok(t.said.includes("POST /api/things/{thing_id}"));
});

const hasLitestar = existsSync(join(APP, ".venv/bin/litestar"));
test("Litestar and aiohttp: typed path parameters come out as {name}", { skip: skip || !hasLitestar }, async () => {
  const lite = await tableOf([PY, "-m", "uvicorn", "litestar_app:app", "--port", "4334"], 4334);
  assert.equal(lite.framework, "litestar");
  assert.deepEqual(lite.routes.find((r) => r.path === "/api/chat/{chat_id}"), { method: "POST", path: "/api/chat/{chat_id}", file: "litestar_app.py", handler: "chat" });
  assert.ok(lite.openapi?.paths?.["/api/chat/{chat_id}"]);
  const aio = await tableOf([PY, "aiohttp_app.py"], 4335);
  assert.deepEqual([aio.framework, aio.port, aio.said], ["aiohttp", 4335, ["POST /api/chat/{chat_id}"]]);
});

// A store's client connects to an address its name was resolved to: the name is read where it is
// resolved and the address where it connects, host and port alone, once each. Plain Python, no venv.
test("each server a Python app reaches is written down by name and by address, and nothing else of it", { timeout: 20_000 }, async () => {
  const { createServer } = await import("node:net");
  const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const file = join(mkdtempSync(join(tmpdir(), "pyhook-")), "trace.jsonl");
  const script = `import socket\nfor _ in range(2):\n    socket.create_connection(("localhost", ${port})).close()\n`;
  const child = spawn("python3", ["-c", script], { env: { PATH: process.env.PATH, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  server.close();
  const conns = rowsOf(file).filter((l) => l.conn).map((l) => l.conn);
  const hosts = conns.filter((c) => c.port === port).map((c) => c.host);
  // Each address tried is its own row: ::1 first where localhost resolves to it too.
  assert.ok(hosts.includes("localhost") && hosts.includes("127.0.0.1") && hosts.length === new Set(hosts).size, JSON.stringify(hosts));
  assert.ok(rowsOf(file).filter((l) => l.conn).every((l) => Object.keys(l).length === 1 && Object.keys(l.conn).join() === "host,port"));
});

// A FastAPI turn that writes out through httpx, requests and aiohttp (once by a whole address, once
// by a path under the session's base address) to a host off this machine, which its own lookup sends
// to a fake provider here, and calls a model both ways.
const HELD_APP = `
import json, os, socket
import aiohttp, httpx, requests
from fastapi import FastAPI, Request

real = socket.getaddrinfo
name = lambda host: host.decode() if isinstance(host, bytes) else str(host)
socket.getaddrinfo = lambda host, *a, **k: real("127.0.0.1" if name(host).endswith("provider.test") else host, *a, **k)
app = FastAPI()
BASE = "http://hooks.provider.test:%s" % os.environ["FAKE_PORT"]
URL = BASE + "/notify"

@app.post("/api/chat")
async def chat(request: Request):
    headers = {"authorization": (await request.json()).get("auth") or "Bearer live_key_1234"}
    out = {"httpx": (await httpx.AsyncClient().post(URL, json={"via": "httpx"}, headers=headers)).json(),
           "requests": requests.post(URL, json={"via": "requests"}, headers=headers).json()}
    async with aiohttp.ClientSession() as s:
        async with s.post(URL, json={"via": "aiohttp"}, headers=headers) as r:
            out["aiohttp"] = json.loads(await r.text())
    async with aiohttp.ClientSession(base_url=BASE) as s:
        async with s.post("/notify", json={"via": "aiohttp-base"}, headers=headers) as r:
            out["aiohttp-base"] = json.loads(await r.text())
    async with aiohttp.ClientSession(base_url="https://api.openai.com") as s:
        try:
            async with s.post("/v1/chat/completions", json={"messages": []}, timeout=aiohttp.ClientTimeout(total=3)) as r:
                await r.read()
        except Exception:
            pass
    try:
        requests.post("https://api.openai.com/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]}, timeout=3)
    except Exception:
        pass
    return out
`;

test("FastAPI: a trial's writes through httpx, requests and aiohttp are held and answered in the app, named by host alone; the person's, a test key's and a model call by a base address pass", { skip, timeout: 60_000 }, async () => {
  const { createServer } = await import("node:http");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pyheld-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "held_app.py"), HELD_APP);
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push(JSON.parse(b).via); res.end("{}"); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const child = spawn(PY, ["-m", "uvicorn", "held_app:app", "--port", "4331", "--app-dir", dir], {
    env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_OUTBOUND_FILE: join(dir, "outbound.json"), FAKE_PORT: String(fake.address().port) }, stdio: "ignore",
  });
  try {
    assert.ok(await up(4331));
    const turn = (tag, body = {}) => fetch("http://127.0.0.1:4331/api/chat", { method: "POST", headers: { "content-type": "application/json", ...(tag ? { "x-cortad-turn": tag } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
    const trial = await turn("t1:1");
    for (const via of ["httpx", "requests", "aiohttp", "aiohttp-base"]) {
      assert.match(trial[via].id, /^cortad-held-\d+$/, via);
      assert.equal(trial[via].via, via, "shaped like what the app sent");
    }
    assert.deepEqual(arrived, [], "nothing a trial wrote left the app");
    await turn(null);
    assert.deepEqual(arrived.sort(), ["aiohttp", "aiohttp-base", "httpx", "requests"], "the person's own request goes out as sent");
    await turn("t2:1", { auth: "Bearer sk_test_51Habc" });
    assert.equal(arrived.length, 8, "a test key goes to the provider's sandbox");
    await new Promise((r) => setTimeout(r, 300));
    const rows = rowsOf(file);
    const held = rows.filter((r) => r.dep?.held);
    assert.deepEqual(held.map((r) => `${r.dep.turn} ${r.dep.called[0].name}`), Array(4).fill("t1:1 POST hooks.provider.test"));
    assert.deepEqual(held.map((r) => JSON.parse(r.dep.called[0].arguments).via).sort(), ["aiohttp", "aiohttp-base", "httpx", "requests"]);
    assert.ok(!readFileSync(file, "utf8").includes("live_key_1234"), "no header value is written");
    assert.ok(rows.some((r) => r.call?.host === "api.openai.com" && r.call.turn === "t1:1"), "a model call is never held");
  } finally { child.kill("SIGKILL"); fake.close(); }
});

// A WhatsApp bot's shape: the webhook queues the message and answers at once; a worker started at
// boot sends the reply later through requests on a thread and httpx, outside every request.
const QUEUE_APP = `
import asyncio, os, socket
import httpx, requests
from fastapi import FastAPI

real = socket.getaddrinfo
name = lambda host: host.decode() if isinstance(host, bytes) else str(host)
socket.getaddrinfo = lambda host, *a, **k: real("127.0.0.1" if name(host).endswith("provider.test") else host, *a, **k)
URL = "http://wa.provider.test:%s/send" % os.environ["FAKE_PORT"]
INBOX = asyncio.Queue()

async def worker():
    while True:
        to = await INBOX.get()
        await asyncio.to_thread(requests.post, URL, json={"to": to, "via": "requests"})
        async with httpx.AsyncClient() as c:
            await c.post(URL, json={"to": to, "via": "httpx"})

app = FastAPI()

@app.on_event("startup")
async def boot():
    asyncio.create_task(worker())

@app.post("/api/simulate")
async def simulate(body: dict):
    await INBOX.put(body["to"])
    return {"ok": True}
`;

test("FastAPI: a worker's writes outside every request go out before a run and are held while one is live", { skip, timeout: 60_000 }, async () => {
  const { createServer } = await import("node:http");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pyqueue-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "queue_app.py"), QUEUE_APP);
  const arrived = [];
  const fake = createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { arrived.push(JSON.parse(b).to); res.end("{}"); }); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const child = spawn(PY, ["-m", "uvicorn", "queue_app:app", "--port", "4333", "--app-dir", dir], {
    env: { ...process.env, PYTHONPATH: HOOK, CORTAD_TRACE_FILE: file, CORTAD_OUTBOUND_FILE: join(dir, "outbound.json"), FAKE_PORT: String(fake.address().port) }, stdio: "ignore",
  });
  const send = (tag, to) => fetch("http://127.0.0.1:4333/api/simulate", { method: "POST", headers: { "content-type": "application/json", ...(tag ? { "x-cortad-turn": tag } : {}) }, body: JSON.stringify({ to }) });
  const settle = () => new Promise((r) => setTimeout(r, 800));
  try {
    assert.ok(await up(4333));
    await send(null, "person");
    await settle();
    assert.deepEqual(arrived, ["person", "person"], "no run yet: the person's queued sends go out");
    await send("t1:1", "trial");
    await settle();
    await send(null, "person-during-run");
    await settle();
    assert.equal(arrived.length, 2, "while a run is live, nothing a worker writes leaves the app");
    const held = rowsOf(file).filter((r) => r.dep?.held);
    assert.deepEqual(held.map((r) => JSON.parse(r.dep.called[0].arguments).to), ["trial", "trial", "person-during-run", "person-during-run"]);
    assert.ok(held.every((r) => r.dep.host === "wa.provider.test" && r.dep.turn === undefined));
  } finally { child.kill("SIGKILL"); fake.close(); }
});
