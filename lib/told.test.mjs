import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeCapture } from "./replay.mjs";

// Two recorded turns of one conversation, the app holding the history: the second turn's prompt
// resends the person's first message. Between the turns forty other requests arrive, as they do
// when trials run side by side, and the first message must still read as the person's.
const FIXTURE = new URL("./hook-fixture.json", import.meta.url).pathname;
const fx = JSON.parse(readFileSync(FIXTURE, "utf8")).told;
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const OTHERS = 40;

async function conversation(port) {
  const post = (body, turn) => fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", headers: { "content-type": "application/json", ...(turn ? { "x-cortad-turn": turn } : {}) }, body: JSON.stringify(body) }).then((r) => r.text());
  await post(fx.turns[0].asked, fx.turns[0].tag);
  for (let i = 0; i < OTHERS; i++) await post({ message: `another shopper asks where parcel number ${i} is` });
  await post(fx.turns[1].asked, fx.turns[1].tag);
  await new Promise((r) => setTimeout(r, 400));
}

function toldAsRecorded(calls) {
  for (const turn of fx.turns) {
    const call = calls.find((c) => c.model === turn.sent.model);
    assert.equal(call?.turn, turn.tag);
    assert.equal(call.instructions, fx.instructions, `${turn.tag}: the system prompt and the reminder block, in prompt order`);
    assert.deepEqual(call.offered, fx.offered);
    assert.deepEqual(call.declared, fx.declared, `${turn.tag}: what each tool does and the inputs it requires, as the call declared them`);
    for (const said of fx.turns.map((t) => t.asked.message)) assert.ok(!call.instructions.includes(said), `${turn.tag}: the person's words are never told as the app's`);
  }
}

// The provider runs in a process of its own, as a real one does: a request the hooked process
// receives is someone speaking to the app.
const PROVIDER = `
const fx = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8")).told;
require("node:http").createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": fx.type }); res.end(fx.reply); }); })
  .listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
const NODE_APP = `
const http = require("node:http");
const fx = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8")).told;
const base = "http://127.0.0.1:" + process.env.PROVIDER_PORT;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const turn = fx.turns.find((t) => t.asked.message === JSON.parse(body).message);
    if (turn) await (await fetch(base + fx.path, { method: "POST", body: JSON.stringify(turn.sent) })).text();
    res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
`;
const portOf = (child) => new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));

test("Node: a model call says what the app told its model, never the person's words, and the command hands it on for the turn asked about", async () => {
  const dir = mkdtempSync(join(tmpdir(), "told-"));
  writeFileSync(join(dir, "app.cjs"), NODE_APP);
  const capture = makeCapture({ work: dir, keepSecret: () => {} });
  const provider = spawn(process.execPath, ["-e", PROVIDER], { stdio: ["ignore", "pipe", "inherit"] });
  let child;
  try {
    child = spawn(process.execPath, [join(dir, "app.cjs")], { cwd: dir, env: { ...process.env, ...capture.env(process.env), PROVIDER_PORT: String(await portOf(provider)) }, stdio: ["ignore", "pipe", "inherit"] });
    await conversation(await portOf(child));
  } finally { child?.kill(); provider.kill(); }
  toldAsRecorded(rowsOf(join(dir, "trace.jsonl")).filter((l) => l.call).map((l) => l.call));

  const [first, second] = fx.turns.map((t) => t.tag);
  const asked = capture.usage(second).rows;
  assert.equal(asked.find((r) => r.turn === second)?.instructions, fx.instructions);
  assert.deepEqual(asked.find((r) => r.turn === second)?.declared, fx.declared);
  assert.equal(asked.find((r) => r.turn === first)?.instructions, undefined, "another turn's calls stay as they were");
  assert.ok(capture.usage().rows.every((r) => r.instructions === undefined && r.declared === undefined), "a report for no turn carries no instructions");
});

const PY_APP = `
import json, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx
from fastapi import FastAPI, Request

fx = json.load(open(${JSON.stringify(FIXTURE)}))["told"]

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        raw = fx["reply"].encode()
        self.send_response(200)
        self.send_header("content-type", fx["type"])
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a):
        pass

server = HTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % server.server_port
app = FastAPI()

@app.post("/chat")
async def chat(request: Request):
    asked = await request.json()
    turn = next((t for t in fx["turns"] if t["asked"]["message"] == asked.get("message")), None)
    if turn:
        async with httpx.AsyncClient() as h:
            await h.post(base + fx["path"], json=turn["sent"])
    return {"ok": True}
`;

test("Python: a model call says what the app told its model, never the person's words", { skip: !existsSync(PY) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "told-"));
  const file = join(dir, "trace.jsonl");
  writeFileSync(join(dir, "told_app.py"), PY_APP);
  const child = spawn(PY, ["-m", "uvicorn", "told_app:app", "--port", "4341"], { cwd: dir, env: { ...process.env, PYTHONPATH: new URL("./pyhook/", import.meta.url).pathname, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:4341/nothing"); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    await conversation(4341);
  } finally { child.kill("SIGKILL"); }
  toldAsRecorded(rowsOf(file).filter((l) => l.call).map((l) => l.call));
});
