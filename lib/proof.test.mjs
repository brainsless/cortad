import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proofsOf } from "./proof.mjs";
import { makeCapture, sourceFinder } from "./replay.mjs";

// Real apps under the real hooks: each door holds a conversation its own way, a client drives two
// turns through it the way the app's own client would, and the proof is read off what was recorded.
const HOOK = new URL("./trace.cjs", import.meta.url).pathname;
const PYHOOK = new URL("./pyhook/", import.meta.url).pathname;
const PY = new URL("../.scratch/py-app/.venv/bin/python", import.meta.url).pathname;
const rowsOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setTimeout(r, 400));

function inFolder(name) {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  copyFileSync(new URL(`./${name}`, import.meta.url), join(dir, name));
  return dir;
}

async function nodeApp(env = {}) {
  const dir = inFolder("proof-app.cjs");
  const file = join(dir, "trace.jsonl");
  const child = spawn(process.execPath, ["--require", HOOK, "proof-app.cjs"], { cwd: dir, env: { ...process.env, CORTAD_TRACE_FILE: file, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { dir, file, child, post };
}

// Two turns on each of the Node app's doors, each the way that door's own client holds a conversation.
async function twoTurns(post) {
  const first = await (await post("/api/chat", { message: "a weekend in Lisbon" }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  await (await post("/api/chat", { message: "the leak season in Porto", sessionId: first.sessionId }, { authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" })).json();
  const streamed = await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }] })).text();
  const said = streamed.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).content ?? "").join("");
  await (await post("/api/stream", { messages: [{ role: "user", content: "hiking in Madeira" }, { role: "assistant", content: said }, { role: "user", content: "the Azores in winter" }] })).text();
  for (const text of ["museums in Madrid", "tapas near Retiro"]) await (await post("/api/threads/t-8f3a2c9d1e7b4a6c/messages", { text })).json();
  for (const q of ["trains from Paris to Nice", "night trains to Vienna"]) await (await post("/api/assist", { q }, { "x-conversation": "c-7d1e2f3a4b5c6d7e8f9a" })).text();
  for (let i = 0; i < 2; i++) await (await post("/api/once", { message: "a day trip to Sintra" })).json();
  await (await post("/api/broken", { message: "is it raining in Rome" })).json();
}

test("Node: each door's ask, session, reply and model are read off two real turns", async () => {
  const app = await nodeApp();
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const of = (key) => proofs.get(key)?.proof;
  assert.deepEqual([...proofs.keys()].sort(), ["POST /api/assist", "POST /api/broken", "POST /api/chat", "POST /api/once", "POST /api/stream", "POST /api/threads/{id}/messages"]);

  assert.deepEqual(of("POST /api/chat").session, { held: true, carrier: "body", key: "sessionId" }, "the id the app handed back in its first reply");
  assert.deepEqual([of("POST /api/chat").askField, of("POST /api/chat").replyPath, of("POST /api/chat").stream], ["message", "reply", false]);
  assert.deepEqual([of("POST /api/chat").exchanges, of("POST /api/chat").modelCalls, of("POST /api/chat").model], [2, 1, "fixture-model"]);
  assert.deepEqual(of("POST /api/chat").tokens, { prompt: 50, completion: 12 }, "the provider's own counts, the median of the two turns");
  assert.equal(typeof of("POST /api/chat").replySeconds, "number");

  assert.deepEqual(of("POST /api/stream").session, { held: true, carrier: "history", key: "messages" });
  assert.deepEqual([of("POST /api/stream").askField, of("POST /api/stream").replyPath, of("POST /api/stream").stream], ["messages", null, true]);
  assert.equal(proofs.get("POST /api/stream").sample.reply, "About the Azores in winter: pack light. Earlier you asked about hiking in Madeira.", "the stream put back together from its events");

  assert.deepEqual(of("POST /api/threads/{id}/messages").session, { held: true, carrier: "path", key: "id" });
  assert.deepEqual(of("POST /api/assist").session, { held: true, carrier: "header", key: "x-conversation" });
  assert.equal(of("POST /api/assist").replyPath, null, "a plain text reply is read whole");
  assert.deepEqual(of("POST /api/once").session, { held: false, carrier: "none", key: null }, "the same words asked twice are not a conversation held");
});

test("Node: the problems a line of code decides are named with the line that holds them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-rules-"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify([{ id: "rule:short", text: "Keep answers short." }]));
  const app = await nodeApp({ CORTAD_RULES_FILE: join(dir, "rules.json") });
  try { await twoTurns(app.post); await settle(); } finally { app.child.kill(); }
  const proofs = proofsOf(rowsOf(app.file), { find: sourceFinder(app.dir, () => ["proof-app.cjs"]) });
  const source = readFileSync(join(app.dir, "proof-app.cjs"), "utf8").split("\n");
  const lineOf = (text) => source.findIndex((l) => l.includes(text)) + 1;
  const problems = (key) => proofs.get(key).problems;

  assert.deepEqual(problems("POST /api/chat"), [{ kind: "leaked-markup", said: 'The reply carried "</system-reminder>", markup from the prompt your app sent the model.', file: "proof-app.cjs", line: lineOf("<system-reminder>") }]);
  const broken = problems("POST /api/broken");
  assert.deepEqual(broken.map((p) => p.kind), ["error-under-2xx", "model-call-failed"]);
  assert.deepEqual([broken[0].file, broken[0].line], ["proof-app.cjs", lineOf("The assistant is unavailable right now.")], "the error sentence found where the app wrote it");
  assert.match(broken[1].said, /^A model call to 127\.0\.0\.1:\d+ for fixture-model answered 503\.$/);
  assert.deepEqual([broken[1].file, broken[1].line], ["proof-app.cjs", lineOf("const complete = ")], "the app's own line that made the call");
  assert.deepEqual(problems("POST /api/assist").map((p) => [p.kind, p.line]), [["rules-not-carried", lineOf("const complete = ")]], "its own system prompt carried none of the read's rules");
  assert.deepEqual(problems("POST /api/stream"), []);
});

