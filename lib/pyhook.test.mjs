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

test("FastAPI: the request that called a model is written down, with body and sign-in", { skip }, async () => {
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
    const rows = lines.filter((l) => !l.hello && !l.call && !l.listen && !l.routes);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /v2/assist");
    assert.deepEqual(JSON.parse(rows[0].body), { prompt: "hello from python", thread: 3 });
    assert.equal(rows[0].headers["x-session"], "py-session-only-they-have");
    assert.match(rows[0].sent, /hello from python/);
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
    const rows = rowsOf(file).filter((l) => !l.hello && !l.call && !l.listen && !l.routes);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /helper/reply");
    assert.equal(rows[0].headers.cookie, "sid=flask-cookie");
    assert.match(rows[0].sent, /hello from flask/);
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
