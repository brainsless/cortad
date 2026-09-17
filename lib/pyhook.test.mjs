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
    const rows = lines.filter((l) => !l.hello);
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
    const rows = rowsOf(file).filter((l) => !l.hello);
    assert.equal(rows.length, 1);
    assert.equal(`${rows[0].method} ${rows[0].path}`, "POST /helper/reply");
    assert.equal(rows[0].headers.cookie, "sid=flask-cookie");
    assert.match(rows[0].sent, /hello from flask/);
  } finally { child.kill("SIGKILL"); }
});