test("the command sends each door once it is proven and again only when a new exchange changes it; header values stay here", async () => {
  const dir = inFolder("proof-app.cjs");
  const sent = [];
  const kept = [];
  const capture = makeCapture({ work: dir, keepSecret: (v) => kept.push(v), onProof: (p) => sent.push(p), root: dir, files: () => ["proof-app.cjs"] });
  const child = spawn(process.execPath, ["proof-app.cjs"], { cwd: dir, env: { ...process.env, ...capture.env(process.env) }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok-4f9a8b7c6d5e4f3a2b1c" }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const first = await post({ message: "a weekend in Lisbon" });
    await settle();
    capture.alive();
    assert.equal(sent.length, 1, "proven by one exchange");
    assert.deepEqual([sent[0].proof.exchanges, sent[0].proof.session.held], [1, false]);
    capture.alive();
    assert.equal(sent.length, 1, "nothing new, nothing sent");
    await post({ message: "the leak season in Porto", sessionId: first.sessionId });
    await settle();
    capture.alive();
    const last = sent.at(-1);
    assert.deepEqual([last.proof.exchanges, last.proof.session], [2, { held: true, carrier: "body", key: "sessionId" }]);
    assert.deepEqual(last.door, { method: "POST", path: "/api/chat" });
    assert.deepEqual(last.template, { body: { message: "the leak season in Porto", sessionId: first.sessionId }, headerNames: ["accept", "accept-language", "authorization", "content-type", "sec-fetch-mode", "user-agent"], askField: "message", sessionKey: "sessionId" });
    assert.ok(!JSON.stringify(sent).includes("tok-4f9a8b7c6d5e4f3a2b1c"), "a sign-in value never leaves");
    assert.ok(kept.includes("tok-4f9a8b7c6d5e4f3a2b1c"), "and is kept to be masked out of anything that does");
    assert.equal(capture.headers().authorization, "Bearer tok-4f9a8b7c6d5e4f3a2b1c", "speaking as the person uses their own header, here");
  } finally { child.kill(); }
});

const skipPy = !existsSync(PY);

test("Python: a cookie the app set, an id the client minted, a stream, and a retrieval that came back empty", { skip: skipPy }, async () => {
  const dir = inFolder("proof_app.py");
  const file = join(dir, "trace.jsonl");
  const port = 4391;
  const child = spawn(PY, ["-m", "uvicorn", "proof_app:app", "--port", String(port)], { cwd: dir, env: { ...process.env, PYTHONPATH: PYHOOK, CORTAD_TRACE_FILE: file }, stdio: "ignore" });
  const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/nothing`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    const one = await post("/chat", { message: "a mushroom risotto" });
    const cookie = one.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await one.json();
    await (await post("/chat", { message: "a lemon tart for six" }, { cookie })).json();
    for (const question of ["crispy tofu at home", "a quick peanut sauce"]) await (await post("/ask", { thread_id: "7f3c2a9e-1b4d-4c8e-9a2f-6d5e4c3b2a10", question })).text();
    await (await post("/recipes", { q: "vegan lasagne" })).json();
    await settle();
  } finally { child.kill("SIGKILL"); }
  const rows = rowsOf(file);
  const proofs = proofsOf(rows, { find: sourceFinder(dir, () => ["proof_app.py"]), routes: rows.find((r) => r.routes)?.routes.routes });
  const of = (key) => proofs.get(key).proof;
  assert.deepEqual(of("POST /chat").session, { held: true, carrier: "cookie", key: "conv" });
  assert.deepEqual([of("POST /chat").askField, of("POST /chat").replyPath, of("POST /chat").tokens], ["message", "answer", { prompt: 40, completion: 9 }]);
  assert.deepEqual(of("POST /ask").session, { held: true, carrier: "body", key: "thread_id" });
  assert.deepEqual([of("POST /ask").askField, of("POST /ask").stream], ["question", true]);
  assert.equal(proofs.get("POST /ask").sample.reply, "For a quick peanut sauce, swap butter for olive oil. You also asked about crispy tofu at home.", "a stream whose events say token keeps its words");
  const source = readFileSync(join(dir, "proof_app.py"), "utf8").split("\n");
  assert.deepEqual(proofs.get("POST /recipes").problems, [{ kind: "retrieval-empty", said: "A retrieval from 127.0.0.1 returned nothing.", file: "proof_app.py", line: source.findIndex((l) => l.includes("found = httpx.post(")) + 1 }]);
});
