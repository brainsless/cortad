import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// gemnex-whatsapp-agent: a bot whose webhook puts the message on a queue and answers {"ok":true} at
// once, while a worker started at boot asks its model three times (plan, analyze, respond) and sends
// the last answer on. No request ever carried the answer, so the endpoint was never proven. Here the
// whole command runs against the same shape of app, in Node and in FastAPI, with a model server of
// the test's that answers each step in its own words, and a stand-in for our API that hands the
// command its jobs, as the bus does, and keeps what comes back. POST /api/log queues too, and its
// worker never asks a model.
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

const NODE_APP = (port) => `
  const http = require("node:http");
  const ask = (step, words) => fetch(process.env.MODEL_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "system", content: "Step: " + step }, { role: "user", content: words }] }) })
    .then((r) => r.json()).then((j) => (j.choices ? j.choices[0].message.content : ""));
  const inbox = [], logs = [], sent = [];
  let wake = null;
  (async function worker() {
    for (;;) {
      if (!inbox.length) await new Promise((r) => { wake = r; });
      const { sender, text } = inbox.shift();
      const plan = await ask("plan", text);
      const analysis = await ask("analyze", text + "\\n" + plan);
      sent.push({ sender, reply: await ask("respond", text + "\\n" + analysis) });
    }
  })();
  setInterval(() => { while (logs.length) sent.push(logs.shift()); }, 50);
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (req.url === "/api/simulate") { inbox.push(msg); if (wake) { const w = wake; wake = null; w(); } }
      else logs.push(msg);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  }).listen(${port}, "127.0.0.1");
`;

const PY_APP = `
import asyncio, os
import httpx
from fastapi import FastAPI

MODEL = os.environ["MODEL_URL"]
INBOX, LOGS, SENT = asyncio.Queue(), asyncio.Queue(), []

def pipeline(text):
    with httpx.Client() as c:
        def ask(step, words):
            got = c.post(MODEL, json={"model": "fake-model", "messages": [{"role": "system", "content": "Step: " + step}, {"role": "user", "content": words}]}).json()
            return got["choices"][0]["message"]["content"] if "choices" in got else ""
        plan = ask("plan", text)
        analysis = ask("analyze", text + "\\n" + plan)
        return ask("respond", text + "\\n" + analysis)

async def worker():
    while True:
        sender, text = await INBOX.get()
        SENT.append((sender, await asyncio.to_thread(pipeline, text)))

async def chores():
    while True:
        SENT.append(await LOGS.get())

app = FastAPI()

@app.on_event("startup")
async def boot():
    asyncio.create_task(worker())
    asyncio.create_task(chores())

@app.post("/api/simulate")
async def simulate(body: dict):
    await INBOX.put((body["sender"], body["text"]))
    return {"ok": True}

@app.post("/api/log")
async def log(body: dict):
    await LOGS.put(body)
    return {"ok": True}
`;

