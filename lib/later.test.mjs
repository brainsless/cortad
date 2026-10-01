import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeOf, projectOf } from "./home.mjs";

// gemnex-whatsapp-agent: a bot whose webhook puts the message on a queue and answers {"ok":true} at
// once, while a worker started at boot asks its model three times (plan, analyze, respond) and sends
// the last answer on. No request ever carried the answer, so the endpoint was never proven. Here the
// whole command runs against apps of that shape, in Node and in FastAPI, each door one way such an app
// is written, with a model server of the test's that answers each step in its own words, and a
// stand-in for our API that hands the command its jobs, as the bus does, and keeps what comes back.
//   /api/simulate  a worker started at boot, three steps
//   /api/drain     a loop the first webhook starts, which keeps that request's context for later ones
//   /api/history   the webhook saves the message to the sender's history, which the answer's prompt carries
//   /api/tool      the model asks for a tool, the tool takes six seconds, then the model answers
//   /api/jobs      a receipt, and the answer fetched on a second request well after the model is done
//   /api/sync      answers in its own reply; a person whose client leaves before it does
//   /api/log       a worker that never asks a model
//   /api/messages  saves the message only; /api/chat answers the conversation, then titles it
//   /api/inbox/:s  a long read of the sender's inbox, held open by the person's own page
//   /api/early     starts the work without waiting on it, then answers {"status":"ok"}
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "..", "local.mjs");
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (done, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await done()) return true; return done(); };

const NODE_APP = (port) => `
  const http = require("node:http");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ask = (step, words) => fetch(process.env.MODEL_URL, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "system", content: "Step: " + step }, { role: "user", content: words }] }) })
    .then((r) => r.json()).then((j) => (j.choices ? j.choices[0].message.content || "" : ""));
  const worker = (work) => {
    const queue = [];
    let wake = null;
    (async () => { for (;;) { if (!queue.length) await new Promise((r) => { wake = r; }); await work(queue.shift()); } })();
    return (m) => { queue.push(m); if (wake) { const w = wake; wake = null; w(); } };
  };
  const history = new Map(), results = new Map(), saved = [];
  const handle = (text) => ask("respond", text);
  let jobs = 0;
  const doors = {
    "/api/simulate": worker(async ({ text }) => { const plan = await ask("plan", text); const analysis = await ask("analyze", text + "\\n" + plan); await ask("respond", text + "\\n" + analysis); }),
    "/api/history": worker(async ({ sender, text }) => { await ask("plan", text); await ask("respond", text + "\\n" + (history.get(sender) || []).join("\\n")); }),
    "/api/tool": worker(async ({ text }) => { await ask("toolplan", text); await sleep(6000); await ask("respond", text); }),
    "/api/jobs": worker(async ({ id, text }) => { results.set(id, await ask("respond", text)); }),
    "/api/log": worker(async () => {}),
  };
  const drainQueue = [];
  let draining = false;
  async function drain() {
    draining = true;
    while (drainQueue.length) { const { text } = drainQueue.shift(); const plan = await ask("plan", text); await ask("respond", text + "\\n" + plan); }
    draining = false;
  }
  http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/api/inbox/")) return setTimeout(() => res.end(JSON.stringify({ messages: [] })), 4000);
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      const m = JSON.parse(body || "{}");
      if (req.url === "/api/messages") { saved.push(m.text); return res.end(JSON.stringify({ id: "msg_" + (100000 + saved.length) })); }
      if (req.url === "/api/chat") {
        const answer = await ask("respond", saved.join("\\n"));
        res.end(JSON.stringify({ reply: answer }));
        return ask("title", saved.join("\\n"));
      }
      if (req.url === "/api/early") { handle(m.text); await sleep(50); return res.end(JSON.stringify({ status: "ok" })); }
      if (!doors[req.url] && !["/api/drain", "/api/sync"].includes(req.url) && !req.url.startsWith("/api/jobs/")) return res.end("{}");
      if (req.url.startsWith("/api/jobs/")) { const id = req.url.split("/").pop(); return res.end(JSON.stringify(results.has(id) ? { reply: results.get(id) } : { id, status: "pending" })); }
      if (req.url === "/api/sync") { await sleep(1500); return res.end(JSON.stringify({ reply: await ask("respond", m.text) })); }
      if (req.url === "/api/jobs") { m.id = "job-" + ++jobs + "0001"; doors[req.url](m); return res.end(JSON.stringify({ jobId: m.id })); }
      if (req.url === "/api/history") history.set(m.sender, [...(history.get(m.sender) || []), m.text]);
      if (req.url === "/api/drain") drainQueue.push(m); else doors[req.url](m);
      res.end(JSON.stringify({ ok: true }));
      if (req.url === "/api/drain" && !draining) drain();
    });
  }).listen(${port}, "127.0.0.1");
`;