async function listening(handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

// The command, started on an app written into a fresh folder, and the stand-in for our API.
async function connected(files, start) {
  const model = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const { messages } = JSON.parse(body);
    const step = messages[0].content.replace("Step: ", "");
    const words = messages.at(-1).content.split("\n")[0];
    res.setHeader("content-type", "application/json");
    if (words.includes("overloaded")) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "the model is overloaded" } })); }
    res.end(JSON.stringify({ model: "fake-model", choices: [{ message: { role: "assistant", content: `${step}: about ${words}` } }], usage: { prompt_tokens: 9, completion_tokens: 4 } }));
  });
  const queued = [];
  const results = new Map();
  const proofs = [];
  const api = await listening(async (req, res) => {
    let body = "";
    for await (const d of req) body += d;
    const reply = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/local/attach") return reply({ box: "lo_000000000000000000000003", key: "k" });
    if (req.url.includes("/tree")) return reply({ id: "c", resumed: true });
    if (req.url.endsWith("/app")) return reply({ jobId: "raise" });
    if (req.url.endsWith("/proof")) { proofs.push(JSON.parse(body)); return reply({ ok: true }); }
    const done = /\/jobs\/([\w-]+)$/.exec(req.url);
    if (done) { results.set(done[1], JSON.parse(body || "{}")); return reply({ ok: true }); }
    if (req.url.includes("/jobs")) { await until(() => queued.length > 0, 500); return reply({ jobs: queued.splice(0) }); }
    reply({ ok: true });
  });
  let n = 0;
  const give = (body) => { const id = `j${++n}`; queued.push({ id, verb: "fetch", body }); return id; };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortad-later-")));
  const probe = await listening(() => {});
  const port = probe.address().port;
  probe.close();
  for (const [name, text] of Object.entries(files(port))) writeFileSync(join(root, name), text);
  const home = mkdtempSync(join(tmpdir(), "cortad-later-home-"));
  mkdirSync(homeOf(projectOf(root), join(home, ".cortad")), { recursive: true });
  writeFileSync(join(homeOf(projectOf(root), join(home, ".cortad")), "token"), "machine-key");
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: tmpdir(), MODEL_URL: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, CORTAD_ORIGIN: `http://127.0.0.1:${api.address().port}` };
  const child = spawn(process.execPath, [LOCAL, "--token", "--start", start(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const exited = once(child, "exit");
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
    for (const s of [api, model]) { s.closeAllConnections(); s.close(); }
  };
  return { port, give, results, proofs, post, out: () => out, stop };
}

const proven = (proofs, path) => proofs.filter((p) => p.door.path === path).at(-1);

async function answersLater(files, start) {
  const c = await connected(files, start);
  try {
    assert.ok(await until(() => /your app is answering on port/.test(c.out()), 60_000), c.out());
    const said = await c.post("/api/simulate", { sender: "966500000001", text: "هل الطلب رقم ٧ جاهز للتسليم اليوم؟" });
    assert.deepEqual(await said.json(), { ok: true }, "the app took the message and answered at once");
    assert.ok(await until(() => proven(c.proofs, "/api/simulate"), 20_000), `the agent's own request proved the door\n${c.out()}`);
    const door = proven(c.proofs, "/api/simulate");
    assert.equal(door.proof.later, true, "marked as answered later, by the model");
    assert.equal(door.proof.modelCalls, 3);
    assert.equal(door.proof.fallback, undefined);
    assert.equal(door.sample.reply, "respond: about هل الطلب رقم ٧ جاهز للتسليم اليوم؟", "the reply is the model's last answer");

    // A run's request, the way the backend sends one to a door answered later.
    const ask = async (path, turn, text, waitMs = 60_000) => {
      const id = c.give({ port: c.port, path, method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn, "x-cortad-answer": "later" }, body: JSON.stringify({ sender: "966500000002", text }), waitMs });
      assert.ok(await until(() => c.results.has(id), 30_000), c.out());
      return c.results.get(id);
    };
    const trial = await ask("/api/simulate", "case-1:1", "Where is my parcel going next week?");
    assert.equal(trial.status, 200);
    assert.deepEqual(JSON.parse(trial.body), { reply: "respond: about Where is my parcel going next week?" }, "a trial's reply is the model's last answer in its turn");

    const failed = await ask("/api/simulate", "case-2:1", "Is the model overloaded today?");
    assert.deepEqual([failed.status, JSON.parse(failed.body), JSON.parse(failed.headers["x-cortad-later"])], [200, { ok: true }, { model: 500 }], "a turn whose model gave no words says so, never the app's receipt as its reply");

    // The canary's three requests (backend src/local/canary.ts) through the same door.
    const fact = "Please note my order number is ZQ12345678 for later.";
    const question = "Which order number did I give you earlier?";
    for (const [turn, text] of [["canary:7:a:1", fact], ["canary:7:a:2", question], ["canary:7:b:1", question]]) assert.equal((await ask("/api/simulate", turn, text)).status, 200);
    assert.ok(await until(() => proven(c.proofs, "/api/simulate")?.proof.canary, 10_000), "the canary through the door is judged");
    assert.deepEqual(proven(c.proofs, "/api/simulate").proof.canary, { n: 7, passed: true, problems: [] });

    await c.post("/api/log", { sender: "966500000001", text: "a note the worker keeps and never shows a model" });
    const none = await ask("/api/log", "case-3:1", "Another note for the log only.", 8_000);
    assert.deepEqual([JSON.parse(none.body), JSON.parse(none.headers["x-cortad-later"])], [{ ok: true }, { waited: 5 }], "no model answered within the wait, and the reply says so");
    await sleep(6000);
    assert.equal(proven(c.proofs, "/api/log"), undefined, "a door whose worker never calls the model is not proven");
  } finally {
    await c.stop();
  }
}

test("Node: an endpoint answered later from a queue is proven by the agent's request, and a trial through the fetch verb gets the model's last answer", { timeout: 180_000 }, () =>
  answersLater((port) => ({ "package.json": JSON.stringify({ name: "later", version: "1.0.0" }), "app.js": NODE_APP(port) }), () => `"${process.execPath}" app.js`));

test("FastAPI: the same, with the worker's model calls made on a thread", { skip: !existsSync(PY), timeout: 180_000 }, () =>
  answersLater(() => ({ "pyproject.toml": '[project]\nname = "later"\nversion = "0.1.0"\n', "queue_app.py": PY_APP }), (port) => `"${PY}" -m uvicorn queue_app:app --port ${port}`));