const PY_APP = `
import asyncio, os
import httpx
from fastapi import BackgroundTasks, FastAPI

MODEL = os.environ["MODEL_URL"]
app = FastAPI()
HISTORY, RESULTS, DRAIN, QUEUES, JOBS, SAVED = {}, {}, [], {}, [0], []
DRAINING = [False]

def body(step, words):
    return {"model": "fake-model", "messages": [{"role": "system", "content": "Step: " + step}, {"role": "user", "content": words}]}

def words_of(got):
    return (got["choices"][0]["message"]["content"] or "") if "choices" in got else ""

async def ask(step, words):
    async with httpx.AsyncClient() as c:
        return words_of((await c.post(MODEL, json=body(step, words))).json())

def pipeline(text):
    with httpx.Client() as c:
        plan = words_of(c.post(MODEL, json=body("plan", text)).json())
        analysis = words_of(c.post(MODEL, json=body("analyze", text + "\\n" + plan)).json())
        return words_of(c.post(MODEL, json=body("respond", text + "\\n" + analysis)).json())

async def simulate(m):
    await asyncio.to_thread(pipeline, m["text"])

async def history(m):
    await ask("plan", m["text"])
    await ask("respond", m["text"] + "\\n" + "\\n".join(HISTORY.get(m["sender"], [])))

async def tool(m):
    await ask("toolplan", m["text"])
    await asyncio.sleep(6)
    await ask("respond", m["text"])

async def jobs(m):
    RESULTS[m["id"]] = await ask("respond", m["text"])

async def log(m):
    pass

WORK = {"/api/simulate": simulate, "/api/history": history, "/api/tool": tool, "/api/jobs": jobs, "/api/log": log}

async def worker(queue, work):
    while True:
        await work(await queue.get())

@app.on_event("startup")
async def boot():
    for path, work in WORK.items():
        QUEUES[path] = asyncio.Queue()
        asyncio.create_task(worker(QUEUES[path], work))

async def drain():
    DRAINING[0] = True
    while DRAIN:
        text = DRAIN.pop(0)["text"]
        plan = await ask("plan", text)
        await ask("respond", text + "\\n" + plan)
    DRAINING[0] = False

@app.get("/api/inbox/{sender}")
async def inbox(sender: str):
    await asyncio.sleep(4)
    return {"messages": []}

@app.post("/api/messages")
async def message(m: dict):
    SAVED.append(m["text"])
    return {"id": "msg_%d" % (100000 + len(SAVED))}

@app.post("/api/chat")
async def chat(m: dict, tasks: BackgroundTasks):
    tasks.add_task(ask, "title", "\\n".join(SAVED))
    return {"reply": await ask("respond", "\\n".join(SAVED))}

@app.post("/api/early")
async def early(m: dict):
    asyncio.create_task(ask("respond", m["text"]))
    await asyncio.sleep(0.05)
    return {"status": "ok"}

@app.get("/api/jobs/{id}")
async def job(id: str):
    return {"reply": RESULTS[id]} if id in RESULTS else {"id": id, "status": "pending"}

@app.post("/api/sync")
async def sync(m: dict):
    await asyncio.sleep(1.5)
    return {"reply": await ask("respond", m["text"])}

@app.post("/api/jobs")
async def job_asked(m: dict):
    JOBS[0] += 1
    m["id"] = "job-%d0001" % JOBS[0]
    await QUEUES["/api/jobs"].put(m)
    return {"jobId": m["id"]}

@app.post("/api/drain")
async def drain_asked(m: dict):
    DRAIN.append(m)
    if not DRAINING[0]:
        asyncio.create_task(drain())
    return {"ok": True}

def webhook(path):
    async def took(m: dict):
        if path == "/api/history":
            HISTORY.setdefault(m["sender"], []).append(m["text"])
        await QUEUES[path].put(m)
        return {"ok": True}
    app.post(path)(took)

for path in ("/api/simulate", "/api/history", "/api/tool", "/api/log"):
    webhook(path)
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
    await sleep(300);
    res.setHeader("content-type", "application/json");
    if (words.includes("overloaded")) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: "the model is overloaded" } })); }
    if (step === "toolplan") return res.end(JSON.stringify({ model: "fake-model", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }));
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
  const post = (path, body, signal) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  // A run's request, the way the backend sends one to a door answered later, and when it came back.
  // `runMs`: the run's own wait for this reply, which the wire is held 15 seconds past.
  const ask = async (path, turn, text, runMs = 60_000) => {
    const sent = Date.now();
    const waitMs = runMs + 15_000;
    const id = give({ port, path, method: "POST", headers: { "content-type": "application/json", "x-cortad-turn": turn, "x-cortad-answer": String(runMs) }, body: JSON.stringify({ sender: "966500000002", text }), waitMs });
    assert.ok(await until(() => results.has(id), waitMs), out);
    return { ...results.get(id), after: Date.now() - sent };
  };
  const exited = once(child, "exit");
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
    for (const s of [api, model]) { s.closeAllConnections(); s.close(); }
  };
  return { post, get, ask, proofs, out: () => out, stop };
}

const proven = (proofs, path) => proofs.filter((p) => p.door.path === path).at(-1);
const replyOf = (got) => JSON.parse(got.body).reply;

// One app under the command for each language, its doors driven one test at a time.
function answersLater(files, start) {
  let c;
  before(async () => {
    c = await connected(files, start);
    assert.ok(await until(() => /your app is answering on port/.test(c.out()), 60_000), c.out());
  });
  after(() => c?.stop());
  const second = (path, turn, text) => sleep(150).then(() => c.ask(path, turn, text));

  test("the agent's own request proves the door as answered later, in the time its model took", async () => {
    const said = await c.post("/api/simulate", { sender: "966500000001", text: "هل الطلب رقم ٧ جاهز للتسليم اليوم؟" });
    assert.deepEqual(await said.json(), { ok: true }, "the app took the message and answered at once");
    assert.ok(await until(() => proven(c.proofs, "/api/simulate"), 20_000), `the agent's own request proved the door\n${c.out()}`);
    const door = proven(c.proofs, "/api/simulate");
    assert.deepEqual([door.proof.later, door.proof.modelCalls, door.proof.fallback], [true, 3, undefined]);
    assert.equal(door.sample.reply, "respond: about هل الطلب رقم ٧ جاهز للتسليم اليوم؟", "the reply is the model's last answer");
    assert.ok(door.proof.replySeconds < 3, `the reply time is the model's, never our settle: ${door.proof.replySeconds}`);
  });

  test("a trial through the fetch verb gets the model's last answer, one whose model failed says so, and the canary passes", async () => {
    const trial = await c.ask("/api/simulate", "case-1:1", "Where is my parcel going next week?");
    assert.deepEqual([trial.status, replyOf(trial)], [200, "respond: about Where is my parcel going next week?"]);
    const failed = await c.ask("/api/simulate", "case-2:1", "Is the model overloaded today?");
    assert.deepEqual([failed.status, JSON.parse(failed.body), JSON.parse(failed.headers["x-cortad-later"])], [200, { ok: true }, { model: 500 }], "never the app's receipt as its reply");
    // The canary's three requests (backend src/local/canary.ts) through the same door.
    const fact = "Please note my order number is ZQ12345678 for later.";
    const question = "Which order number did I give you earlier?";
    for (const [turn, text] of [["canary:7:a:1", fact], ["canary:7:a:2", question], ["canary:7:b:1", question]]) assert.equal((await c.ask("/api/simulate", turn, text)).status, 200);
    assert.ok(await until(() => proven(c.proofs, "/api/simulate")?.proof.canary, 10_000), "the canary through the door is judged");
    assert.deepEqual(proven(c.proofs, "/api/simulate").proof.canary, { n: 7, passed: true, problems: [] });
  });

  test("two trials through a loop the first one started, which keeps its context, each get their own answer", async () => {
    const [a, b] = await Promise.all([c.ask("/api/drain", "drain-1:1", "Where is my parcel going this weekend?"), second("/api/drain", "drain-2:1", "Can I change the colour of my order?")]);
    assert.deepEqual([replyOf(a), replyOf(b)], ["respond: about Where is my parcel going this weekend?", "respond: about Can I change the colour of my order?"]);
  });

  test("two trials sharing a sender whose history the prompt carries: the next message never takes this one's answer", async () => {
    const [a, b] = await Promise.all([c.ask("/api/history", "history-1:1", "Where is my parcel going next month?"), second("/api/history", "history-2:1", "Can I change the size of my order?")]);
    assert.deepEqual([replyOf(a), replyOf(b)], ["respond: about Where is my parcel going next month?", "respond: about Can I change the size of my order?"]);
  });

  test("a tool slower than the settle between two model calls is waited through, never read as a failed model", async () => {
    const got = await c.ask("/api/tool", "tool-1:1", "What does my warranty cover exactly?");
    assert.deepEqual([got.headers["x-cortad-later"], replyOf(got)], [undefined, "respond: about What does my warranty cover exactly?"]);
  });

  test("a receipt whose answer is fetched well after the model is done keeps the second-step shape", async () => {
    const receipt = await (await c.post("/api/jobs", { sender: "966500000001", text: "Summarise my last three orders please." })).json();
    await sleep(7000);
    assert.deepEqual(await (await c.get(`/api/jobs/${receipt.jobId}`)).json(), { reply: "respond: about Summarise my last three orders please." });
    assert.ok(await until(() => proven(c.proofs, "/api/jobs")?.proof.answer, 10_000), c.out());
    assert.deepEqual([proven(c.proofs, "/api/jobs").proof.later, proven(c.proofs, "/api/jobs").proof.answer.method], [undefined, "GET"]);
  });

  test("a client that left before an endpoint answered in its own reply never makes it one answered later", async () => {
    await c.post("/api/sync", { sender: "966500000001", text: "Which store is nearest to me today?" }, AbortSignal.timeout(400)).catch(() => {});
    await sleep(7000);
    await c.post("/api/sync", { sender: "966500000001", text: "Which store is open late tonight?" });
    assert.ok(await until(() => proven(c.proofs, "/api/sync"), 10_000), c.out());
    await sleep(1500);
    assert.deepEqual(c.proofs.filter((p) => p.door.path === "/api/sync").map((p) => p.proof.later), c.proofs.filter((p) => p.door.path === "/api/sync").map(() => undefined));
  });

  test("a chat that answered with its own model call keeps the title it writes after its reply; the message it saved is never answered later", async () => {
    await c.post("/api/messages", { sender: "966500000001", text: "Where is my order number five going?" });
    assert.equal((await (await c.post("/api/chat", { conversationId: "conv_123456" })).json()).reply, "respond: about Where is my order number five going?");
    await sleep(7000);
    assert.ok(proven(c.proofs, "/api/chat"), c.out());
    assert.deepEqual([proven(c.proofs, "/api/messages"), proven(c.proofs, "/api/chat").proof.later], [undefined, undefined]);
  });

  test("a read of the sender held open after one trial was answered never takes the next trial's answer", async () => {
    const first = await c.ask("/api/simulate", "inbox-1:1", "Is my parcel insured on the way?");
    assert.equal(replyOf(first), "respond: about Is my parcel insured on the way?");
    const read = c.get("/api/inbox/966500000002");
    await sleep(300);
    const next = await c.ask("/api/simulate", "inbox-2:1", "Can the courier leave it with a neighbour?");
    await read;
    assert.equal(replyOf(next), "respond: about Can the courier leave it with a neighbour?");
  });

  test("a read of the sender opened while the next trial's answer is being written never loses that answer", async () => {
    const first = await c.ask("/api/simulate", "inbox-3:1", "Is my parcel covered against damage?");
    assert.equal(replyOf(first), "respond: about Is my parcel covered against damage?");
    const next = c.ask("/api/simulate", "inbox-4:1", "Can the courier ring the bell twice?");
    await sleep(450);
    const read = c.get("/api/inbox/966500000002");
    assert.equal(replyOf(await next), "respond: about Can the courier ring the bell twice?");
    await read;
  });

  test("work started without waiting on it, before a reply that only says ok, is answered later by the model", async () => {
    assert.deepEqual(await (await c.post("/api/early", { sender: "966500000001", text: "Where is my parcel going by Friday?" })).json(), { status: "ok" });
    assert.ok(await until(() => proven(c.proofs, "/api/early"), 10_000), c.out());
    const door = proven(c.proofs, "/api/early");
    assert.deepEqual([door.proof.later, door.sample.reply], [true, "respond: about Where is my parcel going by Friday?"]);
  });

  test("a worker that never asks a model is not proven, and a trial's wait ends and says so before the run's own", async () => {
    await c.post("/api/log", { sender: "966500000001", text: "a note the worker keeps and never shows a model" });
    const none = await c.ask("/api/log", "case-3:1", "Another note for the log only.", 12_000);
    assert.deepEqual([JSON.parse(none.body), Object.keys(JSON.parse(none.headers["x-cortad-later"] ?? "{}"))], [{ ok: true }, ["waited"]]);
    assert.ok(none.after < 12_000, `the reason reached the run before its own wait ran out: ${none.after} ms`);
    await sleep(6000);
    assert.equal(proven(c.proofs, "/api/log"), undefined);
  });
}

describe("answered later", { concurrency: true }, () => {
  describe("Node", { concurrency: 1, timeout: 300_000 }, () => answersLater((port) => ({ "package.json": JSON.stringify({ name: "later", version: "1.0.0" }), "app.js": NODE_APP(port) }), () => `"${process.execPath}" app.js`));
  describe("FastAPI, with model calls on a thread, on the worker's task and on a task the handler started", { skip: !existsSync(PY), concurrency: 1, timeout: 300_000 }, () =>
    answersLater(() => ({ "pyproject.toml": '[project]\nname = "later"\nversion = "0.1.0"\n', "queue_app.py": PY_APP }), (port) => `"${PY}" -m uvicorn queue_app:app --port ${port}`));
});
